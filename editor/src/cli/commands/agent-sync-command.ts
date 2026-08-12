import { CliCommandUsageError } from './types';

export function parseAgentSyncCommand(command: readonly string[]): Readonly<{ fix: boolean }> {
  if (command.length === 2) return { fix: false };
  if (command.length === 3 && command[2] === '--fix') return { fix: true };
  throw new CliCommandUsageError("'agent sync' accepts only the optional '--fix' flag.");
}
