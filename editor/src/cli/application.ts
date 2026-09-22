import path from 'node:path';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { ProjectSourceInventory } from '../shared/project-source-inventory';
import type {
  LoadedProjectWorkspaceSnapshot,
  ProjectWorkspaceOpenOptions,
  ProjectWorkspaceOpenResult,
  ProjectWorkspaceService,
} from '../shared/project-workspace/project-workspace-service';
import { bootstrapNovelTeaCli, novelTeaCliUsageFailure } from './bootstrap';
import { classifyNovelTeaCliCommand } from './command-routing';
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
import type { CliTerminalContext } from './commands/types';
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

export interface AuthoringValidationInstrumentation {
  readonly discoveryMs: number;
  readonly cacheAdmissionMs: number;
  readonly workspaceAdmissionMs: number;
  readonly freshnessProofMs: number;
  readonly diagnosticProjectionMs: number;
  readonly cachePublicationMs: number;
  readonly validationWork: Readonly<{ executed: number; reused: number }>;
  readonly sourceWork: Readonly<{
    parsedJsonSources: number;
    reusedJsonSources: number;
    readTextSources: number;
    reusedTextSources: number;
    projectedJsonSources: number;
    wholeProjectSchemaParses: number;
  }>;
  readonly preflightMs: number;
  readonly dependencyMs: number;
  readonly nativeMs: number;
  readonly fontCoveragePreparationMs: number;
  readonly fontCoverageNativeMs: number;
  readonly dependencyWork: Readonly<{
    derivedContributions: number;
    reusedContributions: number;
    analyzedOwners: number;
    reusedSourceAnalyses: number;
    fullProjectTraversals: number;
  }>;
  readonly compilerWork: Readonly<{
    wholeProjectNormalizations: number;
    linkBuilds: number;
    artifactLowerings: number;
    serializations: number;
  }>;
  readonly usefulWork: Readonly<{
    authoredFilesReread: number;
    jsonSourcesParsed: number;
    textSourcesRead: number;
    validationChecksRecomputed: number;
    dependencyWorkRecomputed: number;
    dependencyContributionsRecomputed: number;
    sourceAnalysesRecomputed: number;
    fullProjectTraversals: number;
    fullProjectProjections: number;
    foregroundSerializations: number;
    foregroundSerializedBytes: number;
  }>;
}

export interface ResidentCliProjectWorkspace extends ProjectWorkspaceService {
  hasResidentSession(projectRoot: string): Promise<boolean>;
  openForMutation(
    projectRoot: string,
    options?: ProjectWorkspaceOpenOptions,
  ): Promise<ProjectWorkspaceOpenResult>;
  verifyReadAuthority(snapshot: LoadedProjectWorkspaceSnapshot): Promise<boolean>;
  reconcileAfterOpaqueWrite(projectRoot: string): Promise<void>;
}

export interface RunNovelTeaCliOptions {
  readonly cwd?: string;
  readonly terminal?: CliTerminalContext;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly workspace?: ProjectWorkspaceService;
  readonly residentWorkspace?: ResidentCliProjectWorkspace;
  readonly nativeTools?: NovelTeaCliNativeToolService;
  readonly platformTools?: NovelTeaCliPlatformToolService;
  readonly onPlatformProgress?: (stage: string, message: string) => void;
  readonly onAuthoringValidationInstrumentation?: (
    instrumentation: AuthoringValidationInstrumentation,
  ) => void;
  readonly agentKitPayload?: NovelTeaAgentKitPayload;
  readonly stdinText?: string;
  readonly readStdinText?: () => string;
  readonly forceRuntimeCacheRebuild?: boolean;
  readonly forceAuthoringCacheRebuild?: boolean;
  readonly skipAuthoringWholeResultCache?: boolean;
  readonly expectedAuthoringValidationInputs?: ProjectSourceInventory;
  readonly comfyUiWorkflowLibraryOptions?: WorkflowLibraryServiceOptions;
  readonly abortSignal?: AbortSignal;
  readonly onComfyUiProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
  /** Internal daemon preparation pass: reconcile/open the Project but do not execute the command. */
  readonly prepareResidentSnapshotOnly?: boolean;
  /** Internal disposable-worker contract: native already pinned the supplied immutable generation. */
  readonly trustPinnedResidentSnapshot?: boolean;
  readonly pinnedExternalAssets?: readonly import('./pinned-external-assets').PinnedExternalAssetExpectation[];
  /** Internal bounded retry counter for resident read authority races. */
  readonly residentReadAttempt?: number;
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
  const routing = classifyNovelTeaCliCommand(globals.command);
  if (!routing)
    return novelTeaCliUsageFailure(
      `Unknown command path '${globals.command.join(' ')}'.`,
      globals.json,
    );

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
    const bundleWorkspace =
      routing.projectAccess === 'read' && options.residentWorkspace
        ? options.residentWorkspace
        : services.workspace;
    const projectBundle = await runNovelTeaProjectBundleCli(
      globals,
      services.fileSystem,
      bundleWorkspace,
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
    const opaqueProjectRoot =
      routing.projectAccess === 'opaque-write' && options.residentWorkspace
        ? globals.project
          ? path.resolve(cwd, globals.project)
          : await (async () => {
              const { discoverProjectRoot } =
                await import('../shared/project-workspace/project-workspace-discovery');
              const discovered = await discoverProjectRoot(services.fileSystem, cwd);
              return discovered.ok ? discovered.projectRoot : null;
            })()
        : null;
    try {
      const { runComfyUiCatalogCommand } = await import('./comfyui-catalog-commands');
      const comfyUiCatalog = await runComfyUiCatalogCommand({
        command: globals.command,
        projectOption: globals.project ?? null,
        json: globals.json,
        cwd,
        fileSystem: services.fileSystem,
        workspace:
          routing.projectAccess === 'opaque-write' && options.residentWorkspace
            ? options.residentWorkspace
            : services.workspace,
        libraryOptions: options.comfyUiWorkflowLibraryOptions,
        abortSignal: options.abortSignal,
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
    } finally {
      if (opaqueProjectRoot && options.residentWorkspace)
        await options.residentWorkspace.reconcileAfterOpaqueWrite(opaqueProjectRoot);
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
  if (routing.stdin === 'json') {
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
  const discoveryStarted = Date.now();
  const { discoverProjectRoot, validateExplicitProjectRoot } =
    await import('../shared/project-workspace/project-workspace-discovery');
  const discovery = globals.project
    ? await validateExplicitProjectRoot(fileSystemService, path.resolve(cwd, globals.project))
    : await discoverProjectRoot(fileSystemService, cwd);
  const discoveryMs = Date.now() - discoveryStarted;
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
        terminal: options.terminal,
        stdinJson,
        fileSystem: fileSystemService,
        preparation: prepared.preparation,
        nativeTools,
        platformTools,
        onPlatformProgress: options.onPlatformProgress,
        abortSignal: options.abortSignal,
        forceRuntimeCacheRebuild: options.forceRuntimeCacheRebuild ?? false,
        pinnedExternalAssets: options.pinnedExternalAssets,
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
  const activeWorkspace =
    routing.projectAccess !== 'none' && options.residentWorkspace
      ? options.residentWorkspace
      : services.workspace;
  const residentProjectSession = activeWorkspace === options.residentWorkspace;
  const validationCache =
    globals.command[0] === 'validate' && nativeTools.validateFontCoverage
      ? await import('../shared/authoring-cache')
      : null;
  const cacheAdmissionStarted = Date.now();
  const residentSessionAlreadyLoaded =
    validationCache && residentProjectSession && options.residentWorkspace
      ? await options.residentWorkspace.hasResidentSession(discovery.projectRoot)
      : false;
  const authoringCacheAdmission =
    options.forceAuthoringCacheRebuild ||
    residentSessionAlreadyLoaded ||
    options.skipAuthoringWholeResultCache
      ? null
      : await validationCache?.readAuthoringCacheAdmission(
          services.fileSystem,
          discovery.projectRoot,
          options.expectedAuthoringValidationInputs ?? null,
        );
  const cacheAdmissionMs = Date.now() - cacheAdmissionStarted;
  const cachedValidation = options.skipAuthoringWholeResultCache
    ? null
    : authoringCacheAdmission?.result;
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

  const { openCliProject } = await import('./semantic-project');
  const workspaceAdmissionStarted = Date.now();
  const opened = await openCliProject(activeWorkspace, discovery.projectRoot, {
    readOnly: command.dryRun,
    ...(routing.projectAccess === 'transactional-write' && options.residentWorkspace
      ? {
          openProject: (projectRoot, openOptions) =>
            options.residentWorkspace!.openForMutation(projectRoot, openOptions),
        }
      : {}),
  });
  const workspaceAdmissionMs = Date.now() - workspaceAdmissionStarted;
  if (!opened.ok)
    return failure(workspaceOpenExitCode(opened.diagnostics), opened.diagnostics, globals.json, {
      projectRoot: discovery.projectRoot,
    });

  try {
    const activeOpened = opened;
    const freshnessProofStarted = Date.now();
    // Resident owners already use the daemon's batched native authority proof. Re-inventorying the
    // complete Project in TypeScript here would defeat the resident change-proportional path. The
    // narrow on-disk cache is produced only by non-resident callers (editor/Node/no-daemon); daemon
    // resident results are retained/persisted by native maintenance after foreground completion.
    const validationInputs =
      validationCache && !residentProjectSession && options.expectedAuthoringValidationInputs
        ? await validationCache.captureAuthoringValidationAuthorityInputs(
            services.fileSystem,
            activeOpened.opened.snapshot,
          )
        : null;
    const freshnessProofMs = Date.now() - freshnessProofStarted;
    if (options.expectedAuthoringValidationInputs) {
      const { projectSourceInventoriesEqual } = await import('../shared/project-source-inventory');
      if (
        !validationInputs ||
        !projectSourceInventoriesEqual(options.expectedAuthoringValidationInputs, validationInputs)
      )
        throw new AuthoringValidationAuthorityMismatchError();
    }
    if (options.prepareResidentSnapshotOnly) {
      if (
        routing.projectAccess === 'read' &&
        activeWorkspace === options.residentWorkspace &&
        !options.trustPinnedResidentSnapshot &&
        !(await options.residentWorkspace.verifyReadAuthority(activeOpened.opened.snapshot))
      ) {
        const retry = options.residentReadAttempt ?? 0;
        if (retry < 2) return runNovelTeaCli(argv, { ...options, residentReadAttempt: retry + 1 });
        throw new AuthoringValidationAuthorityMismatchError();
      }
      return formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics: activeOpened.diagnostics,
          projectRoot: discovery.projectRoot,
        },
        globals.json,
        { success: 'NovelTea resident Project snapshot preparation succeeded.' },
      );
    }
    let semantic;
    try {
      semantic = await command.run({
        cwd,
        terminal: options.terminal,
        stdinJson,
        fileSystem: services.fileSystem,
        workspace: activeWorkspace,
        snapshot: activeOpened.opened.snapshot,
        sourceWork: activeOpened.opened.sourceWork,
        nativeTools,
        platformTools,
        onPlatformProgress: options.onPlatformProgress,
        abortSignal: options.abortSignal,
        forceRuntimeCacheRebuild: options.forceRuntimeCacheRebuild ?? false,
        pinnedExternalAssets: options.pinnedExternalAssets,
      });
    } finally {
      if (routing.projectAccess === 'opaque-write' && options.residentWorkspace)
        await options.residentWorkspace.reconcileAfterOpaqueWrite(discovery.projectRoot);
    }

    if (
      routing.projectAccess === 'read' &&
      activeWorkspace === options.residentWorkspace &&
      !options.trustPinnedResidentSnapshot &&
      !(await options.residentWorkspace.verifyReadAuthority(activeOpened.opened.snapshot))
    ) {
      const retry = options.residentReadAttempt ?? 0;
      if (retry < 2) return runNovelTeaCli(argv, { ...options, residentReadAttempt: retry + 1 });
      throw new AuthoringValidationAuthorityMismatchError();
    }

    const diagnosticProjectionStarted = Date.now();
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
    const diagnosticProjectionMs = Date.now() - diagnosticProjectionStarted;
    const cachePublicationStarted = Date.now();
    if (validationCache && !residentProjectSession) {
      const exactResult = {
        success: semantic.ok,
        exitCode: semantic.ok ? 0 : (semantic.exitCode ?? semanticExitCode(diagnostics)),
        diagnostics,
        editorDiagnostics,
      };
      // Persistence is restart acceleration, not foreground correctness. If an editor caller
      // supplied an exact expected authority we already proved it above; ordinary cold/no-daemon
      // validation captures its publication authority entirely after the result is known. Neither
      // the physical inventory nor the cache write may hold the foreground validation open.
      void (async () => {
        const publishInputs =
          validationInputs ??
          (await validationCache.captureAuthoringValidationAuthorityInputs(
            services.fileSystem,
            activeOpened.opened.snapshot,
          ));
        if (publishInputs)
          await validationCache.publishAuthoringCache(
            services.fileSystem,
            discovery.projectRoot,
            publishInputs,
            exactResult,
          );
      })().catch(() => {});
    }
    const cachePublicationMs = Date.now() - cachePublicationStarted;
    if (semantic.authoringValidationMetrics) {
      const dependencyWork = semantic.authoringValidationMetrics.dependencyWork;
      const compilerWork = semantic.authoringValidationMetrics.compilerWork;
      options.onAuthoringValidationInstrumentation?.({
        discoveryMs,
        cacheAdmissionMs,
        workspaceAdmissionMs,
        freshnessProofMs,
        diagnosticProjectionMs,
        cachePublicationMs,
        validationWork: activeOpened.opened.validationWork,
        sourceWork: activeOpened.opened.sourceWork,
        ...semantic.authoringValidationMetrics,
        usefulWork: {
          authoredFilesReread: activeOpened.opened.sourceWork.authoredFilesReread,
          jsonSourcesParsed: activeOpened.opened.sourceWork.parsedJsonSources,
          textSourcesRead: activeOpened.opened.sourceWork.readTextSources,
          validationChecksRecomputed: activeOpened.opened.validationWork.executed,
          dependencyWorkRecomputed:
            dependencyWork.derivedContributions + dependencyWork.analyzedOwners,
          dependencyContributionsRecomputed: dependencyWork.derivedContributions,
          sourceAnalysesRecomputed: dependencyWork.analyzedOwners,
          fullProjectTraversals:
            activeOpened.opened.sourceWork.fullProjectTraversals +
            dependencyWork.fullProjectTraversals +
            compilerWork.wholeProjectNormalizations,
          fullProjectProjections: activeOpened.opened.sourceWork.fullProjectProjections,
          foregroundSerializations:
            activeOpened.opened.sourceWork.foregroundSerializations + compilerWork.serializations,
          foregroundSerializedBytes: activeOpened.opened.sourceWork.foregroundSerializedBytes,
        },
      });
    }
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
