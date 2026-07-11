import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import type { PlatformExportProfile, PlatformStageRequest, PlatformStageResult, ProjectPlatformExportRequest } from '../../shared/project-schema/platform-export-contracts';
import { emptyPackageExportResult, usePackageExportStore, type PackageExportWorkflowResult } from './package-export-store';
import { runPackageExportWorkflow, type RunPackageExportWorkflowOptions } from './package-export-workflow';

/** Stages an already validated and written runtime package. The package export workflow must run first. */
export async function runPlatformStageWorkflow(request: PlatformStageRequest): Promise<PlatformStageResult> {
  const store = usePackageExportStore.getState(); const workspace = useWorkspaceStore.getState();
  store.start(); store.setStage('writing-package'); workspace.setStatusMessage(`Staging ${request.profile.label}`);
  const staged = await window.noveltea.stagePlatformExport(request);
  const result: PackageExportWorkflowResult = {
    ...emptyPackageExportResult(staged.success ? 'complete' : 'failed'), ok: staged.ok, success: staged.success,
    profile: null, outputPath: staged.outputDirectory ?? request.outputDirectory,
    platformProfile: request.profile,
    diagnostics: staged.diagnostics.map(({ severity, path, message, code }) => ({ severity, path, message, category: `platform:${code}` })),
    platformStageResult: staged,
  };
  store.finish(result); workspace.setLastExportResult(result);
  workspace.setStatusMessage(staged.cancelled ? 'Platform staging cancelled' : staged.success ? `Staged ${request.profile.label}` : 'Platform staging failed');
  workspace.addTimelineEntry({ source: 'export', message: staged.success ? `Staged ${request.profile.label}` : 'Platform staging failed', detail: result });
  useBottomPanelStore.getState().setActivePanelId('package-export'); return staged;
}

export function cancelPlatformStageWorkflow(operationId: string) { return window.noveltea.cancelPlatformExport(operationId); }

export async function runProjectPlatformExportWorkflow(request: ProjectPlatformExportRequest, profile: PlatformExportProfile): Promise<PlatformStageResult> {
  const store = usePackageExportStore.getState();
  const workspace = useWorkspaceStore.getState();
  store.start();
  store.setStage('validating');
  workspace.setStatusMessage(`Validating ${profile.label}`);
  const removeProgressListener = window.noveltea.onPlatformExportProgress((progress) => {
    if (progress.operationId !== request.operationId) return;
    store.setStage(progress.stage);
    workspace.setStatusMessage(progress.message);
  });
  let staged: PlatformStageResult;
  try {
    staged = await window.noveltea.exportProjectToPlatform(request);
  } finally {
    removeProgressListener();
  }
  const result: PackageExportWorkflowResult = {
    ...emptyPackageExportResult(staged.success ? 'complete' : 'failed'),
    ok: staged.ok,
    success: staged.success,
    profile: null,
    platformProfile: profile,
    outputPath: staged.outputDirectory ?? request.outputDirectory,
    diagnostics: staged.diagnostics.map(({ severity, path, message, code }) => ({ severity, path, message, category: `platform:${code}` })),
    platformStageResult: staged,
  };
  store.finish(result);
  workspace.setLastExportResult(result);
  workspace.setStatusMessage(staged.cancelled ? 'Platform export cancelled' : staged.success ? `Exported ${profile.label}` : 'Platform export failed');
  workspace.addTimelineEntry({ source: 'export', message: staged.success ? `Exported ${profile.label}` : staged.cancelled ? 'Platform export cancelled' : 'Platform export failed', detail: result });
  useBottomPanelStore.getState().setActivePanelId('package-export');
  return staged;
}

/** Complete UI orchestration: all authoring/runtime/shader blockers run before platform staging. */
export async function runPlatformExportWorkflow(packageOptions: Omit<RunPackageExportWorkflowOptions, 'outputPath'>, request: PlatformStageRequest): Promise<PlatformStageResult> {
  const packaged = await runPackageExportWorkflow({ ...packageOptions, outputPath: request.packagePath });
  if (!packaged.success) return {
    ok: false, success: false, cancelled: false, operationId: request.operationId,
    diagnostics: packaged.diagnostics.map((item) => ({ severity: item.severity, code: item.category ?? 'runtime-package', path: item.path, message: item.message })),
  };
  return runPlatformStageWorkflow({
    ...request,
    runtimePackageReadiness: { validated: true, blockingDiagnosticCount: 0 },
  });
}
