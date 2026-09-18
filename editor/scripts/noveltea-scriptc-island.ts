import { createHash, randomUUID } from 'node:crypto';
import type { NovelTeaCliNativeToolService } from '../src/cli/native-tool-service';
import type {
  LocalizationFontCoverageRequest,
  LocalizationFontCoverageResponse,
} from '../src/shared/localization-font-coverage';
import type { NovelTeaCliPlatformToolService } from '../src/cli/platform-tool-service';
import type { ScriptcHostInvoke } from './noveltea-scriptc-path-metadata';

function trace(message: string): void {
  if (process.env.NOVELTEA_CLI_TRACE === '1') process.stderr.write(`[scriptc-island] ${message}\n`);
}

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
    async runTestSuite(request) {
      return call('run-test-suite', request);
    },
    async runUiTest(request) {
      return call('run-ui-test', request);
    },
    async exportPackage(request) {
      return call('export-package', request);
    },
    async validateFontCoverage(request) {
      return call('font-coverage', request) as LocalizationFontCoverageResponse;
    },
    shaderc(arguments_) {
      const response = call('shaderc', arguments_) as { exitCode?: unknown };
      if (!Number.isSafeInteger(response.exitCode) || (response.exitCode as number) < 0)
        throw new Error(
          `Native shaderc returned invalid exit code '${String(response.exitCode)}'.`,
        );
      return response.exitCode as number;
    },
    texturec(arguments_) {
      const response = call('texturec', arguments_) as { exitCode?: unknown };
      if (!Number.isSafeInteger(response.exitCode) || (response.exitCode as number) < 0)
        throw new Error(
          `Native texturec returned invalid exit code '${String(response.exitCode)}'.`,
        );
      return response.exitCode as number;
    },
  };
}

async function configureScriptcPlatformHost(invoke: ScriptcHostInvoke): Promise<void> {
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
  const [{ configureImageInspectionService }, { configurePlatformHostService }] = await Promise.all(
    [
      import('../src/main/services/image-inspection-service'),
      import('../src/main/services/platform-host-service'),
    ],
  );
  const inspectImage = async (sourcePath: string) =>
    call<{
      width: number;
      height: number;
      hasAlpha: boolean;
      orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
      space?: string;
      alphaBounds?: { left: number; top: number; right: number; bottom: number };
    }>('image-inspect', { sourcePath });
  configureImageInspectionService(inspectImage);
  configurePlatformHostService({
    async runProcess(request) {
      return call('run-process', request);
    },
    inspectImage,
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
  else if (operation === 'run-test-suite') {
    if (!nativeTools.runTestSuite)
      return result(1, '', 'Native test-suite operation is unavailable.\n');
    response = await nativeTools.runTestSuite(input);
  } else if (operation === 'run-ui-test') response = await nativeTools.runUiTest(input);
  else if (operation === 'export-package') response = await nativeTools.exportPackage(input);
  else if (operation === 'font-coverage') {
    if (nativeTools.validateFontCoverage === undefined)
      return result(1, '', 'Font coverage native validation is unavailable.\n');
    response = await nativeTools.validateFontCoverage(
      input as unknown as LocalizationFontCoverageRequest,
    );
  } else return result(2, '', `Unknown internal editor native operation '${operation}'.\n`);

  const record =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  return result(record.ok === true ? 0 : 1, `${JSON.stringify(response)}\n`);
}

export async function runNovelTeaScriptcIsland(
  argvText: string,
  invokeHost: ScriptcHostInvoke,
  forceRuntimeCacheRebuild = false,
): Promise<string> {
  const argv = JSON.parse(argvText) as string[];
  const cancellationCertification =
    process.env.NOVELTEA_CLI_CERTIFICATION === '1' && argv[0] === '__comfyui-cancel-certification';
  const effectiveArgv = cancellationCertification ? argv.slice(1) : argv;
  const nativeTools = createNativeTools(invokeHost);
  const internal = await runInternalCommand(effectiveArgv, nativeTools, invokeHost);
  if (internal !== null) return internal;

  let command: readonly string[] = [];
  try {
    const { parseNovelTeaCliGlobals } = await import('../src/cli/bootstrap');
    command = parseNovelTeaCliGlobals(effectiveArgv).command;
  } catch {
    // Canonical bootstrap below owns usage diagnostics. Failed preliminary parsing must not
    // guess a command family and eagerly initialize capabilities for an invalid command line.
  }
  const family = command[0];
  const operation = command[1];

  let platformTools: NovelTeaCliPlatformToolService | undefined;
  if (family === 'platform') {
    const { createNovelTeaCliPlatformToolService } =
      await import('../src/cli/platform-tool-service-node');
    platformTools = createNovelTeaCliPlatformToolService(nativeTools);
  }

  const platformNeedsHost =
    family === 'platform' &&
    (operation === 'export' || (operation === 'template' && command[2] === 'install'));
  const projectNeedsHost = family === 'project' && operation === 'export';
  if (
    family === 'comfyui' ||
    (family === 'asset' && operation === 'import') ||
    platformNeedsHost ||
    projectNeedsHost
  ) {
    trace('platform host configuration starting');
    await configureScriptcPlatformHost(invokeHost);
  }

  const projectIndependentPlatform =
    family === 'platform' && (operation === 'template' || operation === 'config');
  let fileSystem:
    | import('../src/shared/project-workspace/project-workspace-file-system').ProjectWorkspaceFileSystem
    | undefined;
  let workspace:
    | import('../src/shared/project-workspace/project-workspace-service').ProjectWorkspaceService
    | undefined;
  if (!projectIndependentPlatform) {
    trace('workspace services import starting');
    const [fileSystemModule, serviceModule, transactionModule, metadataModule, cryptoModule] =
      await Promise.all([
        import('../src/shared/project-workspace/node-project-workspace-file-system'),
        import('../src/shared/project-workspace/project-workspace-service'),
        import('../src/shared/project-workspace/project-workspace-transaction'),
        import('./noveltea-scriptc-path-metadata'),
        import('../src/shared/web-crypto'),
      ]);
    cryptoModule.configureSha256BytesImplementation(async (bytes) =>
      createHash('sha256').update(bytes).digest('hex'),
    );
    fileSystem = fileSystemModule.createNodeProjectWorkspaceFileSystem(
      metadataModule.createScriptcPathMetadataReader(invokeHost),
    );
    workspace = new serviceModule.ProjectWorkspaceService(
      fileSystem,
      new transactionModule.ProjectWorkspaceTransactionService(
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
  }

  let agentKitPayload: import('../src/cli/agent-kit').NovelTeaAgentKitPayload | undefined;
  if (family === 'agent' && operation === 'sync') {
    const [agentKit, source] = await Promise.all([
      import('../src/cli/agent-kit'),
      import('./noveltea-scriptc-agent-kit-source'),
    ]);
    agentKitPayload = agentKit.createNovelTeaAgentKitPayload(
      source.scriptcAgentKitSourceFiles,
      source.scriptcAgentKitProvenance,
      source.scriptcAgentKitSystemLayoutSourceFiles,
    );
  }

  let embeddedBuiltInFiles: Readonly<Record<string, string>> | undefined;
  if (family === 'comfyui') {
    const comfyUi = await import('./noveltea-scriptc-comfyui-workflows');
    embeddedBuiltInFiles = comfyUi.scriptcComfyUiWorkflowFiles;
  }

  const cancellationController = cancellationCertification ? new AbortController() : null;
  const cancellationTimer = cancellationController
    ? setTimeout(() => cancellationController.abort(), 500)
    : null;
  try {
    const { runNovelTeaCli } = await import('../src/cli/application');
    const commandResult = await runNovelTeaCli(effectiveArgv, {
      ...(fileSystem ? { fileSystem } : {}),
      ...(workspace ? { workspace } : {}),
      nativeTools,
      ...(platformTools ? { platformTools } : {}),
      ...(embeddedBuiltInFiles ? { comfyUiWorkflowLibraryOptions: { embeddedBuiltInFiles } } : {}),
      ...(cancellationController ? { comfyUiAbortSignal: cancellationController.signal } : {}),
      ...(agentKitPayload ? { agentKitPayload } : {}),
      readStdinText: () => invokeHost('read-stdin', ''),
      forceRuntimeCacheRebuild,
    });
    return result(commandResult.exitCode, commandResult.stdout, commandResult.stderr);
  } finally {
    if (cancellationTimer) clearTimeout(cancellationTimer);
  }
}
