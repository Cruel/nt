import { createEntity } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError, parseCommandFlags } from './types';

export const entityCreateCommand: CliCommandDefinition = {
  path: ['entity', 'create'],
  parse(arguments_) {
    const parsed = parseCommandFlags(arguments_, ['--dry-run']);
    if (parsed.positionals.length !== 2)
      throw new CliCommandUsageError('Usage: noveltea entity create <collection> <id> [--dry-run]');
    const [collection, id] = parsed.positionals;
    const dryRun = parsed.flags.has('--dry-run');
    return {
      dryRun,
      mutation: true,
      run: ({ workspace, snapshot }) => createEntity(workspace, snapshot, collection!, id!, dryRun),
    };
  },
};
