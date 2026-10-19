import { create } from 'zustand';
import { useProjectStore } from '@/project/project-store';
import type { JsonValue } from '@/project/json-value';
import { applyJsonPatch, type JsonPatchOperation } from '@/project/json-patch';
import {
  parseJsonPointer,
  buildJsonPointer,
  getJsonAtPointer,
  hasJsonAtPointer,
} from '@/project/json-pointer';
import { jsonValuesEqual } from '@/project/json-value';
import {
  persistAutoCommitPlan,
  remapRecoveryForAutoCommit,
} from '@/project/structural-command-persistence';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import {
  beginTransaction as beginTransactionCore,
  cancelTransaction as cancelTransactionCore,
  commitTransaction as commitTransactionCore,
  createInitialCommandHistoryState,
  executeCommand as executeCommandCore,
  redoCommand as redoCommandCore,
  undoCommand as undoCommandCore,
  type CommandBusState,
} from './command-bus';
import type {
  CommandDiagnostic,
  CommandExecutionResult,
  CommandHistoryEntry,
  CommandHistoryState,
  CommandRequest,
  CommandTransactionRequest,
} from './command-types';
import {
  assertNativeProjection,
  confirmNativeCommand,
  nativeLocalizationTarget,
} from './native-command-execution';
import { confirmProjectComments } from '@/project/project-comment-confirmation';
import {
  authoringDependencyGraphService,
  isAuthoringDependencyGraphServiceStarted,
} from '@/project/authoring-dependency-graph-runtime';

interface CommandStoreState {
  history: CommandHistoryState;
  lastDiagnostics: CommandDiagnostic[];
  persistencePending: boolean;
  nativeWorkingRevision: number | null;
  nativeProjectSessionId: string | null;
  nativeProjectionRevision: number | null;
  nativeMutationPending: boolean;
  nativeMutationFailure: string | null;
  enableNativeCommandMode: (workingRevision: number) => void;
  executeCommandAsync: (request: CommandRequest) => Promise<CommandExecutionResult>;
  saveNativeUnitAsync: (
    saveUnitIds: string | string[],
    expectedProjectRevision: number,
    options: {
      keepMine?: boolean;
      comments?: 'keep' | 'remove' | 'cancel' | 'perEdit';
      textPaths?: string[];
      textContents?: Record<string, string>;
    },
    onAcknowledged?: (
      result: import('../../main/services/native-authoring-worker-contract').NativeAuthoringPatchResult,
    ) => void,
  ) => Promise<CommandExecutionResult>;
  saveNativeTextAsync: (
    path: string,
    text: string,
    diskRevision: string,
    expectedProjectRevision: number,
  ) => Promise<{ ok: boolean; contentHash?: string; error?: string }>;
  stageNativeTextAsync: (
    path: string,
    text: string,
    diskRevision: string,
    expectedProjectRevision: number,
  ) => Promise<CommandExecutionResult>;
  executeCommandBatchAsync: (
    transaction: CommandTransactionRequest,
    requests: readonly CommandRequest[],
  ) => Promise<CommandExecutionResult>;
  undoAsync: () => Promise<CommandExecutionResult>;
  redoAsync: () => Promise<CommandExecutionResult>;
  executeCommand: (request: CommandRequest) => CommandExecutionResult;
  undo: () => CommandExecutionResult;
  redo: () => CommandExecutionResult;
  beginTransaction: (request: CommandTransactionRequest) => void;
  commitTransaction: () => CommandExecutionResult;
  cancelTransaction: () => void;
  resetCommandHistory: () => void;
  invalidateHistoryAfterCommittedFileMove: () => void;
  discardSaveUnitHistory: (saveUnitId: string) => void;
}

function nativeOnlyResult(message: string): CommandExecutionResult {
  return {
    ok: false,
    projectChanged: false,
    diagnostics: [{ severity: 'error', message }],
  };
}

const nativeRecordFamilies = new Set([
  'animations',
  'archetypes',
  'assets',
  'characters',
  'dialogues',
  'interactables',
  'interactions',
  'layouts',
  'maps',
  'materials',
  'rooms',
  'scenes',
  'scripts',
  'tests',
  'variables',
  'verbs',
]);

/** Physical trash identity is returned by the committed native journal.
 * Never synthesize a restore destination from a record ID or disk state. */
const nativeAssetTrashByCommandId = new Map<
  string,
  import('../../shared/project-asset-audit').ProjectAssetTrashMove[]
>();
const nativeLayoutCopyByCommandId = new Map<string, Record<string, string>>();

function layoutSourceFromRequest(request: CommandRequest): Record<string, string> {
  if (
    request.type !== 'entity.duplicateRecord' ||
    !request.payload ||
    typeof request.payload !== 'object' ||
    Array.isArray(request.payload)
  )
    return {};
  const data = request.payload as Record<string, unknown>;
  if (
    data.collection !== 'layouts' ||
    typeof data.sourceId !== 'string' ||
    typeof data.targetId !== 'string'
  )
    return {};
  return { [`layouts/${data.targetId}`]: `layouts/${data.sourceId}` };
}

function nativeAssetTransition(
  entry: CommandHistoryEntry | undefined,
  direction: 'command' | 'undo' | 'redo',
): import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition'] {
  const operations = entry?.autoCommitPlan?.filesystemOperations.filter(
    (operation) => operation.kind !== 'preexisting-project-assets',
  );
  if (!operations?.length) return undefined;
  if (operations.length !== 1)
    throw new Error('Native structural Save requires one coherent Asset transition.');
  const operation = operations[0]!;
  const trash =
    operation.kind === 'trash-project-assets' ? direction !== 'undo' : direction === 'undo';
  if (trash) return { kind: 'trash', projectRelativePaths: operation.projectRelativePaths };
  if (direction === 'command' && operation.kind === 'staged-project-assets') return undefined;
  const moves = nativeAssetTrashByCommandId.get(entry!.id);
  if (!moves?.length || moves.length !== operation.projectRelativePaths.length)
    throw new Error('Native structural Asset restoration has no committed trash identity.');
  return { kind: 'restore', moves };
}

/** Derive the physical YAML owner selection from the accepted generic patches,
 * not the command name or a renderer-provided filesystem path. All owners
 * commit in one native journal, including reference and editor metadata edits. */
function nativeStructuralOwners(patches: readonly JsonPatchOperation[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const patch of patches) {
    const segments = parseJsonPointer(patch.path);
    const family = segments[0];
    let owner = 'project';
    let relative = patch.path;
    if (family === 'localization') {
      const target = nativeLocalizationTarget(patch.path);
      if (!target) throw new Error(`Unsupported native localization owner: ${patch.path}`);
      owner = target.owner;
      relative = target.relative;
    } else if (family && nativeRecordFamilies.has(family) && segments.length >= 2) {
      owner = `${family}/${segments[1]}`;
      relative = segments.length === 2 ? '/' : buildJsonPointer(segments.slice(2));
    } else if (family === 'editor' || family === 'traits') {
      owner = family;
      relative = segments.length === 1 ? '/' : buildJsonPointer(segments.slice(1));
    }
    (paths[owner] ??= []).push(relative);
  }
  return Object.fromEntries(
    Object.entries(paths).map(([owner, values]) => [
      owner,
      values.includes('/') ? ['/'] : [...new Set(values)].sort(),
    ]),
  );
}

/** This is the asynchronous production command boundary, not speculative
 * publication followed by an optional worker check. A candidate command,
 * undo or redo remains invisible until native acceptance and value parity. */
async function submitNativeCommand(
  proposal: ReturnType<typeof executeCommandCore>,
  patches: readonly import('@/project/json-patch').JsonPatchOperation[],
  kind: 'command' | 'undo' | 'redo',
  layoutCopySources?: Record<string, string>,
): Promise<CommandExecutionResult> {
  const state = useCommandStore.getState();
  const revision = state.nativeWorkingRevision;
  const project = useProjectStore.getState();
  const projectSessionId = project.projectSessionId;
  if (revision === null || !projectSessionId || !project.projectInstanceId)
    return nativeOnlyResult('Native Project session is not ready.');
  if (project.projectRevision !== state.nativeProjectionRevision) {
    const message = 'Renderer Project changed without a native acknowledgment.';
    useCommandStore.setState({ nativeMutationFailure: message });
    return nativeOnlyResult(message);
  }
  if (state.nativeMutationPending || state.nativeMutationFailure)
    return nativeOnlyResult(state.nativeMutationFailure || 'A native Project command is pending.');
  if (!proposal.ok || !proposal.projectChanged) return proposal;
  let effectiveProposal = proposal;
  let plan = proposal.historyEntry?.autoCommitPlan;
  const originalPlan = plan;
  const convertToManual = (reason: string): boolean => {
    if (
      kind !== 'command' ||
      plan?.unsafeRebasePolicy !== 'convert-to-manual-save' ||
      !effectiveProposal.historyEntry
    )
      return false;
    const entry = {
      ...effectiveProposal.historyEntry,
      persistencePolicy: 'manual-save' as const,
      autoCommitPlan: undefined,
    };
    effectiveProposal = {
      ...effectiveProposal,
      historyEntry: entry,
      diagnostics: [
        ...effectiveProposal.diagnostics,
        {
          severity: 'warning' as const,
          message: `Native auto-commit converted to manual Save: ${reason}`,
        },
      ],
      state: {
        ...effectiveProposal.state,
        history: {
          ...effectiveProposal.state.history,
          entries: effectiveProposal.state.history.entries.map((candidate) =>
            candidate.id === entry.id ? entry : candidate,
          ),
        },
      },
    };
    plan = undefined;
    return true;
  };
  let savedBaseline: JsonValue | null = null;
  if (plan) {
    if (!project.savedDocument)
      return nativeOnlyResult('Native structural Save requires a saved Project baseline.');
    // Whole-owner structural Saves must not silently persist earlier manual
    // edits in the same record. Preserve the owner's saved baseline rather
    // than letting an auto-commit absorb an unrelated dirty buffer.
    let overlap: string | null = null;
    for (const patch of patches) {
      const full = patch.path.endsWith('/-') ? patch.path.slice(0, -2) : patch.path;
      const workingHas = hasJsonAtPointer(project.document!, full);
      const savedHas = hasJsonAtPointer(project.savedDocument, full);
      if (
        workingHas !== savedHas ||
        (workingHas &&
          !jsonValuesEqual(
            getJsonAtPointer(project.document!, full),
            getJsonAtPointer(project.savedDocument, full),
          ))
      )
        overlap = full;
    }
    if (overlap && !convertToManual(`Overlapping unsaved edits at ${overlap}`))
      return nativeOnlyResult(
        `Native structural auto-commit overlaps unsaved edits at ${overlap}.`,
      );
  }
  if (plan) {
    try {
      savedBaseline = applyJsonPatch(
        project.savedDocument,
        kind === 'undo' ? plan.inverseBaselinePatches : plan.forwardBaselinePatches,
      ).document;
    } catch (error) {
      return nativeOnlyResult(
        error instanceof Error ? error.message : 'Native baseline cannot be updated.',
      );
    }
  }
  // Resolve physical paths and restore identity before staging a generic
  // patch. No unsupported Asset transition may strand a dirty native session.
  let structuralPathsByOwner: Record<string, string[]> | undefined;
  let assetTransition:
    | import('../../shared/editor-tooling').ProjectWorkspaceCommitOptions['assetTransition']
    | undefined;
  if (plan) {
    try {
      structuralPathsByOwner = nativeStructuralOwners(patches);
      if (!Object.keys(structuralPathsByOwner).length)
        throw new Error('Native structural Save has no changed YAML owners.');
      assetTransition = nativeAssetTransition(effectiveProposal.historyEntry, kind);
      if (effectiveProposal.historyEntry) {
        const planHints = Object.fromEntries(
          plan.identityRemap.flatMap(({ fromPath, toPath }) => {
            const from = (kind === 'undo' ? toPath : fromPath).match(
              /^\/layouts\/([a-z][a-z0-9-]*)$/u,
            );
            const to = (kind === 'undo' ? fromPath : toPath).match(
              /^\/layouts\/([a-z][a-z0-9-]*)$/u,
            );
            return from && to ? [[`layouts/${to[1]}`, `layouts/${from[1]}`]] : [];
          }),
        );
        layoutCopySources = {
          ...planHints,
          ...(nativeLayoutCopyByCommandId.get(effectiveProposal.historyEntry.id) ?? {}),
          ...(layoutCopySources ?? {}),
        };
        if (kind === 'undo') {
          for (const patch of patches) {
            const match = patch.op === 'add'
              ? patch.path.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u)
              : null;
            if (match) {
              const owner = `layouts/${match[1]}`;
              layoutCopySources[owner] ??= owner;
            }
          }
        }
        layoutCopySources = Object.fromEntries(
          Object.entries(layoutCopySources).filter(([owner]) =>
            patches.some((patch) => patch.op === 'add' && patch.path === `/${owner}`),
          ),
        );
      }
    } catch (error) {
      return nativeOnlyResult(
        error instanceof Error ? error.message : 'Invalid native structural Save.',
      );
    }
  }
  if (!plan && originalPlan && kind === 'command') {
    // Manual Save postpones persistence, not the provenance of copied Layout
    // source files that the working native patch will still need to validate.
    layoutCopySources = {
      ...Object.fromEntries(
        originalPlan.identityRemap.flatMap(({ fromPath, toPath }) => {
          const from = fromPath.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u);
          const to = toPath.match(/^\/layouts\/([a-z][a-z0-9-]*)$/u);
          return from && to ? [[`layouts/${to[1]}`, `layouts/${from[1]}`]] : [];
        }),
      ),
      ...(layoutCopySources ?? {}),
    };
  }
  const generation = project.projectRevision;
  const instanceId = project.projectInstanceId;
  const historyAtSubmission = state.history;
  useCommandStore.setState({ nativeMutationPending: true });
  try {
    const confirmed = await confirmNativeCommand(
      busStateFromStores(state.history),
      effectiveProposal,
      patches,
      projectSessionId,
      revision,
      (sessionId, expected, next) =>
        window.noveltea.nativeProjectPatch(
          sessionId,
          expected,
          next,
          layoutCopySources && Object.keys(layoutCopySources).length
            ? layoutCopySources
            : undefined,
        ),
    );
    // A rejected generic patch did not stage a structural change. In
    // particular, it must never fall through to the physical Save attempt.
    if (!confirmed.result.ok || !confirmed.result.projectChanged) {
      useCommandStore.setState({
        nativeMutationPending: false,
        lastDiagnostics: confirmed.result.diagnostics,
      });
      return confirmed.result;
    }
    if (
      layoutCopySources &&
      Object.keys(layoutCopySources).length &&
      effectiveProposal.historyEntry &&
      kind === 'command'
    )
      nativeLayoutCopyByCommandId.set(effectiveProposal.historyEntry.id, layoutCopySources);
    let workingRevision = confirmed.workingRevision;
    if (plan && structuralPathsByOwner) {
      let saved = await window.noveltea.nativeProjectSaveUnit(
        projectSessionId,
        workingRevision,
        [],
        { structuralPathsByOwner, comments: 'keep', assetTransition },
      );
      if (!saved.accepted && saved.commentImpacts?.length) {
        const decision = await confirmProjectComments(saved.commentImpacts, plan.commandType);
        if (decision === 'delete')
          saved = await window.noveltea.nativeProjectSaveUnit(
            projectSessionId,
            workingRevision,
            [],
            { structuralPathsByOwner, comments: 'remove', assetTransition },
          );
        else if (decision !== 'cancel')
          throw new Error('Native structural comment approval returned an invalid decision.');
      }
      if (!saved.accepted) {
        // The YAML journal left the disk unchanged. Restore the native working
        // candidate before returning a normal command failure; never publish
        // a candidate whose physical auto-commit was rejected.
        const entry = effectiveProposal.historyEntry;
        const inverse = kind === 'undo' ? entry?.patches : entry?.inversePatches;
        if (!inverse?.length)
          throw new Error('Rejected native structural Save lacks a rollback patch.');
        const restored = await window.noveltea.nativeProjectPatch(
          projectSessionId,
          workingRevision,
          [...inverse],
        );
        if (!restored.accepted)
          throw new Error(
            `Native structural Save and rollback failed: ${saved.error}; ${restored.error}`,
          );
        assertNativeProjection(project.document!, inverse, restored);
        let restoredRevision = restored.snapshot.workingRevision;
        const stagedImport =
          kind === 'command'
            ? plan.filesystemOperations.find(
                (operation) => operation.kind === 'staged-project-assets',
              )
            : undefined;
        if (stagedImport) {
          // An importer may have already copied bytes into the Project before
          // asking the editor to commit metadata. Failed metadata persistence
          // must not leave those copied files behind as unowned active Assets.
          const cleanup = await window.noveltea.nativeProjectSaveUnit(
            projectSessionId,
            restoredRevision,
            [],
            {
              structuralPathsByOwner: {},
              assetTransition: {
                kind: 'trash',
                projectRelativePaths: stagedImport.projectRelativePaths,
              },
            },
          );
          if (!cleanup.accepted)
            throw new Error(
              `Native structural Save rejected (${saved.error}); staged Asset cleanup failed: ${cleanup.error}`,
            );
          restoredRevision = cleanup.snapshot.workingRevision;
        }
        useCommandStore.setState({
          nativeWorkingRevision: restoredRevision,
          nativeMutationPending: false,
          lastDiagnostics: [
            { severity: 'error', message: saved.error || 'Native structural Save rejected.' },
          ],
        });
        return nativeOnlyResult(saved.error || 'Native structural Save rejected.');
      }
      assertNativeProjection(effectiveProposal.document!, patches, saved);
      if (saved.assetTrashMoves?.length && effectiveProposal.historyEntry)
        nativeAssetTrashByCommandId.set(effectiveProposal.historyEntry.id, saved.assetTrashMoves);
      workingRevision = saved.snapshot.workingRevision;
    }
    const current = useProjectStore.getState();
    if (
      current.projectSessionId !== projectSessionId ||
      current.projectInstanceId !== instanceId ||
      current.projectRevision !== generation ||
      useCommandStore.getState().history !== historyAtSubmission ||
      useCommandStore.getState().nativeWorkingRevision !== revision
    )
      throw new Error(
        'Native Project changed while an editor command was awaiting acknowledgment.',
      );
    if (confirmed.result.projectChanged && !applyBusResult(confirmed.result, kind))
      throw new Error('Native Project accepted a change that the editor cannot publish.');
    if (savedBaseline) {
      const remaps =
        kind === 'undo'
          ? plan!.identityRemap.map(({ fromPath, toPath, fromSaveUnitId, toSaveUnitId }) => ({
              fromPath: toPath,
              toPath: fromPath,
              fromSaveUnitId: toSaveUnitId,
              toSaveUnitId: fromSaveUnitId,
            }))
          : plan!.identityRemap;
      const scriptSourcePaths = { ...project.scriptSourcePaths };
      for (const remap of remaps) {
        const from = remap.fromPath.match(/^\/scripts\/([a-z][a-z0-9-]*)$/u)?.[1];
        const to = remap.toPath.match(/^\/scripts\/([a-z][a-z0-9-]*)$/u)?.[1];
        if (!from || !to || !scriptSourcePaths[from]) continue;
        scriptSourcePaths[to] = scriptSourcePaths[from];
        delete scriptSourcePaths[from];
      }
      useProjectStore.getState().markSaved({ document: savedBaseline, scriptSourcePaths });
      if (remaps.length || plan!.discardRecoverySaveUnitIds.length) {
        const editorState = buildEditorProjectStateSnapshot();
        const recovery = remapRecoveryForAutoCommit(editorState.recovery, remaps);
        for (const id of kind === 'undo' ? [] : plan!.discardRecoverySaveUnitIds)
          delete recovery.saveUnitsById[id];
        setLoadedEditorProjectState({ ...editorState, recovery });
      }
    }
    useCommandStore.setState({
      history: confirmed.result.state.history,
      nativeWorkingRevision: workingRevision,
      nativeProjectionRevision: useProjectStore.getState().projectRevision,
      nativeMutationPending: false,
      lastDiagnostics: confirmed.result.diagnostics,
    });
    return confirmed.result;
  } catch (error) {
    // A lost/invalid acknowledgment may follow an accepted native mutation.
    // Never resume from a stale TS document or fall back to the old writer.
    const message = error instanceof Error ? error.message : 'Native Project command failed.';
    const latestProject = useProjectStore.getState();
    if (
      latestProject.projectInstanceId !== instanceId ||
      latestProject.projectSessionId !== projectSessionId ||
      useCommandStore.getState().nativeWorkingRevision !== revision
    )
      return nativeOnlyResult('Native Project command was superseded by another Project session.');
    useCommandStore.setState({
      nativeMutationPending: false,
      nativeMutationFailure: message,
      lastDiagnostics: [{ severity: 'error', message }],
    });
    return nativeOnlyResult(message);
  }
}

function busStateFromStores(history: CommandHistoryState): CommandBusState {
  const project = useProjectStore.getState();
  return {
    document: project.document,
    savedDocument: project.savedDocument,
    history,
    graphSnapshot:
      !isAuthoringDependencyGraphServiceStarted() || project.projectInstanceId === null
        ? null
        : authoringDependencyGraphService.currentSnapshot(
            project.projectInstanceId,
            project.projectRevision,
          ),
    projectInstanceId: project.projectInstanceId,
    projectRevision: project.projectRevision,
  };
}

function applyBusResult(
  result: ReturnType<typeof executeCommandCore>,
  kind: 'command' | 'transaction-step' | 'persistence-rollback' | 'undo' | 'redo' | 'replace',
) {
  if (result.document !== undefined) {
    return useProjectStore
      .getState()
      .replaceDocumentFromCommand(
        result.document as JsonValue,
        result.cursor ?? result.state.history.cursor,
        {
          kind,
          affectedPaths: result.affectedPaths ?? result.historyEntry?.affectedPaths ?? ['/'],
        },
      );
  } else if (
    result.state.document !== null &&
    result.state.history.cursor !== useProjectStore.getState().historyCursor
  ) {
    useProjectStore.getState().setHistoryCursor(result.state.history.cursor);
  }
  return true;
}

function rejectedPublicationResult(): CommandExecutionResult {
  return {
    ok: false,
    diagnostics: [
      {
        severity: 'error',
        message: 'The project change was rejected because it is not structurally admissible.',
      },
    ],
    projectChanged: false,
  };
}

function persistenceBusyResult(): CommandExecutionResult {
  return {
    ok: false,
    diagnostics: [
      {
        severity: 'error',
        message: 'Wait for the structural project change to finish saving.',
      },
    ],
    projectChanged: false,
  };
}

let structuralPersistenceQueue: Promise<void> = Promise.resolve();

// The UI can dispatch more than one editor intent before the native worker
// responds (typing, numeric steppers, drag commits). Construct each proposal
// against the *latest acknowledged* Project, never a speculative projection.
// The captured session identity keeps queued intents from leaking into a
// different Project, even if its revision happens to match.
const nativeCommandQueues = new Map<string, Promise<void>>();

function queueNativeCommand(
  run: () => Promise<CommandExecutionResult>,
): Promise<CommandExecutionResult> {
  const { projectSessionId, projectInstanceId } = useProjectStore.getState();
  const queueId = `${projectSessionId}:${projectInstanceId}`;
  const perform = async () => {
    const current = useProjectStore.getState();
    if (
      !projectSessionId ||
      !projectInstanceId ||
      current.projectSessionId !== projectSessionId ||
      current.projectInstanceId !== projectInstanceId ||
      useCommandStore.getState().nativeProjectSessionId !== projectSessionId
    )
      return nativeOnlyResult('Queued native command belongs to a superseded Project session.');
    return run();
  };
  const previous = nativeCommandQueues.get(queueId) ?? Promise.resolve();
  const result = previous.then(perform, perform);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  nativeCommandQueues.set(queueId, tail);
  void tail.then(() => {
    if (nativeCommandQueues.get(queueId) === tail) nativeCommandQueues.delete(queueId);
  });
  return result;
}

function commandDiagnostics(
  diagnostics: Array<{ severity: string; message: string; path?: string }>,
) {
  return diagnostics.map((diagnostic) => ({
    severity:
      diagnostic.severity === 'warning'
        ? ('warning' as const)
        : diagnostic.severity === 'info'
          ? ('info' as const)
          : ('error' as const),
    message: diagnostic.message,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
  }));
}

function dispatchPersistenceResult(
  commandId: string,
  result: Awaited<ReturnType<typeof persistAutoCommitPlan>>,
) {
  window.dispatchEvent(
    new CustomEvent('noveltea-structural-persistence-result', {
      detail: { commandId, result },
    }),
  );
}

function rollbackFailedStructuralPersistence(
  entry: CommandHistoryEntry,
  direction: 'forward' | 'undo' | 'redo',
  diagnostics: CommandDiagnostic[],
  result: Awaited<ReturnType<typeof persistAutoCommitPlan>>,
) {
  const state = useCommandStore.getState();
  const busState = busStateFromStores(state.history);
  const rollback = direction === 'undo' ? redoCommandCore(busState) : undoCommandCore(busState);
  if (!applyBusResult(rollback, 'persistence-rollback')) {
    useCommandStore.setState({ persistencePending: false, lastDiagnostics: diagnostics });
    return;
  }
  let history = rollback.state.history;
  if (direction === 'forward') {
    const index = history.entries.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) {
      const entries = history.entries.filter((candidate) => candidate.id !== entry.id);
      history = {
        ...history,
        entries,
        cursor: Math.min(history.cursor, entries.length - 1),
      };
      useProjectStore.getState().setHistoryCursor(history.cursor);
    }
  }
  useCommandStore.setState({
    persistencePending: false,
    lastDiagnostics: diagnostics,
    history,
  });
  if (result.status !== 'cancelled')
    useProjectStore
      .getState()
      .setSaveError(diagnostics[0]?.message ?? 'Structural project persistence failed.');
  dispatchPersistenceResult(entry.id, result);
}

function scheduleStructuralPersistence(
  entry: CommandHistoryEntry,
  direction: 'forward' | 'undo' | 'redo',
) {
  if (!entry.autoCommitPlan) return;
  useCommandStore.setState({ persistencePending: true });
  structuralPersistenceQueue = structuralPersistenceQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const result = await persistAutoCommitPlan(entry.id, entry.autoCommitPlan!, direction);
        const diagnostics = commandDiagnostics(result.diagnostics);
        const state = useCommandStore.getState();
        if (result.status === 'persisted') {
          const project = useProjectStore.getState();
          if (isAuthoringDependencyGraphServiceStarted() && project.projectInstanceId !== null) {
            await authoringDependencyGraphService.waitForCurrentSnapshot(
              project.projectInstanceId,
              project.projectRevision,
            );
          }
          useCommandStore.setState({ persistencePending: false, lastDiagnostics: diagnostics });
          dispatchPersistenceResult(entry.id, result);
          return;
        }
        if (result.status === 'converted-to-manual-save' && direction === 'forward') {
          useCommandStore.setState({
            persistencePending: false,
            lastDiagnostics: diagnostics,
            history: {
              ...state.history,
              entries: state.history.entries.map((candidate) =>
                candidate.id === entry.id
                  ? { ...candidate, persistencePolicy: 'manual-save', autoCommitPlan: undefined }
                  : candidate,
              ),
            },
          });
          dispatchPersistenceResult(entry.id, result);
          return;
        }
        rollbackFailedStructuralPersistence(entry, direction, diagnostics, result);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Structural project persistence failed.';
        const result = {
          status: 'failed' as const,
          diagnostics: [
            {
              severity: 'error' as const,
              category: 'Project structural persistence',
              path: entry.affectedPaths[0] ?? '/',
              message,
            },
          ],
        };
        rollbackFailedStructuralPersistence(
          entry,
          direction,
          commandDiagnostics(result.diagnostics),
          result,
        );
      }
    });
}

export function flushStructuralCommandPersistence(): Promise<void> {
  return structuralPersistenceQueue;
}

export const useCommandStore = create<CommandStoreState>()((set, get) => ({
  history: createInitialCommandHistoryState(),
  lastDiagnostics: [],
  persistencePending: false,
  nativeWorkingRevision: null,
  nativeProjectSessionId: null,
  nativeProjectionRevision: null,
  nativeMutationPending: false,
  nativeMutationFailure: null,
  enableNativeCommandMode: (workingRevision) => {
    if (!Number.isSafeInteger(workingRevision) || workingRevision < 0)
      throw new Error('Invalid initial native Project revision.');
    const projectSessionId = useProjectStore.getState().projectSessionId;
    if (!projectSessionId)
      throw new Error('Cannot enable native commands without an active Project.');
    set({
      nativeProjectSessionId: projectSessionId,
      nativeWorkingRevision: workingRevision,
      nativeProjectionRevision: useProjectStore.getState().projectRevision,
      nativeMutationPending: false,
      nativeMutationFailure: null,
    });
  },
  executeCommandAsync: async (request) => {
    if (get().nativeWorkingRevision === null) {
      if (get().persistencePending) {
        const { projectSessionId, projectInstanceId } = useProjectStore.getState();
        await flushStructuralCommandPersistence();
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== projectSessionId ||
          current.projectInstanceId !== projectInstanceId ||
          get().nativeWorkingRevision !== null
        )
          return nativeOnlyResult('Project changed while awaiting structural persistence.');
      }
      return get().executeCommand(request);
    }
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      if (get().history.activeTransaction)
        return Promise.resolve(
          nativeOnlyResult('Native Project transactions require asynchronous commit support.'),
        );
      const proposal = executeCommandCore(busStateFromStores(get().history), request);
      return submitNativeCommand(
        proposal,
        proposal.historyEntry?.patches ?? [],
        'command',
        layoutSourceFromRequest(request),
      );
    });
  },
  saveNativeUnitAsync: async (saveUnitIds, expectedProjectRevision, options, onAcknowledged) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native Project Save requires native authoring mode.');
    return queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        project.projectRevision !== expectedProjectRevision ||
        state.nativeProjectionRevision !== project.projectRevision
      )
        return nativeOnlyResult('Project changed before its native Save could begin.');
      set({ nativeMutationPending: true });
      try {
        const saved = await window.noveltea.nativeProjectSaveUnit(
          session,
          revision,
          saveUnitIds,
          options,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native Project Save completed after its editor session changed.');
        if (!saved.accepted) {
          const rejected = nativeOnlyResult(saved.error || 'Native scoped Save rejected.');
          set({ nativeMutationPending: false, lastDiagnostics: rejected.diagnostics });
          return rejected;
        }
        if (saved.snapshot.workingRevision < revision)
          throw new Error('Native Save acknowledged an older working Project revision.');
        // Adopt the scoped saved baseline *while the shared mutation queue is
        // still held*. Otherwise a queued native editor command could publish
        // between the physical Save acknowledgment and the recovery rebase.
        onAcknowledged?.(saved);
        set({
          nativeMutationPending: false,
          nativeWorkingRevision: saved.snapshot.workingRevision,
          lastDiagnostics: [],
        });
        return { ok: true, projectChanged: false, diagnostics: [] };
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native Save was superseded by another Project session.');
        const message = error instanceof Error ? error.message : 'Native Project Save failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
  },
  saveNativeTextAsync: async (path, text, diskRevision, expectedProjectRevision) => {
    if (get().nativeWorkingRevision === null)
      return { ok: false, error: 'Native source Save requires native authoring mode.' };
    const result = await queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        state.nativeProjectionRevision !== project.projectRevision ||
        project.projectRevision !== expectedProjectRevision
      )
        return nativeOnlyResult('Project changed before its native source Save could begin.');
      set({ nativeMutationPending: true });
      try {
        const saved = await window.noveltea.nativeProjectSaveText(
          session,
          revision,
          path,
          diskRevision,
          text,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native text Save completed after the Project changed.');
        if (saved.snapshot.workingRevision < revision)
          throw new Error('Native text Save acknowledged a stale revision.');
        if (saved.accepted && !saved.textSourceDiskRevisions?.[path])
          throw new Error('Native text Save omitted its committed exact source revision.');
        set({
          nativeWorkingRevision: saved.snapshot.workingRevision,
          nativeMutationPending: false,
          lastDiagnostics: saved.accepted
            ? []
            : [{ severity: 'error', message: saved.error || 'Native source Save refused.' }],
        });
        if (!saved.accepted) return nativeOnlyResult(saved.error || 'Native source Save refused.');
        return {
          ok: true,
          projectChanged: false,
          diagnostics: [],
          contentHash: saved.textSourceDiskRevisions![path],
        };
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native text Save belongs to a superseded session.');
        const message = error instanceof Error ? error.message : 'Native text Save failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
    return {
      ok: result.ok,
      ...(result.ok && 'contentHash' in result && typeof result.contentHash === 'string'
        ? { contentHash: result.contentHash }
        : { error: result.diagnostics[0]?.message ?? 'Native source Save failed.' }),
    };
  },
  stageNativeTextAsync: async (path, text, diskRevision, expectedProjectRevision) => {
    if (get().nativeWorkingRevision === null)
      return nativeOnlyResult('Native source staging requires native authoring mode.');
    return queueNativeCommand(async () => {
      const state = get();
      const project = useProjectStore.getState();
      const session = project.projectSessionId;
      const instance = project.projectInstanceId;
      const revision = state.nativeWorkingRevision;
      if (state.nativeMutationFailure) return nativeOnlyResult(state.nativeMutationFailure);
      if (
        revision === null ||
        !session ||
        !instance ||
        state.nativeProjectSessionId !== session ||
        state.nativeProjectionRevision !== project.projectRevision ||
        expectedProjectRevision !== project.projectRevision
      )
        return nativeOnlyResult('Native Project changed before source staging began.');
      set({ nativeMutationPending: true });
      try {
        const staged = await window.noveltea.nativeProjectStageText(
          session,
          revision,
          path,
          diskRevision,
          text,
        );
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== session ||
          current.projectInstanceId !== instance ||
          current.projectRevision !== expectedProjectRevision ||
          get().nativeWorkingRevision !== revision
        )
          throw new Error('Native source stage completed after the Project changed.');
        if (staged.snapshot.workingRevision < revision)
          throw new Error('Native source stage acknowledged an old working revision.');
        if (staged.accepted && staged.textSourceStaged === undefined)
          throw new Error('Native source stage acknowledgment lacked staging evidence.');
        set({
          nativeMutationPending: false,
          nativeWorkingRevision: staged.snapshot.workingRevision,
          lastDiagnostics: staged.accepted
            ? []
            : [{ severity: 'error', message: staged.error || 'Native source stage rejected.' }],
        });
        return staged.accepted
          ? { ok: true, projectChanged: false, diagnostics: [] }
          : nativeOnlyResult(staged.error || 'Native source stage rejected.');
      } catch (error) {
        const current = useProjectStore.getState();
        if (current.projectSessionId !== session || current.projectInstanceId !== instance)
          return nativeOnlyResult('Native source stage belongs to a superseded Project.');
        const message = error instanceof Error ? error.message : 'Native source stage failed.';
        set({
          nativeMutationPending: false,
          nativeMutationFailure: message,
          lastDiagnostics: [{ severity: 'error', message }],
        });
        return nativeOnlyResult(message);
      }
    });
  },
  executeCommandBatchAsync: async (transaction, requests) => {
    if (get().nativeWorkingRevision === null) {
      if (get().persistencePending) {
        const { projectSessionId, projectInstanceId } = useProjectStore.getState();
        await flushStructuralCommandPersistence();
        const current = useProjectStore.getState();
        if (
          current.projectSessionId !== projectSessionId ||
          current.projectInstanceId !== projectInstanceId ||
          get().nativeWorkingRevision !== null
        )
          return nativeOnlyResult('Project changed while awaiting structural persistence.');
      }
      if (get().persistencePending) return persistenceBusyResult();
      if (get().history.activeTransaction)
        return nativeOnlyResult('Another editor transaction is still active.');
      get().beginTransaction(transaction);
      if (!get().history.activeTransaction)
        return nativeOnlyResult('Cannot start editor command transaction.');
      for (const request of requests) {
        const step = get().executeCommand(request);
        if (!step.ok) {
          get().cancelTransaction();
          return step;
        }
      }
      const committed = get().commitTransaction();
      if (!committed.ok && get().history.activeTransaction) get().cancelTransaction();
      return committed;
    }
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      if (get().history.activeTransaction)
        return Promise.resolve(nativeOnlyResult('Another Project transaction is active.'));
      const initial = busStateFromStores(get().history);
      let working = beginTransactionCore(initial, transaction);
      if (!working.history.activeTransaction)
        return Promise.resolve(nativeOnlyResult('Cannot start native command transaction.'));
      for (const request of requests) {
        const step = executeCommandCore(working, request);
        if (!step.ok)
          return Promise.resolve({ ...step, document: undefined, projectChanged: false });
        working = step.state;
      }
      const proposal = commitTransactionCore(working);
      return submitNativeCommand(
        proposal,
        proposal.historyEntry?.patches ?? [],
        'command',
        Object.assign({}, ...requests.map(layoutSourceFromRequest)),
      );
    });
  },
  undoAsync: async () => {
    if (get().nativeWorkingRevision === null) return get().undo();
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = undoCommandCore(busStateFromStores(get().history));
      return submitNativeCommand(proposal, proposal.historyEntry?.inversePatches ?? [], 'undo');
    });
  },
  redoAsync: async () => {
    if (get().nativeWorkingRevision === null) return get().redo();
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure)
        return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = redoCommandCore(busStateFromStores(get().history));
      return submitNativeCommand(proposal, proposal.historyEntry?.patches ?? [], 'redo');
    });
  },
  executeCommand: (request) => {
    if (get().nativeWorkingRevision !== null)
      return nativeOnlyResult('Native Project commands must use executeCommandAsync.');
    if (get().persistencePending) return persistenceBusyResult();
    const result = executeCommandCore(busStateFromStores(get().history), request);
    const kind = get().history.activeTransaction ? 'transaction-step' : 'command';
    if (!applyBusResult(result, kind)) return rejectedPublicationResult();
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'forward');
    }
    return result;
  },
  undo: () => {
    if (get().nativeWorkingRevision !== null)
      return nativeOnlyResult('Native Project undo must use undoAsync.');
    if (get().persistencePending) return persistenceBusyResult();
    const result = undoCommandCore(busStateFromStores(get().history));
    if (!applyBusResult(result, 'undo')) return rejectedPublicationResult();
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.projectChanged && result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'undo');
    }
    return result;
  },
  redo: () => {
    if (get().nativeWorkingRevision !== null)
      return nativeOnlyResult('Native Project redo must use redoAsync.');
    if (get().persistencePending) return persistenceBusyResult();
    const result = redoCommandCore(busStateFromStores(get().history));
    if (!applyBusResult(result, 'redo')) return rejectedPublicationResult();
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.projectChanged && result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'redo');
    }
    return result;
  },
  beginTransaction: (request) => {
    if (get().nativeWorkingRevision !== null) return;
    if (get().persistencePending) return;
    const next = beginTransactionCore(busStateFromStores(get().history), request);
    set({ history: next.history, lastDiagnostics: [] });
  },
  commitTransaction: () => {
    if (get().nativeWorkingRevision !== null)
      return nativeOnlyResult('Native Project transactions require asynchronous commit support.');
    if (get().persistencePending) return persistenceBusyResult();
    const result = commitTransactionCore(busStateFromStores(get().history));
    // Transaction steps are already visible publications; commit only finalizes history.
    if (!applyBusResult(result, 'replace')) return rejectedPublicationResult();
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'forward');
    }
    return result;
  },
  cancelTransaction: () => {
    if (get().nativeWorkingRevision !== null) return;
    if (get().persistencePending) return;
    const next = cancelTransactionCore(busStateFromStores(get().history));
    if (next.document !== null) {
      const transaction = get().history.activeTransaction;
      const accepted = useProjectStore
        .getState()
        .replaceDocumentFromCommand(next.document, next.history.cursor, {
          kind: 'transaction-cancel',
          affectedPaths: transaction?.affectedPaths ?? ['/'],
        });
      if (!accepted) return;
    }
    set({ history: next.history, lastDiagnostics: [] });
  },
  resetCommandHistory: () =>
    set((current) => {
      nativeAssetTrashByCommandId.clear();
      nativeLayoutCopyByCommandId.clear();
      // A history reset within a native Project must never silently reactivate
      // the retired TypeScript command writer. Only unloading/switching to a
      // different session can clear native authority.
      const sameSession =
        current.nativeProjectSessionId !== null &&
        current.nativeProjectSessionId === useProjectStore.getState().projectSessionId;
      return {
        history: createInitialCommandHistoryState(),
        lastDiagnostics: [],
        persistencePending: false,
        nativeProjectSessionId: sameSession ? current.nativeProjectSessionId : null,
        nativeWorkingRevision: sameSession ? current.nativeWorkingRevision : null,
        nativeProjectionRevision: sameSession ? current.nativeProjectionRevision : null,
        nativeMutationPending: sameSession ? current.nativeMutationPending : false,
        nativeMutationFailure: sameSession ? current.nativeMutationFailure : null,
      };
    }),
  // Filesystem renames are committed outside the command bus. Old forward/inverse
  // patches can restore paths that no longer exist, including through redo or an
  // active transaction. Invalidate the history at the physical commit boundary.
  invalidateHistoryAfterCommittedFileMove: () => {
    if (get().nativeWorkingRevision !== null) {
      set({
        nativeMutationFailure: 'Legacy filesystem moves cannot update native Project history.',
      });
      return;
    }
    set({ history: createInitialCommandHistoryState(), lastDiagnostics: [] });
    useProjectStore.getState().setHistoryCursor(-1);
  },
  discardSaveUnitHistory: (saveUnitId) => {
    if (get().nativeWorkingRevision !== null) {
      set({
        nativeMutationFailure:
          'Legacy Save-unit history changes are unavailable for native Project.',
      });
      return;
    }
    const history = get().history;
    const removedApplied = history.entries
      .slice(0, history.cursor + 1)
      .filter((entry) => entry.originSaveUnitId === saveUnitId).length;
    const entries = history.entries.filter((entry) => entry.originSaveUnitId !== saveUnitId);
    const cursor = Math.max(-1, history.cursor - removedApplied);
    set({ history: { ...history, entries, cursor } });
    useProjectStore.getState().setHistoryCursor(cursor);
  },
}));

export function selectCanUndo(state: Pick<CommandStoreState, 'history'>) {
  return state.history.cursor >= 0 && !state.history.activeTransaction;
}

export function selectCanRedo(state: Pick<CommandStoreState, 'history'>) {
  return (
    state.history.cursor < state.history.entries.length - 1 && !state.history.activeTransaction
  );
}

export function selectVisibleCommandHistory(
  state: Pick<CommandStoreState, 'history'>,
): CommandHistoryEntry[] {
  return state.history.entries;
}
