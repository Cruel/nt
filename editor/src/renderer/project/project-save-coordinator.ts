import { useCommandStore } from '@/commands/command-store';
import { usePendingInputStore } from '@/workbench/pending-input-store';
import {
  buildEditorProjectStateSnapshot,
  editorProjectStateFromProject,
  mergeEditorProjectState,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import type {
  ProjectContentSaveResponse,
  SaveProjectResponse,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type {
  EditorProjectState,
  EditorRecoverySaveUnit,
  EditorRecoveryState,
} from '../../shared/project-schema/editor-project-state';
import {
  stripEditorProjectState,
  stripLocalEditorProjectState,
} from '../../shared/project-schema/editor-project-state';
import {
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-diagnostic-projection';
import { applyJsonPatch, type JsonPatchOperation } from './json-patch';
import type { JsonPointer } from './json-pointer';
import { cloneJsonValue, jsonValuesEqual, type JsonValue } from './json-value';
import { projectNativeExternalResult } from './native-external-projection';
import { confirmProjectComments } from './project-comment-confirmation';
import { rebaseRecoveryOverlays } from './project-recovery-rebase';
import {
  acknowledgeNativeSavedSources,
  flushNativeProjectSources,
  useProjectSourceStore,
} from './project-source-store';
import { useProjectStore } from './project-store';
import {
  resolveSaveUnitForTab,
  sourceIdFromSaveUnitId,
  sourceSaveUnitId,
} from './save-unit-registry';
import type { SaveUnitId } from './save-unit-types';

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
  response?: SaveProjectResponse | ProjectContentSaveResponse;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

/** Native certification Save never calls the legacy TypeScript workspace
 * writer. It updates only the acknowledged logical unit's saved baseline and
 * retains unrelated recovery overlays. Multi-unit atomic groups must be sent
 * through one native transaction, not split into partially saved commands. */
async function commitSelectedNativeSaveUnits(
  selectedIds: Set<SaveUnitId>,
  snapshot: EditorProjectState,
  candidateContent: JsonValue,
  sourceIds: readonly string[] = [],
  keepMine = false,
): Promise<ProjectSaveCoordinatorResult> {
  const current = useProjectStore.getState();
  const remaining = uniqueSorted([
    ...Object.keys(snapshot.recovery.saveUnitsById),
    ...sourceIds.map((id) => sourceSaveUnitId(id)),
  ]);
  if (selectedIds.size === 0 && sourceIds.length === 0) {
    return {
      success: false,
      status: 'blocked',
      diagnostics: [
        {
          code: 'editor.native-save.atomic-group-unavailable',
          severity: 'error',
          category: 'Project save',
          path: '/',
          message: 'Native Save requires at least one logical Save unit.',
        },
      ],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: remaining,
    };
  }
  const saveUnitIds = [...selectedIds].sort();
  const sourceBuffers = useProjectSourceStore.getState().buffersById;
  const submittedSources = Object.fromEntries(
    sourceIds.map((id) => {
      const buffer = sourceBuffers[id];
      if (!buffer?.dirty || buffer.conflict)
        throw new Error(`Native mixed Save requires a cleanly staged dirty source: ${id}`);
      return [id, { text: buffer.text, baseContentHash: buffer.baseContentHash }];
    }),
  );
  const acknowledged = {
    remainingDirtySaveUnitIds: null as string[] | null,
    externalConflictDiagnostics: [] as ProjectValidationDiagnostic[],
  };
  let comments: 'keep' | 'remove' = 'keep';
  let submitted: Awaited<
    ReturnType<ReturnType<typeof useCommandStore.getState>['saveNativeUnitAsync']>
  >;
  for (let attempt = 0; ; attempt += 1) {
    submitted = await useCommandStore.getState().saveNativeUnitAsync(
      saveUnitIds.length === 1 ? saveUnitIds[0]! : saveUnitIds,
      current.projectRevision,
      {
        comments,
        ...(keepMine ? { keepMine: true } : {}),
        ...(sourceIds.length
          ? {
              textPaths: [...sourceIds],
              textContents: Object.fromEntries(
                Object.entries(submittedSources).map(([id, source]) => [id, source.text]),
              ),
            }
          : {}),
      },
      (saved) => {
        const latest = useProjectStore.getState();
        if (
          !latest.document ||
          latest.projectInstanceId !== current.projectInstanceId ||
          latest.projectRevision !== current.projectRevision
        )
          throw new Error('Native Save was accepted after the editor Project changed.');
        // An exact-CAS native Save may incorporate a disjoint external edit in
        // the same physical owner. Its saved/working source is authoritative;
        // the renderer's pre-Save candidate is not a valid disk projection then.
        const authoritative = saved.affectedRecords?.length
          ? projectNativeExternalResult({
              saved: latest.savedDocument!,
              working: latest.document,
              recovery: snapshot.recovery,
              result: saved,
            })
          : null;
        const savedContent = authoritative?.saved ?? candidateContent;
        const workingContent = authoritative?.working ?? latest.document;
        const rebased = rebaseRecoveryOverlays(
          authoritative?.recovery ?? snapshot.recovery,
          savedContent,
          workingContent,
          selectedIds,
        );
        acknowledged.externalConflictDiagnostics = Object.entries(rebased.saveUnitsById)
          .filter(([, entry]) => entry.externalConflict)
          .map(([id, entry]) => externalConflictSaveDiagnostic(id, entry));
        const savedEditorState = editorStateForContentCandidate(snapshot, savedContent, rebased);
        const workingEditorState = editorStateForContentCandidate(
          snapshot,
          workingContent,
          rebased,
        );
        if (sourceIds.length)
          acknowledgeNativeSavedSources(
            latest.projectSessionId!,
            submittedSources,
            saved.textSourceDiskRevisions ?? {},
          );
        const persisted = mergeEditorProjectState(savedContent, savedEditorState);
        const projected = mergeEditorProjectState(workingContent, workingEditorState);
        if (
          authoritative &&
          !jsonValuesEqual(
            stripLocalEditorProjectState(latest.document),
            stripLocalEditorProjectState(workingContent),
          )
        ) {
          if (
            !useProjectStore.getState().publishExternalReconciliation({
              document: projected,
              savedDocument: persisted,
              scriptSourcePaths: latest.scriptSourcePaths,
              affectedPaths: authoritative.affectedPaths,
            })
          )
            throw new Error('Native Save produced an inadmissible external editor projection.');
        } else {
          useProjectStore.getState().markSaved({ document: persisted });
        }
        setLoadedEditorProjectState(workingEditorState);
        useProjectStore.getState().markEditorMetadataPersisted(workingEditorState);
        acknowledged.remainingDirtySaveUnitIds = uniqueSorted([
          ...Object.keys(rebased.saveUnitsById),
          ...Object.entries(useProjectSourceStore.getState().buffersById)
            .filter(([, buffer]) => buffer.dirty)
            .map(([id]) => sourceSaveUnitId(id)),
        ]);
      },
    );
    if (submitted.ok || !submitted.commentImpacts?.length || attempt >= 3) break;
    const decision = await confirmProjectComments(submitted.commentImpacts, 'Save Project');
    if (decision === 'cancel') {
      return {
        success: false,
        status: 'cancelled',
        diagnostics: [],
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: remaining,
      };
    }
    if (decision === 'keep') break;
    comments = 'remove';
  }
  if (!submitted.ok) {
    return {
      success: false,
      status: 'failed',
      diagnostics: submitted.diagnostics.map((diagnostic) => ({
        code: diagnostic.code ?? 'editor.native-save.rejected',
        severity: diagnostic.severity,
        category: 'Project save',
        path: diagnostic.path ?? '/',
        message: diagnostic.message,
      })),
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: remaining,
    };
  }
  if (acknowledged.remainingDirtySaveUnitIds === null) {
    return {
      success: false,
      status: 'failed',
      diagnostics: [
        {
          code: 'editor.native-save.superseded',
          severity: 'error',
          category: 'Project save',
          path: '/',
          message: 'Native Save was accepted but its editor baseline was not acknowledged.',
        },
      ],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: remaining,
    };
  }
  const remainingDirtySaveUnitIds = acknowledged.remainingDirtySaveUnitIds;
  return {
    success: true,
    status: remainingDirtySaveUnitIds.length ? 'partially-saved' : 'saved',
    diagnostics: acknowledged.externalConflictDiagnostics,
    savedSaveUnitIds: uniqueSorted([
      ...saveUnitIds,
      ...sourceIds.map((id) => sourceSaveUnitId(id)),
    ]),
    remainingDirtySaveUnitIds,
  };
}

export async function saveActiveSaveUnit(
  explicitSaveUnitId?: SaveUnitId,
  options: { allowExternalConflict?: boolean; acceptExternalSourceBase?: boolean } = {},
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
  const sourceId = saveUnitId ? sourceIdFromSaveUnitId(saveUnitId) : null;
  if (sourceId) {
    const sourceStore = useProjectSourceStore.getState();
    const buffer = sourceStore.buffersById[sourceId];
    if (!buffer?.dirty) {
      return {
        success: true,
        status: 'nothing-to-save',
        diagnostics: [],
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: Object.entries(sourceStore.buffersById)
          .filter(([, candidate]) => candidate.dirty)
          .map(([candidateId]) => sourceSaveUnitId(candidateId))
          .sort(),
      };
    }
    const saved = await sourceStore.save(sourceId, options.acceptExternalSourceBase ?? false);
    const remainingDirtySaveUnitIds = Object.entries(useProjectSourceStore.getState().buffersById)
      .filter(([, candidate]) => candidate.dirty)
      .map(([candidateId]) => sourceSaveUnitId(candidateId))
      .sort();
    const remainsDirty = remainingDirtySaveUnitIds.includes(sourceSaveUnitId(sourceId));
    return {
      success: saved,
      status: saved ? (remainsDirty ? 'partially-saved' : 'saved') : 'failed',
      diagnostics: saved
        ? []
        : [
            {
              code: 'editor.source-save.failed',
              severity: 'error',
              path: sourceId,
              category: 'Project save',
              message:
                useProjectSourceStore.getState().error ??
                `Source '${sourceId}' could not be saved.`,
            },
          ],
      savedSaveUnitIds: saved ? [sourceSaveUnitId(sourceId)] : [],
      remainingDirtySaveUnitIds,
    };
  }
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
    const candidateContent = buildCandidateForSaveUnitIds(
      projectState.savedDocument,
      snapshot.recovery,
      selectedIds,
    );
    // The native Save operation owns scoped semantic admission and dependent
    // record validation. Do not consult the obsolete TypeScript validator or
    // infer dependencies from a second interpretation of the saved Project.
    return await commitSelectedNativeSaveUnits(
      selectedIds,
      snapshot,
      candidateContent,
      [],
      options.allowExternalConflict ?? false,
    );
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

  // Never mix a native working Project Save with the retired source-buffer
  // writer or split a linked Save All into independently committed units.
  const sourceIds = Object.entries(useProjectSourceStore.getState().buffersById)
    .filter(([, buffer]) => buffer.dirty)
    .map(([id]) => id);
  const dirtySources = sourceIds.map((id) => sourceSaveUnitId(id));
  const dirtyRecords = Object.keys(buildEditorProjectStateSnapshot().recovery.saveUnitsById);
  const all = uniqueSorted([...dirtySources, ...dirtyRecords]);
  if (all.length === 0)
    return {
      success: true,
      status: 'nothing-to-save',
      diagnostics: [],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: [],
    };
  try {
    if (sourceIds.length) await flushNativeProjectSources();
  } catch (error) {
    return {
      success: false,
      status: 'blocked',
      diagnostics: [
        {
          code: 'editor.native-save-all.stage-rejected',
          severity: 'error',
          category: 'Project save',
          path: '/',
          message: error instanceof Error ? error.message : 'Native source staging failed.',
        },
      ],
      savedSaveUnitIds: [],
      remainingDirtySaveUnitIds: all,
    };
  }
  {
    const snapshot = buildEditorProjectStateSnapshot();
    const ids = new Set(dirtyRecords);
    const entries = orderedEntries(snapshot.recovery, ids);
    const failures = entries.flatMap(([id, entry]) => [
      ...(entry.externalConflict ? [externalConflictSaveDiagnostic(id, entry)] : []),
      ...Object.keys(entry.pendingRawInputByPath).map((path) => pendingInputDiagnostic(id, path)),
    ]);
    if (failures.length > 0)
      return {
        success: false,
        status: 'blocked',
        diagnostics: failures,
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: all,
      };
    try {
      const candidate = buildCandidateForSaveUnitIds(
        projectState.savedDocument,
        snapshot.recovery,
        ids,
      );
      // The native Project owner validates the staged, revision-bound Save
      // atomically. Revalidating the candidate with the retired TypeScript
      // Project engine would introduce a second, potentially contradictory
      // semantic authority and could reject a native-valid Save.
      return commitSelectedNativeSaveUnits(ids, snapshot, candidate, sourceIds);
    } catch (error) {
      return {
        success: false,
        status: 'failed',
        diagnostics: [
          {
            code: 'editor.native-save-all.candidate',
            severity: 'error',
            category: 'Project save',
            path: '/',
            message: error instanceof Error ? error.message : 'Native Save All candidate failed.',
          },
        ],
        savedSaveUnitIds: [],
        remainingDirtySaveUnitIds: all,
      };
    }
  }
}

export async function saveConflictingSaveUnitKeepMine(
  saveUnitId: SaveUnitId,
): Promise<ProjectSaveCoordinatorResult> {
  return saveActiveSaveUnit(saveUnitId, { allowExternalConflict: true });
}

export function resolveExternalConflictUseDisk(saveUnitId: SaveUnitId): boolean {
  const projectState = useProjectStore.getState();
  if (!projectState.document || !projectState.savedDocument) return false;
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
