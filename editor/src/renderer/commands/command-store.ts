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

interface CommandStoreState {
  history: CommandHistoryState;
  lastDiagnostics: CommandDiagnostic[];
  persistencePending: boolean;
  executeCommand: (request: CommandRequest) => CommandExecutionResult;
  undo: () => CommandExecutionResult;
  redo: () => CommandExecutionResult;
  beginTransaction: (request: CommandTransactionRequest) => void;
  commitTransaction: () => CommandExecutionResult;
  cancelTransaction: () => void;
  resetCommandHistory: () => void;
}

function busStateFromStores(history: CommandHistoryState): CommandBusState {
  const project = useProjectStore.getState();
  return { document: project.document, savedDocument: project.savedDocument, history };
}

function applyBusResult(result: ReturnType<typeof executeCommandCore>) {
  if (result.document !== undefined) {
    useProjectStore
      .getState()
      .replaceDocumentFromCommand(
        result.document as JsonValue,
        result.cursor ?? result.state.history.cursor,
      );
  } else if (
    result.state.document !== null &&
    result.state.history.cursor !== useProjectStore.getState().historyCursor
  ) {
    useProjectStore.getState().setHistoryCursor(result.state.history.cursor);
  }
  return result;
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
  applyBusResult(rollback);
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
  executeCommand: (request) => {
    if (get().persistencePending) return persistenceBusyResult();
    const result = executeCommandCore(busStateFromStores(get().history), request);
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'forward');
    }
    return result;
  },
  undo: () => {
    if (get().persistencePending) return persistenceBusyResult();
    const result = undoCommandCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.projectChanged && result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'undo');
    }
    return result;
  },
  redo: () => {
    if (get().persistencePending) return persistenceBusyResult();
    const result = redoCommandCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.projectChanged && result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'redo');
    }
    return result;
  },
  beginTransaction: (request) => {
    if (get().persistencePending) return;
    const next = beginTransactionCore(busStateFromStores(get().history), request);
    set({ history: next.history, lastDiagnostics: [] });
  },
  commitTransaction: () => {
    if (get().persistencePending) return persistenceBusyResult();
    const result = commitTransactionCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    if (result.historyEntry?.autoCommitPlan) {
      scheduleStructuralPersistence(result.historyEntry, 'forward');
    }
    return result;
  },
  cancelTransaction: () => {
    if (get().persistencePending) return;
    const next = cancelTransactionCore(busStateFromStores(get().history));
    if (next.document !== null) {
      useProjectStore.getState().replaceDocumentFromCommand(next.document, next.history.cursor);
    }
    set({ history: next.history, lastDiagnostics: [] });
  },
  resetCommandHistory: () =>
    set({
      history: createInitialCommandHistoryState(),
      lastDiagnostics: [],
      persistencePending: false,
    }),
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
