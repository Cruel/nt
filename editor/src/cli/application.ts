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
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  NOVELTEA_CLI_HELP,
  NOVELTEA_CLI_VERSION,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
  type NovelTeaCliExitCode,
} from './contracts';
import { openCliProject } from './semantic-project';
import {
  createSubprocessNovelTeaCliNativeToolService,
  type NovelTeaCliNativeToolService,
} from './native-tool-service';
import { CliCommandUsageError, parseCliCommand } from './commands';

interface ParsedGlobalArguments {
  readonly json: boolean;
  readonly project?: string;
  readonly command: readonly string[];
  readonly help: boolean;
  readonly version: boolean;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface RunNovelTeaCliOptions {
  readonly cwd?: string;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly workspace?: ProjectWorkspaceService;
  readonly nativeTools?: NovelTeaCliNativeToolService;
}

function parseGlobals(argv: readonly string[]): ParsedGlobalArguments {
  let json = false;
  let project: string | undefined;
  let help = false;
  let version = false;
  let index = 0;
  while (index < argv.length && argv[index]!.startsWith('--')) {
    const argument = argv[index]!;
    if (argument === '--json') {
      if (json) throw new CliUsageError("Global option '--json' may be supplied only once.");
      json = true;
      index += 1;
      continue;
    }
    if (argument === '--project') {
      if (project !== undefined)
        throw new CliUsageError("Global option '--project' may be supplied only once.");
      const value = argv[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliUsageError("Global option '--project' requires a project directory.");
      project = value;
      index += 2;
      continue;
    }
    if (argument === '--help') {
      help = true;
      index += 1;
      continue;
    }
    if (argument === '--version') {
      version = true;
      index += 1;
      continue;
    }
    throw new CliUsageError(`Unknown global option '${argument}'.`);
  }
  const command = argv.slice(index);
  if ((help || version) && command.length > 0)
    throw new CliUsageError('--help and --version do not accept a command path.');
  if (help && version) throw new CliUsageError('--help and --version cannot be combined.');
  return { json, project, command, help, version };
}

function usageFailure(message: string, json: boolean): NovelTeaCliCommandResult {
  return formatCliResult(
    {
      success: false,
      exitCode: NOVELTEA_CLI_EXIT_CODES.usage,
      diagnostics: [cliDiagnostic('CLI_USAGE', '/', message)],
    },
    json,
    { failure: `${message}\n\n${NOVELTEA_CLI_HELP.trimEnd()}` },
  );
}

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

async function resolvedProjectRoot(
  globals: ParsedGlobalArguments,
  cwd: string,
  fileSystem: ProjectWorkspaceFileSystem,
) {
  return globals.project
    ? validateExplicitProjectRoot(fileSystem, path.resolve(cwd, globals.project))
    : discoverProjectRoot(fileSystem, cwd);
}

export async function runNovelTeaCli(
  argv: readonly string[],
  options: RunNovelTeaCliOptions = {},
): Promise<NovelTeaCliCommandResult> {
  let globals: ParsedGlobalArguments;
  try {
    globals = parseGlobals(argv);
  } catch (error) {
    return usageFailure(
      error instanceof Error ? error.message : String(error),
      argv.includes('--json'),
    );
  }

  if (globals.help) {
    if (globals.json)
      return formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics: [],
          help: NOVELTEA_CLI_HELP,
        },
        true,
      );
    return {
      exitCode: 0,
      envelope: { success: true, exitCode: 0, diagnostics: [], help: NOVELTEA_CLI_HELP },
      stdout: NOVELTEA_CLI_HELP,
      stderr: '',
    };
  }
  if (globals.version) {
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: [],
        version: NOVELTEA_CLI_VERSION,
      },
      globals.json,
      { success: NOVELTEA_CLI_VERSION },
    );
  }
  if (globals.command.length === 0) return usageFailure('A command is required.', globals.json);

  let command;
  try {
    command = parseCliCommand(globals.command);
  } catch (error) {
    return usageFailure(error instanceof Error ? error.message : String(error), globals.json);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const fileSystem = options.fileSystem ?? createNodeProjectWorkspaceFileSystem();
  const workspace = options.workspace ?? createNodeProjectWorkspaceService();
  const nativeTools = options.nativeTools ?? createSubprocessNovelTeaCliNativeToolService();

  const discovery = await resolvedProjectRoot(globals, cwd, fileSystem);
  if (!discovery.ok) {
    return failure(
      NOVELTEA_CLI_EXIT_CODES.workspace,
      [cliDiagnostic(discovery.code, discovery.path, discovery.message)],
      globals.json,
      discovery.projectRoot ? { projectRoot: discovery.projectRoot } : {},
    );
  }

  const opened = await openCliProject(workspace, discovery.projectRoot, {
    readOnly: command.dryRun,
  });
  if (!opened.ok)
    return failure(workspaceOpenExitCode(opened.diagnostics), opened.diagnostics, globals.json, {
      projectRoot: discovery.projectRoot,
    });

  try {
    const semantic = await command.run({
      workspace,
      snapshot: opened.opened.snapshot,
      nativeTools,
    });

    const diagnostics = [...opened.diagnostics, ...semantic.diagnostics];
    if (!semantic.ok) {
      return failure(semanticExitCode(diagnostics), diagnostics, globals.json, {
        projectRoot: discovery.projectRoot,
        ...semantic.fields,
      });
    }
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
    if (error instanceof CliUsageError || error instanceof CliCommandUsageError)
      return usageFailure(error.message, globals.json);
    if (error instanceof ProjectWorkspaceMutationError) {
      return failure(
        NOVELTEA_CLI_EXIT_CODES.mutation,
        [cliDiagnostic(error.code, '/.noveltea/transactions', error.message)],
        globals.json,
        { projectRoot: discovery.projectRoot },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      NOVELTEA_CLI_EXIT_CODES.internal,
      [cliDiagnostic('CLI_INTERNAL', '/', message)],
      globals.json,
      { projectRoot: discovery.projectRoot },
    );
  }
}
