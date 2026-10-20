import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';

/** The native static Project graph's diagnostic boundary. This is not yet the
 * complete public validate command: font shaping, shader compilation and
 * distribution notice checks must also run before its result can be published.
 */
export async function readNativeProjectValidation(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'validate') return null;
  if (globals.command.length !== 1)
    return novelTeaCliUsageFailure('validate does not accept arguments.', globals.json);
  const projectRoot = await nativeProjectRoot(cwd, globals.project);
  if (!projectRoot) {
    const message = 'No NovelTea project.yaml was found from the current directory upward.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic('WORKSPACE_NOT_FOUND', '/project.yaml', message)],
      },
      globals.json,
      { failure: message },
    );
  }
  let response: Awaited<ReturnType<NativeProjectCommandCall>>;
  try {
    response = await native({ action: 'project-validate', projectRoot });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (
    response.ok !== true ||
    typeof response.valid !== 'boolean' ||
    !Array.isArray(response.cliDiagnostics)
  ) {
    const message = response.error ?? 'Native Project validation returned an invalid response.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [cliDiagnostic('NATIVE_PROJECT_VALIDATION_UNAVAILABLE', '/', message)],
        projectRoot,
      },
      globals.json,
      { failure: message },
    );
  }
  const diagnostics = nativeProjectDiagnostics(response);
  if (diagnostics.length !== response.cliDiagnostics.length) {
    const message = 'Native Project validation returned malformed diagnostics.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [cliDiagnostic('NATIVE_PROJECT_VALIDATION_UNAVAILABLE', '/', message)],
        projectRoot,
      },
      globals.json,
      { failure: message },
    );
  }
  const success =
    response.valid && !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return formatCliResult(
    {
      success,
      exitCode: success ? NOVELTEA_CLI_EXIT_CODES.success : NOVELTEA_CLI_EXIT_CODES.semantic,
      diagnostics,
      projectRoot,
    },
    globals.json,
    { success: 'NovelTea validate succeeded.', failure: 'NovelTea validate failed.' },
  );
}
