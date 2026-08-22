import path from 'node:path';
import {
  listComfyUiWorkflowLibrary,
  type WorkflowLibraryServiceOptions,
} from '../main/services/comfyui-workflow-library-service';
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
  const library = await listComfyUiWorkflowLibrary(
    {
      projectFilePath,
      includeOverridden: parsed.includeAll,
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
