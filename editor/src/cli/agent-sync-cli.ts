import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { NovelTeaAgentKitPayload } from './agent-kit';
import { syncNovelTeaAgentKit } from './agent-sync';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import { parseAgentSyncCommand } from './commands/agent-sync-command';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
} from './contracts';
import { preflightNovelTeaWorkspace } from './workspace-preflight';
import {
  ensureNovelTeaLocalStateIgnored,
  inspectNovelTeaAgentBootstrap,
  repairNovelTeaAgentBootstrap,
  type NovelTeaAgentBootstrapInspection,
} from '../shared/project-workspace/agent-bootstrap';

function bootstrapDiagnostic(inspection: NovelTeaAgentBootstrapInspection) {
  const details = {
    missing: [
      'AGENT_BOOTSTRAP_MISSING',
      'NovelTea managed instructions are missing. Run `noveltea agent sync --fix` to add them.',
    ],
    outdated: [
      'AGENT_BOOTSTRAP_OUTDATED',
      'NovelTea managed instructions are outdated. Run `noveltea agent sync --fix` to update them.',
    ],
    malformed: [
      'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED',
      'NovelTea managed AGENTS.md markers are malformed and require manual repair.',
    ],
  } as const;
  if (inspection.status === 'current') return null;
  const [code, message] = details[inspection.status];
  return cliDiagnostic(code, '/AGENTS.md', message, 'warning');
}

export async function runNovelTeaAgentSyncCli(
  globals: ParsedGlobalArguments,
  fileSystem: ProjectWorkspaceFileSystem,
  cwd = process.cwd(),
  payload?: NovelTeaAgentKitPayload,
): Promise<NovelTeaCliCommandResult> {
  let fix: boolean;
  try {
    fix = parseAgentSyncCommand(globals.command).fix;
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  const preflight = await preflightNovelTeaWorkspace(globals, fileSystem, cwd);
  if (!preflight.ok) return preflight.result;

  let agentKitChanged = false;
  let agentBootstrapChanged = false;
  try {
    const initialBootstrap = await inspectNovelTeaAgentBootstrap(fileSystem, preflight.projectRoot);
    if (fix && initialBootstrap.status === 'malformed') {
      const diagnostic = bootstrapDiagnostic(initialBootstrap)!;
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.mutation,
          diagnostics: [diagnostic],
          projectRoot: preflight.projectRoot,
          agentBootstrapStatus: initialBootstrap.status,
          agentBootstrapChanged: false,
        },
        globals.json,
        { failure: `${diagnostic.message} Remove or repair the markers, then retry.` },
      );
    }
    agentBootstrapChanged = fix
      ? await repairNovelTeaAgentBootstrap(fileSystem, preflight.projectRoot, initialBootstrap)
      : false;
    const result = await syncNovelTeaAgentKit(fileSystem, preflight.projectRoot, { payload });
    agentKitChanged = result.changed;
    const gitignoreStatus = await ensureNovelTeaLocalStateIgnored(
      fileSystem,
      preflight.projectRoot,
    );
    const diagnostics: NovelTeaCliDiagnostic[] = [];
    const bootstrapWarning = fix ? null : bootstrapDiagnostic(initialBootstrap);
    if (bootstrapWarning) diagnostics.push(bootstrapWarning);
    if (gitignoreStatus === 'missing-rule')
      diagnostics.push(
        cliDiagnostic(
          'AGENT_LOCAL_STATE_NOT_IGNORED',
          '/.gitignore',
          'Add a .noveltea ignore rule to the existing .gitignore file.',
          'warning',
        ),
      );
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics,
        projectRoot: preflight.projectRoot,
        agentKitChanged,
        agentBootstrapStatus: fix ? 'current' : initialBootstrap.status,
        agentBootstrapChanged,
        agentGitignoreStatus: gitignoreStatus,
        agentGitignoreCreated: gitignoreStatus === 'created',
        agentGuidePath: result.guidePath,
        agentManifestPath: result.manifestPath,
      },
      globals.json,
      {
        success: agentBootstrapChanged
          ? 'NovelTea agent sync succeeded and repaired AGENTS.md.'
          : 'NovelTea agent sync succeeded.',
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const internal = message.includes('failed its embedded hash validation');
    return formatCliResult(
      {
        success: false,
        exitCode: internal ? NOVELTEA_CLI_EXIT_CODES.internal : NOVELTEA_CLI_EXIT_CODES.mutation,
        diagnostics: [
          cliDiagnostic(internal ? 'CLI_INTERNAL' : 'AGENT_SYNC_MUTATION_FAILED', '/', message),
        ],
        projectRoot: preflight.projectRoot,
        agentKitChanged,
        agentBootstrapChanged,
      },
      globals.json,
      { failure: message },
    );
  }
}
