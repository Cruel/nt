import { syncNovelTeaAgentKit } from '../agent-sync';
import type { CliCommandDefinition } from './types';
import { CliCommandUsageError } from './types';

export const agentSyncCommand: CliCommandDefinition = {
  path: ['agent', 'sync'],
  parse(arguments_) {
    if (arguments_.length > 0)
      throw new CliCommandUsageError("'agent sync' does not accept command arguments.");
    return {
      dryRun: false,
      mutation: true,
      async run(context) {
        const projectRoot = context.snapshot.projectRoot;
        if (!projectRoot)
          return {
            ok: false,
            diagnostics: [
              {
                code: 'AGENT_KIT_WORKSPACE_UNSUPPORTED',
                severity: 'error',
                path: '/project.json',
                message: 'Agent sync requires a loaded NovelTea workspace v1 project.',
              },
            ],
          };
        const result = await syncNovelTeaAgentKit(context.fileSystem, projectRoot);
        return {
          ok: true,
          diagnostics: [],
          fields: {
            agentKitChanged: result.changed,
            agentGuidePath: result.guidePath,
            agentManifestPath: result.manifestPath,
          },
        };
      },
    };
  },
};
