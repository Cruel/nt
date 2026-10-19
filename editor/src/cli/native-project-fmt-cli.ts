import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';

/** Native formatting is planned and committed against exact source revisions. */
export async function runNativeProjectFmtCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'fmt') return null;
  const args = globals.command.slice(1);
  const check = args.includes('--check');
  const stripDefaults = args.includes('--strip-defaults');
  const paths = args.filter((item) => item !== '--check' && item !== '--strip-defaults');
  if (
    paths.length > 1 ||
    args.filter((item) => item === '--check').length > 1 ||
    args.filter((item) => item === '--strip-defaults').length > 1 ||
    paths.some((item) => item.startsWith('--'))
  )
    return novelTeaCliUsageFailure(
      'Usage: noveltea fmt [<tracked-yaml-path>] [--check] [--strip-defaults]',
      globals.json,
    );
  const root = await nativeProjectRoot(cwd, globals.project);
  if (!root) {
    const message = 'No project.yaml found.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic('WORKSPACE_UNAVAILABLE', '/project.yaml', message)],
      },
      globals.json,
      { failure: message },
    );
  }
  const request = {
    action: 'fmt',
    projectRoot: root,
    check: true,
    stripDefaults,
    ...(paths.length ? { path: paths[0] } : {}),
  };
  let result;
  try {
    result = await native(request);
    if (result.ok && !check && result.changed === true) {
      if (!result.diskPreconditions || typeof result.diskPreconditions !== 'object')
        throw new Error('Native fmt planning omitted exact disk revisions.');
      result = await native({
        ...request,
        check: false,
        diskPreconditions: result.diskPreconditions,
      });
    }
  } catch (error) {
    // A transport failure after mutation cannot safely be replayed.
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    const message = result.error ?? 'Native YAML formatter failed.';
    const usage = message.includes('not an existing tracked YAML source');
    const collision = message.includes('revision') || message.includes('transaction');
    return formatCliResult(
      {
        success: false,
        exitCode: usage
          ? NOVELTEA_CLI_EXIT_CODES.usage
          : collision
            ? NOVELTEA_CLI_EXIT_CODES.mutation
            : NOVELTEA_CLI_EXIT_CODES.workspace,
        projectRoot: root,
        diagnostics: [
          cliDiagnostic(
            usage ? 'FMT_PATH' : collision ? 'WORKSPACE_TRANSACTION_CONFLICT' : 'FMT_INVALID_YAML',
            `/${paths[0] ?? ''}`,
            message,
          ),
        ],
      },
      globals.json,
      { failure: message },
    );
  }
  if (!Array.isArray(result.files) || typeof result.checked !== 'number')
    throw new Error('Native fmt result lacks its tracked source inventory.');
  const files = result.files as string[];
  const count = files.length;
  const needsFormatting = check && count > 0;
  return formatCliResult(
    {
      success: !needsFormatting,
      exitCode: needsFormatting
        ? NOVELTEA_CLI_EXIT_CODES.semantic
        : NOVELTEA_CLI_EXIT_CODES.success,
      projectRoot: root,
      diagnostics: files.map((file) =>
        cliDiagnostic(
          'FMT_CHANGE',
          `/${file}`,
          check ? 'Source requires formatting.' : 'Source formatted.',
          'warning',
        ),
      ),
      checked: result.checked,
      changed: count,
      files,
      check,
    },
    globals.json,
    {
      success: check
        ? 'All YAML Project sources are formatted.'
        : 'YAML Project sources formatted.',
      failure: `${count} YAML Project source(s) require formatting.`,
    },
  );
}
