import type {
  AuthoringDependencyGraphSnapshot,
  AuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-contracts';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { JsonPatchOperation } from './json-patch';
import { buildJsonPointer, parseJsonPointer, type JsonPointer } from './json-pointer';
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

function parentPath(path: JsonPointer, levels = 1): JsonPointer {
  const segments = parseJsonPointer(path);
  return buildJsonPointer(segments.slice(0, Math.max(0, segments.length - levels)));
}

function repairPatchForEdge(
  role: string,
  sourcePath: JsonPointer,
  repair: AuthoringDependencyGraphSnapshot['graph']['edgesById'] extends ReadonlyMap<
    string,
    infer E
  >
    ? E extends { repair: infer R }
      ? R
      : never
    : never,
): { patch?: JsonPatchOperation; action: string; warning?: string; blocked?: string } {
  if (role === 'character-room-placement' || role === 'interactable-room-placement') {
    return {
      patch: { op: 'replace', path: sourcePath, value: { kind: 'nowhere' } as JsonValue },
      action: 'Move initial location to nowhere',
    };
  }
  if (role === 'room-cast-character' || role === 'room-overlay-layout') {
    const itemPath =
      repair.kind === 'remove-array-item' ? repair.itemPath : parentPath(sourcePath, 3);
    return { patch: { op: 'remove', path: itemPath }, action: 'Remove array item' };
  }
  if (role === 'room-placement-layout') {
    return {
      patch: { op: 'replace', path: parentPath(sourcePath, 1), value: null },
      action: 'Clear placement Layout',
    };
  }
  if (role === 'system-layout') {
    return {
      patch: { op: 'replace', path: parentPath(sourcePath, 1), value: null },
      action: 'Clear system Layout',
    };
  }
  if (role === 'room-compose-script') {
    return {
      patch: { op: 'replace', path: parentPath(sourcePath, 3), value: null },
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
    return {
      patch: { op: 'replace', path: parentPath(sourcePath, 1), value: null },
      action: 'Clear nullable reference',
    };
  }
  if (role === 'room-environment-material' || role === 'room-exit-target') {
    return {
      action: 'Replacement required',
      blocked: 'A replacement is required before deletion.',
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
        action: 'Replacement required',
        blocked: 'A replacement is required before deletion.',
      };
    case 'blocked':
      return { action: 'Blocked', blocked: repair.reason };
  }
}

function sortPatches(patches: JsonPatchOperation[]): JsonPatchOperation[] {
  return patches.sort((left, right) => {
    if (left.op !== 'remove' || right.op !== 'remove') return 0;
    const a = parseJsonPointer(left.path);
    const b = parseJsonPointer(right.path);
    const aParent = a.slice(0, -1).join('/');
    const bParent = b.slice(0, -1).join('/');
    if (aParent !== bParent) return aParent.localeCompare(bParent);
    const ai = Number(a.at(-1));
    const bi = Number(b.at(-1));
    return Number.isInteger(ai) && Number.isInteger(bi)
      ? bi - ai
      : right.path.localeCompare(left.path);
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
  const edges = [...input.snapshot.graph.edgesById.values()].filter(
    (edge) => keyEquals(edge.target, input.target) && !keyEquals(edge.source, input.target),
  );
  if (!input.force) {
    for (const edge of edges) {
      const planned = repairPatchForEdge(edge.role, edge.sourcePath, edge.repair);
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
