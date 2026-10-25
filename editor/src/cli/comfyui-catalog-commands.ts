import path from 'node:path';
import { checkHeadlessComfyUiConnection } from '../main/services/comfyui-connection-service';
import {
  ComfyUiRunError,
  preflightComfyUiRun,
  prepareComfyUiWorkflow,
  runComfyUiWorkflow,
  type ComfyUiRunnableWorkflowEntry,
} from '../main/services/comfyui-run-service';
import { loadComfyUiUserConfig } from '../main/services/comfyui-user-config-service';
import {
  listComfyUiWorkflowLibrary,
  verifyComfyUiWorkflowLibrary,
  type WorkflowLibraryServiceOptions,
} from '../main/services/comfyui-workflow-library-service';
import {
  comfyUiServerIdentity,
  defaultComfyUiConfig,
  normalizeComfyUiSharedUserConfig,
  type ComfyUiConfig,
  type ComfyUiSharedUserConfig,
} from '../shared/comfyui';
import {
  isComfyUiWorkflowClassification,
  isComfyUiWorkflowPublicId,
  type ComfyUiWorkflowActiveEntry,
  type ComfyUiWorkflowDiagnostic,
  type ComfyUiWorkflowLibraryEntry,
} from '../shared/comfyui-workflows';
import type { NativeResidentProjectPreparation } from '../shared/project-workspace/native-project-preparation-contracts';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { CliCommandUsageError } from './commands/types';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import type { NovelTeaCliNativeToolService } from './native-tool-service';

interface RunComfyUiCatalogCommandOptions {
  command: readonly string[];
  projectOption: string | null;
  json: boolean;
  cwd: string;
  fileSystem: ProjectWorkspaceFileSystem;
  nativeTools?: NovelTeaCliNativeToolService;
  nativeProjectCommands?: NativeProjectCommandCall;
  pinnedNativePreparation?: Readonly<{
    projectRoot: string;
    preparation: NativeResidentProjectPreparation | null;
  }>;
  libraryOptions?: WorkflowLibraryServiceOptions;
  abortSignal?: AbortSignal;
  onRunProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
}

function parseWorkflowCommand(command: readonly string[]) {
  if (command[0] !== 'comfyui' || command[1] !== 'workflows') return null;
  let id: string | null = null;
  let includeAll = false;
  for (const argument of command.slice(2)) {
    if (argument === '--all') {
      if (includeAll) throw new CliCommandUsageError("Option '--all' may be supplied only once.");
      includeAll = true;
      continue;
    }
    if (argument.startsWith('--'))
      throw new CliCommandUsageError(`Unknown command option '${argument}'.`);
    if (id) throw new CliCommandUsageError('Usage: noveltea comfyui workflows [<id>] [--all].');
    id = argument;
  }
  if (id && includeAll)
    throw new CliCommandUsageError("Option '--all' is only valid when listing workflows.");
  return { id, includeAll };
}

function parseServerOption(arguments_: readonly string[], usage: string) {
  let server: string | null = null;
  const positional: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--server') {
      if (server) throw new CliCommandUsageError("Option '--server' may be supplied only once.");
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--server' requires an HTTP(S) URL.");
      server = value;
      index += 1;
      continue;
    }
    if (argument.startsWith('--'))
      throw new CliCommandUsageError(`Unknown command option '${argument}'.`);
    positional.push(argument);
  }
  if (positional.length > 1) throw new CliCommandUsageError(usage);
  return { server, positional };
}

function parseStatusCommand(command: readonly string[]) {
  if (command[0] !== 'comfyui' || command[1] !== 'status') return null;
  const parsed = parseServerOption(
    command.slice(2),
    'Usage: noveltea comfyui status [--server <url>].',
  );
  if (parsed.positional.length > 0)
    throw new CliCommandUsageError('Usage: noveltea comfyui status [--server <url>].');
  return { server: parsed.server };
}

function parseRunCommand(command: readonly string[]) {
  if (command[0] !== 'comfyui' || command[1] !== 'run') return null;
  let workflowId: string | null = null;
  let classification: string | null = null;
  const outputRoutes: string[] = [];
  let server: string | null = null;
  let force = false;
  const inputs = new Map<string, string>();
  for (let index = 2; index < command.length; index += 1) {
    const argument = command[index]!;
    if (argument === '--input') {
      const value = command[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--input' requires <name=value>.");
      const equals = value.indexOf('=');
      if (equals <= 0) throw new CliCommandUsageError("Option '--input' requires <name=value>.");
      const name = value.slice(0, equals);
      if (inputs.has(name))
        throw new CliCommandUsageError(`Input '${name}' was supplied more than once.`);
      inputs.set(name, value.slice(equals + 1));
      index += 1;
      continue;
    }
    if (argument === '--type') {
      if (classification)
        throw new CliCommandUsageError("Option '--type' may be supplied only once.");
      const value = command[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--type' requires a workflow classification.");
      if (!isComfyUiWorkflowClassification(value))
        throw new CliCommandUsageError(
          "Option '--type' requires a dotted workflow classification such as 'image.generate'.",
        );
      classification = value;
      index += 1;
      continue;
    }
    if (argument === '--output') {
      const value = command[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--output' requires <path> or <name=path>.");
      outputRoutes.push(value);
      index += 1;
      continue;
    }
    if (argument === '--server') {
      if (server) throw new CliCommandUsageError("Option '--server' may be supplied only once.");
      const value = command[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--server' requires an HTTP(S) URL.");
      server = value;
      index += 1;
      continue;
    }
    if (argument === '--force') {
      if (force) throw new CliCommandUsageError("Option '--force' may be supplied only once.");
      force = true;
      continue;
    }
    if (argument.startsWith('--'))
      throw new CliCommandUsageError(`Unknown command option '${argument}'.`);
    if (workflowId)
      throw new CliCommandUsageError(
        'Usage: noveltea comfyui run [<workflow-id> | --type <classification>] [--input <name=value>]... [--output <routing>]... [--server <url>] [--force].',
      );
    workflowId = argument;
  }
  if (workflowId && classification)
    throw new CliCommandUsageError(
      "'comfyui run' accepts either an explicit workflow id or '--type <classification>', not both.",
    );
  if (!workflowId && !classification)
    throw new CliCommandUsageError(
      "'comfyui run' requires an explicit workflow id or '--type <classification>'.",
    );
  if (force && outputRoutes.length === 0)
    throw new CliCommandUsageError(
      "Option '--force' is valid only with an explicit filesystem '--output'.",
    );
  return { workflowId, classification, outputRoutes, server, force, inputs };
}

function resolveRunFilesystemRoutes(
  outputArguments: readonly string[],
  entry: ComfyUiRunnableWorkflowEntry,
): Map<string, string> {
  const declaredIds = Object.keys(entry.definition.contract.outputs);
  const routes = new Map<string, string>();
  for (const argument of outputArguments) {
    const equals = argument.indexOf('=');
    let outputId: string;
    let routePath: string;
    if (equals > 0 && isComfyUiWorkflowPublicId(argument.slice(0, equals))) {
      outputId = argument.slice(0, equals);
      routePath = argument.slice(equals + 1);
      if (!routePath)
        throw new CliCommandUsageError(`Output route '${outputId}' requires a filesystem path.`);
    } else {
      if (declaredIds.length !== 1)
        throw new CliCommandUsageError(
          'Bare --output <path> is valid only when the workflow declares exactly one named output.',
        );
      outputId = declaredIds[0]!;
      routePath = argument;
    }
    if (!declaredIds.includes(outputId))
      throw new CliCommandUsageError(`Workflow does not declare output '${outputId}'.`);
    if (routes.has(outputId))
      throw new CliCommandUsageError(`Output '${outputId}' was routed more than once.`);
    routes.set(outputId, routePath);
  }
  return routes;
}

function parseVerifyCommand(command: readonly string[]) {
  if (command[0] !== 'comfyui' || command[1] !== 'verify') return null;
  const parsed = parseServerOption(
    command.slice(2),
    'Usage: noveltea comfyui verify [<id>] [--server <url>].',
  );
  return { id: parsed.positional[0] ?? null, server: parsed.server };
}

function resolvedComfyUiConfig(
  shared: ComfyUiSharedUserConfig,
  serverOverride: string | null,
): ComfyUiConfig {
  let resolved: ComfyUiSharedUserConfig;
  try {
    resolved = normalizeComfyUiSharedUserConfig({
      ...shared,
      ...(serverOverride ? { serverUrl: serverOverride } : {}),
    });
  } catch {
    throw new CliCommandUsageError('ComfyUI server must be a valid HTTP(S) URL.');
  }
  return {
    ...defaultComfyUiConfig(),
    enabled: true,
    serverUrl: resolved.serverUrl,
    requestTimeoutMs: resolved.requestTimeoutMs,
    defaultWorkflows: resolved.defaultWorkflows,
  };
}

function boundedConnectionFailure(message: string | null) {
  if (message?.toLowerCase().includes('timed out')) return 'ComfyUI connection timed out.';
  return 'ComfyUI connection check failed.';
}

async function optionalProjectRoot(
  projectOption: string | null,
  cwd: string,
  fileSystem: ProjectWorkspaceFileSystem,
  native?: NativeProjectCommandCall,
  pinned?: RunComfyUiCatalogCommandOptions['pinnedNativePreparation'],
  captureNativeGeneration = false,
): Promise<{
  projectRoot: string | null;
  sourceGeneration?: string;
  error?: NovelTeaCliDiagnostic;
}> {
  if (!native) throw new Error('ComfyUI Project access requires native Project authority.');
  {
    const root =
      pinned?.projectRoot ?? (await nativeProjectRoot(cwd, projectOption ?? undefined, fileSystem));
    if (!root)
      return projectOption
        ? {
            projectRoot: null,
            error: cliDiagnostic(
              'WORKSPACE_NOT_FOUND',
              '/project.yaml',
              'No NovelTea project.yaml was found at the selected Project root.',
            ),
          }
        : { projectRoot: null };
    if (pinned && !pinned.preparation)
      return {
        projectRoot: null,
        error: cliDiagnostic(
          'WORKSPACE_REVISION_CONFLICT',
          '/project.yaml',
          'Pinned Project has no native preparation.',
        ),
      };
    if (pinned)
      return { projectRoot: root, sourceGeneration: pinned.preparation!.sourceGeneration };
    if (!pinned) {
      const admission = await native({
        action: captureNativeGeneration ? 'comfyui-admission' : 'workspace-preflight',
        projectRoot: root,
      });
      if (!admission.ok) {
        const diagnostic = (
          admission.diagnostics as
            | Array<{ code?: string; path?: string; message?: string }>
            | undefined
        )?.[0];
        return {
          projectRoot: null,
          error: cliDiagnostic(
            diagnostic?.code ?? 'WORKSPACE_MANIFEST_INVALID',
            diagnostic?.path ?? '/project.yaml',
            diagnostic?.message ?? admission.error ?? 'Native Project admission failed.',
          ),
        };
      }
      if (captureNativeGeneration) {
        if (typeof admission.sourceGeneration !== 'string' || !admission.sourceGeneration)
          return {
            projectRoot: null,
            error: cliDiagnostic(
              'WORKSPACE_REVISION_CONFLICT',
              '/project.yaml',
              'Native ComfyUI Project admission returned no source generation.',
            ),
          };
        return { projectRoot: root, sourceGeneration: admission.sourceGeneration };
      }
    }
    return { projectRoot: root };
  }
}

function workflowDiagnosticToCli(value: ComfyUiWorkflowDiagnostic): NovelTeaCliDiagnostic {
  return cliDiagnostic(
    value.severity === 'error' ? 'COMFYUI_WORKFLOW_INVALID' : 'COMFYUI_WORKFLOW_DIAGNOSTIC',
    value.path,
    value.message,
    value.severity,
  );
}

function sourceRank(source: ComfyUiWorkflowLibraryEntry['source']) {
  if (source === 'project') return 3;
  if (source === 'user') return 2;
  return 1;
}

function activeSummary(entry: ComfyUiWorkflowActiveEntry) {
  return {
    id: entry.id,
    label: entry.label,
    source: entry.source,
    classification: entry.classification ?? null,
    description: entry.definition.description ?? null,
    validationStatus: entry.offlineStatus,
    verificationStatus: entry.onlineStatus,
    runnable: entry.runnable,
    packageHash: entry.packageHash ?? null,
  };
}

function diagnosticSummary(entry: ComfyUiWorkflowLibraryEntry) {
  return {
    id: entry.id ?? null,
    label: entry.label ?? null,
    source: entry.source,
    workflowKey: entry.workflowKey,
    manifestFile: entry.manifestFile,
    classification: entry.classification ?? null,
    validationStatus: entry.offlineStatus,
    verificationStatus: entry.onlineStatus,
    runnable: entry.runnable ?? false,
    active: entry.active,
    overridden: entry.overridden,
    overriddenBy: entry.overriddenBy ?? null,
    packageHash: entry.packageHash ?? null,
    diagnostics: entry.diagnostics,
    verificationDiagnostics: entry.verificationDiagnostics,
  };
}

function inspectedWorkflow(entry: ComfyUiWorkflowActiveEntry) {
  const definition = entry.definition;
  return {
    id: entry.id,
    label: entry.label,
    provider: definition.provider,
    source: entry.source,
    workflowKey: entry.workflowKey,
    packageHash: entry.packageHash ?? null,
    classification: entry.classification ?? null,
    description: definition.description ?? null,
    validationStatus: entry.offlineStatus,
    runnable: entry.runnable,
    verification: {
      status: entry.onlineStatus,
      diagnostics: entry.verificationDiagnostics,
    },
    inputs: definition.contract.inputs,
    outputs: definition.contract.outputs,
    requiredNodeClasses: definition.requiredNodeClasses,
  };
}

function listHuman(entries: ReturnType<typeof activeSummary>[]) {
  if (entries.length === 0) return 'No ComfyUI workflows found.';
  return entries
    .map(
      (entry) =>
        `${entry.id}\t${entry.source}\t${entry.classification ?? '-'}\t${entry.validationStatus}\t${entry.label}`,
    )
    .join('\n');
}

function listAllHuman(entries: ReturnType<typeof diagnosticSummary>[]) {
  if (entries.length === 0) return 'No ComfyUI workflow packages found.';
  return entries
    .map((entry) => {
      const identity = entry.id ?? entry.manifestFile;
      const state = entry.active
        ? 'active'
        : entry.overridden
          ? `overridden by ${entry.overriddenBy}`
          : 'inactive';
      return `${identity}\t${entry.source}\t${entry.validationStatus}\t${state}`;
    })
    .join('\n');
}

function statusHuman(status: {
  serverUrl: string;
  comfyUiVersion: string | null;
  queueRemaining: number | null;
}) {
  return [
    `ComfyUI ready at ${status.serverUrl}`,
    `Version: ${status.comfyUiVersion ?? 'unknown'}`,
    `Queue: ${status.queueRemaining ?? 'unknown'}`,
  ].join('\n');
}

function verifyHuman(
  serverUrl: string,
  verified: readonly { id: string }[],
  skipped: readonly string[],
) {
  const lines = [`ComfyUI verification succeeded at ${serverUrl}.`];
  if (verified.length > 0) lines.push(`Verified: ${verified.map((entry) => entry.id).join(', ')}`);
  if (skipped.length > 0) lines.push(`Skipped: ${skipped.join(', ')}`);
  return lines.join('\n');
}

function inspectHuman(entry: ReturnType<typeof inspectedWorkflow>) {
  const lines = [
    `${entry.id} — ${entry.label}`,
    `Source: ${entry.source}`,
    `Classification: ${entry.classification ?? '-'}`,
    `Validation: ${entry.validationStatus}`,
    `Verification: ${entry.verification.status}`,
    `Runnable: ${entry.runnable ? 'yes' : 'no'}`,
  ];
  if (entry.description) lines.push(`Description: ${entry.description}`);
  lines.push('Inputs:');
  for (const [id, input] of Object.entries(entry.inputs)) {
    const defaultText =
      input.defaultValue === undefined ? '' : ` default=${JSON.stringify(input.defaultValue)}`;
    const authoring = input.authoring?.label ? ` (${input.authoring.label})` : '';
    lines.push(
      `  ${id}: ${input.type} ${input.required ? 'required' : 'optional'}${defaultText}${authoring}`,
    );
  }
  lines.push('Outputs:');
  for (const [id, output] of Object.entries(entry.outputs))
    lines.push(
      `  ${id}: ${output.mediaType} ${output.cardinality} ${output.required ? 'required' : 'optional'}`,
    );
  return lines.join('\n');
}

export async function runComfyUiCatalogCommand(
  options: RunComfyUiCatalogCommandOptions,
): Promise<NovelTeaCliCommandResult | null> {
  const runCommand = parseRunCommand(options.command);
  if (runCommand) {
    const project = await optionalProjectRoot(
      options.projectOption,
      options.cwd,
      options.fileSystem,
      options.nativeProjectCommands,
      options.pinnedNativePreparation,
      true,
    );
    if (project.error)
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
          diagnostics: [project.error],
        },
        options.json,
        { failure: project.error.message },
      );
    const shared = await loadComfyUiUserConfig();
    const config = resolvedComfyUiConfig(shared, runCommand.server);
    const projectFilePath = project.projectRoot
      ? path.join(project.projectRoot, 'project.yaml')
      : null;
    const library = await listComfyUiWorkflowLibrary(
      {
        projectFilePath,
        includeOverridden: false,
        serverIdentity: comfyUiServerIdentity(config.serverUrl),
        comfyUiVersion: 'unknown',
      },
      options.libraryOptions,
    );
    const resolvedWorkflowId =
      runCommand.workflowId ?? config.defaultWorkflows[runCommand.classification!];
    if (!resolvedWorkflowId) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_DEFAULT_WORKFLOW_NOT_CONFIGURED',
        '/workflow',
        `No default ComfyUI workflow is configured for classification '${runCommand.classification}'.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          classification: runCommand.classification,
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    const selectedEntry = library.entries.find(
      (candidate) => candidate.active && candidate.id === resolvedWorkflowId,
    );
    if (!selectedEntry) {
      const diagnostic = cliDiagnostic(
        runCommand.classification
          ? 'COMFYUI_DEFAULT_WORKFLOW_UNAVAILABLE'
          : 'COMFYUI_WORKFLOW_NOT_FOUND',
        '/workflow',
        runCommand.classification
          ? `Configured default ComfyUI workflow '${resolvedWorkflowId}' for classification '${runCommand.classification}' is not available in the effective catalog.`
          : `ComfyUI workflow '${resolvedWorkflowId}' is not available in the effective catalog.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: resolvedWorkflowId,
          ...(runCommand.classification ? { classification: runCommand.classification } : {}),
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    if (runCommand.classification && selectedEntry.classification !== runCommand.classification) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_DEFAULT_WORKFLOW_CLASSIFICATION_MISMATCH',
        '/workflow',
        `Configured default ComfyUI workflow '${resolvedWorkflowId}' is classified as '${selectedEntry.classification ?? 'unclassified'}', not '${runCommand.classification}'.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: resolvedWorkflowId,
          classification: runCommand.classification,
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    if (
      !selectedEntry.runnable ||
      !selectedEntry.id ||
      !selectedEntry.label ||
      !selectedEntry.definition ||
      !selectedEntry.workflowJsonText ||
      !selectedEntry.packageHash
    ) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_WORKFLOW_NOT_RUNNABLE',
        '/workflow',
        `ComfyUI workflow '${selectedEntry.id ?? resolvedWorkflowId}' is not runnable by this NovelTea build.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: selectedEntry.id ?? resolvedWorkflowId,
          ...(runCommand.classification ? { classification: runCommand.classification } : {}),
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    const entry = selectedEntry as ComfyUiRunnableWorkflowEntry;

    let prepared;
    let runPlan;
    try {
      const filesystemRoutes = resolveRunFilesystemRoutes(runCommand.outputRoutes, entry);
      prepared = await prepareComfyUiWorkflow(entry, runCommand.inputs, options.cwd);
      runPlan = await preflightComfyUiRun({
        entry,
        filesystemRoutes: new Map(
          [...filesystemRoutes.entries()].map(([outputId, routePath]) => [
            outputId,
            path.resolve(options.cwd, routePath),
          ]),
        ),
        projectAvailable: Boolean(project.projectRoot),
        force: runCommand.force,
        config,
        imageInputs: prepared.imageInputs,
      });
      if (
        project.projectRoot &&
        !options.nativeProjectCommands &&
        Object.values(runPlan.routes).some((route) => route.target === 'asset')
      )
        throw new Error('Native ComfyUI Asset preflight requires native Project admission.');
    } catch (error) {
      if (error instanceof CliCommandUsageError) throw error;
      const failure =
        error instanceof ComfyUiRunError
          ? error
          : new ComfyUiRunError(
              'COMFYUI_PREFLIGHT_FAILED',
              '/',
              'ComfyUI execution preflight failed.',
            );
      const diagnostic = cliDiagnostic(failure.code, failure.path, failure.message);
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: entry.id,
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }

    const verification = await verifyComfyUiWorkflowLibrary(
      {
        projectFilePath,
        config,
        workflowId: entry.id,
        force: true,
      },
      options.libraryOptions,
    );
    if (!verification.success) {
      const diagnostics = verification.diagnostics.map((value) =>
        cliDiagnostic('COMFYUI_VERIFICATION_FAILED', value.path, value.message, value.severity),
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics,
          workflowId: entry.id,
          serverUrl: config.serverUrl,
          verified: verification.verified,
          failed: verification.failed,
        },
        options.json,
        { failure: diagnostics[0]?.message ?? 'ComfyUI workflow verification failed.' },
      );
    }
    if (
      !verification.verified.some(
        (record) =>
          record.workflowKey === entry.workflowKey && record.packageHash === entry.packageHash,
      )
    ) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_WORKFLOW_CHANGED',
        '/workflow',
        `ComfyUI workflow '${entry.id}' changed while the invocation was being prepared; run it again.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: entry.id,
          serverUrl: config.serverUrl,
          packageHash: entry.packageHash,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }

    const controller = options.abortSignal ? null : new AbortController();
    const signal = options.abortSignal ?? controller!.signal;
    const onSigint = () => controller?.abort();
    if (controller) process.once('SIGINT', onSigint);
    try {
      const result = await runComfyUiWorkflow({
        entry,
        workflow: prepared.workflow,
        imageInputs: prepared.imageInputs,
        config,
        signal,
        onProgress: options.json ? undefined : options.onRunProgress,
      });
      let published;
      try {
        const publicationOptions = {
          projectRoot: project.projectRoot,
          fileSystem: options.fileSystem,
          nativeProjectCommands: options.nativeProjectCommands,
          expectedSourceGeneration: project.sourceGeneration,
          workflow: entry,
          promptId: result.promptId,
          plan: runPlan,
          outputs: result.outputs,
          force: runCommand.force,
          registerStagedOutput: options.nativeTools?.registerStagedOutput
            ? async (path: string) => options.nativeTools!.registerStagedOutput!(path)
            : undefined,
          commitStagedProjectAssets: options.nativeTools?.commitComfyUiAssetPublication
            ? async (
                request: import('../main/services/comfyui-publication-contracts').ComfyUiStagedAssetPublicationRequest,
              ) =>
                (await options.nativeTools!.commitComfyUiAssetPublication!(request)) as Record<
                  string,
                  import('../main/services/comfyui-publication-contracts').ComfyUiPublishedAssetOutput[]
                >
            : undefined,
        };
        {
          if (!options.nativeProjectCommands)
            throw new Error('Native ComfyUI publication requires native Project authority.');
          const { publishNativeComfyUiOutputs } =
            await import('../main/services/native-comfyui-asset-publication');
          published = await publishNativeComfyUiOutputs({
            ...publicationOptions,
            nativeProjectCommands: options.nativeProjectCommands,
          });
        }
      } catch (error) {
        if (error instanceof ComfyUiRunError)
          throw new ComfyUiRunError(
            error.code,
            error.path,
            error.message.startsWith('ComfyUI generation succeeded')
              ? error.message
              : `ComfyUI generation succeeded, but local publication failed: ${error.message}`,
            error.interrupted,
          );
        throw new ComfyUiRunError(
          'COMFYUI_PUBLICATION_FAILED',
          '/outputs',
          `ComfyUI generation succeeded, but local publication failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const structuredOutputs = Object.fromEntries(
        Object.entries(published).map(([outputId, values]) => [
          outputId,
          entry.definition.contract.outputs[outputId]!.cardinality === 'one'
            ? (values[0] ?? null)
            : values,
        ]),
      );
      const descriptions = Object.entries(published).flatMap(([outputId, values]) =>
        values.map((value) =>
          value.target === 'asset'
            ? `${outputId}: asset:${value.assetId}`
            : `${outputId}: ${value.path}`,
        ),
      );
      return formatCliResult(
        {
          success: true,
          exitCode: NOVELTEA_CLI_EXIT_CODES.success,
          diagnostics: [],
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          workflow: {
            id: entry.id,
            source: entry.source,
            workflowKey: entry.workflowKey,
            packageHash: entry.packageHash,
          },
          serverUrl: result.serverUrl,
          clientId: result.clientId,
          promptId: result.promptId,
          outputs: structuredOutputs,
        },
        options.json,
        {
          success: `ComfyUI workflow '${entry.id}' completed.${descriptions.length ? `\n${descriptions.join('\n')}` : ''}`,
        },
      );
    } catch (error) {
      const failure =
        error instanceof ComfyUiRunError
          ? error
          : new ComfyUiRunError('COMFYUI_RUN_FAILED', '/', 'ComfyUI execution failed.');
      const diagnostic = cliDiagnostic(failure.code, failure.path, failure.message);
      return formatCliResult(
        {
          success: false,
          exitCode: failure.interrupted
            ? NOVELTEA_CLI_EXIT_CODES.interrupted
            : NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflow: {
            id: entry.id,
            source: entry.source,
            workflowKey: entry.workflowKey,
            packageHash: entry.packageHash,
          },
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    } finally {
      if (controller) process.off('SIGINT', onSigint);
    }
  }

  const statusCommand = parseStatusCommand(options.command);
  if (statusCommand) {
    if (options.projectOption)
      throw new CliCommandUsageError(
        "Global option '--project' is not supported by project-independent 'comfyui status'.",
      );
    const shared = await loadComfyUiUserConfig();
    const config = resolvedComfyUiConfig(shared, statusCommand.server);
    const status = await checkHeadlessComfyUiConnection(config);
    if (status.state !== 'ready') {
      const diagnostic = cliDiagnostic(
        'COMFYUI_SERVER_UNAVAILABLE',
        '/server',
        boundedConnectionFailure(status.message),
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          serverUrl: config.serverUrl,
          checkedAt: status.checkedAt,
        },
        options.json,
        { failure: `${diagnostic.message} Server: ${config.serverUrl}` },
      );
    }
    const result = {
      serverUrl: config.serverUrl,
      checkedAt: status.checkedAt,
      comfyUiVersion: status.comfyUiVersion ?? null,
      queueRemaining: status.queueRemaining,
    };
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: [],
        ...result,
      },
      options.json,
      { success: statusHuman(result) },
    );
  }

  const verifyCommand = parseVerifyCommand(options.command);
  if (verifyCommand) {
    const project = await optionalProjectRoot(
      options.projectOption,
      options.cwd,
      options.fileSystem,
      options.nativeProjectCommands,
      options.pinnedNativePreparation,
    );
    if (project.error)
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
          diagnostics: [project.error],
        },
        options.json,
        { failure: project.error.message },
      );
    const shared = await loadComfyUiUserConfig();
    const config = resolvedComfyUiConfig(shared, verifyCommand.server);
    const projectFilePath = project.projectRoot
      ? path.join(project.projectRoot, 'project.yaml')
      : null;
    const verification = await verifyComfyUiWorkflowLibrary(
      {
        projectFilePath,
        config,
        workflowId: verifyCommand.id ?? undefined,
        force: true,
      },
      options.libraryOptions,
    );
    const diagnostics = verification.diagnostics.map((value) =>
      cliDiagnostic('COMFYUI_VERIFICATION_FAILED', value.path, value.message, value.severity),
    );
    if (!verification.success)
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics,
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          serverUrl: config.serverUrl,
          checkedAt: verification.checkedAt,
          workflowId: verifyCommand.id,
          verified: verification.verified,
          failed: verification.failed,
          skipped: verification.skipped,
        },
        options.json,
        { failure: diagnostics[0]?.message ?? 'ComfyUI workflow verification failed.' },
      );
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics,
        ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
        serverUrl: config.serverUrl,
        checkedAt: verification.checkedAt,
        workflowId: verifyCommand.id,
        verified: verification.verified,
        failed: verification.failed,
        skipped: verification.skipped,
      },
      options.json,
      { success: verifyHuman(config.serverUrl, verification.verified, verification.skipped) },
    );
  }

  const parsed = parseWorkflowCommand(options.command);
  if (!parsed) return null;

  const project = await optionalProjectRoot(
    options.projectOption,
    options.cwd,
    options.fileSystem,
    options.nativeProjectCommands,
    options.pinnedNativePreparation,
  );
  if (project.error)
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [project.error],
      },
      options.json,
      { failure: project.error.message },
    );

  const projectFilePath = project.projectRoot
    ? path.join(project.projectRoot, 'project.yaml')
    : null;
  const shared = await loadComfyUiUserConfig();
  const library = await listComfyUiWorkflowLibrary(
    {
      projectFilePath,
      includeOverridden: parsed.includeAll,
      serverIdentity: comfyUiServerIdentity(shared.serverUrl),
      comfyUiVersion: 'unknown',
    },
    options.libraryOptions,
  );

  if (parsed.id) {
    const selected = library.activeWorkflows.find((entry) => entry.id === parsed.id);
    if (!selected) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_WORKFLOW_NOT_FOUND',
        '/workflow',
        `ComfyUI workflow '${parsed.id}' is not available in the effective catalog.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
          workflowId: parsed.id,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    const workflow = inspectedWorkflow(selected);
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: selected.diagnostics.map(workflowDiagnosticToCli),
        ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
        workflow,
      },
      options.json,
      { success: inspectHuman(workflow) },
    );
  }

  if (parsed.includeAll) {
    const workflows = library.entries
      .map(diagnosticSummary)
      .sort(
        (left, right) =>
          (left.id ?? left.manifestFile).localeCompare(right.id ?? right.manifestFile) ||
          sourceRank(right.source) - sourceRank(left.source) ||
          left.manifestFile.localeCompare(right.manifestFile),
      );
    return formatCliResult(
      {
        success: true,
        exitCode: NOVELTEA_CLI_EXIT_CODES.success,
        diagnostics: library.diagnostics.map(workflowDiagnosticToCli),
        ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
        workflows,
      },
      options.json,
      { success: listAllHuman(workflows) },
    );
  }

  const workflows = library.activeWorkflows
    .map(activeSummary)
    .sort((left, right) => left.id.localeCompare(right.id));
  return formatCliResult(
    {
      success: true,
      exitCode: NOVELTEA_CLI_EXIT_CODES.success,
      diagnostics: [],
      ...(project.projectRoot ? { projectRoot: project.projectRoot } : {}),
      workflows,
    },
    options.json,
    { success: listHuman(workflows) },
  );
}
