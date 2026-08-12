import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { PackageExportResponse, ToolDiagnostic } from '../../shared/editor-tooling';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ExportProfileData } from '../../shared/project-schema/authoring-export';
import { prepareRuntimeArtifact } from '../../shared/runtime-artifact-preparation';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import { type PackageExportWorkflowResult, usePackageExportStore } from './package-export-store';
import {
  rendererRuntimeArtifactPaths,
  rendererShaderCompilerAdapter,
} from './runtime-artifact-adapters';

export interface RunPackageExportWorkflowOptions {
  project: AuthoringProject;
  projectRoot: string | null;
  outputPath: string;
  profile: ExportProfileData;
}

function hasErrors(diagnostics: Array<{ severity: string }>) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function failureResult(
  stage: PackageExportWorkflowResult['stage'],
  options: RunPackageExportWorkflowOptions,
  diagnostics: ProjectValidationDiagnostic[],
  partial: Partial<PackageExportWorkflowResult> = {},
): PackageExportWorkflowResult {
  return {
    ok: false,
    success: false,
    stage,
    profile: options.profile,
    outputPath: options.outputPath,
    diagnostics,
    validationDiagnostics: [],
    shaderDiagnostics: [],
    shaderOutputs: [],
    fileEntries: [],
    manifestPreview: null,
    ...partial,
  };
}

function normalizePackageResponse(value: unknown): PackageExportResponse {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    ok: record.ok === true,
    success: record.success === true,
    diagnostics: Array.isArray(record.diagnostics) ? (record.diagnostics as ToolDiagnostic[]) : [],
    manifest: record.manifest,
    byteCount: typeof record.byteCount === 'number' ? record.byteCount : undefined,
    checksums:
      record.checksums && typeof record.checksums === 'object'
        ? (record.checksums as Record<string, string>)
        : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  };
}

export async function runPackageExportWorkflow(
  options: RunPackageExportWorkflowOptions,
): Promise<PackageExportWorkflowResult> {
  const exportStore = usePackageExportStore.getState();
  const workspace = useWorkspaceStore.getState();
  exportStore.start();
  workspace.setLastExportResult(null);
  exportStore.setStage('compiling-project');
  workspace.setStatusMessage('Building runtime package data');
  const prepared = await prepareRuntimeArtifact({
    project: options.project,
    projectRoot: options.projectRoot,
    profile: options.profile,
    intent: 'runtime-package-export',
    shaderCompiler: rendererShaderCompilerAdapter,
    paths: rendererRuntimeArtifactPaths,
    onStage: (stage) => {
      exportStore.setStage(stage);
      workspace.setStatusMessage(
        stage === 'compiling-project'
          ? 'Building runtime package data'
          : 'Compiling shaders before export',
      );
    },
  });
  if (prepared.status !== 'prepared') {
    const diagnostics = prepared.diagnostics;
    const assessment = prepared.status === 'blocked' ? prepared.assessment : null;
    const result = failureResult('failed', options, diagnostics, {
      validationDiagnostics: assessment?.runtimeDiagnostics ?? diagnostics,
      shaderDiagnostics: prepared.status === 'blocked' ? prepared.shaderDiagnostics : [],
      shaderOutputs: prepared.status === 'blocked' ? prepared.shaderOutputs : [],
      fileEntries: assessment?.fileEntries ?? [],
      manifestPreview: assessment?.manifestPreview ?? null,
    });
    exportStore.finish(result);
    workspace.setLastExportResult(result);
    workspace.addTimelineEntry({
      source: 'export',
      message: 'Export blocked by runtime conversion diagnostics',
      detail: result,
    });
    workspace.setStatusMessage('Export blocked by runtime conversion diagnostics');
    useBottomPanelStore.getState().setActivePanelId('package-export');
    return result;
  }

  exportStore.setStage('writing-package');
  workspace.setStatusMessage('Writing runtime package');
  const response = normalizePackageResponse(
    await window.noveltea.exportPackage(
      prepared.artifact.compiledProject,
      options.outputPath,
      prepared.artifact.packageOptions,
    ),
  );
  const publicationDiagnostics = classifyProjectValidationDiagnostics(response.diagnostics ?? [], {
    producer: 'package-publication',
  });
  const diagnostics = collectProjectValidationDiagnostics(
    prepared.artifact.diagnostics,
    publicationDiagnostics,
  );
  const runtimeDiagnostics = diagnostics.filter((diagnostic) =>
    diagnostic.boundaries.includes('runtime-package'),
  );
  const success = response.ok && response.success && !hasErrors(runtimeDiagnostics);
  const result: PackageExportWorkflowResult = {
    ok: response.ok,
    success,
    stage: success ? 'complete' : 'failed',
    profile: options.profile,
    outputPath: options.outputPath,
    diagnostics,
    validationDiagnostics: prepared.assessment.runtimeDiagnostics,
    shaderDiagnostics: prepared.shaderDiagnostics,
    shaderOutputs: prepared.shaderOutputs,
    fileEntries: prepared.artifact.fileEntries,
    manifestPreview: prepared.artifact.manifestPreview,
    packageResponse: response,
    manifest: response.manifest,
    byteCount: response.byteCount,
    checksums: response.checksums,
  };

  exportStore.finish(result);
  workspace.setLastExportResult(result);
  workspace.addTimelineEntry({
    source: 'export',
    message: success
      ? `Exported package ${options.outputPath}`
      : (response.error ?? 'Package export failed'),
    detail: result,
  });
  workspace.setStatusMessage(
    success
      ? `Exported ${response.byteCount ?? 0} bytes to ${options.outputPath}`
      : (response.error ?? 'Package export failed'),
  );
  useBottomPanelStore.getState().setActivePanelId('package-export');
  return result;
}
