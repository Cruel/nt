import type { JsonPatchOperation } from '@/project/json-patch';
import type { JsonPointer } from '@/project/json-pointer';
import type { JsonValue } from '@/project/json-value';

export type CommandSeverity = 'info' | 'warning' | 'error';

export interface CommandDiagnostic {
  severity: CommandSeverity;
  message: string;
  path?: string;
  commandType?: string;
}

export interface CommandRequest<TPayload = unknown> {
  type: string;
  label?: string;
  payload: TPayload;
}

export interface CommandHandlerResult {
  patches: JsonPatchOperation[];
  diagnostics?: CommandDiagnostic[];
  affectedPaths?: JsonPointer[];
}

export interface CommandHandlerContext<TPayload = unknown> {
  document: JsonValue;
  payload: TPayload;
  request: CommandRequest<TPayload>;
}

export type CommandHandler<TPayload = unknown> = (
  context: CommandHandlerContext<TPayload>,
) => CommandHandlerResult;

export interface CommandHistoryEntry {
  id: string;
  type: string;
  label: string;
  timestamp: number;
  patches: JsonPatchOperation[];
  inversePatches: JsonPatchOperation[];
  affectedPaths: JsonPointer[];
  diagnostics: CommandDiagnostic[];
  transactionId?: string;
}

export interface CommandHistoryState {
  entries: CommandHistoryEntry[];
  cursor: number;
  activeTransaction: ActiveCommandTransaction | null;
}

export interface ActiveCommandTransaction {
  id: string;
  label: string;
  startedAt: number;
  baseDocument: JsonValue;
  patches: JsonPatchOperation[];
  inversePatches: JsonPatchOperation[];
  affectedPaths: JsonPointer[];
  diagnostics: CommandDiagnostic[];
}

export interface CommandExecutionResult {
  ok: boolean;
  commandId?: string;
  historyEntry?: CommandHistoryEntry;
  diagnostics: CommandDiagnostic[];
  projectChanged: boolean;
  document?: JsonValue;
  cursor?: number;
}
