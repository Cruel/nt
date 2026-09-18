import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { ProjectSourceInventory } from '../shared/project-source-inventory';
import type { ProjectWorkspaceService } from '../shared/project-workspace/project-workspace-service';
import { bootstrapNovelTeaCli, novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
  type NovelTeaCliExitCode,
} from './contracts';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import {
  unavailablePlatformTools,
  type NovelTeaCliPlatformToolService,
} from './platform-tool-service';
import { CliCommandUsageError, parseCliCommand } from './commands';
import type { NovelTeaAgentKitPayload } from './agent-kit';
import type { WorkflowLibraryServiceOptions } from '../main/services/comfyui-workflow-library-service';

export class AuthoringValidationAuthorityMismatchError extends Error {
  constructor() {
    super('Authoring validation inputs no longer match the editor-authoritative disk generation.');
  }
}

function editorDiagnosticProjectionKey(diagnostic: NovelTeaCliDiagnostic): string {
  return [diagnostic.code, diagnostic.severity, diagnostic.path, diagnostic.message].join('\u0000');
}

export interface RunNovelTeaCliOptions {
  readonly cwd?: string;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly workspace?: ProjectWorkspaceService;
  readonly nativeTools?: NovelTeaCliNativeToolService;
  readonly platformTools?: NovelTeaCliPlatformToolService;
  readonly onPlatformProgress?: (stage: string, message: string) => void;
  readonly agentKitPayload?: NovelTeaAgentKitPayload;
  readonly stdinText?: string;
  readonly readStdinText?: () => string;
  readonly forceRuntimeCacheRebuild?: boolean;
  readonly forceAuthoringCacheRebuild?: boolean;
  readonly expectedAuthoringValidationInputs?: ProjectSourceInventory;
  readonly comfyUiWorkflowLibraryOptions?: WorkflowLibraryServiceOptions;
  readonly comfyUiAbortSignal?: AbortSignal;
  readonly onComfyUiProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
}

const unavailableNativeTools: NovelTeaCliNativeToolService = {
  compileShaders() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  runHeadlessTest() {
    return Promise.reject(new Error('Native NovelTea tooling is unavailable in this CLI host.'));
  },
  runTestSuite() {
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
  texturec() {
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
    failure: diagnostics[0]?.message ?? 'Command failed.',
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

function projectPreparationExitCode(
  diagnostics: readonly NovelTeaCliDiagnostic[],
): NovelTeaCliExitCode {
  return diagnostics.every((item) => item.code.startsWith('WORKSPACE_'))
    ? workspaceOpenExitCode(diagnostics)
    : semanticExitCode(diagnostics);
}

export async function runNovelTeaCli(
  argv: readonly string[],
  options: RunNovelTeaCliOptions = {},
): Promise<NovelTeaCliCommandResult> {
  const bootstrap = bootstrapNovelTeaCli(argv);
  if (bootstrap.complete) return bootstrap.result;
  const globals = bootstrap.globals;

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const platformTools = options.platformTools ?? unavailablePlatformTools;
  const nativeTools = options.nativeTools ?? unavailableNativeTools;
  let fileSystem = options.fileSystem;
  let workspace = options.workspace;
  const projectFileSystem = async () => {
    if (!fileSystem) {
      const { createNodeProjectWorkspaceFileSystem } =
        await import('../shared/project-workspace/node-project-workspace-file-system');
      fileSystem = createNodeProjectWorkspaceFileSystem();
    }
    return fileSystem;
  };
  const workspaceServices = async () => {
    const resolvedFileSystem = await projectFileSystem();
    if (!workspace) {
      const { createNodeProjectWorkspaceService } =
        await import('../shared/project-workspace/node-project-workspace-service');
      workspace = createNodeProjectWorkspaceService();
    }
    return { fileSystem: resolvedFileSystem, workspace };
  };

  if (globals.command[0] === 'project' && globals.command[1] === 'create') {
    const services = await workspaceServices();
    const { runNovelTeaProjectCreateCli } = await import('./project-create-cli');
    return runNovelTeaProjectCreateCli(globals, services.fileSystem, services.workspace);
  }
  if (
    globals.command[0] === 'project' &&
    (globals.command[1] === 'export' || globals.command[1] === 'import')
  ) {
    const services = await workspaceServices();
    const { runNovelTeaProjectBundleCli } = await import('./project-bundle-cli');
    const projectBundle = await runNovelTeaProjectBundleCli(
      globals,
      services.fileSystem,
      services.workspace,
      cwd,
    );
    if (projectBundle) return projectBundle;
  }
  if (globals.command[0] === 'agent' && globals.command[1] === 'sync') {
    const services = await workspaceServices();
    const { runNovelTeaAgentSyncCli } = await import('./agent-sync-cli');
    return runNovelTeaAgentSyncCli(globals, services.fileSystem, cwd, options.agentKitPayload);
  }

  if (globals.command[0] === 'comfyui') {
    const services = await workspaceServices();
    try {
      const { runComfyUiCatalogCommand } = await import('./comfyui-catalog-commands');
      const comfyUiCatalog = await runComfyUiCatalogCommand({
        command: globals.command,
        projectOption: globals.project ?? null,
        json: globals.json,
        cwd,
        fileSystem: services.fileSystem,
        workspace: services.workspace,
        libraryOptions: options.comfyUiWorkflowLibraryOptions,
        abortSignal: options.comfyUiAbortSignal,
        onRunProgress: options.onComfyUiProgress,
      });
      if (comfyUiCatalog) return comfyUiCatalog;
    } catch (error) {
      if (error instanceof CliCommandUsageError)
        return novelTeaCliUsageFailure(error.message, globals.json);
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
  }

  if (
    globals.command[0] === 'platform' &&
    (globals.command[1] === 'template' || globals.command[1] === 'config')
  ) {
    try {
      const { runProjectIndependentPlatformCommand } =
        await import('./platform-independent-commands');
      const independent = await runProjectIndependentPlatformCommand({
        command: globals.command,
        projectOption: globals.project,
        cwd,
        platformTools,
      });
      if (independent) {
        if (!independent.ok)
          return failure(
            independent.exitCode ?? semanticExitCode(independent.diagnostics),
            independent.diagnostics,
            globals.json,
            independent.fields,
          );
        return formatCliResult(
          {
            success: true,
            exitCode: NOVELTEA_CLI_EXIT_CODES.success,
            diagnostics: independent.diagnostics,
            ...independent.fields,
          },
          globals.json,
          {
            success: independent.humanSuccess ?? `NovelTea ${globals.command.join(' ')} succeeded.`,
          },
        );
      }
    } catch (error) {
      if (error instanceof CliCommandUsageError)
        return novelTeaCliUsageFailure(error.message, globals.json);
      return failure(
        NOVELTEA_CLI_EXIT_CODES.native,
        [
          cliDiagnostic(
            'native.platform',
            '/',
            error instanceof Error ? error.message : String(error),
          ),
        ],
        globals.json,
      );
    }
  }
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
  if (globals.command[0] === 'texturec') {
    if (globals.json)
      return novelTeaCliUsageFailure("Raw 'texturec' does not support NovelTea --json mode.", true);
    let exitCode: number;
    try {
      exitCode = nativeTools.texturec(globals.command.slice(1));
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
    command = await parseCliCommand(globals.command);
  } catch (error) {
    return novelTeaCliUsageFailure(
      error instanceof Error ? error.message : String(error),
      globals.json,
    );
  }

  let stdinJson: unknown;
  if (
    (globals.command.length === 2 &&
      globals.command[0] === 'test' &&
      (globals.command[1] === 'run-spec' || globals.command[1] === 'run-ui-spec')) ||
    (globals.command[0] === 'localization' &&
      globals.command[1] === 'reconcile' &&
      globals.command.includes('--apply'))
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

  const fileSystemService = await projectFileSystem();
  const { discoverProjectRoot, validateExplicitProjectRoot } =
    await import('../shared/project-workspace/project-workspace-discovery');
  const discovery = globals.project
    ? await validateExplicitProjectRoot(fileSystemService, path.resolve(cwd, globals.project))
    : await discoverProjectRoot(fileSystemService, cwd);
  if (!discovery.ok)
    return failure(
      NOVELTEA_CLI_EXIT_CODES.workspace,
      [cliDiagnostic(discovery.code, discovery.path, discovery.message)],
      globals.json,
      discovery.projectRoot ? { projectRoot: discovery.projectRoot } : {},
    );

  if (command.projectPreparation) {
    try {
      const { prepareCliProject } = await import('./project-preparation');
      const prepared = await prepareCliProject(
        fileSystemService,
        discovery.projectRoot,
        command.projectPreparation,
      );
      if (!prepared.ok)
        return failure(
          projectPreparationExitCode(prepared.diagnostics),
          prepared.diagnostics,
          globals.json,
          { projectRoot: discovery.projectRoot },
        );
      const semantic = await command.run({
        cwd,
        stdinJson,
        fileSystem: fileSystemService,
        preparation: prepared.preparation,
        nativeTools,
        platformTools,
        onPlatformProgress: options.onPlatformProgress,
        forceRuntimeCacheRebuild: options.forceRuntimeCacheRebuild ?? false,
      });
      const diagnostics = [...prepared.diagnostics, ...semantic.diagnostics];
      if (!semantic.ok)
        return failure(
          semantic.exitCode ?? semanticExitCode(diagnostics),
          diagnostics,
          globals.json,
          {
            projectRoot: discovery.projectRoot,
            ...semantic.fields,
          },
        );
      return formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics,
          projectRoot: discovery.projectRoot,
          ...semantic.fields,
        },
        globals.json,
        { success: semantic.humanSuccess ?? `NovelTea ${globals.command.join(' ')} succeeded.` },
      );
    } catch (error) {
      if (error instanceof CliCommandUsageError)
        return novelTeaCliUsageFailure(error.message, globals.json);
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        NOVELTEA_CLI_EXIT_CODES.internal,
        [cliDiagnostic('CLI_INTERNAL', '/', message)],
        globals.json,
        { projectRoot: discovery.projectRoot },
      );
    }
  }

  const services = await workspaceServices();
  const validationCache =
    globals.command[0] === 'validate' && nativeTools.validateFontCoverage
      ? await import('../shared/authoring-cache')
      : null;
  const cachedValidation = options.forceAuthoringCacheRebuild
    ? null
    : await validationCache?.readAuthoringCache(
        services.fileSystem,
        discovery.projectRoot,
        options.expectedAuthoringValidationInputs ?? null,
      );
  if (cachedValidation) {
    const { editorDiagnostics, ...cachedEnvelope } = cachedValidation;
    if (!cachedValidation.success)
      return {
        ...failure(cachedValidation.exitCode, cachedValidation.diagnostics, globals.json, {
          projectRoot: discovery.projectRoot,
        }),
        editorDiagnostics,
      };
    return {
      ...formatCliResult({ ...cachedEnvelope, projectRoot: discovery.projectRoot }, globals.json, {
        success: 'NovelTea validate succeeded.',
      }),
      editorDiagnostics,
    };
  }

  const validationBaseline = await validationCache?.captureAuthoringSourceBaseline(
    services.fileSystem,
    discovery.projectRoot,
  );
  const reusableAuthoring = options.forceAuthoringCacheRebuild
    ? null
    : await validationCache?.readReusableAuthoringContributions(
        services.fileSystem,
        discovery.projectRoot,
      );
  const { openCliProject } = await import('./semantic-project');
  const opened = await openCliProject(services.workspace, discovery.projectRoot, {
    readOnly: command.dryRun,
    reusableSourceContributions: reusableAuthoring?.sourceContributions,
    reusableValidationContributions: reusableAuthoring?.validationContributions,
  });
  if (!opened.ok)
    return failure(workspaceOpenExitCode(opened.diagnostics), opened.diagnostics, globals.json, {
      projectRoot: discovery.projectRoot,
    });

  try {
    let activeOpened = opened;
    let validationInputs = await validationCache?.captureAuthoringValidationInputs(
      services.fileSystem,
      activeOpened.opened.snapshot,
      validationBaseline ?? null,
      activeOpened.opened.sourceContributions,
      reusableAuthoring?.inventory ?? null,
    );
    if (reusableAuthoring && !validationInputs) {
      const freshOpened = await openCliProject(services.workspace, discovery.projectRoot, {
        readOnly: command.dryRun,
      });
      if (!freshOpened.ok)
        return failure(
          workspaceOpenExitCode(freshOpened.diagnostics),
          freshOpened.diagnostics,
          globals.json,
          { projectRoot: discovery.projectRoot },
        );
      activeOpened = freshOpened;
      validationInputs = await validationCache?.captureAuthoringValidationInputs(
        services.fileSystem,
        activeOpened.opened.snapshot,
        validationBaseline ?? null,
        activeOpened.opened.sourceContributions,
      );
    }
    if (options.expectedAuthoringValidationInputs) {
      const { projectSourceInventoriesEqual } = await import('../shared/project-source-inventory');
      if (
        !validationInputs ||
        !projectSourceInventoriesEqual(options.expectedAuthoringValidationInputs, validationInputs)
      )
        throw new AuthoringValidationAuthorityMismatchError();
    }
    const semantic = await command.run({
      cwd,
      stdinJson,
      fileSystem: services.fileSystem,
      workspace: services.workspace,
      snapshot: activeOpened.opened.snapshot,
      nativeTools,
      platformTools,
      onPlatformProgress: options.onPlatformProgress,
      forceRuntimeCacheRebuild: options.forceRuntimeCacheRebuild ?? false,
    });

    const diagnostics = [...activeOpened.diagnostics, ...semantic.diagnostics];
    let editorDiagnostics = activeOpened.opened.authoringDiagnostics;
    if (validationCache) {
      const [validation, settings] = await Promise.all([
        import('../shared/project-schema/project-validation'),
        import('../shared/project-schema/authoring-project-settings'),
      ]);
      const authoringDiagnostics = validation.collectProjectValidationDiagnostics(
        activeOpened.opened.authoringDiagnostics,
        settings.validateProjectSettingsAuthoringState(activeOpened.opened.snapshot.project),
      );
      const authoringKeys = new Set(authoringDiagnostics.map(editorDiagnosticProjectionKey));
      const supplementalDiagnostics = validation
        .classifyProjectValidationDiagnostics(semantic.diagnostics, { producer: 'compiler' })
        .filter((diagnostic) => !authoringKeys.has(editorDiagnosticProjectionKey(diagnostic)));
      editorDiagnostics = validation.collectProjectValidationDiagnostics(
        authoringDiagnostics,
        supplementalDiagnostics,
      );
    }
    if (validationInputs)
      await validationCache?.publishAuthoringCache(
        services.fileSystem,
        discovery.projectRoot,
        validationInputs,
        activeOpened.opened.sourceContributions,
        semantic.authoringDependencyAnalysis,
        {
          success: semantic.ok,
          exitCode: semantic.ok ? 0 : (semantic.exitCode ?? semanticExitCode(diagnostics)),
          diagnostics,
          editorDiagnostics,
        },
        activeOpened.opened.validationContributions,
      );
    if (!semantic.ok)
      return {
        ...failure(semantic.exitCode ?? semanticExitCode(diagnostics), diagnostics, globals.json, {
          projectRoot: discovery.projectRoot,
          ...semantic.fields,
        }),
        editorDiagnostics,
      };
    return {
      ...formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics,
          projectRoot: discovery.projectRoot,
          ...semantic.fields,
        },
        globals.json,
        { success: semantic.humanSuccess ?? `NovelTea ${globals.command.join(' ')} succeeded.` },
      ),
      editorDiagnostics,
    };
  } catch (error) {
    if (error instanceof AuthoringValidationAuthorityMismatchError) throw error;
    if (error instanceof CliCommandUsageError)
      return novelTeaCliUsageFailure(error.message, globals.json);
    const { ProjectWorkspaceMutationError } =
      await import('../shared/project-workspace/project-workspace-transaction');
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
