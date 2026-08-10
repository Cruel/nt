import { agentSyncCommand } from './agent-sync-command';
import { entityCreateCommand } from './entity-create-command';
import { entityDeleteCommand } from './entity-delete-command';
import { entityRenameCommand } from './entity-rename-command';
import type { CliCommandDefinition, CliCommandInvocation } from './types';
import { CliCommandUsageError } from './types';
import { usagesCommand } from './usages-command';
import { validateCommand } from './validate-command';
import {
  packageExportCommand,
  shadersCompileCommand,
  testRunCommand,
  testRunSpecCommand,
  testRunUiSpecCommand,
} from './native-commands';

const commands: readonly CliCommandDefinition[] = Object.freeze([
  agentSyncCommand,
  shadersCompileCommand,
  testRunCommand,
  testRunSpecCommand,
  testRunUiSpecCommand,
  packageExportCommand,
  entityCreateCommand,
  entityRenameCommand,
  entityDeleteCommand,
  validateCommand,
  usagesCommand,
]);

function matchesPath(command: readonly string[], path: readonly string[]): boolean {
  return path.every((segment, index) => command[index] === segment);
}

export function parseCliCommand(command: readonly string[]): CliCommandInvocation {
  const definition = commands.find((candidate) => matchesPath(command, candidate.path));
  if (!definition) throw new CliCommandUsageError(`Unknown command path '${command.join(' ')}'.`);
  return definition.parse(command.slice(definition.path.length));
}

export { CliCommandUsageError } from './types';
