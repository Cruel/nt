import { create } from 'zustand';
import { useProjectStore } from '@/project/project-store';
import type { JsonValue } from '@/project/json-value';
import { persistAutoCommitPlan } from '@/project/structural-command-persistence';
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
import { confirmNativeCommand } from './native-command-execution';
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
    options: { keepMine?: boolean; comments?: 'keep' | 'remove' | 'cancel' | 'perEdit' },
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

/** This is the asynchronous production command boundary, not speculative
 * publication followed by an optional worker check. A candidate command,
 * undo or redo remains invisible until native acceptance and value parity. */
async function submitNativeCommand(
  proposal: ReturnType<typeof executeCommandCore>,
  patches: readonly import('@/project/json-patch').JsonPatchOperation[],
  kind: 'command' | 'undo' | 'redo',
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
  const generation = project.projectRevision;
  const instanceId = project.projectInstanceId;
  const historyAtSubmission = state.history;
  useCommandStore.setState({ nativeMutationPending: true });
  try {
    const confirmed = await confirmNativeCommand(
      busStateFromStores(state.history),
      proposal,
      patches,
      projectSessionId,
      revision,
      (sessionId, expected, next) => window.noveltea.nativeProjectPatch(sessionId, expected, next),
    );
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
    useCommandStore.setState({
      history: confirmed.result.state.history,
      nativeWorkingRevision: confirmed.workingRevision,
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
      if (get().nativeMutationFailure) return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      if (get().history.activeTransaction)
        return Promise.resolve(nativeOnlyResult('Native Project transactions require asynchronous commit support.'));
      if (request.persistencePolicy !== 'manual-save')
        return Promise.resolve(nativeOnlyResult('Native auto-commit is unavailable until native Save is active.'));
      const proposal = executeCommandCore(busStateFromStores(get().history), request);
      return submitNativeCommand(proposal, proposal.historyEntry?.patches ?? [], 'command');
    });
  },
  saveNativeUnitAsync: async (saveUnitIds, expectedProjectRevision, options) => {
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
          session, revision, saveUnitIds, options,
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
      if (transaction.persistencePolicy !== 'manual-save')
        return Promise.resolve(nativeOnlyResult('Native auto-commit is unavailable until native Save is active.'));
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
      return submitNativeCommand(proposal, proposal.historyEntry?.patches ?? [], 'command');
    });
  },
  undoAsync: async () => {
    if (get().nativeWorkingRevision === null) return get().undo();
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure) return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = undoCommandCore(busStateFromStores(get().history));
      if (proposal.historyEntry?.autoCommitPlan)
        return Promise.resolve(nativeOnlyResult('Native undo of auto-committed commands requires native Save.'));
      return submitNativeCommand(proposal, proposal.historyEntry?.inversePatches ?? [], 'undo');
    });
  },
  redoAsync: async () => {
    if (get().nativeWorkingRevision === null) return get().redo();
    return queueNativeCommand(() => {
      if (get().nativeMutationFailure) return Promise.resolve(nativeOnlyResult(get().nativeMutationFailure!));
      const proposal = redoCommandCore(busStateFromStores(get().history));
      if (proposal.historyEntry?.autoCommitPlan)
        return Promise.resolve(nativeOnlyResult('Native redo of auto-committed commands requires native Save.'));
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
