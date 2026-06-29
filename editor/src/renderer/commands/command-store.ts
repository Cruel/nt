import { create } from 'zustand';
import { useProjectStore } from '@/project/project-store';
import type { JsonValue } from '@/project/json-value';
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
import type { CommandDiagnostic, CommandExecutionResult, CommandHistoryEntry, CommandHistoryState, CommandRequest } from './command-types';

interface CommandStoreState {
  history: CommandHistoryState;
  lastDiagnostics: CommandDiagnostic[];
  executeCommand: (request: CommandRequest) => CommandExecutionResult;
  undo: () => CommandExecutionResult;
  redo: () => CommandExecutionResult;
  beginTransaction: (label: string) => void;
  commitTransaction: () => CommandExecutionResult;
  cancelTransaction: () => void;
  resetCommandHistory: () => void;
}

function busStateFromStores(history: CommandHistoryState): CommandBusState {
  return { document: useProjectStore.getState().document, history };
}

function applyBusResult(result: ReturnType<typeof executeCommandCore>) {
  if (result.document !== undefined) {
    useProjectStore
      .getState()
      .replaceDocumentFromCommand(result.document as JsonValue, result.cursor ?? result.state.history.cursor);
  } else if (result.state.document !== null && result.state.history.cursor !== useProjectStore.getState().historyCursor) {
    useProjectStore.getState().setHistoryCursor(result.state.history.cursor);
  }
  return result;
}

export const useCommandStore = create<CommandStoreState>()((set, get) => ({
  history: createInitialCommandHistoryState(),
  lastDiagnostics: [],
  executeCommand: (request) => {
    const result = executeCommandCore(busStateFromStores(get().history), request);
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    return result;
  },
  undo: () => {
    const result = undoCommandCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    return result;
  },
  redo: () => {
    const result = redoCommandCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    return result;
  },
  beginTransaction: (label) => {
    const next = beginTransactionCore(busStateFromStores(get().history), label);
    set({ history: next.history, lastDiagnostics: [] });
  },
  commitTransaction: () => {
    const result = commitTransactionCore(busStateFromStores(get().history));
    applyBusResult(result);
    set({ history: result.state.history, lastDiagnostics: result.diagnostics });
    return result;
  },
  cancelTransaction: () => {
    const next = cancelTransactionCore(busStateFromStores(get().history));
    if (next.document !== null) {
      useProjectStore.getState().replaceDocumentFromCommand(next.document, next.history.cursor);
    }
    set({ history: next.history, lastDiagnostics: [] });
  },
  resetCommandHistory: () => set({ history: createInitialCommandHistoryState(), lastDiagnostics: [] }),
}));

export function selectCanUndo(state: Pick<CommandStoreState, 'history'>) {
  return state.history.cursor >= 0 && !state.history.activeTransaction;
}

export function selectCanRedo(state: Pick<CommandStoreState, 'history'>) {
  return state.history.cursor < state.history.entries.length - 1 && !state.history.activeTransaction;
}

export function selectVisibleCommandHistory(state: Pick<CommandStoreState, 'history'>): CommandHistoryEntry[] {
  return state.history.entries;
}
