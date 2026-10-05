import { inspectMediaTool, installedMediaTool } from '../main/services/media-preparation-service';
import { novelTeaCliUsageFailure, type ParsedGlobalArguments } from './bootstrap';
import { cliDiagnostic, formatCliResult, NOVELTEA_CLI_EXIT_CODES } from './contracts';

export function mediaToolCheckCommand(globals: ParsedGlobalArguments, cliExecutable?: string) {
  if (globals.command.length !== 2 || globals.command[1] !== 'check')
    return novelTeaCliUsageFailure('Expected media-tool check with no arguments.', globals.json);
  try {
    const tool = inspectMediaTool(installedMediaTool(cliExecutable));
    return formatCliResult({ success: true, exitCode: 0, diagnostics: [], tool }, globals.json, {
      success: `FFmpeg ${tool.version}: ${tool.executable}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.native,
        diagnostics: [cliDiagnostic('media.tool', '/', message)],
      },
      globals.json,
      { failure: message },
    );
  }
}
