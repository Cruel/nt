type TreeKey = string | number;

type TreeNode<K extends TreeKey, V> = Readonly<{
  key: K;
  value: V;
  priority: number;
  left: TreeNode<K, V> | null;
  right: TreeNode<K, V> | null;
}>;

function compareTreeKeys<K extends TreeKey>(left: K, right: K): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  // Collation can equate distinct Unicode paths; tree identity must match dictionary identity.
  return left === right ? 0 : left < right ? -1 : 1;
}

function treePriority(key: TreeKey): number {
  const text = `${typeof key === 'number' ? '#' : '$'}${String(key)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16_777_619);
  return hash >>> 0;
}

function treeNode<K extends TreeKey, V>(
  key: K,
  value: V,
  priority: number,
  left: TreeNode<K, V> | null,
  right: TreeNode<K, V> | null,
): TreeNode<K, V> {
  return { key, value, priority, left, right };
}

function rotateTreeRight<K extends TreeKey, V>(root: TreeNode<K, V>): TreeNode<K, V> {
  const pivot = root.left!;
  const moved = treeNode(root.key, root.value, root.priority, pivot.right, root.right);
  return treeNode(pivot.key, pivot.value, pivot.priority, pivot.left, moved);
}

function rotateTreeLeft<K extends TreeKey, V>(root: TreeNode<K, V>): TreeNode<K, V> {
  const pivot = root.right!;
  const moved = treeNode(root.key, root.value, root.priority, root.left, pivot.left);
  return treeNode(pivot.key, pivot.value, pivot.priority, moved, pivot.right);
}

function treeSet<K extends TreeKey, V>(
  root: TreeNode<K, V> | null,
  key: K,
  value: V,
): TreeNode<K, V> {
  if (!root) return treeNode(key, value, treePriority(key), null, null);
  const comparison = compareTreeKeys(key, root.key);
  if (comparison === 0) return treeNode(root.key, value, root.priority, root.left, root.right);
  if (comparison < 0) {
    const left = treeSet(root.left, key, value);
    const next = treeNode(root.key, root.value, root.priority, left, root.right);
    return left.priority < next.priority ? rotateTreeRight(next) : next;
  }
  const right = treeSet(root.right, key, value);
  const next = treeNode(root.key, root.value, root.priority, root.left, right);
  return right.priority < next.priority ? rotateTreeLeft(next) : next;
}

function treeGet<K extends TreeKey, V>(root: TreeNode<K, V> | null, key: K): V | undefined {
  let current = root;
  while (current) {
    const comparison = compareTreeKeys(key, current.key);
    if (comparison === 0) return current.value;
    current = comparison < 0 ? current.left : current.right;
  }
  return undefined;
}

function treeForEach<K extends TreeKey, V>(
  root: TreeNode<K, V> | null,
  callback: (key: K, value: V) => void,
): void {
  const stack: TreeNode<K, V>[] = [];
  let current = root;
  while (current || stack.length > 0) {
    while (current) {
      stack.push(current);
      current = current.left;
    }
    current = stack.pop()!;
    callback(current.key, current.value);
    current = current.right;
  }
}

type RecordOverride<T> = Readonly<{ value: T; insertion: number | null }>;
type RecordOverlayState<T> = Readonly<{
  root: Readonly<Record<string, T>>;
  overrides: TreeNode<string, RecordOverride<T>> | null;
  nextInsertion: number;
}>;

type ArrayOverlayState<T> = Readonly<{
  root: readonly T[];
  overrides: TreeNode<number, Readonly<{ value: T }>> | null;
}>;

type MapOverride<V> = Readonly<{
  present: boolean;
  value?: V;
  insertion: number | null;
}>;
type MapOverlayState<V> = Readonly<{
  root: ReadonlyMap<string, V>;
  overrides: TreeNode<string, MapOverride<V>> | null;
  size: number;
  nextInsertion: number;
}>;

const recordOverlayStates = new WeakMap<object, RecordOverlayState<unknown>>();
const arrayOverlayStates = new WeakMap<object, ArrayOverlayState<unknown>>();
const mapOverlayStates = new WeakMap<object, MapOverlayState<unknown>>();

function recordValue<T>(state: RecordOverlayState<T>, key: string): T | undefined {
  const override = treeGet(state.overrides, key);
  return override === undefined ? state.root[key] : override.value;
}

function recordHas<T>(state: RecordOverlayState<T>, key: string): boolean {
  return treeGet(state.overrides, key) !== undefined || Object.hasOwn(state.root, key);
}

/**
 * Persistent copy-on-write view for JSON-shaped dictionaries. Updates allocate only the search-tree
 * path for each changed key; prior generations share every untouched node. Lookup depth therefore
 * depends on distinct changed keys, never on resident generation count, and updates never compact or
 * rescan historical changes.
 */
export function overlayReadonlyRecord<T>(
  base: Readonly<Record<string, T>>,
  changes: Readonly<Record<string, T>>,
  onEnumerate?: () => void,
): Readonly<Record<string, T>> {
  const entries = Object.entries(changes) as [string, T][];
  if (entries.length === 0) return base;
  const prior = recordOverlayStates.get(base as object) as RecordOverlayState<T> | undefined;
  const root = prior?.root ?? base;
  let overrides = prior?.overrides ?? null;
  let nextInsertion = prior?.nextInsertion ?? 0;
  for (const [key, value] of entries) {
    const previous = treeGet(overrides, key);
    const insertion = previous?.insertion ?? (Object.hasOwn(root, key) ? null : nextInsertion++);
    overrides = treeSet(overrides, key, { value, insertion });
  }
  const state: RecordOverlayState<T> = { root, overrides, nextInsertion };
  const proxy = new Proxy(Object.create(null) as Record<string, T>, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      return recordValue(state, property);
    },
    has(_target, property) {
      return typeof property === 'string' && recordHas(state, property);
    },
    ownKeys() {
      onEnumerate?.();
      const rootKeys = Reflect.ownKeys(state.root);
      const inserted: Array<readonly [number, string]> = [];
      treeForEach(state.overrides, (key, override) => {
        if (override.insertion !== null) inserted.push([override.insertion, key]);
      });
      inserted.sort(([left], [right]) => left - right);
      return [...rootKeys, ...inserted.map(([, key]) => key)];
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== 'string' || !recordHas(state, property)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: recordValue(state, property),
      };
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    defineProperty() {
      return false;
    },
  });
  recordOverlayStates.set(proxy, state as RecordOverlayState<unknown>);
  return proxy;
}

function arrayValue<T>(state: ArrayOverlayState<T>, index: number): T | undefined {
  const override = treeGet(state.overrides, index);
  return override === undefined ? state.root[index] : override.value;
}

function arrayIndex(property: PropertyKey): number | null {
  if (typeof property !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(property)) return null;
  const index = Number(property);
  return Number.isSafeInteger(index) ? index : null;
}

/** Persistent copy-on-write view for fixed-length readonly arrays. */
export function overlayReadonlyArray<T>(
  base: readonly T[],
  changes: ReadonlyMap<number, T>,
): readonly T[] {
  if (changes.size === 0) return base;
  const prior = arrayOverlayStates.get(base as object) as ArrayOverlayState<T> | undefined;
  let overrides = prior?.overrides ?? null;
  for (const [index, value] of changes) overrides = treeSet(overrides, index, { value });
  const state: ArrayOverlayState<T> = { root: prior?.root ?? base, overrides };
  const target: T[] = [];
  target.length = state.root.length;
  const proxy: readonly T[] = new Proxy(target, {
    get(_target, property, receiver) {
      if (property === 'length') return state.root.length;
      const index = arrayIndex(property);
      if (index !== null) return arrayValue(state, index);
      return Reflect.get(state.root, property, receiver);
    },
    has(_target, property) {
      const index = arrayIndex(property);
      if (index !== null) return index >= 0 && index < state.root.length;
      return Reflect.has(state.root, property);
    },
    ownKeys() {
      return Reflect.ownKeys(state.root);
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property === 'length')
        return { configurable: false, enumerable: false, writable: true, value: state.root.length };
      const index = arrayIndex(property);
      if (index !== null) {
        if (index < 0 || index >= state.root.length) return undefined;
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: arrayValue(state, index),
        };
      }
      return Reflect.getOwnPropertyDescriptor(state.root, property);
    },
    set() {
      return false;
    },
    deleteProperty() {
      return false;
    },
    defineProperty() {
      return false;
    },
  });
  arrayOverlayStates.set(proxy as object, state as ArrayOverlayState<unknown>);
  return proxy;
}

function mapValue<V>(state: MapOverlayState<V>, key: string): MapOverride<V> {
  const override = treeGet(state.overrides, key);
  if (override) return override;
  return state.root.has(key)
    ? { present: true, value: state.root.get(key), insertion: null }
    : { present: false, insertion: null };
}

class PersistentOverlayReadonlyMap<V> implements ReadonlyMap<string, V> {
  constructor(private readonly state: MapOverlayState<V>) {}

  get size(): number {
    return this.state.size;
  }

  get(key: string): V | undefined {
    const value = mapValue(this.state, key);
    return value.present ? value.value : undefined;
  }

  has(key: string): boolean {
    return mapValue(this.state, key).present;
  }

  private materialized(): Map<string, V> {
    const overrides = new Map<string, MapOverride<V>>();
    treeForEach(this.state.overrides, (key, value) => overrides.set(key, value));
    const values = new Map<string, V>();
    for (const [key, value] of this.state.root) {
      const override = overrides.get(key);
      if (!override) values.set(key, value);
      else if (override.present && override.insertion === null)
        values.set(key, override.value as V);
    }
    const inserted: Array<readonly [number, string, V]> = [];
    for (const [key, override] of overrides)
      if (override.present && override.insertion !== null)
        inserted.push([override.insertion, key, override.value as V]);
    inserted.sort(([left], [right]) => left - right);
    for (const [, key, value] of inserted) values.set(key, value);
    return values;
  }

  entries(): MapIterator<[string, V]> {
    return this.materialized().entries();
  }

  keys(): MapIterator<string> {
    return this.materialized().keys();
  }

  values(): MapIterator<V> {
    return this.materialized().values();
  }

  forEach(
    callbackfn: (value: V, key: string, map: ReadonlyMap<string, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.materialized()) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return 'PersistentOverlayReadonlyMap';
  }
}

/**
 * Persistent copy-on-write Map view. Size is advanced from the preceding generation using only the
 * current delta; distinct historical keys live in a persistent search tree and are never rescanned
 * or compacted by an isolated update.
 */
export function overlayReadonlyMap<V>(
  base: ReadonlyMap<string, V>,
  changes: ReadonlyMap<string, V>,
  deleted: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, V> {
  if (changes.size === 0 && deleted.size === 0) return base;
  const prior = mapOverlayStates.get(base as object) as MapOverlayState<V> | undefined;
  const root = prior?.root ?? base;
  let overrides = prior?.overrides ?? null;
  let size = prior?.size ?? base.size;
  let nextInsertion = prior?.nextInsertion ?? 0;

  for (const key of deleted) {
    const current = mapValue({ root, overrides, size, nextInsertion }, key);
    if (current.present) size -= 1;
    overrides = treeSet(overrides, key, { present: false, insertion: null });
  }
  for (const [key, value] of changes) {
    const current = mapValue({ root, overrides, size, nextInsertion }, key);
    const insertion = current.present ? current.insertion : nextInsertion++;
    if (!current.present) size += 1;
    overrides = treeSet(overrides, key, { present: true, value, insertion });
  }

  const state: MapOverlayState<V> = { root, overrides, size, nextInsertion };
  const overlay = new PersistentOverlayReadonlyMap(state);
  mapOverlayStates.set(overlay, state as MapOverlayState<unknown>);
  return overlay;
}
