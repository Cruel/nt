import type {
  AuthoringDependencyGraphSnapshot,
  AuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-contracts';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { JsonPatchOperation } from './json-patch';
import { parseJsonPointer, type JsonPointer } from './json-pointer';
import type { JsonValue } from './json-value';

export interface AuthoringRepairPreviewItem {
  edgeId: string;
  role: string;
  sourcePath: JsonPointer;
  action: string;
}

export interface AuthoringRepairPlan {
  projectInstanceId: string;
  projectRevision: number;
  target: AuthoringDependencyNodeKey;
  patches: readonly JsonPatchOperation[];
  preview: readonly AuthoringRepairPreviewItem[];
  warnings: readonly string[];
}

export type AuthoringRepairPlanResult =
  | { status: 'ready'; plan: AuthoringRepairPlan }
  | { status: 'blocked'; reason: string }
  | { status: 'stale'; reason: string };

function keyEquals(left: AuthoringDependencyNodeKey, right: AuthoringDependencyNodeKey): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readonlyMapValues<K, V>(map: ReadonlyMap<K, V>): V[] {
  const values: V[] = [];
  for (const [, value] of map) values.push(value);
  return values;
}

function repairTargetsForTarget(
  snapshot: AuthoringDependencyGraphSnapshot,
  target: AuthoringDependencyNodeKey,
): readonly AuthoringDependencyNodeKey[] {
  const targets = [target];
  if (target.kind === 'record' && target.collection === 'rooms') {
    for (const [, node] of snapshot.graph.nodesByKey)
      if (
        node.key.kind === 'nested' &&
        node.key.ownerCollection === 'rooms' &&
        node.key.ownerId === target.id &&
        node.key.family === 'room-placement'
      )
        targets.push(node.key);
  }
  return targets;
}

export function authoringRepairEdgesForTarget(
  snapshot: AuthoringDependencyGraphSnapshot | null,
  target: AuthoringDependencyNodeKey,
) {
  if (!snapshot) return [];
  const repairTargets = repairTargetsForTarget(snapshot, target);
  return readonlyMapValues(snapshot.graph.edgesById).filter(
    (edge) =>
      repairTargets.some((repairTarget) => keyEquals(edge.target, repairTarget)) &&
      !keyEquals(edge.source, target),
  );
}

function repairPatchForEdge(
  role: string,
  repair: AuthoringDependencyGraphSnapshot['graph']['edgesById'] extends ReadonlyMap<
    string,
    infer E
  >
    ? E extends { repair: infer R }
      ? R
      : never
    : never,
  replacementId?: string,
): { patch?: JsonPatchOperation; action: string; warning?: string; blocked?: string } {
  if (role === 'room-cast-character' || role === 'room-overlay-layout') {
    if (repair.kind !== 'remove-array-item')
      return {
        action: 'Invalid array repair descriptor',
        blocked: 'The array reference repair descriptor does not identify an item to remove.',
      };
    return { patch: { op: 'remove', path: repair.itemPath }, action: 'Remove array item' };
  }
  if (role === 'room-placement-layout') {
    if (repair.kind !== 'set-null')
      return {
        action: 'Invalid nullable repair descriptor',
        blocked: 'The placement Layout repair descriptor does not identify a nullable field.',
      };
    return {
      patch: { op: 'replace', path: repair.path, value: null },
      action: 'Clear placement Layout',
    };
  }
  if (role === 'system-layout') {
    if (repair.kind !== 'set-null')
      return {
        action: 'Invalid nullable repair descriptor',
        blocked: 'The system Layout repair descriptor does not identify a nullable field.',
      };
    return {
      patch: { op: 'replace', path: repair.path, value: null },
      action: 'Clear system Layout',
    };
  }
  if (role === 'room-compose-script') {
    if (repair.kind !== 'set-null')
      return {
        action: 'Invalid nullable repair descriptor',
        blocked: 'The Room composition repair descriptor does not identify a nullable field.',
      };
    return {
      patch: {
        op: 'replace',
        path: repair.path,
        value: null,
      },
      action: 'Clear Room composition',
    };
  }
  if (
    role === 'room-background' ||
    role === 'room-prop-asset' ||
    role === 'room-environment-asset' ||
    role === 'room-background-material' ||
    role === 'room-prop-material'
  ) {
    if (repair.kind !== 'set-null')
      return {
        action: 'Invalid nullable repair descriptor',
        blocked: 'The nullable reference repair descriptor does not identify a field to clear.',
      };
    return {
      patch: { op: 'replace', path: repair.path, value: null },
      action: 'Clear nullable reference',
    };
  }
  if (role === 'room-environment-material' || role === 'room-exit-target') {
    const expectedCollection = role === 'room-environment-material' ? 'materials' : 'rooms';
    if (
      repair.kind === 'replacement-required' &&
      repair.collection === expectedCollection &&
      replacementId
    ) {
      return {
        patch: {
          op: 'replace',
          path: repair.path,
          value: { collection: repair.collection, id: replacementId } as JsonValue,
        },
        action: `Replace with ${repair.collection}/${replacementId}`,
      };
    }
    return {
      action: 'Replacement required',
      blocked:
        repair.kind === 'replacement-required' && repair.collection === expectedCollection
          ? 'A replacement is required before deletion.'
          : 'The replacement repair descriptor has an invalid authoring value encoding.',
    };
  }

  switch (repair.kind) {
    case 'set-null':
      return { patch: { op: 'replace', path: repair.path, value: null }, action: 'Set null' };
    case 'clear-field':
      return { patch: { op: 'remove', path: repair.path }, action: 'Clear field' };
    case 'remove-array-item':
      return { patch: { op: 'remove', path: repair.itemPath }, action: 'Remove array item' };
    case 'remove-map-entry':
      return { patch: { op: 'remove', path: repair.entryPath }, action: 'Remove map entry' };
    case 'warning-only':
      return { action: 'Manual Lua review', warning: repair.reason };
    case 'replacement-required':
      return {
        action: 'Unsupported replacement encoding',
        blocked: 'This reference role has no safe automatic replacement encoding.',
      };
    case 'blocked':
      return { action: 'Blocked', blocked: repair.reason };
  }
}

function sortPatches(patches: JsonPatchOperation[]): JsonPatchOperation[] {
  return patches.sort((left, right) => {
    const category = (patch: JsonPatchOperation) => {
      if (patch.op !== 'remove') return 2;
      const tail = parseJsonPointer(patch.path).at(-1);
      return tail !== undefined && Number.isInteger(Number(tail)) ? 0 : 1;
    };
    const categoryDifference = category(left) - category(right);
    if (categoryDifference !== 0) return categoryDifference;
    if (left.op !== 'remove' || right.op !== 'remove')
      return left.path.localeCompare(right.path) || left.op.localeCompare(right.op);
    const a = parseJsonPointer(left.path);
    const b = parseJsonPointer(right.path);
    const aParent = a.slice(0, -1).join('/');
    const bParent = b.slice(0, -1).join('/');
    if (aParent !== bParent) return aParent.localeCompare(bParent);
    const ai = Number(a.at(-1));
    const bi = Number(b.at(-1));
    if (Number.isInteger(ai) && Number.isInteger(bi)) return bi - ai;
    return right.path.localeCompare(left.path);
  });
}

export function generateAuthoringRepairPlan(input: {
  snapshot: AuthoringDependencyGraphSnapshot | null;
  projectInstanceId: string | null;
  projectRevision: number;
  target: AuthoringDependencyNodeKey;
  deletePath: JsonPointer;
  metadataPath?: JsonPointer;
  force?: boolean;
  replacements?: Readonly<Record<string, string>>;
}): AuthoringRepairPlanResult {
  if (
    !input.snapshot ||
    !input.projectInstanceId ||
    input.snapshot.projectInstanceId !== input.projectInstanceId ||
    input.snapshot.projectRevision !== input.projectRevision
  ) {
    return {
      status: 'stale',
      reason: 'The dependency graph is not ready for the current project revision.',
    };
  }

  const patches: JsonPatchOperation[] = [];
  const preview: AuthoringRepairPreviewItem[] = [];
  const warnings: string[] = [];
  const edges = authoringRepairEdgesForTarget(input.snapshot, input.target);
  if (!input.force) {
    for (const edge of edges) {
      const replacementId = input.replacements?.[edge.id];
      if (replacementId && edge.repair.kind === 'replacement-required') {
        const replacementKey = JSON.stringify(['record', edge.repair.collection, replacementId]);
        if (
          !input.snapshot.graph.nodesByKey.has(replacementKey) ||
          (input.target.kind === 'record' &&
            input.target.collection === edge.repair.collection &&
            input.target.id === replacementId)
        )
          return { status: 'blocked', reason: 'The selected replacement is unavailable.' };
      }
      const planned = repairPatchForEdge(edge.role, edge.repair, replacementId);
      if (planned.blocked) return { status: 'blocked', reason: planned.blocked };
      if (planned.patch) patches.push(planned.patch);
      if (planned.warning) warnings.push(planned.warning);
      preview.push({
        edgeId: edge.id,
        role: edge.role,
        sourcePath: edge.sourcePath,
        action: planned.action,
      });
    }
  }
  patches.push({ op: 'remove', path: input.deletePath });
  if (input.metadataPath) patches.push({ op: 'remove', path: input.metadataPath });
  return {
    status: 'ready',
    plan: {
      projectInstanceId: input.projectInstanceId,
      projectRevision: input.projectRevision,
      target: input.target,
      patches: Object.freeze(sortPatches(patches)),
      preview: Object.freeze(preview),
      warnings: Object.freeze(warnings),
    },
  };
}

export function recordTarget(
  collection: AuthoringCollectionKey,
  id: string,
): AuthoringDependencyNodeKey {
  return { kind: 'record', collection, id };
}
