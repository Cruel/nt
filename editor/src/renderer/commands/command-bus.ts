import { applyJsonPatch } from '@/project/json-patch';
import { cloneJsonValue, type JsonValue } from '@/project/json-value';
import { createBuiltinCommandHandlers, labelForCommand } from './builtin-commands';
import type {
  ActiveCommandTransaction,
  CommandDiagnostic,
  CommandExecutionResult,
  CommandHandler,
  CommandHistoryEntry,
  CommandHistoryState,
  CommandRequest,
} from './command-types';

export interface CommandBusState {
  document: JsonValue | null;
  history: CommandHistoryState;
}

export interface CommandBusResult extends CommandExecutionResult {
  state: CommandBusState;
}

let nextCommandId = 1;
let nextTransactionId = 1;

function createCommandId(prefix = 'command'): string {
  const id = `${prefix}:${nextCommandId}`;
  nextCommandId += 1;
  return id;
}

export function resetCommandIdsForTests() {
  nextCommandId = 1;
  nextTransactionId = 1;
}

export function createInitialCommandHistoryState(): CommandHistoryState {
  return { entries: [], cursor: -1, activeTransaction: null };
}

export function createInitialCommandBusState(document: JsonValue | null = null): CommandBusState {
  return {
    document: document === null ? null : cloneJsonValue(document),
    history: createInitialCommandHistoryState(),
  };
}

function commandError(message: string, commandType?: string): CommandDiagnostic {
  return { severity: 'error', message, commandType };
}

function hasError(diagnostics: CommandDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function registryWithBuiltins(
  registry?: Record<string, CommandHandler>,
): Record<string, CommandHandler> {
  return { ...createBuiltinCommandHandlers(), ...(registry ?? {}) };
}

function withNoChange(state: CommandBusState, diagnostics: CommandDiagnostic[]): CommandBusResult {
  return { ok: false, diagnostics, projectChanged: false, state };
}

export function executeCommand(
  state: CommandBusState,
  request: CommandRequest,
  registry?: Record<string, CommandHandler>,
): CommandBusResult {
  if (state.document === null) {
    return withNoChange(state, [commandError('No project is loaded.', request.type)]);
  }
  const handler = registryWithBuiltins(registry)[request.type];
  if (!handler) {
    return withNoChange(state, [commandError(`Unknown command '${request.type}'.`, request.type)]);
  }

  const handled = handler({ document: state.document, payload: request.payload, request });
  const diagnostics = (handled.diagnostics ?? []).map((diagnostic) => ({
    ...diagnostic,
    commandType: diagnostic.commandType ?? request.type,
  }));
  if (hasError(diagnostics)) {
    return withNoChange(state, diagnostics);
  }
  if (handled.patches.length === 0) {
    return { ok: true, diagnostics, projectChanged: false, state };
  }

  let patched: ReturnType<typeof applyJsonPatch>;
  try {
    patched = applyJsonPatch(state.document, handled.patches);
  } catch (error) {
    return withNoChange(state, [
      commandError(error instanceof Error ? error.message : 'Command patch failed.', request.type),
    ]);
  }

  if (state.history.activeTransaction) {
    const transaction = state.history.activeTransaction;
    const nextTransaction: ActiveCommandTransaction = {
      ...transaction,
      patches: [...transaction.patches, ...handled.patches],
      inversePatches: [...patched.inversePatches, ...transaction.inversePatches],
      affectedPaths: [
        ...transaction.affectedPaths,
        ...(handled.affectedPaths ?? handled.patches.map((patch) => patch.path)),
      ],
      diagnostics: [...transaction.diagnostics, ...diagnostics],
    };
    const nextState: CommandBusState = {
      document: patched.document,
      history: { ...state.history, activeTransaction: nextTransaction },
    };
    return {
      ok: true,
      diagnostics,
      projectChanged: true,
      document: patched.document,
      state: nextState,
    };
  }

  const historyEntry: CommandHistoryEntry = {
    id: createCommandId(),
    type: request.type,
    label: request.label ?? labelForCommand(request.type),
    timestamp: Date.now(),
    patches: handled.patches,
    inversePatches: patched.inversePatches,
    affectedPaths: handled.affectedPaths ?? handled.patches.map((patch) => patch.path),
    diagnostics,
  };
  const entries = [...state.history.entries.slice(0, state.history.cursor + 1), historyEntry];
  const cursor = entries.length - 1;
  const nextState: CommandBusState = {
    document: patched.document,
    history: { ...state.history, entries, cursor },
  };
  return {
    ok: true,
    commandId: historyEntry.id,
    historyEntry,
    diagnostics,
    projectChanged: true,
    document: patched.document,
    cursor,
    state: nextState,
  };
}

export function undoCommand(state: CommandBusState): CommandBusResult {
  const entry = state.history.entries[state.history.cursor];
  if (state.document === null) {
    return withNoChange(state, [commandError('No project is loaded.')]);
  }
  if (!entry) {
    return {
      ok: true,
      diagnostics: [{ severity: 'info', message: 'Nothing to undo.' }],
      projectChanged: false,
      state,
    };
  }
  try {
    const patched = applyJsonPatch(state.document, entry.inversePatches);
    const cursor = state.history.cursor - 1;
    const nextState = {
      document: patched.document,
      history: { ...state.history, cursor },
    };
    return {
      ok: true,
      commandId: entry.id,
      historyEntry: entry,
      diagnostics: [],
      projectChanged: true,
      document: patched.document,
      cursor,
      state: nextState,
    };
  } catch (error) {
    return withNoChange(state, [
      commandError(error instanceof Error ? error.message : 'Undo failed.'),
    ]);
  }
}

export function redoCommand(state: CommandBusState): CommandBusResult {
  const entry = state.history.entries[state.history.cursor + 1];
  if (state.document === null) {
    return withNoChange(state, [commandError('No project is loaded.')]);
  }
  if (!entry) {
    return {
      ok: true,
      diagnostics: [{ severity: 'info', message: 'Nothing to redo.' }],
      projectChanged: false,
      state,
    };
  }
  try {
    const patched = applyJsonPatch(state.document, entry.patches);
    const cursor = state.history.cursor + 1;
    const nextState = {
      document: patched.document,
      history: { ...state.history, cursor },
    };
    return {
      ok: true,
      commandId: entry.id,
      historyEntry: entry,
      diagnostics: [],
      projectChanged: true,
      document: patched.document,
      cursor,
      state: nextState,
    };
  } catch (error) {
    return withNoChange(state, [
      commandError(error instanceof Error ? error.message : 'Redo failed.'),
    ]);
  }
}

export function beginTransaction(state: CommandBusState, label: string): CommandBusState {
  if (state.document === null || state.history.activeTransaction) return state;
  const transaction: ActiveCommandTransaction = {
    id: `transaction:${nextTransactionId}`,
    label,
    startedAt: Date.now(),
    baseDocument: cloneJsonValue(state.document),
    patches: [],
    inversePatches: [],
    affectedPaths: [],
    diagnostics: [],
  };
  nextTransactionId += 1;
  return { ...state, history: { ...state.history, activeTransaction: transaction } };
}

export function cancelTransaction(state: CommandBusState): CommandBusState {
  const transaction = state.history.activeTransaction;
  if (!transaction) return state;
  return {
    document: cloneJsonValue(transaction.baseDocument),
    history: { ...state.history, activeTransaction: null },
  };
}

export function commitTransaction(state: CommandBusState): CommandBusResult {
  const transaction = state.history.activeTransaction;
  if (!transaction) {
    return {
      ok: true,
      diagnostics: [{ severity: 'info', message: 'No active transaction.' }],
      projectChanged: false,
      state,
    };
  }
  if (transaction.patches.length === 0) {
    const nextState = { ...state, history: { ...state.history, activeTransaction: null } };
    return {
      ok: true,
      diagnostics: [{ severity: 'info', message: 'Transaction had no changes.' }],
      projectChanged: false,
      state: nextState,
    };
  }
  const historyEntry: CommandHistoryEntry = {
    id: createCommandId('transaction'),
    type: 'transaction',
    label: transaction.label,
    timestamp: Date.now(),
    patches: transaction.patches,
    inversePatches: transaction.inversePatches,
    affectedPaths: transaction.affectedPaths,
    diagnostics: transaction.diagnostics,
    transactionId: transaction.id,
  };
  const entries = [...state.history.entries.slice(0, state.history.cursor + 1), historyEntry];
  const cursor = entries.length - 1;
  const nextState: CommandBusState = {
    document: state.document,
    history: { entries, cursor, activeTransaction: null },
  };
  return {
    ok: true,
    commandId: historyEntry.id,
    historyEntry,
    diagnostics: transaction.diagnostics,
    projectChanged: true,
    document: state.document ?? undefined,
    cursor,
    state: nextState,
  };
}
