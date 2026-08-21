import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import type { JsonPointer } from './json-pointer';
import { cloneJsonValue, jsonValuesEqual, toJsonValue, type JsonValue } from './json-value';
import { resolveSaveUnitForTab } from './save-unit-registry';
import type { SaveUnitId } from './save-unit-types';
import { useProjectStore } from './project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import { useCommandStore } from '@/commands/command-store';
import {
  buildEditorProjectStateSnapshot,
  editorProjectStateFromProject,
  mergeEditorProjectState,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import type {
  EditorProjectState,
  EditorRecoverySaveUnit,
  EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import {
  stripEditorProjectState,
  stripLocalEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import { decodeAuthoringProject } from '../../shared/project-schema/decode-authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { validateProjectSettingsAuthoringState } from '../../shared/project-schema/authoring-project-settings';
import {
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  projectValidationDiagnosticKey,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import type { SaveProjectResponse, ToolDiagnostic } from '../../shared/editor-tooling';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  diffJsonDocuments,
  reconcileExternalProjectChange,
} from './project-external-reconciliation';
import { rebaseRecoveryOverlays } from './project-recovery-rebase';

export type ProjectSaveCoordinatorStatus =
  | 'saved'
  | 'partially-saved'
  | 'nothing-to-save'
  | 'blocked'
  | 'cancelled'
  | 'failed';

export interface ProjectSaveCoordinatorResult {
  success: boolean;
  status: ProjectSaveCoordinatorStatus;
  diagnostics: ToolDiagnostic[];
  savedSaveUnitIds: SaveUnitId[];
  remainingDirtySaveUnitIds: SaveUnitId[];
  dependencySaveUnitIds?: SaveUnitId[];
  response?: SaveProjectResponse;
}

interface SaveComponent {
  ids: SaveUnitId[];
  entries: Array<[SaveUnitId, EditorRecoverySaveUnit]>;
  paths: JsonPointer[];
}

function pathOverlaps(left: string, right: string): boolean {
  if (left === '/' || right === '/') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function authoringDiagnostics(document: JsonValue): ProjectValidationDiagnostic[] {
  const decoded = decodeAuthoringProject(stripLocalEditorProjectState(document));
  if (!decoded.project) return collectProjectValidationDiagnostics(decoded.structuralDiagnostics);
  const supplementalSettingsDiagnostics = validateProjectSettingsAuthoringState(
    decoded.project,
  ).filter(
    (diagnostic) =>
      !decoded.semanticDiagnostics.some(
        (existing) =>
          existing.path === diagnostic.path &&
          existing.severity === diagnostic.severity &&
          existing.message === diagnostic.message,
      ),
  );
  return collectProjectValidationDiagnostics(
    decoded.semanticDiagnostics,
    validateAuthoringProject(decoded.project),
    supplementalSettingsDiagnostics,
  );
}

function authoringErrors(diagnostics: readonly ProjectValidationDiagnostic[]) {
  return diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error' && diagnostic.boundaries.includes('authoring'),
  );
}

function orderedEntries(
  recovery: EditorRecoveryState,
  selectedIds?: ReadonlySet<SaveUnitId>,
): Array<[SaveUnitId, EditorRecoverySaveUnit]> {
  return Object.entries(recovery.saveUnitsById)
    .filter(([saveUnitId]) => !selectedIds || selectedIds.has(saveUnitId))
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.sequence - right.sequence || leftId.localeCompare(rightId),
    );
}

export function buildCandidateForSaveUnitIds(
  savedDocument: JsonValue,
  recovery: EditorRecoveryState,
  selectedIds: ReadonlySet<SaveUnitId>,
): JsonValue {
  let candidate = cloneJsonValue(stripLocalEditorProjectState(savedDocument) as JsonValue);
  for (const [, entry] of orderedEntries(recovery, selectedIds)) {
    candidate = applyJsonPatch(candidate, entry.patches as JsonPatchOperation[]).document;
  }
  return candidate;
}

function componentPaths(entries: Array<[SaveUnitId, EditorRecoverySaveUnit]>): JsonPointer[] {
  return uniqueSorted(entries.flatMap(([, entry]) => entry.affectedPaths)) as JsonPointer[];
}

function diagnosticOwnedByPaths(
  diagnostic: ProjectValidationDiagnostic,
  paths: readonly JsonPointer[],
): boolean {
  return diagnostic.ownerPaths.some((ownerPath) =>
    paths.some((path) => pathOverlaps(ownerPath, path)),
  );
}

function selectedBlockingDiagnostics(
  baselineDiagnostics: readonly ProjectValidationDiagnostic[],
  candidateDiagnostics: readonly ProjectValidationDiagnostic[],
  selectedPaths: readonly JsonPointer[],
): ProjectValidationDiagnostic[] {
  const baselineKeys = new Set(
    authoringErrors(baselineDiagnostics).map(projectValidationDiagnosticKey),
  );
  return authoringErrors(candidateDiagnostics).filter(
    (diagnostic) =>
      diagnosticOwnedByPaths(diagnostic, selectedPaths) ||
      !baselineKeys.has(projectValidationDiagnosticKey(diagnostic)),
  );
}

function pendingInputDiagnostic(saveUnitId: SaveUnitId, path: string): ProjectValidationDiagnostic {
  return createProjectValidationDiagnostic({
    code: 'editor.save.pending-input',
    severity: 'error',
    category: 'Project save',
    path,
    message:
      'This save unit contains invalid pending input. Correct or discard the value before saving.',
    boundaries: ['authoring'],
    ownerPaths: [path],
  });
}

function externalConflictSaveDiagnostic(
  saveUnitId: SaveUnitId,
  entry: EditorRecoverySaveUnit,
): ProjectValidationDiagnostic {
  const conflict = entry.externalConflict!;
  const path = conflict.conflictingPaths[0] ?? entry.affectedPaths[0] ?? '/';
  return createProjectValidationDiagnostic({
    code: 'editor.external-change.conflict',
    severity: 'error',
    category: 'External changes',
    path,
    message: `External changes conflict with unsaved edits in '${saveUnitId}'. Choose Use Disk or Keep Mine before saving this item.`,
    boundaries: ['authoring'],
    ownerPaths: conflict.conflictingPaths.length > 0 ? conflict.conflictingPaths : [path],
  });
}

function dependencyDiagnostic(
  activeSaveUnitId: SaveUnitId,
  dependencyIds: readonly SaveUnitId[],
  recovery: EditorRecoveryState,
): ProjectValidationDiagnostic {
  const firstDependency = dependencyIds[0]!;
  const ownerPath = recovery.saveUnitsById[firstDependency]?.affectedPaths[0] ?? '/';
  return createProjectValidationDiagnostic({
    code: 'editor.save.dependency-dirty',
    severity: 'error',
    category: 'Project save',
    path: ownerPath,
    message: `Saving '${activeSaveUnitId}' requires unsaved ${dependencyIds.length === 1 ? 'dependency' : 'dependencies'} ${dependencyIds.join(', ')}. Save the dependency first or use Save All.`,
    boundaries: ['authoring'],
    ownerPaths: [ownerPath],
  });
}

function activeTab() {
  const workbench = useWorkbenchStore.getState();
  const group = workbench.groupsById[workbench.activeGroupId];
  return group?.activeTabId ? workbench.tabsById[group.activeTabId] : undefined;
}

function projectAssetPaths(document: JsonValue): string[] {
  const content = stripEditorProjectState(document);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const assets = (content as Record<string, unknown>).assets;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return [];
  const paths = new Set<string>();
  for (const record of Object.values(assets)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const data = parseAssetData((record as Record<string, unknown>).data);
    if (data?.source.path) paths.add(data.source.path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function atomicClosure(recovery: EditorRecoveryState, initialId: SaveUnitId): Set<SaveUnitId> {
  const selected = new Set<SaveUnitId>([initialId]);
  let changed = true;
  while (changed) {
    changed = false;
    const groups = new Set(
      [...selected].flatMap(
        (saveUnitId) => recovery.saveUnitsById[saveUnitId]?.atomicTransactionGroupIds ?? [],
      ),
    );
    for (const [saveUnitId, entry] of Object.entries(recovery.saveUnitsById)) {
      if (
        !selected.has(saveUnitId) &&
        entry.atomicTransactionGroupIds.some((groupId) => groups.has(groupId))
      ) {
        selected.add(saveUnitId);
        changed = true;
      }
    }
  }
  return selected;
}

function dirtyDependencyIds(
  savedDocument: JsonValue,
  recovery: EditorRecoveryState,
  selectedIds: ReadonlySet<SaveUnitId>,
  blocking: readonly ProjectValidationDiagnostic[],
): SaveUnitId[] {
  if (blocking.length === 0) return [];
  const blockingKeys = new Set(blocking.map(projectValidationDiagnosticKey));
  const dependencies: SaveUnitId[] = [];
  for (const saveUnitId of Object.keys(recovery.saveUnitsById).sort()) {
    if (selectedIds.has(saveUnitId)) continue;
    try {
      const withDependency = new Set([...selectedIds, saveUnitId]);
      const diagnostics = authoringDiagnostics(
        buildCandidateForSaveUnitIds(savedDocument, recovery, withDependency),
      );
      const keys = new Set(authoringErrors(diagnostics).map(projectValidationDiagnosticKey));
      if ([...blockingKeys].some((key) => !keys.has(key))) dependencies.push(saveUnitId);
    } catch {
      // A dependency candidate that cannot apply cannot make the active candidate safe.
    }
  }
  return dependencies;
}

function editorStateForContentCandidate(
  snapshot: EditorProjectState,
  candidateContent: JsonValue,
  recovery: EditorRecoveryState,
): EditorProjectState {
  const tracked = editorProjectStateFromProject(candidateContent);
  return {
    ...snapshot,
    chapters: tracked.chapters,
    tags: tracked.tags,
    recordMetadata: tracked.recordMetadata,
    recovery,
  };
}

async function commitSelectedSaveUnits(
  selectedIds: Set<SaveUnitId>,
  snapshot: EditorProjectState,
  candidateContent: JsonValue,
): Promise<ProjectSaveCoordinatorResult> {
  const projectState = useProjectStore.getState();
  const currentDocument = projectState.document;
  const projectFilePath = projectState.projectFilePath;
  const projectSessionId = projectState.projectSessionId;
  const workspaceRevision = projectState.workspaceRevision;
  if (
    !currentDocument ||
    !projectState.savedDocument ||
    !projectFilePath ||
    !projectSessionId ||
    !workspaceRevision
  ) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById),
    };
  }

  const rebasedRecovery = rebaseRecoveryOverlays(
    snapshot.recovery,
    candidateContent,
    currentDocument,
    selectedIds,
  );
  const editorStateForWrite = editorStateForContentCandidate(
    snapshot,
    candidateContent,
    rebasedRecovery,
  );
  const selectedChangedPaths = diffJsonDocuments(
    stripLocalEditorProjectState(projectState.savedDocument) as JsonValue,
    candidateContent,
  ).map((patch) => patch.path);
  useProjectStore.getState().setSaving(true);
  const response = await window.noveltea.saveProjectContent(
    projectSessionId,
    workspaceRevision,
    candidateContent,
    editorStateForWrite,
    projectState.scriptSourcePaths,
    {
      expectedFileRevisions: { ...projectState.fileRevisions },
      saveUnitIds: [...selectedIds].sort(),
      baselineProject: projectState.savedDocument,
      affectedPaths: selectedChangedPaths,
      operationLabel: 'editor save',
    },
  );
  if (!response.success) {
    useProjectStore.getState().setSaveError(response.error ?? 'Project save failed.');
    return {
      success: false,
      status: 'failed',
      diagnostics: response.diagnostics ?? [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
      response,
    };
  }

  const authoritativeEditorState = response.editorState ?? editorStateForWrite;
  const authoritativeDiskDocument = mergeEditorProjectState(
    response.contentProject ? toJsonValue(response.contentProject) : candidateContent,
    authoritativeEditorState,
  );
  const authoritativeWorkspaceRevision = (response.workspaceRevision ??
    workspaceRevision) as `sha256:${string}`;
  const authoritativeFileRevisions = response.fileRevisions ?? projectState.fileRevisions;
  const authoritativeScriptSourcePaths =
    response.scriptSourcePaths ?? projectState.scriptSourcePaths;
  const postSave = reconcileExternalProjectChange({
    baseDocument: projectState.savedDocument,
    localDocument: currentDocument,
    externalDocument: authoritativeDiskDocument,
    recovery: rebasedRecovery,
    externalWorkspaceRevision: authoritativeWorkspaceRevision,
    externalFileRevisions: authoritativeFileRevisions,
  });
  const workingEditorState = editorStateForContentCandidate(
    authoritativeEditorState,
    postSave.workingDocument,
    postSave.recovery,
  );
  const savedEditorState = editorStateForContentCandidate(
    authoritativeEditorState,
    postSave.savedDocument,
    postSave.recovery,
  );
  const workingDocument = mergeEditorProjectState(postSave.workingDocument, workingEditorState);
  const savedDocument = mergeEditorProjectState(postSave.savedDocument, savedEditorState);
  const workingContentChanged = !jsonValuesEqual(
    stripLocalEditorProjectState(currentDocument) as JsonValue,
    stripLocalEditorProjectState(workingDocument) as JsonValue,
  );
  if (workingContentChanged) {
    const published = useProjectStore.getState().publishExternalReconciliation({
      document: workingDocument,
      savedDocument,
      workspaceRevision: authoritativeWorkspaceRevision,
      fileRevisions: authoritativeFileRevisions,
      scriptSourcePaths: authoritativeScriptSourcePaths,
      affectedPaths: postSave.externalChangedPaths,
    });
    if (!published) {
      useProjectStore.getState().setSaveError('Saved workspace could not be published.');
      return {
        success: false,
        status: 'failed',
        diagnostics: response.diagnostics ?? [],
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
        response,
      };
    }
    useProjectStore.getState().setSaving(false);
  } else {
    useProjectStore.getState().markSaved({
      document: savedDocument,
      projectPath: response.projectPath,
      projectFilePath: response.projectFilePath,
      workspaceRevision: authoritativeWorkspaceRevision,
      fileRevisions: authoritativeFileRevisions,
      scriptSourcePaths: authoritativeScriptSourcePaths,
    });
  }
  setLoadedEditorProjectState(workingEditorState);
  useProjectStore.getState().markEditorMetadataPersisted(workingEditorState);
  const conflictDiagnostics = Object.entries(postSave.recovery.saveUnitsById)
    .filter(([, entry]) => entry.externalConflict)
    .map(([saveUnitId, entry]) => externalConflictSaveDiagnostic(saveUnitId, entry));
  const diagnostics = [...(response.diagnostics ?? []), ...conflictDiagnostics];
  return {
    success: true,
    status: Object.keys(postSave.recovery.saveUnitsById).length > 0 ? 'partially-saved' : 'saved',
    diagnostics,
    savedSaveUnitIds: [...selectedIds].sort(),
    remainingDirtySaveUnitIds: Object.keys(postSave.recovery.saveUnitsById).sort(),
    response,
  };
}

export async function saveActiveSaveUnit(
  explicitSaveUnitId?: SaveUnitId,
  options: { allowExternalConflict?: boolean } = {},
): Promise<ProjectSaveCoordinatorResult> {
  const projectState = useProjectStore.getState();
  const tab = activeTab();
  const resolution = tab
    ? resolveSaveUnitForTab(tab, projectState.document)
    : explicitSaveUnitId
      ? null
      : undefined;
  const saveUnitId =
    explicitSaveUnitId ?? (resolution?.status === 'savable' ? resolution.descriptor.id : null);
  if (!saveUnitId || resolution?.status === 'non-content') {
    return {
      success: true,
      status: 'nothing-to-save',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  }
  if (!projectState.document || !projectState.savedDocument || !projectState.projectFilePath) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  }

  const snapshot = buildEditorProjectStateSnapshot();
  const activeEntry = snapshot.recovery.saveUnitsById[saveUnitId];
  if (!activeEntry) {
    return {
      success: true,
      status: 'nothing-to-save',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }
  const selectedIds = atomicClosure(snapshot.recovery, saveUnitId);
  const selectedEntries = orderedEntries(snapshot.recovery, selectedIds);
  const selectedPaths = componentPaths(selectedEntries);
  const conflictDiagnostics = selectedEntries
    .filter(([, entry]) => entry.externalConflict)
    .map(([selectedSaveUnitId, entry]) =>
      externalConflictSaveDiagnostic(selectedSaveUnitId, entry),
    );
  if (conflictDiagnostics.length > 0 && !options.allowExternalConflict) {
    return {
      success: false,
      status: 'blocked',
      diagnostics: conflictDiagnostics,
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }
  const pendingDiagnostics = selectedEntries.flatMap(([, entry]) =>
    Object.keys(entry.pendingRawInputByPath).map((path) =>
      pendingInputDiagnostic(saveUnitId, path),
    ),
  );
  if (pendingDiagnostics.length > 0) {
    return {
      success: false,
      status: 'blocked',
      diagnostics: pendingDiagnostics,
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }

  try {
    const baselineDiagnostics = authoringDiagnostics(projectState.savedDocument);
    const candidateContent = buildCandidateForSaveUnitIds(
      projectState.savedDocument,
      snapshot.recovery,
      selectedIds,
    );
    const candidateDiagnostics = authoringDiagnostics(candidateContent);
    const blocking = selectedBlockingDiagnostics(
      baselineDiagnostics,
      candidateDiagnostics,
      selectedPaths,
    );
    if (blocking.length > 0) {
      const dependencies = dirtyDependencyIds(
        projectState.savedDocument,
        snapshot.recovery,
        selectedIds,
        blocking,
      );
      if (dependencies.length > 0) {
        const diagnostic = dependencyDiagnostic(saveUnitId, dependencies, snapshot.recovery);
        return {
          success: false,
          status: 'blocked',
          diagnostics: [diagnostic, ...blocking],
          savedSaveUnitIds: [],
          remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
          dependencySaveUnitIds: dependencies,
        };
      }
      return {
        success: false,
        status: 'blocked',
        diagnostics: blocking,
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
      };
    }
    return await commitSelectedSaveUnits(selectedIds, snapshot, candidateContent);
  } catch (error) {
    const diagnostic = createProjectValidationDiagnostic({
      code: 'editor.save.candidate-failed',
      severity: 'error',
      category: 'Project save',
      path: selectedPaths[0] ?? '/',
      message: error instanceof Error ? error.message : 'The save candidate could not be built.',
      boundaries: ['authoring'],
      ownerPaths: selectedPaths.length > 0 ? selectedPaths : ['/'],
    });
    return {
      success: false,
      status: 'failed',
      diagnostics: [diagnostic],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }
}

function atomicComponents(recovery: EditorRecoveryState): SaveComponent[] {
  const ids = Object.keys(recovery.saveUnitsById).sort();
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent.set(
      leftRoot < rightRoot ? rightRoot : leftRoot,
      leftRoot < rightRoot ? leftRoot : rightRoot,
    );
  };
  const ownerByGroup = new Map<string, string>();
  for (const id of ids) {
    for (const groupId of recovery.saveUnitsById[id]!.atomicTransactionGroupIds) {
      const owner = ownerByGroup.get(groupId);
      if (owner) union(owner, id);
      else ownerByGroup.set(groupId, id);
    }
  }
  const byRoot = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  return [...byRoot.values()]
    .map((componentIds) => {
      const sortedIds = componentIds.sort();
      const entries = sortedIds.map(
        (id) => [id, recovery.saveUnitsById[id]!] as [SaveUnitId, EditorRecoverySaveUnit],
      );
      return { ids: sortedIds, entries, paths: componentPaths(entries) };
    })
    .sort((left, right) => left.ids[0]!.localeCompare(right.ids[0]!));
}

function componentForDiagnostic(
  diagnostic: ProjectValidationDiagnostic,
  components: readonly SaveComponent[],
): SaveComponent[] {
  return components.filter((component) => diagnosticOwnedByPaths(diagnostic, component.paths));
}

function mergeSaveComponents(components: readonly SaveComponent[]): SaveComponent {
  const ids = uniqueSorted(components.flatMap((component) => component.ids));
  const entries = components
    .flatMap((component) => component.entries)
    .sort(
      ([leftId, left], [rightId, right]) =>
        left.sequence - right.sequence || leftId.localeCompare(rightId),
    );
  return { ids, entries, paths: componentPaths(entries) };
}

function connectSaveComponents(
  components: readonly SaveComponent[],
  edges: ReadonlyArray<readonly [SaveComponent, SaveComponent]>,
): SaveComponent[] {
  const indexByComponent = new Map(components.map((component, index) => [component, index]));
  const parent = components.map((_, index) => index);
  const find = (index: number): number => {
    const current = parent[index]!;
    if (current === index) return index;
    const root = find(current);
    parent[index] = root;
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot)
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  for (const [left, right] of edges) {
    const leftIndex = indexByComponent.get(left);
    const rightIndex = indexByComponent.get(right);
    if (leftIndex !== undefined && rightIndex !== undefined) union(leftIndex, rightIndex);
  }
  const groups = new Map<number, SaveComponent[]>();
  components.forEach((component, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), component]);
  });
  return [...groups.values()]
    .map(mergeSaveComponents)
    .sort((left, right) => left.ids[0]!.localeCompare(right.ids[0]!));
}

export async function saveAllSaveUnits(): Promise<ProjectSaveCoordinatorResult> {
  const projectState = useProjectStore.getState();
  if (!projectState.document || !projectState.savedDocument || !projectState.projectFilePath) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  }
  const snapshot = buildEditorProjectStateSnapshot();
  let components = atomicComponents(snapshot.recovery);
  if (components.length === 0) {
    return {
      success: true,
      status: 'nothing-to-save',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  }

  const blockedDiagnostics: ProjectValidationDiagnostic[] = [];
  components = components.filter((component) => {
    const blocked = component.entries.flatMap(([saveUnitId, entry]) => [
      ...(entry.externalConflict ? [externalConflictSaveDiagnostic(saveUnitId, entry)] : []),
      ...Object.keys(entry.pendingRawInputByPath).map((path) =>
        pendingInputDiagnostic(component.ids[0]!, path),
      ),
    ]);
    blockedDiagnostics.push(...blocked);
    return blocked.length === 0;
  });

  const baselineDiagnostics = authoringDiagnostics(projectState.savedDocument);
  const componentBySaveUnitId = new Map(
    components.flatMap((component) =>
      component.ids.map((saveUnitId) => [saveUnitId, component] as const),
    ),
  );
  const dependencyEdges: Array<readonly [SaveComponent, SaveComponent]> = [];
  const rejectedComponents = new Set<SaveComponent>();
  for (const component of components) {
    const selectedIds = new Set(component.ids);
    try {
      const candidate = buildCandidateForSaveUnitIds(
        projectState.savedDocument,
        snapshot.recovery,
        selectedIds,
      );
      const blocking = selectedBlockingDiagnostics(
        baselineDiagnostics,
        authoringDiagnostics(candidate),
        component.paths,
      );
      if (blocking.length > 0) {
        const dependencies = dirtyDependencyIds(
          projectState.savedDocument,
          snapshot.recovery,
          selectedIds,
          blocking,
        );
        const dependencyComponents = [
          ...new Set(
            dependencies
              .map((saveUnitId) => componentBySaveUnitId.get(saveUnitId))
              .filter((dependency): dependency is SaveComponent => Boolean(dependency)),
          ),
        ];
        if (dependencies.length === 0 || dependencyComponents.length === 0) {
          rejectedComponents.add(component);
          blockedDiagnostics.push(...blocking);
        } else {
          dependencyComponents.forEach((dependency) =>
            dependencyEdges.push([component, dependency]),
          );
        }
      }
    } catch (error) {
      rejectedComponents.add(component);
      blockedDiagnostics.push(
        createProjectValidationDiagnostic({
          code: 'editor.save-all.component-failed',
          severity: 'error',
          category: 'Project save',
          path: component.paths[0] ?? '/',
          message:
            error instanceof Error ? error.message : 'A Save All component could not be built.',
          boundaries: ['authoring'],
          ownerPaths: component.paths.length > 0 ? component.paths : ['/'],
        }),
      );
    }
  }

  const activeAtomicComponents = components.filter(
    (component) => !rejectedComponents.has(component),
  );
  const connectedComponents = connectSaveComponents(
    activeAtomicComponents,
    dependencyEdges.filter(
      ([left, right]) => !rejectedComponents.has(left) && !rejectedComponents.has(right),
    ),
  );
  const validConnectedComponents: SaveComponent[] = [];
  for (const component of connectedComponents) {
    const selectedIds = new Set(component.ids);
    try {
      const candidate = buildCandidateForSaveUnitIds(
        projectState.savedDocument,
        snapshot.recovery,
        selectedIds,
      );
      const blocking = selectedBlockingDiagnostics(
        baselineDiagnostics,
        authoringDiagnostics(candidate),
        component.paths,
      );
      if (blocking.length === 0) validConnectedComponents.push(component);
      else blockedDiagnostics.push(...blocking);
    } catch (error) {
      blockedDiagnostics.push(
        createProjectValidationDiagnostic({
          code: 'editor.save-all.connected-component-failed',
          severity: 'error',
          category: 'Project save',
          path: component.paths[0] ?? '/',
          message:
            error instanceof Error
              ? error.message
              : 'A connected Save All component could not be built.',
          boundaries: ['authoring'],
          ownerPaths: component.paths.length > 0 ? component.paths : ['/'],
        }),
      );
    }
  }

  let selected = validConnectedComponents;
  let candidateContent: JsonValue | null = null;
  while (selected.length > 0) {
    const selectedIds = new Set(selected.flatMap((component) => component.ids));
    candidateContent = buildCandidateForSaveUnitIds(
      projectState.savedDocument,
      snapshot.recovery,
      selectedIds,
    );
    const candidateErrors = selectedBlockingDiagnostics(
      baselineDiagnostics,
      authoringDiagnostics(candidateContent),
      selected.flatMap((component) => component.paths),
    );
    if (candidateErrors.length === 0) break;
    const implicated = new Set<SaveComponent>();
    for (const diagnostic of candidateErrors) {
      const owners = componentForDiagnostic(diagnostic, selected);
      if (owners.length === 0) {
        const implementationDiagnostic = createProjectValidationDiagnostic({
          code: 'editor.save-all.unattributed-error',
          severity: 'error',
          category: 'Project save',
          path: diagnostic.path,
          message:
            'Save All produced a new authoring error that could not be attributed to a selected save component. No content was written.',
          boundaries: ['authoring'],
          ownerPaths: diagnostic.ownerPaths,
        });
        return {
          success: false,
          status: 'failed',
          diagnostics: [implementationDiagnostic, diagnostic],
          savedSaveUnitIds: [],
          remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
        };
      }
      owners.forEach((component) => implicated.add(component));
      blockedDiagnostics.push(diagnostic);
    }
    selected = selected.filter((component) => !implicated.has(component));
    candidateContent = null;
  }

  if (selected.length === 0 || !candidateContent) {
    return {
      success: false,
      status: 'blocked',
      diagnostics: collectProjectValidationDiagnostics(blockedDiagnostics),
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }
  const selectedIds = new Set(selected.flatMap((component) => component.ids));
  const result = await commitSelectedSaveUnits(selectedIds, snapshot, candidateContent);
  return {
    ...result,
    diagnostics: collectProjectValidationDiagnostics([
      ...(result.diagnostics as ProjectValidationDiagnostic[]),
      ...blockedDiagnostics,
    ]),
  };
}

export async function saveConflictingSaveUnitKeepMine(
  saveUnitId: SaveUnitId,
): Promise<ProjectSaveCoordinatorResult> {
  return saveActiveSaveUnit(saveUnitId, { allowExternalConflict: true });
}

export function resolveExternalConflictUseDisk(saveUnitId: SaveUnitId): boolean {
  const projectState = useProjectStore.getState();
  if (!projectState.document || !projectState.savedDocument || !projectState.workspaceRevision)
    return false;
  const snapshot = buildEditorProjectStateSnapshot();
  const conflict = snapshot.recovery.saveUnitsById[saveUnitId]?.externalConflict;
  if (!conflict) return false;

  const saveUnitsById = { ...snapshot.recovery.saveUnitsById };
  delete saveUnitsById[saveUnitId];
  const recovery: EditorRecoveryState = { ...snapshot.recovery, saveUnitsById };
  const remainingIds = new Set(Object.keys(saveUnitsById));
  const workingContent = buildCandidateForSaveUnitIds(
    projectState.savedDocument,
    recovery,
    remainingIds,
  );
  const workingEditorState = editorStateForContentCandidate(snapshot, workingContent, recovery);
  const savedContent = stripLocalEditorProjectState(projectState.savedDocument) as JsonValue;
  const savedEditorState = editorStateForContentCandidate(snapshot, savedContent, recovery);
  const workingDocument = mergeEditorProjectState(workingContent, workingEditorState);
  const savedDocument = mergeEditorProjectState(savedContent, savedEditorState);

  useCommandStore.getState().discardSaveUnitHistory(saveUnitId);
  usePendingInputStore.getState().clearPendingInputsForSaveUnit(saveUnitId);
  setLoadedEditorProjectState(workingEditorState);
  return useProjectStore.getState().publishExternalReconciliation({
    document: workingDocument,
    savedDocument,
    workspaceRevision: projectState.workspaceRevision,
    fileRevisions: projectState.fileRevisions,
    scriptSourcePaths: projectState.scriptSourcePaths,
    affectedPaths: conflict.conflictingPaths,
  });
}

export async function saveProjectAsCopy(): Promise<ProjectSaveCoordinatorResult> {
  const projectState = useProjectStore.getState();
  if (!projectState.document) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  }
  const snapshot = buildEditorProjectStateSnapshot();
  const baseline = projectState.savedDocument ?? projectState.document;
  const copyContent = stripLocalEditorProjectState(baseline) as JsonValue;
  const copyDocument = mergeEditorProjectState(
    copyContent,
    editorStateForContentCandidate(snapshot, copyContent, snapshot.recovery),
  );
  if (!projectState.projectSessionId) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    };
  }
  const response = await window.noveltea.saveProjectCopyAs(
    projectState.projectSessionId,
    copyDocument,
    projectAssetPaths(projectState.document),
    projectState.scriptSourcePaths,
  );
  if (!response.success) {
    return {
      success: false,
      status: response.error === 'Save canceled.' ? 'cancelled' : 'failed',
      diagnostics: response.diagnostics ?? [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
      response,
    };
  }
  return {
    success: true,
    status: 'saved',
    diagnostics: response.diagnostics ?? [],
    savedSaveUnitIds: [],
    remainingDirtySaveUnitIds: Object.keys(snapshot.recovery.saveUnitsById).sort(),
    response,
  };
}
