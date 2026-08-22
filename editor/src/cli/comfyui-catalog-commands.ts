import path from 'node:path';
import { checkComfyUiConnection } from '../main/services/comfyui-service';
import { loadComfyUiUserConfig } from '../main/services/comfyui-user-config-service';
import {
  ComfyUiRunError,
  prepareComfyUiScalarWorkflow,
  preflightComfyUiScalarRun,
  runComfyUiScalarWorkflow,
  type ComfyUiRunnableWorkflowEntry,
} from '../main/services/comfyui-run-service';
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
import type {
  ComfyUiWorkflowActiveEntry,
  ComfyUiWorkflowDiagnostic,
  ComfyUiWorkflowLibraryEntry,
} from '../shared/comfyui-workflows';
import {
  discoverProjectRoot,
  validateExplicitProjectRoot,
  type ProjectWorkspaceDiscoveryResult,
  type ProjectWorkspaceFileSystem,
} from '../shared/project-workspace';
import { CliCommandUsageError } from './commands/types';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
  type NovelTeaCliDiagnostic,
} from './contracts';

interface RunComfyUiCatalogCommandOptions {
  command: readonly string[];
  projectOption: string | null;
  json: boolean;
  cwd: string;
  fileSystem: ProjectWorkspaceFileSystem;
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
  let outputPath: string | null = null;
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
    if (argument === '--output') {
      if (outputPath)
        throw new CliCommandUsageError(
          "Option '--output' may be supplied only once in this execution slice.",
        );
      const value = command[index + 1];
      if (!value || value.startsWith('--'))
        throw new CliCommandUsageError("Option '--output' requires a path.");
      outputPath = value;
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
        'Usage: noveltea comfyui run <workflow-id> [--input <name=value>]... --output <path> [--server <url>] [--force].',
      );
    workflowId = argument;
  }
  if (!workflowId)
    throw new CliCommandUsageError("'comfyui run' requires an explicit workflow id in issue #107.");
  if (!outputPath)
    throw new CliCommandUsageError("'comfyui run' requires '--output <path>' in issue #107.");
  return { workflowId, outputPath, server, force, inputs };
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
    defaultWorkflowId: resolved.defaultWorkflowId,
    defaultWorkflows: resolved.defaultWorkflows,
  };
}

function boundedConnectionFailure(message: string | null) {
  if (message?.toLowerCase().includes('timed out')) return 'ComfyUI connection timed out.';
  return 'ComfyUI connection check failed.';
}

function discoveryDiagnostic(discovery: Exclude<ProjectWorkspaceDiscoveryResult, { ok: true }>) {
  return cliDiagnostic(discovery.code, discovery.path, discovery.message);
}

async function optionalProjectRoot(
  projectOption: string | null,
  cwd: string,
  fileSystem: ProjectWorkspaceFileSystem,
): Promise<{ projectRoot: string | null; error?: NovelTeaCliDiagnostic }> {
  const discovery = projectOption
    ? await validateExplicitProjectRoot(fileSystem, path.resolve(cwd, projectOption))
    : await discoverProjectRoot(fileSystem, cwd);
  if (discovery.ok) return { projectRoot: discovery.projectRoot };
  if (!projectOption && discovery.code === 'WORKSPACE_NOT_FOUND') return { projectRoot: null };
  return { projectRoot: null, error: discoveryDiagnostic(discovery) };
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
      ? path.join(project.projectRoot, 'project.json')
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
    const selectedEntry = library.entries.find(
      (candidate) => candidate.active && candidate.id === runCommand.workflowId,
    );
    if (!selectedEntry) {
      const diagnostic = cliDiagnostic(
        'COMFYUI_WORKFLOW_NOT_FOUND',
        '/workflow',
        `ComfyUI workflow '${runCommand.workflowId}' is not available in the effective catalog.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: runCommand.workflowId,
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
        `ComfyUI workflow '${selectedEntry.id ?? runCommand.workflowId}' is not runnable by this NovelTea build.`,
      );
      return formatCliResult(
        {
          success: false,
          exitCode: NOVELTEA_CLI_EXIT_CODES.semantic,
          diagnostics: [diagnostic],
          workflowId: selectedEntry.id ?? runCommand.workflowId,
          serverUrl: config.serverUrl,
        },
        options.json,
        { failure: diagnostic.message },
      );
    }
    const entry = selectedEntry as ComfyUiRunnableWorkflowEntry;

    const absoluteOutputPath = path.resolve(options.cwd, runCommand.outputPath);
    let workflow;
    try {
      workflow = prepareComfyUiScalarWorkflow(entry, runCommand.inputs);
      await preflightComfyUiScalarRun({
        entry,
        outputPath: absoluteOutputPath,
        force: runCommand.force,
      });
    } catch (error) {
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
      const result = await runComfyUiScalarWorkflow({
        entry,
        workflow,
        config,
        outputPath: absoluteOutputPath,
        force: runCommand.force,
        signal,
        onProgress: options.json ? undefined : options.onRunProgress,
      });
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
          outputs: { [result.output.outputId]: result.output },
        },
        options.json,
        {
          success: `ComfyUI workflow '${entry.id}' completed.\n${result.output.outputId}: ${result.output.path}`,
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
    const status = await checkComfyUiConnection(config);
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
      ? path.join(project.projectRoot, 'project.json')
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

  const project = await optionalProjectRoot(options.projectOption, options.cwd, options.fileSystem);
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
    ? path.join(project.projectRoot, 'project.json')
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
