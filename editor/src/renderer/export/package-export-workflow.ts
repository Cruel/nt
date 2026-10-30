import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { PackageExportResponse, ToolDiagnostic } from '../../shared/editor-tooling';
import type { ExportProfileData } from '../../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  classifyProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-diagnostic-projection';
import { type PackageExportWorkflowResult, usePackageExportStore } from './package-export-store';

export interface RunPackageExportWorkflowOptions {
  project: AuthoringProject;
  projectRoot: string | null;
  outputPath: string;
  profile: ExportProfileData;
  allowLocalizationWarnings?: boolean;
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
  const nativeRevision = useCommandStore.getState().nativeWorkingRevision;
  if (nativeRevision === null) {
    const result = failureResult('failed', options, [
      {
        code: 'editor.native-export.session-required',
        severity: 'error',
        path: '/',
        message: 'Native Project session is required.',
        boundaries: ['runtime-package'],
        ownerPaths: ['/'],
      },
    ]);
    exportStore.finish(result);
    return result;
  }

  const projectSessionId = useProjectStore.getState().projectSessionId;
  if (!projectSessionId)
    throw new Error('Native package export requires an active Project session.');
  let response: PackageExportResponse;
  try {
    response = normalizePackageResponse(
      await window.noveltea.nativeProjectExportPackage(
        projectSessionId,
        nativeRevision,
        options.outputPath,
      ),
    );
  } catch (error) {
    response = {
      ok: false,
      success: false,
      diagnostics: [
        {
          severity: 'error',
          category: 'Native export admission',
          path: '/',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const diagnostics = classifyProjectValidationDiagnostics(response.diagnostics, {
    producer: 'package-publication',
  });
  const result: PackageExportWorkflowResult = {
    ...failureResult(response.success ? 'complete' : 'failed', options, diagnostics),
    ok: response.ok,
    success: response.ok && response.success,
    validationDiagnostics: diagnostics,
    packageResponse: response,
    manifest: response.manifest,
    byteCount: response.byteCount,
    checksums: response.checksums,
  };
  exportStore.finish(result);
  workspace.setLastExportResult(result);
  workspace.addTimelineEntry({
    source: 'export',
    message: result.success ? 'Runtime package exported' : 'Runtime package export failed',
    detail: result,
  });
  workspace.setStatusMessage(result.success ? 'Runtime package exported' : 'Export failed');
  useBottomPanelStore.getState().setActivePanelId('package-export');
  return result;
}
