import { deleteEntity } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags, requireAuthoringCollection } from './types';

export const entityDeleteCommand: CliCommandDefinition = {
  path: ['entity', 'delete'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, [
      '--dry-run',
      '--force',
      '--allow-possible-source-references',
    ]);
    if (parsed.positionals.length !== 2)
      throw new CliCommandUsageError(
        'Usage: noveltea entity delete <collection> <id> [--dry-run] [--force] [--allow-possible-source-references]',
      );
    const [collectionValue, id] = parsed.positionals;
    const collection = requireAuthoringCollection(collectionValue!);
    const dryRun = parsed.flags.has('--dry-run');
    const force = parsed.flags.has('--force');
    const allowPossibleSourceReferences = parsed.flags.has('--allow-possible-source-references');
    return {
      dryRun,
      mutation: true,
      run: ({ workspace, snapshot }) =>
        deleteEntity(workspace, snapshot, collection, id!, {
          dryRun,
          force,
          allowPossibleSourceReferences,
        }),
    };
  },
};
