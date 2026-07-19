import { applyJsonPatch } from '@/project/json-patch';
import { buildJsonPointer, parseJsonPointer, type JsonPointer } from '@/project/json-pointer';
import { cloneJsonValue, type JsonValue } from '@/project/json-value';
import { createBuiltinCommandHandlers, labelForCommand } from './builtin-commands';
import type {
  ActiveCommandTransaction,
  CommandDiagnostic,
  CommandExecutionResult,
  CommandHandler,
  CommandHandlerResult,
  CommandHistoryEntry,
  CommandHistoryState,
  CommandRequest,
  CommandTransactionRequest,
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
  return { ...createBuiltinCommandHandlers(), ...registry };
}

function withNoChange(state: CommandBusState, diagnostics: CommandDiagnostic[]): CommandBusResult {
  return { ok: false, diagnostics, projectChanged: false, state };
}

export function canonicalizeAffectedPaths(paths: JsonPointer[]): JsonPointer[] {
  return [...new Set(paths.map((path) => buildJsonPointer(parseJsonPointer(path))))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function validateAttribution(
  request: Pick<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'> & {
    type?: string;
    atomicTransactionGroupId?: string;
  },
): CommandDiagnostic[] {
  const diagnostics: CommandDiagnostic[] = [];
  if (!request.originSaveUnitId?.trim()) {
    diagnostics.push(
      commandError('Mutating commands require an origin save-unit ID.', request.type),
    );
  }
  if (request.persistencePolicy !== 'manual-save' && request.persistencePolicy !== 'auto-commit') {
    diagnostics.push(commandError('Mutating commands require a persistence policy.', request.type));
  }
  if (request.atomicTransactionGroupId !== undefined && !request.atomicTransactionGroupId.trim()) {
    diagnostics.push(commandError('Atomic transaction-group IDs must not be blank.', request.type));
  }
  return diagnostics;
}

function affectedPathsForResult(handled: CommandHandlerResult): JsonPointer[] {
  return canonicalizeAffectedPaths([
    ...handled.patches.map((patch) => patch.path),
    ...(handled.affectedPaths ?? []),
  ]);
}

export function executeCommand(
  state: CommandBusState,
  request: CommandRequest,
  registry?: Record<string, CommandHandler>,
): CommandBusResult {
  const attributionDiagnostics = validateAttribution(request);
  if (attributionDiagnostics.length > 0) return withNoChange(state, attributionDiagnostics);
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
  if (handled.originSaveUnitId && handled.originSaveUnitId !== request.originSaveUnitId) {
    return withNoChange(state, [
      commandError('Command handler changed the request origin save-unit ID.', request.type),
    ]);
  }
  if (handled.persistencePolicy && handled.persistencePolicy !== request.persistencePolicy) {
    return withNoChange(state, [
      commandError('Command handler changed the request persistence policy.', request.type),
    ]);
  }
  if (
    handled.atomicTransactionGroupId &&
    request.atomicTransactionGroupId &&
    handled.atomicTransactionGroupId !== request.atomicTransactionGroupId
  ) {
    return withNoChange(state, [
      commandError(
        'Command handler changed the request atomic transaction-group ID.',
        request.type,
      ),
    ]);
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
    const requestedAtomicTransactionGroupId =
      handled.atomicTransactionGroupId ?? request.atomicTransactionGroupId;
    if (
      transaction.originSaveUnitId !== request.originSaveUnitId ||
      transaction.persistencePolicy !== request.persistencePolicy ||
      (requestedAtomicTransactionGroupId !== undefined &&
        transaction.atomicTransactionGroupId !== requestedAtomicTransactionGroupId)
    ) {
      return withNoChange(state, [
        commandError(
          'All commands in a transaction must share one origin save unit, persistence policy, and atomic transaction-group ID.',
          request.type,
        ),
      ]);
    }
    const affectedPaths = affectedPathsForResult(handled);
    const nextTransaction: ActiveCommandTransaction = {
      ...transaction,
      patches: [...transaction.patches, ...handled.patches],
      inversePatches: [...patched.inversePatches, ...transaction.inversePatches],
      affectedPaths: canonicalizeAffectedPaths([...transaction.affectedPaths, ...affectedPaths]),
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

  const commandId = createCommandId();
  const affectedPaths = affectedPathsForResult(handled);
  const atomicTransactionGroupId =
    handled.atomicTransactionGroupId ??
    request.atomicTransactionGroupId ??
    (affectedPaths.length > 1 ? `atomic:${commandId}` : undefined);
  const historyEntry: CommandHistoryEntry = {
    id: commandId,
    type: request.type,
    label: request.label ?? labelForCommand(request.type),
    timestamp: Date.now(),
    patches: handled.patches,
    inversePatches: patched.inversePatches,
    affectedPaths,
    diagnostics,
    originSaveUnitId: request.originSaveUnitId,
    persistencePolicy: request.persistencePolicy,
    atomicTransactionGroupId,
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

export function beginTransaction(
  state: CommandBusState,
  request: CommandTransactionRequest,
): CommandBusState {
  if (
    state.document === null ||
    state.history.activeTransaction ||
    validateAttribution(request).length > 0
  )
    return state;
  const transactionId = `transaction:${nextTransactionId}`;
  const transaction: ActiveCommandTransaction = {
    id: transactionId,
    label: request.label,
    startedAt: Date.now(),
    baseDocument: cloneJsonValue(state.document),
    patches: [],
    inversePatches: [],
    affectedPaths: [],
    diagnostics: [],
    originSaveUnitId: request.originSaveUnitId,
    persistencePolicy: request.persistencePolicy,
    atomicTransactionGroupId: request.atomicTransactionGroupId ?? transactionId,
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
    originSaveUnitId: transaction.originSaveUnitId,
    persistencePolicy: transaction.persistencePolicy,
    atomicTransactionGroupId: transaction.atomicTransactionGroupId,
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
