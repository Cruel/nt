import { useCommandStore } from '@/commands/command-store';
import { getJsonAtPointer, hasJsonAtPointer, parseJsonPointer } from '@/project/json-pointer';
import { applyJsonPatch, type JsonPatchOperation } from '@/project/json-patch';
import { cloneJsonValue, jsonValuesEqual, toJsonValue, type JsonValue } from '@/project/json-value';
import {
  PROJECT_SETTINGS_SAVE_UNIT_ID,
  recordSaveUnitId,
  resolveSaveUnitForTab,
} from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { useDraftDirtyStore, serializeDraftDirtyState } from './draft-dirty-store';
import { serializePendingInputs, usePendingInputStore } from './pending-input-store';
import { useBottomPanelStore } from './bottom-panel-store';
import { useLocalEditorSessionStore } from './local-editor-session-store';
import { useProjectExplorerStore } from '../workspace/project-explorer-store';
import { createInitialWorkbenchState } from './workbench-model';
import { useWorkbenchStore } from './workbench-store';
import {
  restoreSerializedWorkbenchTabStates,
  serializeWorkbenchTabStates,
} from './workbench-tab-state';
import {
  emptyEditorProjectState,
  parseEditorProjectState,
  type EditorProjectState,
  type EditorRecoveryPatch,
  type EditorRecoverySaveUnit,
} from '../../shared/project-schema/editor-project-state';
import type { AuthoringEnumRepair } from '../../shared/project-schema/decode-authoring-project';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';

interface RecoveryContext {
  editorState: EditorProjectState;
  repairs: AuthoringEnumRepair[];
}

export interface ReconstructedEditorProject {
  savedDocument: JsonValue;
  workingDocument: JsonValue;
  diagnostics: ProjectValidationDiagnostic[];
}

let recoveryContext: RecoveryContext = {
  editorState: emptyEditorProjectState(),
  repairs: [],
};

function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentSaveUnitForPath(path: string): string {
  const segments = parseJsonPointer(path);
  if (['project', 'settings', 'startupHook', 'entrypoint'].includes(segments[0] ?? ''))
    return PROJECT_SETTINGS_SAVE_UNIT_ID;
  if (segments.length >= 2) return recordSaveUnitId(segments[0]!, segments[1]!);
  return `project:path:${segments[0] ?? 'root'}`;
}

function recoveryApplyDiagnostic(saveUnitId: string, message: string): ProjectValidationDiagnostic {
  const escaped = saveUnitId.replaceAll('~', '~0').replaceAll('/', '~1');
  const path = `/editor/recovery/saveUnitsById/${escaped}`;
  return createProjectValidationDiagnostic({
    code: 'editor.recovery.patch.failed',
    severity: 'warning',
    category: 'Project recovery',
    path,
    message,
    boundaries: ['authoring'],
    ownerPaths: [path],
  });
}

function mergeContentAndEditorState(
  content: JsonValue,
  editorState: EditorProjectState,
): JsonValue {
  const cloned = cloneJsonValue(content);
  if (!isObject(cloned)) return cloned;
  return { ...cloned, editor: toJsonValue(editorState) };
}

function repairPatches(repairs: readonly AuthoringEnumRepair[]): JsonPatchOperation[] {
  return repairs.map((repair) => ({
    op: 'replace' as const,
    path: repair.path,
    value: repair.replacement,
  }));
}

export function reconstructEditorProject(
  savedContentProject: JsonValue,
  decodedContentProject: JsonValue,
  editorState: EditorProjectState,
  repairs: readonly AuthoringEnumRepair[],
): ReconstructedEditorProject {
  const savedDocument = mergeContentAndEditorState(savedContentProject, editorState);
  let workingDocument = mergeContentAndEditorState(decodedContentProject, editorState);
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const entries = Object.entries(editorState.recovery.saveUnitsById).sort(
    ([leftId, left], [rightId, right]) =>
      left.sequence - right.sequence || leftId.localeCompare(rightId),
  );
  for (const [saveUnitId, entry] of entries) {
    try {
      workingDocument = applyJsonPatch(
        workingDocument,
        entry.patches as JsonPatchOperation[],
      ).document;
    } catch (error) {
      diagnostics.push(
        recoveryApplyDiagnostic(
          saveUnitId,
          error instanceof Error ? error.message : 'Recovery patch could not be applied.',
        ),
      );
    }
  }
  recoveryContext = {
    editorState: cloneSerializable(editorState),
    repairs: [...repairs],
  };
  usePendingInputStore.getState().hydratePendingInputs(editorState.recovery);
  return { savedDocument, workingDocument, diagnostics };
}

function readOptional(document: JsonValue, path: string) {
  if (!hasJsonAtPointer(document, path)) return { exists: false as const };
  return { exists: true as const, value: cloneJsonValue(getJsonAtPointer(document, path)) };
}

function patchForPath(
  saved: JsonValue,
  current: JsonValue,
  path: string,
): EditorRecoveryPatch | null {
  const before = readOptional(saved, path);
  const after = readOptional(current, path);
  if (!before.exists && !after.exists) return null;
  if (before.exists && after.exists && jsonValuesEqual(before.value, after.value)) return null;
  if (!after.exists) return { op: 'remove', path };
  if (!before.exists) return { op: 'add', path, value: after.value };
  return { op: 'replace', path, value: after.value };
}

function canonicalRecoveryRoots(paths: readonly string[]): string[] {
  const canonical = [...new Set(paths)]
    .filter((path) => path.startsWith('/') && path !== '/editor' && !path.startsWith('/editor/'))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  const roots: string[] = [];
  for (const path of canonical) {
    if (roots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    roots.push(path);
  }
  return roots;
}

function buildRecoveryEntries(): EditorProjectState['recovery'] {
  const projectState = useProjectStore.getState();
  const current = projectState.document;
  const saved = projectState.savedDocument;
  if (!current || !saved) return { sequence: 0, saveUnitsById: {} };

  const pathsByUnit = new Map<string, Set<string>>();
  const atomicGroupsByUnit = new Map<string, Set<string>>();
  const sequenceByUnit = new Map<string, number>();
  let sequence = recoveryContext.editorState.recovery.sequence;
  for (const [saveUnitId, entry] of Object.entries(
    recoveryContext.editorState.recovery.saveUnitsById,
  )) {
    pathsByUnit.set(saveUnitId, new Set(entry.affectedPaths));
    atomicGroupsByUnit.set(saveUnitId, new Set(entry.atomicTransactionGroupIds));
    sequenceByUnit.set(saveUnitId, entry.sequence);
    sequence = Math.max(sequence, entry.sequence);
  }

  const pendingInputsBySaveUnitId = serializePendingInputs(usePendingInputStore.getState());
  for (const [saveUnitId, pendingByPath] of Object.entries(pendingInputsBySaveUnitId)) {
    const paths = pathsByUnit.get(saveUnitId) ?? new Set<string>();
    for (const path of Object.keys(pendingByPath)) paths.add(path);
    pathsByUnit.set(saveUnitId, paths);
    if (!sequenceByUnit.has(saveUnitId)) sequenceByUnit.set(saveUnitId, ++sequence);
  }

  for (const repair of recoveryContext.repairs) {
    const saveUnitId = contentSaveUnitForPath(repair.path);
    const paths = pathsByUnit.get(saveUnitId) ?? new Set<string>();
    paths.add(repair.path);
    pathsByUnit.set(saveUnitId, paths);
    if (!sequenceByUnit.has(saveUnitId)) sequenceByUnit.set(saveUnitId, ++sequence);
  }

  const history = useCommandStore.getState().history;
  for (const [index, entry] of history.entries.slice(0, history.cursor + 1).entries()) {
    const paths = pathsByUnit.get(entry.originSaveUnitId) ?? new Set<string>();
    for (const path of entry.affectedPaths) paths.add(path);
    pathsByUnit.set(entry.originSaveUnitId, paths);
    if (entry.atomicTransactionGroupId) {
      const groups = atomicGroupsByUnit.get(entry.originSaveUnitId) ?? new Set<string>();
      groups.add(entry.atomicTransactionGroupId);
      atomicGroupsByUnit.set(entry.originSaveUnitId, groups);
    }
    sequenceByUnit.set(
      entry.originSaveUnitId,
      Math.max(sequenceByUnit.get(entry.originSaveUnitId) ?? 0, sequence + index + 1),
    );
  }
  sequence += Math.max(0, history.cursor + 1);

  const workbench = useWorkbenchStore.getState();
  for (const tab of Object.values(workbench.tabsById)) {
    const resolution = resolveSaveUnitForTab(tab, current);
    if (resolution.status !== 'savable') continue;
    const paths = pathsByUnit.get(resolution.descriptor.id) ?? new Set<string>();
    for (const path of resolution.descriptor.ownedPaths) paths.add(path);
    pathsByUnit.set(resolution.descriptor.id, paths);
  }

  const saveUnitsById: Record<string, EditorRecoverySaveUnit> = {};
  for (const [saveUnitId, affectedPathSet] of [...pathsByUnit.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const affectedPaths = [...affectedPathSet]
      .filter((path) => path.startsWith('/') && path !== '/editor' && !path.startsWith('/editor/'))
      .sort();
    const patches = canonicalRecoveryRoots(affectedPaths)
      .map((path) => patchForPath(saved, current, path))
      .filter((patch): patch is EditorRecoveryPatch => patch !== null);
    const pendingRawInputByPath = pendingInputsBySaveUnitId[saveUnitId] ?? {};
    if (patches.length === 0 && Object.keys(pendingRawInputByPath).length === 0) continue;
    saveUnitsById[saveUnitId] = {
      sequence: sequenceByUnit.get(saveUnitId) ?? ++sequence,
      patches,
      affectedPaths,
      pendingRawInputByPath,
      atomicTransactionGroupIds: [...(atomicGroupsByUnit.get(saveUnitId) ?? [])].sort(),
    };
  }
  return { sequence, saveUnitsById };
}

export function buildEditorProjectStateSnapshot(
  options: { includeRecovery?: boolean } = {},
): EditorProjectState {
  const workbench = useWorkbenchStore.getState().serializeProjectWorkbench();
  const draftsByKey = serializeDraftDirtyState(useDraftDirtyStore.getState());
  const explorerStore = useProjectExplorerStore.getState();
  const currentEditorState = editorProjectStateFromProject(useProjectStore.getState().document);
  const tabStatesById = serializeWorkbenchTabStates(Object.keys(workbench?.tabsById ?? {}));
  return {
    ...emptyEditorProjectState(recoveryContext.editorState.contentFingerprint),
    contentFingerprint: recoveryContext.editorState.contentFingerprint,
    recovery:
      options.includeRecovery === false
        ? { sequence: 0, saveUnitsById: {} }
        : buildRecoveryEntries(),
    ...((currentEditorState.lastSuccessfulPlatformExportIdentity ??
    recoveryContext.editorState.lastSuccessfulPlatformExportIdentity)
      ? {
          lastSuccessfulPlatformExportIdentity:
            currentEditorState.lastSuccessfulPlatformExportIdentity ??
            recoveryContext.editorState.lastSuccessfulPlatformExportIdentity,
        }
      : {}),
    workbench: workbench ?? undefined,
    explorer: explorerStore.serializeExplorer(),
    chapters: explorerStore.serializeChapters(),
    tags: currentEditorState.tags,
    recordMetadata: currentEditorState.recordMetadata,
    bottomPanel: useBottomPanelStore.getState().serialize(),
    tabStatesById,
    draftsByKey,
  };
}

export function mergeEditorProjectState(
  project: JsonValue,
  editorState: EditorProjectState,
): JsonValue {
  return mergeContentAndEditorState(project, editorState);
}

export function editorProjectStateFromProject(project: unknown): EditorProjectState {
  if (typeof project !== 'object' || project === null || Array.isArray(project))
    return emptyEditorProjectState();
  return parseEditorProjectState((project as Record<string, unknown>).editor);
}

export function setLoadedEditorProjectState(
  editorState: EditorProjectState,
  repairs: readonly AuthoringEnumRepair[] = [],
) {
  recoveryContext = { editorState: cloneSerializable(editorState), repairs: [...repairs] };
  usePendingInputStore.getState().hydratePendingInputs(editorState.recovery);
}

export function discardLoadedRecoverySaveUnits(saveUnitIds: Iterable<string>) {
  const discarded = new Set(saveUnitIds);
  if (discarded.size === 0) return;
  for (const saveUnitId of discarded)
    usePendingInputStore.getState().clearPendingInputsForSaveUnit(saveUnitId);
  recoveryContext = {
    ...recoveryContext,
    editorState: {
      ...recoveryContext.editorState,
      recovery: {
        ...recoveryContext.editorState.recovery,
        saveUnitsById: Object.fromEntries(
          Object.entries(recoveryContext.editorState.recovery.saveUnitsById).filter(
            ([saveUnitId]) => !discarded.has(saveUnitId),
          ),
        ),
      },
    },
  };
}

export function markEditorRecoveryCommitted(contentFingerprint: string) {
  usePendingInputStore.getState().resetPendingInputs();
  recoveryContext = {
    editorState: {
      ...recoveryContext.editorState,
      contentFingerprint,
      recovery: { sequence: 0, saveUnitsById: {} },
    },
    repairs: [],
  };
}

export function saveLocalEditorSessionSnapshot(projectFilePath: string | null) {
  useLocalEditorSessionStore
    .getState()
    .saveShellWorkbench(projectFilePath, useWorkbenchStore.getState().serializeShellWorkbench());
}

export function clearLocalEditorSessionSnapshot() {
  useLocalEditorSessionStore.getState().clearShellWorkbench();
}

export function restoreNoProjectEditorSession() {
  const localShellSession = useLocalEditorSessionStore.getState().shellSession;
  if (localShellSession?.projectFilePath !== null) return;
  useWorkbenchStore
    .getState()
    .restoreShellWorkbench(localShellSession.shellWorkbench, {}, createInitialWorkbenchState());
}

export function restoreEditorProjectState(
  project: JsonValue,
  projectFilePath: string | null,
  editorStateOverride?: EditorProjectState,
) {
  const editorState = editorStateOverride ?? editorProjectStateFromProject(project);
  usePendingInputStore.getState().hydratePendingInputs(editorState.recovery);
  const projectWorkbench = useWorkbenchStore
    .getState()
    .restoreProjectWorkbench(editorState.workbench, project);
  useProjectExplorerStore.getState().hydrate(editorState.explorer, editorState.chapters);
  useBottomPanelStore.getState().hydrate(editorState.bottomPanel);
  useDraftDirtyStore.getState().restoreSerializedDrafts(editorState.draftsByKey ?? {});
  const localShellSession = useLocalEditorSessionStore.getState().shellSession;
  if (localShellSession?.projectFilePath === projectFilePath) {
    useWorkbenchStore
      .getState()
      .restoreShellWorkbench(localShellSession.shellWorkbench, project, projectWorkbench);
  }
  const restoredWorkbench = useWorkbenchStore.getState();
  restoreSerializedWorkbenchTabStates(
    Object.fromEntries(
      Object.entries(editorState.tabStatesById ?? {}).filter(
        ([tabId]) => !!restoredWorkbench.tabsById[tabId],
      ),
    ),
  );
}

export function repairOperationsForTests(repairs: readonly AuthoringEnumRepair[]) {
  return repairPatches(repairs);
}
