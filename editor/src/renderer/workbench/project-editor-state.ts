import { useCommandStore } from '@/commands/command-store';
import { getJsonAtPointer, hasJsonAtPointer, parseJsonPointer } from '@/project/json-pointer';
import { applyJsonPatch, type JsonPatchOperation } from '@/project/json-patch';
import { cloneJsonValue, jsonValuesEqual, type JsonValue } from '@/project/json-value';
import {
  PROJECT_SETTINGS_SAVE_UNIT_ID,
  SAVE_UNIT_IDS,
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
  isTrackedEditorProjectStatePath,
  parseEditorProjectState,
  type EditorProjectState,
  type EditorRecoveryExternalConflict,
  type EditorRecoveryPatch,
  type EditorRecoverySaveUnit,
} from '../../shared/project-schema/editor-project-state';
import type { AuthoringEnumRepair } from '../../shared/project-schema/decode-authoring-project';
import { isAuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
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
  editorState: EditorProjectState;
  diagnostics: ProjectValidationDiagnostic[];
}

export interface ReconstructEditorProjectOptions {
  recoveryBaselineWorkspaceRevision?: string | null;
  currentWorkspaceRevision?: string | null;
  currentFileRevisions?: Readonly<Record<string, `sha256:${string}`>>;
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
  const root = segments[0] ?? '';
  if (['project', 'settings', 'startupHook', 'entrypoint'].includes(root))
    return PROJECT_SETTINGS_SAVE_UNIT_ID;
  if (root === 'properties') return 'project:properties';
  if (root === 'localization') return 'project:localization';
  if (root === 'editor') {
    if (segments[1] === 'chapters') return SAVE_UNIT_IDS.projectChapters;
    if (segments[1] === 'tags') return SAVE_UNIT_IDS.projectTags;
    if (segments[1] === 'recordMetadata' && segments[2])
      return segments[3] ? recordSaveUnitId(segments[2], segments[3]) : `collection:${segments[2]}`;
    return `project:path:${segments.slice(0, 2).join(':')}`;
  }
  if (isAuthoringCollectionKey(root))
    return segments[1] ? recordSaveUnitId(root, segments[1]) : `collection:${root}`;
  return `project:path:${root || 'root'}`;
}

function manualSaveUnitForHistoryPath(originSaveUnitId: string, path: string): string {
  if (originSaveUnitId.startsWith('workflow:')) return originSaveUnitId;
  const segments = parseJsonPointer(path);
  const recordMatch = originSaveUnitId.match(/^record:([^:]+):(.+)$/);
  if (recordMatch) {
    const [, collection, entityId] = recordMatch;
    if (
      (segments[0] === collection && segments[1] === entityId) ||
      (segments[0] === 'editor' &&
        segments[1] === 'recordMetadata' &&
        segments[2] === collection &&
        segments[3] === entityId)
    )
      return originSaveUnitId;
  }
  const collectionMatch = originSaveUnitId.match(/^collection:([^:]+)$/);
  if (collectionMatch) {
    const collection = collectionMatch[1]!;
    if (
      segments[0] === collection ||
      (segments[0] === 'editor' && segments[1] === 'recordMetadata' && segments[2] === collection)
    )
      return originSaveUnitId;
  }
  const mapped = contentSaveUnitForPath(path);
  return mapped.startsWith('project:path:') ? originSaveUnitId : mapped;
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

function staleRecoveryDiagnostic(paths: readonly string[]): ProjectValidationDiagnostic {
  const path = paths[0] ?? '/';
  return createProjectValidationDiagnostic({
    code: 'editor.recovery.baseline-changed',
    severity: 'warning',
    category: 'Project recovery',
    path,
    message:
      'Recovered unsaved edits were created against an older workspace revision. Choose Use Disk or Keep Mine before saving the affected item.',
    boundaries: ['authoring'],
    ownerPaths: paths.length > 0 ? [...paths] : ['/'],
  });
}

function mergeContentAndEditorState(
  content: JsonValue,
  editorState: EditorProjectState,
): JsonValue {
  const cloned = cloneJsonValue(content);
  if (!isObject(cloned)) return cloned;
  return { ...cloned, editor: cloneSerializable(editorState) as JsonValue };
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
  options: ReconstructEditorProjectOptions = {},
): ReconstructedEditorProject {
  let savedDocument = mergeContentAndEditorState(savedContentProject, editorState);
  let workingDocument = mergeContentAndEditorState(decodedContentProject, editorState);
  const diagnostics: ProjectValidationDiagnostic[] = [];
  const entries = Object.entries(editorState.recovery.saveUnitsById).sort(
    ([leftId, left], [rightId, right]) =>
      left.sequence - right.sequence || leftId.localeCompare(rightId),
  );
  const appliedSaveUnitIds = new Set<string>();
  for (const [saveUnitId, entry] of entries) {
    try {
      workingDocument = applyJsonPatch(
        workingDocument,
        entry.patches as JsonPatchOperation[],
      ).document;
      appliedSaveUnitIds.add(saveUnitId);
    } catch (error) {
      diagnostics.push(
        recoveryApplyDiagnostic(
          saveUnitId,
          error instanceof Error ? error.message : 'Recovery patch could not be applied.',
        ),
      );
    }
  }

  const effectiveRecovery = cloneSerializable(editorState.recovery);
  const recoveryBaselineChanged =
    options.recoveryBaselineWorkspaceRevision !== undefined &&
    options.recoveryBaselineWorkspaceRevision !== null &&
    options.currentWorkspaceRevision !== undefined &&
    options.currentWorkspaceRevision !== null &&
    options.recoveryBaselineWorkspaceRevision !== options.currentWorkspaceRevision;
  if (recoveryBaselineChanged) {
    const stalePaths = new Set<string>();
    for (const [saveUnitId, entry] of Object.entries(effectiveRecovery.saveUnitsById)) {
      if (
        !appliedSaveUnitIds.has(saveUnitId) ||
        entry.patches.length === 0 ||
        entry.externalConflict
      )
        continue;
      const paths = canonicalRecoveryRoots([
        ...entry.affectedPaths,
        ...entry.patches.map((patch) => patch.path),
      ]);
      if (paths.length === 0) continue;
      paths.forEach((path) => stalePaths.add(path));
      const baseValueByPath: EditorRecoveryExternalConflict['baseValueByPath'] = {};
      const localValueByPath: EditorRecoveryExternalConflict['localValueByPath'] = {};
      const externalValueByPath: EditorRecoveryExternalConflict['externalValueByPath'] = {};
      for (const path of paths) {
        const disk = readOptional(savedDocument, path);
        const local = readOptional(workingDocument, path);
        baseValueByPath[path] = disk.exists
          ? { exists: true, value: disk.value }
          : { exists: false };
        externalValueByPath[path] = disk.exists
          ? { exists: true, value: disk.value }
          : { exists: false };
        localValueByPath[path] = local.exists
          ? { exists: true, value: local.value }
          : { exists: false };
      }
      entry.externalConflict = {
        baseValueByPath,
        localValueByPath,
        externalValueByPath,
        conflictingPaths: paths,
        externalWorkspaceRevision: options.currentWorkspaceRevision as `sha256:${string}`,
        externalFileRevisions: { ...options.currentFileRevisions },
      };
    }
    if (stalePaths.size > 0) diagnostics.push(staleRecoveryDiagnostic([...stalePaths].sort()));
  }

  const effectiveEditorState: EditorProjectState = {
    ...editorState,
    recovery: effectiveRecovery,
  };
  const savedTracked = parseEditorProjectState(
    isObject(savedDocument) ? savedDocument.editor : undefined,
  );
  const workingTracked = parseEditorProjectState(
    isObject(workingDocument) ? workingDocument.editor : undefined,
  );
  const savedEditorState: EditorProjectState = {
    ...effectiveEditorState,
    chapters: savedTracked.chapters,
    tags: savedTracked.tags,
    recordMetadata: savedTracked.recordMetadata,
  };
  const workingEditorState: EditorProjectState = {
    ...effectiveEditorState,
    chapters: workingTracked.chapters,
    tags: workingTracked.tags,
    recordMetadata: workingTracked.recordMetadata,
  };
  savedDocument = mergeContentAndEditorState(savedDocument, savedEditorState);
  workingDocument = mergeContentAndEditorState(workingDocument, workingEditorState);
  recoveryContext = {
    editorState: cloneSerializable(workingEditorState),
    repairs: [...repairs],
  };
  usePendingInputStore.getState().hydratePendingInputs(effectiveRecovery);
  return { savedDocument, workingDocument, editorState: workingEditorState, diagnostics };
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

function recoveryPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalRecoveryRoots(paths: readonly string[]): string[] {
  const canonical = [...new Set(paths)]
    .filter(
      (path) =>
        path.startsWith('/') &&
        path !== '/editor' &&
        (!path.startsWith('/editor/') || isTrackedEditorProjectStatePath(path)),
    )
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
    const attributedSaveUnitIds = new Set<string>();
    for (const path of entry.affectedPaths) {
      const saveUnitId =
        entry.persistencePolicy === 'manual-save'
          ? manualSaveUnitForHistoryPath(entry.originSaveUnitId, path)
          : entry.originSaveUnitId;
      const paths = pathsByUnit.get(saveUnitId) ?? new Set<string>();
      paths.add(path);
      pathsByUnit.set(saveUnitId, paths);
      attributedSaveUnitIds.add(saveUnitId);
    }
    for (const saveUnitId of attributedSaveUnitIds) {
      if (entry.atomicTransactionGroupId) {
        const groups = atomicGroupsByUnit.get(saveUnitId) ?? new Set<string>();
        groups.add(entry.atomicTransactionGroupId);
        atomicGroupsByUnit.set(saveUnitId, groups);
      }
      sequenceByUnit.set(
        saveUnitId,
        Math.max(sequenceByUnit.get(saveUnitId) ?? 0, sequence + index + 1),
      );
    }
  }
  sequence += Math.max(0, history.cursor + 1);

  const workbench = useWorkbenchStore.getState();
  for (const tab of Object.values(workbench.tabsById)) {
    const resolution = resolveSaveUnitForTab(tab, current);
    if (resolution.status !== 'savable') continue;
    const paths = pathsByUnit.get(resolution.descriptor.id) ?? new Set<string>();
    for (const path of resolution.descriptor.ownedPaths) {
      const ownedByAnotherUnit = [...pathsByUnit.entries()].some(
        ([saveUnitId, ownedPaths]) =>
          saveUnitId !== resolution.descriptor.id &&
          [...ownedPaths].some((ownedPath) => recoveryPathsOverlap(path, ownedPath)),
      );
      if (!ownedByAnotherUnit) paths.add(path);
    }
    if (paths.size > 0) pathsByUnit.set(resolution.descriptor.id, paths);
  }

  const saveUnitsById: Record<string, EditorRecoverySaveUnit> = {};
  for (const [saveUnitId, affectedPathSet] of [...pathsByUnit.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const affectedPaths = [...affectedPathSet]
      .filter(
        (path) =>
          path.startsWith('/') &&
          path !== '/editor' &&
          (!path.startsWith('/editor/') || isTrackedEditorProjectStatePath(path)),
      )
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
      ...(recoveryContext.editorState.recovery.saveUnitsById[saveUnitId]?.externalConflict
        ? {
            externalConflict:
              recoveryContext.editorState.recovery.saveUnitsById[saveUnitId]!.externalConflict,
          }
        : {}),
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
    ...emptyEditorProjectState(),
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

export function markEditorRecoveryCommitted() {
  usePendingInputStore.getState().resetPendingInputs();
  recoveryContext = {
    editorState: {
      ...recoveryContext.editorState,
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
