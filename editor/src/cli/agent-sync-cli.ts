import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { syncNovelTeaAgentKit } from './agent-sync';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import { validateAgentSyncCommand } from './commands/agent-sync-command';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { preflightNovelTeaWorkspace } from './workspace-preflight';

export async function runNovelTeaAgentSyncCli(
  globals: ParsedGlobalArguments,
  fileSystem: ProjectWorkspaceFileSystem,
  cwd = process.cwd(),
): Promise<NovelTeaCliCommandResult> {
  try {
    validateAgentSyncCommand(globals.command);
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  const preflight = await preflightNovelTeaWorkspace(globals, fileSystem, cwd);
  if (!preflight.ok) return preflight.result;

  try {
    const result = await syncNovelTeaAgentKit(fileSystem, preflight.projectRoot);
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: [],
        projectRoot: preflight.projectRoot,
        agentKitChanged: result.changed,
        agentGuidePath: result.guidePath,
        agentManifestPath: result.manifestPath,
      },
      globals.json,
      { success: 'NovelTea agent sync succeeded.' },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [cliDiagnostic('CLI_INTERNAL', '/', message)],
        projectRoot: preflight.projectRoot,
      },
      globals.json,
      { failure: message },
    );
  }
}
