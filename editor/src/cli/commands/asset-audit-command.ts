import type { CliSemanticResult } from '../semantic-project';
import { assetAuditProjectPreparationIntent } from '../project-preparation';
import type { CliCommandDefinition, CliScopedCommandContext } from './types';
import { CliCommandUsageError } from './types';

function auditAssetDirectory(context: CliScopedCommandContext): CliSemanticResult {
  const tracked = new Set(
    Object.values(context.preparation.assets).flatMap((record) =>
      record.data.source.type === 'project-file' ? [record.data.source.path] : [],
    ),
  );
  const untrackedFiles = context.preparation.assetFilesystemInventory.filter(
    ({ projectRelativePath }) => !tracked.has(projectRelativePath),
  );
  return {
    ok: true,
    diagnostics: [],
    humanSuccess:
      untrackedFiles.length === 0
        ? 'No untracked Asset files.'
        : `Found ${untrackedFiles.length} untracked Asset file${untrackedFiles.length === 1 ? '' : 's'}.`,
    fields: { untrackedFiles },
  };
}

export const assetAuditCommand: CliCommandDefinition = {
  path: ['asset', 'audit'],
  parse(arguments_) {
    if (arguments_.length !== 0) throw new CliCommandUsageError('Usage: noveltea asset audit');
    return {
      dryRun: true,
      mutation: false,
      projectPreparation: assetAuditProjectPreparationIntent,
      run: auditAssetDirectory,
    };
  },
};
