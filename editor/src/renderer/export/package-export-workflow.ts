import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useShaderCompileStore } from '@/shaders/shader-compile-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type {
  PackageExportOptions,
  PackageExportResponse,
  ShaderCompileDiagnostic,
  ToolDiagnostic,
} from '../../shared/editor-tooling';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import type { ExportProfileData } from '../../shared/project-schema/authoring-export';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import {
  authoringValidationSucceeded,
  validateAuthoringProject,
} from '../../shared/project-schema/authoring-validation';
import {
  buildCompiledRuntimeExport,
  hasAuthoringShadersOrMaterials,
} from '../../shared/project-schema/compiled-runtime-export';
import { type PackageExportWorkflowResult, usePackageExportStore } from './package-export-store';

export interface RunPackageExportWorkflowOptions {
  project: AuthoringProject;
  projectRoot: string | null;
  outputPath: string;
  profile: ExportProfileData;
}

function hasErrors(diagnostics: Array<{ severity: string }>) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function asToolDiagnostics(diagnostics: ShaderCompileDiagnostic[]): ToolDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    path: diagnostic.path ?? diagnostic.outputPath ?? diagnostic.sourcePath ?? '/',
    message: diagnostic.message,
    category: 'shader',
  }));
}

function failureResult(
  stage: PackageExportWorkflowResult['stage'],
  options: RunPackageExportWorkflowOptions,
  diagnostics: ToolDiagnostic[],
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

function defaultShaderCompileOptions(
  projectRoot: string | null,
  outputRoot: string | null,
  shaderVariants: string[],
) {
  const root = projectRoot ?? '';
  return {
    shaderc: '',
    bgfxShaderIncludeDir: '',
    projectRoot: root,
    outputRoot: root ? `${root}/.noveltea/build` : '',
    cacheRoot: root ? `${root}/.noveltea/cache` : '',
    shaderVariants,
  };
}

function packageOptionsWithShaderRoot(
  options: PackageExportOptions,
  projectRoot: string | null,
): PackageExportOptions {
  if (
    options.shaderVariants &&
    options.shaderVariants.length > 0 &&
    !options.shaderAssetRoot &&
    projectRoot
  ) {
    return { ...options, shaderAssetRoot: `${projectRoot}/.noveltea/build` };
  }
  return options;
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
  workspace.setStatusMessage('Validating project before export');

  const validationDiagnostics = validateAuthoringProject(options.project);
  if (!authoringValidationSucceeded(validationDiagnostics)) {
    const result = failureResult('failed', options, validationDiagnostics, {
      validationDiagnostics,
    });
    exportStore.finish(result);
    workspace.setLastExportResult(result);
    workspace.addTimelineEntry({
      source: 'export',
      message: 'Export blocked by validation errors',
      detail: result,
    });
    workspace.setStatusMessage(
      `Export blocked by ${validationDiagnostics.filter((diagnostic) => diagnostic.severity === 'error').length} validation error(s)`,
    );
    useBottomPanelStore.getState().setActivePanelId('package-export');
    return result;
  }

  exportStore.setStage('compiling-project');
  workspace.setStatusMessage('Building runtime package data');
  let built = buildCompiledRuntimeExport(options.project, {
    projectRoot: options.projectRoot,
    profile: options.profile,
  });
  if (!built.ok || !built.compiledProject) {
    const result = failureResult('failed', options, built.diagnostics, {
      validationDiagnostics,
      fileEntries: built.fileEntries,
      manifestPreview: built.manifestPreview,
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

  let shaderDiagnostics: ShaderCompileDiagnostic[] = [];
  let shaderOutputs = useShaderCompileStore.getState().outputs;
  if (
    options.profile.compileShadersBeforeExport &&
    hasAuthoringShadersOrMaterials(options.project)
  ) {
    exportStore.setStage('compiling-shaders');
    workspace.setStatusMessage('Compiling shaders before export');
    const shaderProject = buildShaderMaterialProject(options.project);
    const response = await useShaderCompileStore
      .getState()
      .runCompile(
        shaderProject.project,
        defaultShaderCompileOptions(
          options.projectRoot,
          options.projectRoot ? `${options.projectRoot}/.noveltea/build` : null,
          options.profile.shaderVariants,
        ),
      );
    shaderDiagnostics = response.diagnostics;
    shaderOutputs = response.outputs;
    if (!response.success || hasErrors(response.diagnostics)) {
      const diagnostics = [...built.diagnostics, ...asToolDiagnostics(response.diagnostics)];
      const result = failureResult('failed', options, diagnostics, {
        validationDiagnostics,
        shaderDiagnostics,
        shaderOutputs,
        fileEntries: built.fileEntries,
        manifestPreview: built.manifestPreview,
      });
      exportStore.finish(result);
      workspace.setLastExportResult(result);
      workspace.addTimelineEntry({
        source: 'export',
        message: 'Export blocked by shader compile errors',
        detail: result,
      });
      workspace.setStatusMessage('Export blocked by shader compile errors');
      useBottomPanelStore.getState().setActivePanelId('shader-compile');
      return result;
    }
    if (response.outputs.length > 0) {
      const command = useCommandStore.getState().executeCommand({
        type: 'shader.applyCompiledOutputs',
        label: 'Apply shader compile outputs for export',
        payload: { outputs: response.outputs },
      });
      if (!command.ok) {
        const diagnostics: ToolDiagnostic[] =
          command.diagnostics.length > 0
            ? command.diagnostics.map((diagnostic) => ({
                severity: diagnostic.severity,
                path: diagnostic.path ?? '/',
                message: diagnostic.message,
                category: diagnostic.commandType ?? 'shader',
              }))
            : [
                {
                  severity: 'error' as const,
                  path: '/shaders',
                  message: 'Failed to apply shader compile outputs.',
                  category: 'shader',
                },
              ];
        const result = failureResult('failed', options, diagnostics, {
          validationDiagnostics,
          shaderDiagnostics,
          shaderOutputs,
        });
        exportStore.finish(result);
        workspace.setLastExportResult(result);
        workspace.setStatusMessage('Export blocked while applying shader outputs');
        useBottomPanelStore.getState().setActivePanelId('package-export');
        return result;
      }
      const latestProject = useProjectStore.getState().document;
      if (latestProject) {
        built = buildCompiledRuntimeExport(latestProject as AuthoringProject, {
          projectRoot: options.projectRoot,
          profile: options.profile,
        });
      }
    }
  }

  exportStore.setStage('writing-package');
  workspace.setStatusMessage('Writing runtime package');
  const packageOptions = packageOptionsWithShaderRoot(built.packageOptions, options.projectRoot);
  const response = normalizePackageResponse(
    await window.noveltea.exportPackage(built.compiledProject, options.outputPath, packageOptions),
  );
  const diagnostics = [...built.diagnostics, ...(response.diagnostics ?? [])];
  const success = response.ok && response.success && !hasErrors(diagnostics);
  const result: PackageExportWorkflowResult = {
    ok: response.ok,
    success,
    stage: success ? 'complete' : 'failed',
    profile: options.profile,
    outputPath: options.outputPath,
    diagnostics,
    validationDiagnostics,
    shaderDiagnostics,
    shaderOutputs,
    fileEntries: built.fileEntries,
    manifestPreview: built.manifestPreview,
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
