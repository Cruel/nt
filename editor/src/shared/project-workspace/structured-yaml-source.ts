import { Document, isMap, isSeq, isScalar, Scalar, type Node, type Pair } from 'yaml';
import { parseVariableYamlDocument } from './variable-yaml-source';

function ambiguous(value: string): boolean {
  return /^(?:yes|no|on|off|y|n|~|true|false|null|[-+]?0[0-9]+|\.inf|\.nan)$/iu.test(value);
}

function quoteAmbiguous(node: Node | null | undefined): void {
  if (!node) return;
  if (isMap(node)) {
    for (const pair of node.items) {
      quoteAmbiguous(pair.key as Node | null);
      quoteAmbiguous(pair.value as Node | null);
    }
  } else if (isSeq(node)) {
    for (const child of node.items) quoteAmbiguous(child as Node | null);
  } else if (
    isScalar(node) &&
    typeof node.value === 'string' &&
    (node.type === undefined || node.type === Scalar.PLAIN) &&
    ambiguous(node.value)
  ) {
    node.type = Scalar.QUOTE_DOUBLE;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Document-aware structural update: unchanged entries (including their comments) stay put. */
function updateNode(doc: Document, node: Node, before: unknown, after: unknown): void {
  if (isMap(node) && isObject(before) && isObject(after)) {
    for (const pair of [...node.items] as Pair[]) {
      const key = (pair.key as Scalar).value;
      if (typeof key === 'string' && !Object.hasOwn(after, key)) node.delete(key);
    }
    for (const [key, next] of Object.entries(after)) {
      if (same(before[key], next)) continue;
      const oldNode = node.get(key, true);
      if (oldNode && isObject(before[key]) && isObject(next) && isMap(oldNode)) {
        updateNode(doc, oldNode, before[key], next);
      } else if (oldNode && Array.isArray(before[key]) && Array.isArray(next) && isSeq(oldNode)) {
        updateNode(doc, oldNode, before[key], next);
      } else if (oldNode && isScalar(oldNode) && !isObject(next) && !Array.isArray(next)) {
        if (typeof oldNode.value !== typeof next || next === null) oldNode.type = undefined;
        oldNode.value = next;
      } else {
        node.set(key, doc.createNode(next));
      }
    }
  } else if (isSeq(node) && Array.isArray(before) && Array.isArray(after)) {
    const identity = (item: unknown): string | undefined =>
      isObject(item) && typeof item.id === 'string'
        ? item.id
        : typeof item === 'string'
          ? item
          : undefined;
    const oldIds = before.map(identity);
    const nextIds = after.map(identity);
    if (
      oldIds.every((id) => id !== undefined) &&
      nextIds.every((id) => id !== undefined) &&
      new Set(oldIds).size === oldIds.length &&
      new Set(nextIds).size === nextIds.length &&
      node.items.length === before.length
    ) {
      const oldNodes = new Map(oldIds.map((id, i) => [id, node.items[i]!]));
      const oldValues = new Map(oldIds.map((id, i) => [id, before[i]]));
      node.items.splice(
        0,
        node.items.length,
        ...after.map((item, i) => {
          const old = oldNodes.get(nextIds[i]);
          if (!old) return doc.createNode(item);
          updateNode(doc, old as Node, oldValues.get(nextIds[i]), item);
          return old;
        }),
      );
    } else {
      // No stable correspondence: never attach an unrelated entry's comments to a new value.
      if (
        node.items.some((item) => item && ((item as Node).comment || (item as Node).commentBefore))
      )
        throw new Error('Cannot replace a commented YAML sequence without stable item identities.');
      node.items.splice(0, node.items.length, ...after.map((item) => doc.createNode(item)));
    }
  }
}

export function decodeStructuredYaml(text: string): unknown {
  return parseVariableYamlDocument(text).toJS();
}

export function encodeStructuredYaml(value: unknown, previousText?: string): string {
  if (previousText === undefined) {
    const doc = new Document(value);
    quoteAmbiguous(doc.contents);
    return doc.toString({ indent: 2, lineWidth: 0 });
  }
  const doc = parseVariableYamlDocument(previousText);
  const before = doc.toJS() as unknown;
  if (same(before, value)) return previousText;
  if (!doc.contents || !isMap(doc.contents) || !isObject(before) || !isObject(value))
    throw new Error('Cannot update a YAML document whose root mapping has changed shape.');
  updateNode(doc, doc.contents, before, value);
  quoteAmbiguous(doc.contents);
  return doc.toString({ indent: 2, lineWidth: 0 });
}
