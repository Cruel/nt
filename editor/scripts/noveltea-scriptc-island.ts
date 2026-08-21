import { createHash, randomUUID } from 'node:crypto';
import { createNovelTeaAgentKitPayload } from '../src/cli/agent-kit';
import { runNovelTeaCli } from '../src/cli/application';
import type { NovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import type { NovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service';
import { createNovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service-node';
import { configurePlatformHostService } from '../src/main/services/platform-host-service';
import {
  scriptcAgentKitProvenance,
  scriptcAgentKitSourceFiles,
  scriptcAgentKitSystemLayoutSourceFiles,
} from './noveltea-scriptc-agent-kit-source';
import {
  createNodeProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  ProjectWorkspaceTransactionService,
} from '../src/shared/project-workspace';
import { configureSha256BytesImplementation } from '../src/shared/web-crypto';

configureSha256BytesImplementation(async (bytes) =>
  createHash('sha256').update(bytes).digest('hex'),
);

export type ScriptcHostInvoke = (operation: string, requestText: string) => string;

function createNativeTools(invoke: ScriptcHostInvoke): NovelTeaCliNativeToolService {
  const call = (operation: string, request: unknown): unknown =>
    JSON.parse(invoke(operation, JSON.stringify(request))) as unknown;
  return {
    async compileShaders(shaderProject, options) {
      return call('compile-shaders', { shaderProject, options }) as Awaited<
        ReturnType<NovelTeaCliNativeToolService['compileShaders']>
      >;
    },
    async runHeadlessTest(request) {
      return call('run-test', request);
    },
    async runUiTest(request) {
      return call('run-ui-test', request);
    },
    async exportPackage(request) {
      return call('export-package', request);
    },
    shaderc(arguments_) {
      const response = call('shaderc', arguments_) as { exitCode?: unknown };
      if (!Number.isSafeInteger(response.exitCode) || (response.exitCode as number) < 0)
        throw new Error(
          `Native shaderc returned invalid exit code '${String(response.exitCode)}'.`,
        );
      return response.exitCode as number;
    },
  };
}

function configureScriptcPlatformHost(invoke: ScriptcHostInvoke): void {
  const call = <T>(operation: string, request: unknown): T => {
    const response = JSON.parse(invoke(operation, JSON.stringify(request))) as unknown;
    if (
      response &&
      typeof response === 'object' &&
      (response as { ok?: unknown }).ok === false &&
      typeof (response as { error?: unknown }).error === 'string'
    )
      throw new Error((response as { error: string }).error);
    return response as T;
  };
  configurePlatformHostService({
    async runProcess(request) {
      return call('run-process', request);
    },
    async inspectImage(sourcePath) {
      return call('image-inspect', { sourcePath });
    },
    async resizeImageToPng(request) {
      call('image-resize-png', request);
    },
    async createArchive(request) {
      call('create-archive', request);
    },
    async fileMode(path, fallback) {
      return call('file-mode', { path, fallback });
    },
    async availableDiskSpace(path) {
      return call('disk-space', { path });
    },
  });
}

function result(exitCode: number, stdout = '', stderr = ''): string {
  return JSON.stringify([exitCode, stdout, stderr]);
}

async function runInternalCommand(
  argv: readonly string[],
  nativeTools: NovelTeaCliNativeToolService,
  invokeHost: ScriptcHostInvoke,
): Promise<string | null> {
  if (argv[0] === '__shaderc-batch') {
    if (argv.length !== 1)
      return result(2, '', 'Internal shaderc batch bridge accepts no arguments.\n');
    const parsed = JSON.parse(invokeHost('read-stdin', '') || '[]') as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some(
        (entry) => !Array.isArray(entry) || entry.some((argument) => typeof argument !== 'string'),
      )
    )
      return result(2, '', 'Internal shaderc batch bridge requires an array of string arrays.\n');
    for (const command of parsed as string[][]) {
      const exitCode = nativeTools.shaderc(command);
      if (exitCode !== 0) return result(exitCode);
    }
    return result(0);
  }

  if (argv[0] !== '__editor-native') return null;
  const operation = argv[1];
  if (argv.length !== 2 || !operation)
    return result(2, '', 'Internal editor native bridge requires exactly one operation.\n');
  const input = JSON.parse(invokeHost('read-stdin', '') || '{}') as Record<string, unknown>;
  let response: unknown;
  if (operation === 'compile-shaders')
    response = await nativeTools.compileShaders(input.shaderProject, input.options ?? {});
  else if (operation === 'run-test') response = await nativeTools.runHeadlessTest(input);
  else if (operation === 'run-ui-test') response = await nativeTools.runUiTest(input);
  else if (operation === 'export-package') response = await nativeTools.exportPackage(input);
  else return result(2, '', `Unknown internal editor native operation '${operation}'.\n`);

  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  return result(record.ok === true ? 0 : 1, `${JSON.stringify(response)}\n`);
}

export async function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: ScriptcHostInvoke,
): Promise<string> {
  const argv = JSON.parse(argvText) as string[];
  const nativeTools = createNativeTools(invokeHost);
  configureScriptcPlatformHost(invokeHost);
  const platformTools: NovelTeaCliPlatformToolService =
    createNovelTeaCliPlatformToolService(nativeTools);
  const internal = await runInternalCommand(argv, nativeTools, invokeHost);
  if (internal !== null) return internal;

  const fileSystem = createNodeProjectWorkspaceFileSystem();
  const workspace = new ProjectWorkspaceService(
    fileSystem,
    new ProjectWorkspaceTransactionService(
      fileSystem,
      {
        async isProcessAlive(pid) {
          const value = invokeHost('process-alive', String(pid));
          return value === 'true' ? true : value === 'false' ? false : null;
        },
      },
      process.pid,
      randomUUID,
    ),
  );
  const needsAgentKit = argv.some(
    (argument, index) => argument === 'agent' && argv[index + 1] === 'sync',
  );
  const commandResult = await runNovelTeaCli(argv, {
    fileSystem,
    workspace,
    nativeTools,
    platformTools,
    ...(needsAgentKit
      ? {
          agentKitPayload: createNovelTeaAgentKitPayload(
            scriptcAgentKitSourceFiles,
            scriptcAgentKitProvenance,
            scriptcAgentKitSystemLayoutSourceFiles,
          ),
        }
      : {}),
    readStdinText: () => invokeHost('read-stdin', ''),
  });
  return result(commandResult.exitCode, commandResult.stdout, commandResult.stderr);
}
