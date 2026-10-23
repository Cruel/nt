import path from 'node:path';
import { bootstrapNovelTeaCli, novelTeaCliUsageFailure } from './bootstrap';
import { classifyNovelTeaCliCommand } from './command-routing';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliExitCode,
} from './contracts';
import type { RunNovelTeaCliOptions } from './application';
import { dispatchNativeProjectCommand } from './native-project-command-dispatch';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import { unavailablePlatformTools } from './platform-tool-service';

export type NativeOnlyCliOptions = RunNovelTeaCliOptions &
  Required<Pick<RunNovelTeaCliOptions, 'nativeProjectCommands'>>;

/**
 * Standalone native-only application layer. It never imports the retired
 * TypeScript Project application, semantic reader or Workspace validator.
 * Native command ownership is required at construction; no Project request
 * is eligible for an alternate reader if a native operation is unclaimed.
 */
export async function runNativeOnlyNovelTeaCli(
  argv: readonly string[],
  options: NativeOnlyCliOptions,
): Promise<NovelTeaCliCommandResult> {
  const bootstrap = bootstrapNovelTeaCli(argv);
  if (bootstrap.complete) return bootstrap.result;
  const globals = bootstrap.globals;
  const routing = classifyNovelTeaCliCommand(globals.command);
  if (!routing)
    return novelTeaCliUsageFailure(
      `Unknown command path '${globals.command.join(' ')}'.`,
      globals.json,
    );
  if (typeof options.nativeProjectCommands !== 'function')
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [
          cliDiagnostic(
            'CLI_NATIVE_OWNER_MISSING',
            '/',
            'Native Project authority is unavailable.',
          ),
        ],
      },
      globals.json,
      { failure: 'Native Project authority is unavailable.' },
    );
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const platformTools = options.platformTools ?? unavailablePlatformTools;
  const nativeTools = options.nativeTools as NovelTeaCliNativeToolService | undefined;
  // Only Project-independent actions can run without a native tool service.
  const missingNativeTools = new Proxy({} as NovelTeaCliNativeToolService, {
    get() {
      throw new Error('Native NovelTea tool host is unavailable.');
    },
  });
  const tools = nativeTools ?? missingNativeTools;
  const claimed = await dispatchNativeProjectCommand(globals, cwd, options, tools, platformTools);
  if (claimed) return claimed;
  if (globals.command[0] === 'agent' && globals.command[1] === 'sync') {
    const { runNovelTeaAgentSyncCli } = await import('./agent-sync-cli');
    const { createNodeProjectWorkspaceFileSystem } =
      await import('../shared/project-workspace/node-project-workspace-file-system');
    return runNovelTeaAgentSyncCli(
      globals,
      options.fileSystem ?? createNodeProjectWorkspaceFileSystem(),
      cwd,
      options.agentKitPayload,
      options.nativeProjectCommands,
    );
  }
  if (globals.command[0] === 'comfyui') {
    const { runComfyUiCatalogCommand } = await import('./comfyui-catalog-commands');
    const { createNodeProjectWorkspaceFileSystem } =
      await import('../shared/project-workspace/node-project-workspace-file-system');
    const result = await runComfyUiCatalogCommand({
      command: globals.command,
      projectOption: globals.project ?? null,
      json: globals.json,
      cwd,
      fileSystem: options.fileSystem ?? createNodeProjectWorkspaceFileSystem(),
      nativeTools: tools,
      nativeProjectCommands: options.nativeProjectCommands,
      pinnedNativePreparation: options.pinnedNativePreparation,
      libraryOptions: options.comfyUiWorkflowLibraryOptions,
      abortSignal: options.abortSignal,
      onRunProgress: options.onComfyUiProgress,
    });
    if (result) return result;
  }
  if (
    globals.command[0] === 'platform' &&
    (globals.command[1] === 'template' || globals.command[1] === 'config')
  ) {
    const { runProjectIndependentPlatformCommand } =
      await import('./platform-independent-commands');
    const independent = await runProjectIndependentPlatformCommand({
      command: globals.command,
      projectOption: globals.project,
      cwd,
      platformTools,
    });
    if (independent)
      return formatCliResult(
        {
          success: independent.ok,
          exitCode: independent.ok
            ? NOVELTEA_CLI_EXIT_CODES.success
            : (independent.exitCode ?? NOVELTEA_CLI_EXIT_CODES.native),
          diagnostics: independent.diagnostics,
          ...independent.fields,
        },
        globals.json,
        independent.ok
          ? { success: independent.humanSuccess ?? 'NovelTea platform command succeeded.' }
          : { failure: independent.diagnostics[0]?.message ?? 'Platform operation failed.' },
      );
  }
  if (globals.command[0] === 'shaderc' || globals.command[0] === 'texturec') {
    if (globals.json)
      return novelTeaCliUsageFailure(
        `Raw '${globals.command[0]}' does not support NovelTea --json mode.`,
        true,
      );
    try {
      const exitCode = tools[globals.command[0]](globals.command.slice(1)) as NovelTeaCliExitCode;
      return {
        exitCode,
        envelope: { success: exitCode === 0, exitCode, diagnostics: [] },
        stdout: '',
        stderr: '',
      };
    } catch (error) {
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
          diagnostics: [
            cliDiagnostic(
              'CLI_INTERNAL',
              '/',
              error instanceof Error ? error.message : String(error),
            ),
          ],
        },
        globals.json,
      );
    }
  }
  return formatCliResult(
    {
      success: false,
      exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
      diagnostics: [
        cliDiagnostic(
          'CLI_NATIVE_UNCLAIMED',
          '/',
          `Native Project host has no handler for '${globals.command.join(' ')}'.`,
        ),
      ],
    },
    globals.json,
    { failure: 'The native host did not claim this CLI command.' },
  );
}
