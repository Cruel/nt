import {
  beginTransaction as beginTransactionCore,
  cancelTransaction,
  commitTransaction,
  createInitialCommandBusState as createInitialCommandBusStateCore,
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
import { buildAuthoringDependencyGraph } from '../../shared/authoring-dependency-graph';
import { authoringProjectSchema } from '../../shared/project-schema/authoring-project';
import type { JsonValue } from '@/project/json-value';

export {
  cancelTransaction,
  commitTransaction,
  createInitialCommandHistoryState,
  redoCommand,
  resetCommandIdsForTests,
  undoCommand,
};

function withCurrentGraph(state: CommandBusState): CommandBusState {
  if (state.document === null) return state;
  const project = authoringProjectSchema.safeParse(state.document);
  if (!project.success) return state;
  const projectInstanceId = state.projectInstanceId ?? 'test:command-bus';
  const projectRevision = state.projectRevision ?? 1;
  return {
    ...state,
    projectInstanceId,
    projectRevision,
    graphSnapshot: {
      projectInstanceId,
      projectRevision,
      graphRevision: projectRevision,
      graph: buildAuthoringDependencyGraph(project.data),
    },
  };
}

export function createInitialCommandBusState(
  document: JsonValue | null = null,
  savedDocument: JsonValue | null = document,
): CommandBusState {
  return withCurrentGraph(createInitialCommandBusStateCore(document, savedDocument));
}

type TestCommandRequest = Omit<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'> &
  Partial<Pick<CommandRequest, 'originSaveUnitId' | 'persistencePolicy'>>;

export function executeCommand(
  state: CommandBusState,
  request: TestCommandRequest,
  registry?: Record<string, CommandHandler>,
) {
  const transaction = state.history.activeTransaction;
  return executeCommandCore(
    withCurrentGraph(state),
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
