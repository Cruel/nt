import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { getJsonAtPointer, hasJsonAtPointer, type JsonPointer } from './json-pointer';
import { cloneJsonValue, jsonValuesEqual, type JsonValue } from './json-value';
import {
  isTrackedEditorProjectStatePath,
  stripLocalEditorProjectState,
  type EditorRecoveryPatch,
  type EditorRecoverySaveUnit,
  type EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import type { SaveUnitId } from './save-unit-types';

function pathOverlaps(left: string, right: string): boolean {
  if (left === '/' || right === '/') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function orderedEntries(
  recovery: EditorRecoveryState,
): Array<[SaveUnitId, EditorRecoverySaveUnit]> {
  return Object.entries(recovery.saveUnitsById).sort(
    ([leftId, left], [rightId, right]) =>
      left.sequence - right.sequence || leftId.localeCompare(rightId),
  );
}

function readOptional(document: JsonValue, path: JsonPointer) {
  if (!hasJsonAtPointer(document, path)) return { exists: false as const };
  return { exists: true as const, value: cloneJsonValue(getJsonAtPointer(document, path)) };
}

function patchForPath(
  baseline: JsonValue,
  working: JsonValue,
  path: JsonPointer,
): EditorRecoveryPatch | null {
  const before = readOptional(baseline, path);
  const after = readOptional(working, path);
  if (!before.exists && !after.exists) return null;
  if (before.exists && after.exists && jsonValuesEqual(before.value, after.value)) return null;
  if (!after.exists) return { op: 'remove', path };
  if (!before.exists) return { op: 'add', path, value: after.value };
  return { op: 'replace', path, value: after.value };
}

function canonicalRoots(paths: readonly JsonPointer[]): JsonPointer[] {
  const roots: JsonPointer[] = [];
  for (const path of uniqueSorted(paths).sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  )) {
    if (
      path === '/editor' ||
      (path.startsWith('/editor/') && !isTrackedEditorProjectStatePath(path))
    )
      continue;
    if (roots.some((root) => pathOverlaps(root, path) && path.startsWith(root))) continue;
    roots.push(path);
  }
  return roots;
}

export function rebaseRecoveryOverlays(
  recovery: EditorRecoveryState,
  candidateBaseline: JsonValue,
  workingDocument: JsonValue,
  committedSaveUnitIds: ReadonlySet<SaveUnitId>,
): EditorRecoveryState {
  const baselineContent = stripLocalEditorProjectState(candidateBaseline) as JsonValue;
  const workingContent = stripLocalEditorProjectState(workingDocument) as JsonValue;
  const saveUnitsById: Record<SaveUnitId, EditorRecoverySaveUnit> = {};
  for (const [saveUnitId, entry] of orderedEntries(recovery)) {
    if (committedSaveUnitIds.has(saveUnitId)) continue;
    const affectedPaths = uniqueSorted(entry.affectedPaths) as JsonPointer[];
    const patches = canonicalRoots(affectedPaths)
      .map((path) => patchForPath(baselineContent, workingContent, path))
      .filter((patch): patch is EditorRecoveryPatch => patch !== null);
    if (patches.length === 0 && Object.keys(entry.pendingRawInputByPath).length === 0) continue;
    saveUnitsById[saveUnitId] = {
      ...entry,
      patches,
      affectedPaths,
    };
  }
  return { sequence: recovery.sequence, saveUnitsById };
}

export function applyRecoveryOverlays(
  baseline: JsonValue,
  recovery: EditorRecoveryState,
): JsonValue {
  let document = cloneJsonValue(baseline);
  for (const [, entry] of orderedEntries(recovery))
    document = applyJsonPatch(document, entry.patches as JsonPatchOperation[]).document;
  return document;
}
