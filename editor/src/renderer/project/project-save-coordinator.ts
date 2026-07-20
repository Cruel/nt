import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import { getJsonAtPointer, hasJsonAtPointer, type JsonPointer } from './json-pointer';
import { cloneJsonValue, jsonValuesEqual, type JsonValue } from './json-value';
import { resolveSaveUnitForTab } from './save-unit-registry';
import type { SaveUnitId } from './save-unit-types';
import { useProjectStore } from './project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  buildEditorProjectStateSnapshot,
  mergeEditorProjectState,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import type {
  EditorProjectState,
  EditorRecoveryPatch,
  EditorRecoverySaveUnit,
  EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import { stripEditorProjectState } from '../../shared/project-schema/editor-project-state';
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
  const decoded = decodeAuthoringProject(stripEditorProjectState(document));
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
  let candidate = cloneJsonValue(stripEditorProjectState(savedDocument) as JsonValue);
  for (const [, entry] of orderedEntries(recovery, selectedIds)) {
    candidate = applyJsonPatch(candidate, entry.patches as JsonPatchOperation[]).document;
  }
  return candidate;
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
    if (path === '/editor' || path.startsWith('/editor/')) continue;
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
  const baselineContent = stripEditorProjectState(candidateBaseline) as JsonValue;
  const workingContent = stripEditorProjectState(workingDocument) as JsonValue;
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

async function commitSelectedSaveUnits(
  selectedIds: Set<SaveUnitId>,
  snapshot: EditorProjectState,
  candidateContent: JsonValue,
): Promise<ProjectSaveCoordinatorResult> {
  const projectState = useProjectStore.getState();
  const currentDocument = projectState.document;
  const projectFilePath = projectState.projectFilePath;
  if (!currentDocument || !projectState.savedDocument || !projectFilePath) {
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
  const editorStateForWrite: EditorProjectState = {
    ...snapshot,
    recovery: rebasedRecovery,
  };
  useProjectStore.getState().setSaving(true);
  const response = await window.noveltea.saveProjectContent(
    projectFilePath,
    snapshot.contentFingerprint,
    candidateContent,
    editorStateForWrite,
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

  const persistedEditorState: EditorProjectState = {
    ...editorStateForWrite,
    contentFingerprint: response.contentFingerprint ?? editorStateForWrite.contentFingerprint,
  };
  const savedDocument = mergeEditorProjectState(candidateContent, persistedEditorState);
  useProjectStore.getState().markSaved({
    document: savedDocument,
    projectPath: response.projectPath,
    projectFilePath: response.projectFilePath,
  });
  setLoadedEditorProjectState(persistedEditorState);
  useProjectStore.getState().markEditorMetadataPersisted(persistedEditorState);
  return {
    success: true,
    status: Object.keys(rebasedRecovery.saveUnitsById).length > 0 ? 'partially-saved' : 'saved',
    diagnostics: response.diagnostics ?? [],
    savedSaveUnitIds: [...selectedIds].sort(),
    remainingDirtySaveUnitIds: Object.keys(rebasedRecovery.saveUnitsById).sort(),
    response,
  };
}

export async function saveActiveSaveUnit(
  explicitSaveUnitId?: SaveUnitId,
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
    const pending = component.entries.flatMap(([, entry]) =>
      Object.keys(entry.pendingRawInputByPath).map((path) =>
        pendingInputDiagnostic(component.ids[0]!, path),
      ),
    );
    blockedDiagnostics.push(...pending);
    return pending.length === 0;
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
  const copyDocument = mergeEditorProjectState(
    stripEditorProjectState(baseline) as JsonValue,
    snapshot,
  );
  const response = await window.noveltea.saveProjectCopyAs(
    copyDocument,
    projectState.projectFilePath,
    projectState.projectFilePath,
    projectAssetPaths(projectState.document),
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
