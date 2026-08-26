import {
  type EditorRecoveryExternalConflict,
  type EditorRecoveryPatch,
  type EditorRecoveryState,
  stripLocalEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import {
  buildJsonPointer,
  getJsonAtPointer,
  hasJsonAtPointer,
  type JsonPointer,
} from './json-pointer';
import { cloneJsonValue, isJsonObject, jsonValuesEqual, type JsonValue } from './json-value';
import { rebaseRecoveryOverlays } from './project-recovery-rebase';

export interface ProjectExternalReconciliationInput {
  baseDocument: JsonValue;
  localDocument: JsonValue;
  externalDocument: JsonValue;
  recovery: EditorRecoveryState;
  externalFileRevisions: Readonly<Record<string, `sha256:${string}` | 'absent'>>;
}

export interface ProjectExternalReconciliationResult {
  savedDocument: JsonValue;
  workingDocument: JsonValue;
  recovery: EditorRecoveryState;
  externalChangedPaths: JsonPointer[];
  conflictingSaveUnitIds: string[];
  conflictingPaths: JsonPointer[];
}

interface OptionalJsonValue {
  exists: boolean;
  value?: JsonValue;
}

function pathOverlaps(left: string, right: string): boolean {
  if (left === '' || right === '') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function optionalValue(document: JsonValue, path: JsonPointer): OptionalJsonValue {
  if (!hasJsonAtPointer(document, path)) return { exists: false };
  return { exists: true, value: cloneJsonValue(getJsonAtPointer(document, path)) };
}

function conflictValue(document: JsonValue, path: JsonPointer) {
  const read = optionalValue(document, path);
  return read.exists
    ? ({ exists: true, value: read.value! } as const)
    : ({ exists: false } as const);
}

function appendJsonDiff(
  before: JsonValue,
  after: JsonValue,
  path: JsonPointer,
  output: JsonPatchOperation[],
) {
  if (jsonValuesEqual(before, after)) return;
  if (Array.isArray(before) || Array.isArray(after)) {
    output.push({ op: 'replace', path, value: cloneJsonValue(after) });
    return;
  }
  if (isJsonObject(before) && isJsonObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPath = buildJsonPointer([...pathSegments(path), key]);
      const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
      const afterHas = Object.prototype.hasOwnProperty.call(after, key);
      if (!beforeHas) {
        output.push({ op: 'add', path: childPath, value: cloneJsonValue(after[key]!) });
        continue;
      }
      if (!afterHas) {
        output.push({ op: 'remove', path: childPath });
        continue;
      }
      appendJsonDiff(before[key]!, after[key]!, childPath, output);
    }
    return;
  }
  output.push({ op: 'replace', path, value: cloneJsonValue(after) });
}

function pathSegments(path: JsonPointer): string[] {
  if (!path) return [];
  return path
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

export function diffJsonDocuments(before: JsonValue, after: JsonValue): JsonPatchOperation[] {
  const output: JsonPatchOperation[] = [];
  appendJsonDiff(before, after, '', output);
  return output;
}

function localPathsForSaveUnit(
  entry: EditorRecoveryState['saveUnitsById'][string],
  localPatches: readonly JsonPatchOperation[],
): JsonPointer[] {
  const roots = [...entry.affectedPaths, ...entry.patches.map((patch) => patch.path)];
  return localPatches
    .map((patch) => patch.path)
    .filter((path) => roots.some((root) => pathOverlaps(path, root)))
    .sort();
}

function conflictSnapshot(
  base: JsonValue,
  local: JsonValue,
  external: JsonValue,
  paths: readonly JsonPointer[],
  externalFileRevisions: Readonly<Record<string, `sha256:${string}` | 'absent'>>,
  previous?: EditorRecoveryExternalConflict,
): EditorRecoveryExternalConflict {
  const baseValueByPath: EditorRecoveryExternalConflict['baseValueByPath'] = {};
  const localValueByPath: EditorRecoveryExternalConflict['localValueByPath'] = {};
  const externalValueByPath: EditorRecoveryExternalConflict['externalValueByPath'] = {};
  for (const path of paths) {
    baseValueByPath[path] = previous?.baseValueByPath[path] ?? conflictValue(base, path);
    localValueByPath[path] = conflictValue(local, path);
    externalValueByPath[path] = conflictValue(external, path);
  }
  return {
    baseValueByPath,
    localValueByPath,
    externalValueByPath,
    conflictingPaths: [...paths],
    externalFileRevisions: {
      ...previous?.externalFileRevisions,
      ...externalFileRevisions,
    },
  };
}

function advanceBaselineFileRevisions(
  entry: EditorRecoveryState['saveUnitsById'][string],
  externalFileRevisions: Readonly<Record<string, `sha256:${string}` | 'absent'>>,
) {
  if (!entry.baselineFileRevisions) return entry;
  const baselineFileRevisions = { ...entry.baselineFileRevisions };
  for (const [file, revision] of Object.entries(externalFileRevisions))
    if (file in baselineFileRevisions) baselineFileRevisions[file] = revision;
  return { ...entry, baselineFileRevisions };
}

function clearConflict(entry: EditorRecoveryState['saveUnitsById'][string]) {
  const { externalConflict: _externalConflict, ...rest } = entry;
  return rest;
}

export function reconcileExternalProjectChange(
  input: ProjectExternalReconciliationInput,
): ProjectExternalReconciliationResult {
  const base = stripLocalEditorProjectState(input.baseDocument) as JsonValue;
  const local = stripLocalEditorProjectState(input.localDocument) as JsonValue;
  const external = stripLocalEditorProjectState(input.externalDocument) as JsonValue;
  const localPatches = diffJsonDocuments(base, local);
  const externalPatches = diffJsonDocuments(base, external);
  const localPaths = localPatches.map((patch) => patch.path);

  let working = cloneJsonValue(local);
  for (const patch of externalPatches) {
    if (localPaths.some((path) => pathOverlaps(path, patch.path))) continue;
    working = applyJsonPatch(working, [patch]).document;
  }

  const rebased = rebaseRecoveryOverlays(input.recovery, external, working, new Set());
  const saveUnitsById: EditorRecoveryState['saveUnitsById'] = {};
  const conflictingSaveUnitIds: string[] = [];
  const allConflictingPaths = new Set<JsonPointer>();
  const localVsExternal = diffJsonDocuments(external, working).map((patch) => patch.path);

  for (const [saveUnitId, rebasedEntry] of Object.entries(rebased.saveUnitsById)) {
    const originalEntry = input.recovery.saveUnitsById[saveUnitId] ?? rebasedEntry;
    const unitLocalPaths = localPathsForSaveUnit(originalEntry, localPatches);
    const newConflictPaths = unitLocalPaths.filter((localPath) =>
      externalPatches.some((externalPatch) => pathOverlaps(localPath, externalPatch.path)),
    );
    const persistedConflictPaths = (originalEntry.externalConflict?.conflictingPaths ?? []).filter(
      (conflictPath) => localVsExternal.some((path) => pathOverlaps(path, conflictPath)),
    );
    const conflictPaths = [...new Set([...newConflictPaths, ...persistedConflictPaths])].sort();
    if (conflictPaths.length === 0) {
      saveUnitsById[saveUnitId] = clearConflict(
        advanceBaselineFileRevisions(rebasedEntry, input.externalFileRevisions),
      );
      continue;
    }
    conflictingSaveUnitIds.push(saveUnitId);
    conflictPaths.forEach((path) => allConflictingPaths.add(path));
    saveUnitsById[saveUnitId] = {
      ...rebasedEntry,
      externalConflict: conflictSnapshot(
        base,
        working,
        external,
        conflictPaths,
        input.externalFileRevisions,
        originalEntry.externalConflict,
      ),
    };
  }

  return {
    savedDocument: external,
    workingDocument: working,
    recovery: { ...rebased, saveUnitsById },
    externalChangedPaths: externalPatches.map((patch) => patch.path).sort(),
    conflictingSaveUnitIds: conflictingSaveUnitIds.sort(),
    conflictingPaths: [...allConflictingPaths].sort(),
  };
}

export function externalConflictDiagnostic(
  saveUnitId: string,
  conflict: EditorRecoveryExternalConflict,
) {
  const path = conflict.conflictingPaths[0] ?? '/';
  return {
    code: 'editor.external-change.conflict',
    severity: 'error' as const,
    category: 'External changes',
    path,
    message: `External changes conflict with unsaved edits in '${saveUnitId}'. Choose Use Disk or Keep Mine before saving this item.`,
    boundaries: ['authoring'] as const,
    ownerPaths:
      conflict.conflictingPaths.length > 0 ? conflict.conflictingPaths : ([path] as const),
  };
}

export function recoveryWithoutSaveUnit(
  recovery: EditorRecoveryState,
  saveUnitId: string,
): EditorRecoveryState {
  const saveUnitsById = { ...recovery.saveUnitsById };
  delete saveUnitsById[saveUnitId];
  return { ...recovery, saveUnitsById };
}

export function recoveryPatchPaths(recovery: EditorRecoveryState): EditorRecoveryPatch[] {
  return Object.values(recovery.saveUnitsById).flatMap((entry) => entry.patches);
}
