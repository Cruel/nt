import { usagesForEntity } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags, requireAuthoringCollection } from './types';

export const usagesCommand: CliCommandDefinition = {
  path: ['usages'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, []);
    if (parsed.positionals.length !== 2)
      throw new CliCommandUsageError('Usage: noveltea usages <collection> <id>');
    const [collectionValue, id] = parsed.positionals;
    const collection = requireAuthoringCollection(collectionValue!);
    return {
      dryRun: false,
      mutation: false,
      run: ({ workspace, snapshot }) => usagesForEntity(workspace, snapshot, collection!, id!),
    };
  },
};
