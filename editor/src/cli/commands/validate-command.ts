import { validateCliProject } from '../semantic-project';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError } from './types';

export const validateCommand: CliCommandDefinition = {
  path: ['validate'],
  parse(arguments_) {
    if (arguments_.length > 0)
      throw new CliCommandUsageError('validate does not accept arguments.');
    return {
      dryRun: false,
      mutation: false,
      run: ({ workspace, snapshot, nativeTools }) =>
        validateCliProject(workspace, snapshot, nativeTools),
    };
  },
};
