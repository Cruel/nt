import {
  beginTransaction as beginTransactionCore,
  cancelTransaction,
  commitTransaction,
  createInitialCommandBusState,
  createInitialCommandHistoryState,
  executeCommand as executeCommandCore,
  redoCommand,
  resetCommandIdsForTests,
  undoCommand,
  type CommandBusState,
} from '@/commands/command-bus';
import type {
  CommandHandler,
  CommandRequest,
  CommandTransactionRequest,
} from '@/commands/command-types';

export {
  cancelTransaction,
  commitTransaction,
  createInitialCommandBusState,
  createInitialCommandHistoryState,
  redoCommand,
  resetCommandIdsForTests,
  undoCommand,
};

type TestCommandRequest = Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'> &
  Partial<Pick<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>>;

export function executeCommand(
  state: CommandBusState,
  request: TestCommandRequest,
  registry?: Record<string, CommandHandler>,
) {
  const transaction = state.history.activeTransaction;
  return executeCommandCore(
    state,
    {
      originSaveUnitId: transaction?.originSaveUnitId ?? 'test:save-unit',
      persistencePolicy: transaction?.persistencePolicy ?? 'manual-save',
      ...request,
    },
    registry,
  );
}

export function beginTransaction(
  state: CommandBusState,
  request: string | CommandTransactionRequest,
) {
  return beginTransactionCore(
    state,
    typeof request === 'string'
      ? {
          label: request,
          originSaveUnitId: 'test:transaction',
          persistencePolicy: 'manual-save',
        }
      : request,
  );
}
