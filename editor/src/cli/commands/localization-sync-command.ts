import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { cliDiagnostic } from '../contracts';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags } from './types';

export const localizationSyncCommand: CliCommandDefinition = {
  path: ['localization', 'sync'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--dry-run']);
    if (parsed.positionals.length > 0)
      throw new CliCommandUsageError('localization sync does not accept positional arguments.');
    const dryRun = parsed.flags.has('--dry-run');
    return {
      dryRun,
      mutation: !dryRun,
      async run({ workspace, snapshot }) {
        const result = synchronizeLocalizationMessageTracking(snapshot.project);
        if (!dryRun && result.changed)
          await workspace.write(
            snapshot.projectRoot,
            snapshot.workspaceRevision,
            result.project,
            result.project.editor,
            snapshot.scriptSourcePaths,
            {
              operationLabel: 'cli localization sync',
              targetFiles: ['localization.json'],
              refreshAfterCommit: false,
            },
          );
        const diagnostics = result.unresolved.map((item) =>
          cliDiagnostic(
            'localization.sync.reconciliation-required',
            item.sourcePath,
            `Managed ${item.family.toUpperCase()} Message occurrence ${item.ordinal} is ambiguous and was left untracked.`,
            'warning',
          ),
        );
        return {
          ok: true,
          diagnostics,
          fields: {
            dryRun,
            changed: result.changed,
            materializedMessageIds: result.materializedMessageIds,
            preservedMessageIds: result.preservedMessageIds,
            unresolved: result.unresolved,
            structuredMessageCount: result.structuredMessageCount,
            writes: !dryRun && result.changed ? ['localization.json'] : [],
          },
          humanSuccess: result.changed
            ? dryRun
              ? 'Localization sync found deterministic tracking updates.'
              : 'Localization tracking synchronized.'
            : 'Localization tracking is already synchronized.',
        };
      },
    };
  },
};
