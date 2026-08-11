import { CliCommandUsageError } from './types';

export function validateAgentSyncCommand(command: readonly string[]): void {
  if (command.length !== 2)
    throw new CliCommandUsageError("'agent sync' does not accept command arguments.");
}
