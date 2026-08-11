import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  NOVELTEA_CLI_HELP,
  NOVELTEA_CLI_VERSION,
  type NovelTeaCliCommandResult,
} from './contracts';

export interface ParsedGlobalArguments {
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

export type NovelTeaCliBootstrapResult =
  | Readonly<{ complete: true; result: NovelTeaCliCommandResult }>
  | Readonly<{ complete: false; globals: ParsedGlobalArguments }>;

export function parseNovelTeaCliGlobals(argv: readonly string[]): ParsedGlobalArguments {
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

export function novelTeaCliUsageFailure(message: string, json: boolean): NovelTeaCliCommandResult {
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

export function bootstrapNovelTeaCli(argv: readonly string[]): NovelTeaCliBootstrapResult {
  let globals: ParsedGlobalArguments;
  try {
    globals = parseNovelTeaCliGlobals(argv);
  } catch (error) {
    return {
      complete: true,
      result: novelTeaCliUsageFailure(
        error instanceof Error ? error.message : String(error),
        argv.includes('--json'),
      ),
    };
  }

  if (globals.help) {
    if (globals.json)
      return {
        complete: true,
        result: formatCliResult(
          {
            success: true,
            exitCode: NOVELTEA_CLI_EXIT_CODES.success,
            diagnostics: [],
            help: NOVELTEA_CLI_HELP,
          },
          true,
        ),
      };
    return {
      complete: true,
      result: {
        exitCode: 0,
        envelope: { success: true, exitCode: 0, diagnostics: [], help: NOVELTEA_CLI_HELP },
        stdout: NOVELTEA_CLI_HELP,
        stderr: '',
      },
    };
  }

  if (globals.version)
    return {
      complete: true,
      result: formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics: [],
          version: NOVELTEA_CLI_VERSION,
        },
        globals.json,
        { success: NOVELTEA_CLI_VERSION },
      ),
    };

  if (globals.command.length === 0)
    return {
      complete: true,
      result: novelTeaCliUsageFailure('A command is required.', globals.json),
    };

  const command = globals.command;
  const knownPath =
    command[0] === 'shaderc' ||
    (command[0] === 'agent' && command[1] === 'sync') ||
    command[0] === 'validate' ||
    command[0] === 'usages' ||
    (command[0] === 'entity' &&
      (command[1] === 'create' || command[1] === 'rename' || command[1] === 'delete')) ||
    (command[0] === 'shaders' && command[1] === 'compile') ||
    (command[0] === 'test' &&
      (command[1] === 'run' || command[1] === 'run-spec' || command[1] === 'run-ui-spec')) ||
    (command[0] === 'package' && command[1] === 'export');
  if (!knownPath)
    return {
      complete: true,
      result: novelTeaCliUsageFailure(`Unknown command path '${command.join(' ')}'.`, globals.json),
    };

  return { complete: false, globals };
}

export function novelTeaCliCommandNeedsZod(command: readonly string[]): boolean {
  if (command[0] === 'validate' || command[0] === 'usages') return true;
  if (command[0] === 'entity')
    return command[1] === 'create' || command[1] === 'rename' || command[1] === 'delete';
  if (command[0] === 'shaders') return command[1] === 'compile';
  if (command[0] === 'test')
    return command[1] === 'run' || command[1] === 'run-spec' || command[1] === 'run-ui-spec';
  return command[0] === 'package' && command[1] === 'export';
}
