import { assetAuditCommand } from './asset-audit-command';
import { assetImportCommand } from './asset-import-command';
import { entityCreateCommand } from './entity-create-command';
import { entityDeleteCommand } from './entity-delete-command';
import { entityRenameCommand } from './entity-rename-command';
import { localizationReconcileCommand } from './localization-reconcile-command';
import { localizationSyncCommand } from './localization-sync-command';
import {
  localizationAcceptCommand,
  localizationReviewCommand,
  localizationViewCommand,
} from './localization-workflow-command';
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
import { platformExportCommand, platformProfilesCommand } from '../platform-commands';

const commands: readonly CliCommandDefinition[] = Object.freeze([
  shadersCompileCommand,
  testRunCommand,
  testRunSpecCommand,
  testRunUiSpecCommand,
  packageExportCommand,
  platformProfilesCommand,
  platformExportCommand,
  assetAuditCommand,
  assetImportCommand,
  entityCreateCommand,
  entityRenameCommand,
  entityDeleteCommand,
  localizationSyncCommand,
  localizationReconcileCommand,
  localizationViewCommand,
  localizationAcceptCommand,
  localizationReviewCommand,
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
