import { renameEntity } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags, requireAuthoringCollection } from './types';

export const entityRenameCommand: CliCommandDefinition = {
  path: ['entity', 'rename'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, [
      '--dry-run',
      '--allow-possible-source-references',
    ]);
    if (parsed.positionals.length !== 3)
      throw new CliCommandUsageError(
        'Usage: noveltea entity rename <collection> <old-id> <new-id> [--dry-run] [--allow-possible-source-references]',
      );
    const [collectionValue, fromId, toId] = parsed.positionals;
    const collection = requireAuthoringCollection(collectionValue!);
    const dryRun = parsed.flags.has('--dry-run');
    const allowPossibleSourceReferences = parsed.flags.has('--allow-possible-source-references');
    return {
      dryRun,
      mutation: true,
      run: ({ workspace, snapshot }) =>
        renameEntity(workspace, snapshot, collection, fromId!, toId!, {
          dryRun,
          allowPossibleSourceReferences,
        }),
    };
  },
};
