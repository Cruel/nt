import type { CliCommandDefinition, CliParsedCommand } from './types';
import { CliCommandUsageError } from './types';

function matchesPath(command: readonly string[], path: readonly string[]): boolean {
  return path.every((segment, index) => command[index] === segment);
}

async function commandDefinitions(
  command: readonly string[],
): Promise<readonly CliCommandDefinition[]> {
  switch (command[0]) {
    case 'asset': {
      const [{ assetAuditCommand }, { assetImportCommand }] = await Promise.all([
        import('./asset-audit-command'),
        import('./asset-import-command'),
      ]);
      return [assetAuditCommand, assetImportCommand];
    }
    case 'entity': {
      const [{ entityCreateCommand }, { entityRenameCommand }, { entityDeleteCommand }] =
        await Promise.all([
          import('./entity-create-command'),
          import('./entity-rename-command'),
          import('./entity-delete-command'),
        ]);
      return [entityCreateCommand, entityRenameCommand, entityDeleteCommand];
    }
    case 'localization': {
      const [sync, reconcile, workflow] = await Promise.all([
        import('./localization-sync-command'),
        import('./localization-reconcile-command'),
        import('./localization-workflow-command'),
      ]);
      return [
        sync.localizationSyncCommand,
        reconcile.localizationReconcileCommand,
        workflow.localizationViewCommand,
        workflow.localizationAcceptCommand,
        workflow.localizationReviewCommand,
      ];
    }
    case 'validate': {
      const { validateCommand } = await import('./validate-command');
      return [validateCommand];
    }
    case 'usages': {
      const { usagesCommand } = await import('./usages-command');
      return [usagesCommand];
    }
    case 'shaders':
    case 'test':
    case 'package': {
      const native = await import('./native-commands');
      return [
        native.shadersCompileCommand,
        native.testRunCommand,
        native.testRunSpecCommand,
        native.testRunUiSpecCommand,
        native.packageExportCommand,
      ];
    }
    case 'platform': {
      const platform = await import('../platform-commands');
      return [platform.platformProfilesCommand, platform.platformExportCommand];
    }
    default:
      return [];
  }
}

export async function parseCliCommand(command: readonly string[]): Promise<CliParsedCommand> {
  const commands = await commandDefinitions(command);
  const definition = commands.find((candidate) => matchesPath(command, candidate.path));
  if (!definition) throw new CliCommandUsageError(`Unknown command path '${command.join(' ')}'.`);
  return definition.parse(command.slice(definition.path.length));
}

export { CliCommandUsageError } from './types';
