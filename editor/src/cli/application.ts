import path from 'node:path';
import {
  createNodeProjectWorkspaceFileSystem,
  createNodeProjectWorkspaceService,
  discoverProjectRoot,
  validateExplicitProjectRoot,
  ProjectWorkspaceMutationError,
  type ProjectWorkspaceFileSystem,
  type ProjectWorkspaceService,
} from '../shared/project-workspace';
import { bootstrapNovelTeaCli, novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
  type NovelTeaCliExitCode,
} from './contracts';
import { openCliProject } from './semantic-project';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import { CliCommandUsageError, parseCliCommand } from './commands';
import type { NovelTeaAgentKitPayload } from './agent-kit';
import { runNovelTeaAgentSyncCli } from './agent-sync-cli';
import { runNovelTeaProjectCreateCli } from './project-create-cli';

export interface RunNovelTeaCliOptions {
  readonly cwd?: string;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly workspace?: ProjectWorkspaceService;
  readonly nativeTools?: NovelTeaCliNativeToolService;
  readonly agentKitPayload?: NovelTeaAgentKitPayload;
  readonly stdinText?: string;
  readonly readStdinText?: () => string;
}

const unavailableNativeTools: NovelTeaCliNativeToolService = {
  compileShaders() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  runHeadlessTest() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  runUiTest() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  exportPackage() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  shaderc() {
    throw new Error('Native NovelTea tooling is unavailable in this CLI host.');
  },
};

function failure(
  exitCode: NovelTeaCliExitCode,
  diagnostics: readonly NovelTeaCliDiagnostic[],
  json: boolean,
  fields: Readonly<Record<string, unknown>> = {},
): NovelTeaCliCommandResult {
  return formatCliResult({ success: false, exitCode, diagnostics, ...fields }, json, {
    failure: diagnostics[0]?.message ?? 'NovelTea command failed.',
  });
}

function semanticExitCode(diagnostics: readonly NovelTeaCliDiagnostic[]): NovelTeaCliExitCode {
  if (diagnostics.some((item) => item.code === 'CLI_USAGE')) return NOVELTEA_CLI_EXIT_CODES.usage;
  return diagnostics.some((item) => item.code.startsWith('native.'))
    ? NOVELTEA_CLI_EXIT_CODES.native
    : NOVELTEA_CLI_EXIT_CODES.semantic;
}

function workspaceOpenExitCode(diagnostics: readonly NovelTeaCliDiagnostic[]): NovelTeaCliExitCode {
  return diagnostics.some(
    (item) =>
      item.code === 'WORKSPACE_REVISION_CONFLICT' ||
      item.code === 'WORKSPACE_BUSY' ||
      item.code === 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT',
  )
    ? NOVELTEA_CLI_EXIT_CODES.mutation
    : NOVELTEA_CLI_EXIT_CODES.workspace;
}

export async function runNovelTeaCli(
  argv: readonly string[],
  options: RunNovelTeaCliOptions = {},
): Promise<NovelTeaCliCommandResult> {
  const bootstrap = bootstrapNovelTeaCli(argv);
  if (bootstrap.complete) return bootstrap.result;
  const globals = bootstrap.globals;

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const fileSystem = options.fileSystem ?? createNodeProjectWorkspaceFileSystem();
  const workspace = options.workspace ?? createNodeProjectWorkspaceService();
  if (globals.command[0] === 'project' && globals.command[1] === 'create')
    return runNovelTeaProjectCreateCli(globals, fileSystem, workspace);
  if (globals.command[0] === 'agent' && globals.command[1] === 'sync')
    return runNovelTeaAgentSyncCli(globals, fileSystem, cwd, options.agentKitPayload);

  const nativeTools = options.nativeTools ?? unavailableNativeTools;
  if (globals.command[0] === 'shaderc') {
    if (globals.json)
      return novelTeaCliUsageFailure("Raw 'shaderc' does not support NovelTea --json mode.", true);
    let exitCode: number;
    try {
      exitCode = nativeTools.shaderc(globals.command.slice(1));
    } catch (error) {
      return failure(
        NOVELTEA_CLI_EXIT_CODES.internal,
        [
          cliDiagnostic(
            'CLI_INTERNAL',
            '/',
            error instanceof Error ? error.message : String(error),
          ),
        ],
        globals.json,
      );
    }
    return {
      exitCode: exitCode as NovelTeaCliExitCode,
      envelope: {
        success: exitCode === 0,
        exitCode: exitCode as NovelTeaCliExitCode,
        diagnostics: [],
      },
      stdout: '',
      stderr: '',
    };
  }

  let command;
  try {
    command = parseCliCommand(globals.command);
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  let stdinJson: unknown;
  if (
    globals.command.length === 2 &&
    globals.command[0] === 'test' &&
    (globals.command[1] === 'run-spec' || globals.command[1] === 'run-ui-spec')
  ) {
    try {
      const stdinText = options.stdinText ?? options.readStdinText?.();
      if (!stdinText || stdinText.trim() === '')
        throw new Error('Command requires one UTF-8 JSON value on stdin.');
      stdinJson = JSON.parse(stdinText) as unknown;
    } catch (error) {
      return novelTeaCliUsageFailure(
        error instanceof Error ? error.message : String(error),
        globals.json,
      );
    }
  }

  const discovery = globals.project
    ? await validateExplicitProjectRoot(fileSystem, path.resolve(cwd, globals.project))
    : await discoverProjectRoot(fileSystem, cwd);
  if (!discovery.ok)
    return failure(
      NOVELTEA_CLI_EXIT_CODES.workspace,
      [cliDiagnostic(discovery.code, discovery.path, discovery.message)],
      globals.json,
      discovery.projectRoot ? { projectRoot: discovery.projectRoot } : {},
    );

  const opened = await openCliProject(workspace, discovery.projectRoot, {
    readOnly: command.dryRun,
  });
  if (!opened.ok)
    return failure(workspaceOpenExitCode(opened.diagnostics), opened.diagnostics, globals.json, {
      projectRoot: discovery.projectRoot,
    });

  try {
    const semantic = await command.run({
      cwd,
      stdinJson,
      fileSystem,
      workspace,
      snapshot: opened.opened.snapshot,
      nativeTools,
    });

    const diagnostics = [...opened.diagnostics, ...semantic.diagnostics];
    if (!semantic.ok)
      return failure(semanticExitCode(diagnostics), diagnostics, globals.json, {
        projectRoot: discovery.projectRoot,
        ...semantic.fields,
      });
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics,
        projectRoot: discovery.projectRoot,
        ...semantic.fields,
      },
      globals.json,
      { success: `NovelTea ${globals.command.join(' ')} succeeded.` },
    );
  } catch (error) {
    if (error instanceof CliCommandUsageError)
      return novelTeaCliUsageFailure(error.message, globals.json);
    if (error instanceof ProjectWorkspaceMutationError)
      return failure(
        NOVELTEA_CLI_EXIT_CODES.mutation,
        [cliDiagnostic(error.code, '/.noveltea/transactions', error.message)],
        globals.json,
        { projectRoot: discovery.projectRoot },
      );
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      NOVELTEA_CLI_EXIT_CODES.internal,
      [cliDiagnostic('CLI_INTERNAL', '/', message)],
      globals.json,
      { projectRoot: discovery.projectRoot },
    );
  }
}
