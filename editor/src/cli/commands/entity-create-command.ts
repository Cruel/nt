import { createEntity } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags, requireAuthoringCollection } from './types';

export const entityCreateCommand: CliCommandDefinition = {
  path: ['entity', 'create'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--dry-run']);
    if (parsed.positionals.length !== 2)
      throw new CliCommandUsageError('Usage: noveltea entity create <collection> <id> [--dry-run]');
    const [collectionValue, id] = parsed.positionals;
    const collection = requireAuthoringCollection(collectionValue!);
    if (collection === 'assets')
      throw new CliCommandUsageError(
        "Generic Asset creation is not supported; add/import Asset source files directly and run 'noveltea validate'.",
      );
    const dryRun = parsed.flags.has('--dry-run');
    return {
      dryRun,
      mutation: true,
      run: ({ workspace, snapshot }) => createEntity(workspace, snapshot, collection!, id!, dryRun),
    };
  },
};
