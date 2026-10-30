import { useProjectStore } from '@/project/project-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useBottomPanelStore } from '@/workbench/bottom-panel-store';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { editorProjectStateSchema } from '../../shared/project-schema/editor-project-state';
import type {
  PlatformExportProfile,
  PlatformStageRequest,
  PlatformStageResult,
  ProjectPlatformExportRequest,
} from '../../shared/project-schema/platform-export-contracts';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createPlatformExportValidationDiagnostic,
} from '../../shared/project-schema/project-diagnostic-projection';
import {
  emptyPackageExportResult,
  usePackageExportStore,
  type PackageExportWorkflowResult,
} from './package-export-store';
import {
  runPackageExportWorkflow,
  type RunPackageExportWorkflowOptions,
} from './package-export-workflow';

function platformStageDiagnostics(result: PlatformStageResult) {
  return collectProjectValidationDiagnostics(
    classifyProjectValidationDiagnostics(
      result.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        category: diagnostic.category ?? `platform:${diagnostic.code}`,
      })),
      { producer: 'platform-export' },
    ),
  );
}

/** Stages an already validated and written runtime package. The package export workflow must run first. */
export async function runPlatformStageWorkflow(
  request: PlatformStageRequest,
): Promise<PlatformStageResult> {
  const store = usePackageExportStore.getState();
  const workspace = useWorkspaceStore.getState();
  store.start();
  store.setStage('writing-package');
  workspace.setStatusMessage(`Staging ${request.profile.label}`);
  const projectSessionId = useProjectStore.getState().projectSessionId;
  const staged = projectSessionId
    ? await window.noveltea.stagePlatformExport(projectSessionId, request)
    : {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: [
          createPlatformExportValidationDiagnostic({
            code: 'platform-export.active-project-session-required',
            severity: 'error',
            path: '/project',
            message: 'Platform staging requires the active saved Project session.',
          }),
        ],
      };
  const result: PackageExportWorkflowResult = {
    ...emptyPackageExportResult(staged.success ? 'complete' : 'failed'),
    ok: staged.ok,
    success: staged.success,
    profile: null,
    outputPath: staged.outputDirectory ?? request.outputDirectory,
    platformProfile: request.profile,
    diagnostics: platformStageDiagnostics(staged),
    platformStageResult: staged,
  };
  store.finish(result);
  workspace.setLastExportResult(result);
  workspace.setStatusMessage(
    staged.cancelled
      ? 'Platform staging cancelled'
      : staged.success
        ? `Staged ${request.profile.label}`
        : 'Platform staging failed',
  );
  workspace.addTimelineEntry({
    source: 'export',
    message: staged.success ? `Staged ${request.profile.label}` : 'Platform staging failed',
    detail: result,
  });
  useBottomPanelStore.getState().setActivePanelId('package-export');
  return staged;
}

export function cancelPlatformStageWorkflow(operationId: string) {
  const projectSessionId = useProjectStore.getState().projectSessionId;
  return projectSessionId
    ? window.noveltea.cancelPlatformExport(projectSessionId, operationId)
    : Promise.resolve({ cancelled: false });
}

async function recordSuccessfulExportIdentity(
  project: AuthoringProject,
  profile: PlatformExportProfile,
) {
  const projectState = useProjectStore.getState();
  const liveProject = projectState.document as AuthoringProject | null;
  if (!liveProject || !projectState.projectFilePath || !projectState.projectSessionId) {
    return createPlatformExportValidationDiagnostic({
      code: 'platform-export.identity-history.project-file-required',
      severity: 'error',
      category: 'Export identity history',
      path: '/editor/lastSuccessfulPlatformExportIdentity',
      message:
        'The successful export identity could not be recorded because the project has no saved project file.',
      ownerPaths: ['/editor/lastSuccessfulPlatformExportIdentity'],
    });
  }
  const exportedSettings = projectSettingsFromProject(project);
  const applicationId =
    profile.target === 'android'
      ? (exportedSettings.app.android.applicationId ?? exportedSettings.app.applicationId)
      : exportedSettings.app.applicationId;
  const snapshot = buildEditorProjectStateSnapshot();
  const editorState = editorProjectStateSchema.parse(
    JSON.parse(
      JSON.stringify({
        ...snapshot,
        lastSuccessfulPlatformExportIdentity: {
          applicationId,
          saveNamespace: exportedSettings.app.saveNamespace,
          completedAt: new Date().toISOString(),
        },
      }),
    ),
  );
  const result = await window.noveltea.saveProjectEditorMetadata(
    projectState.projectSessionId,
    editorState,
    {},
  );
  if (!result.success) {
    return createPlatformExportValidationDiagnostic({
      code: 'platform-export.identity-history.write-failed',
      severity: 'error',
      category: 'Export identity history',
      path: '/editor/lastSuccessfulPlatformExportIdentity',
      message: result.error ?? 'The successful export identity metadata could not be saved.',
      ownerPaths: ['/editor/lastSuccessfulPlatformExportIdentity'],
    });
  }
  const persisted = result.editorState ?? editorState;
  setLoadedEditorProjectState(persisted);
  useProjectStore.getState().markEditorMetadataPersisted(persisted);
  return null;
}

export async function runProjectPlatformExportWorkflow(
  request: ProjectPlatformExportRequest,
  profile: PlatformExportProfile,
): Promise<PlatformStageResult> {
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
    if (!request.project || !request.projectRoot) {
      staged = {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId ?? 'platform-export',
        diagnostics: [
          createPlatformExportValidationDiagnostic({
            code: 'platform-export.current-project-required',
            severity: 'error',
            path: '/project',
            message:
              'The current in-memory project and project root are required for editor platform export.',
          }),
        ],
      };
    } else {
      const projectSessionId = useProjectStore.getState().projectSessionId;
      if (!projectSessionId)
        throw new Error('Native platform export requires an active Project session.');
      const { projectPath: _projectPath, projectRoot: _projectRoot, ...ipcRequest } = request;
      try {
        staged = await window.noveltea.exportProjectToPlatform(projectSessionId, {
          ...ipcRequest,
          preparedRuntimeArtifact: undefined,
        });
      } catch (error) {
        staged = {
          ok: false,
          success: false,
          cancelled: false,
          operationId: request.operationId ?? 'native-platform-export',
          diagnostics: [
            createPlatformExportValidationDiagnostic({
              code: 'platform-export.native-admission-failed',
              severity: 'error',
              path: '/project',
              message: error instanceof Error ? error.message : String(error),
            }),
          ],
        };
      }
    }
  } finally {
    removeProgressListener();
  }
  if (staged.success && request.project) {
    const metadataDiagnostic = await recordSuccessfulExportIdentity(
      request.project as AuthoringProject,
      profile,
    );
    if (metadataDiagnostic) {
      staged = {
        ...staged,
        ok: false,
        success: false,
        diagnostics: collectProjectValidationDiagnostics(staged.diagnostics, [metadataDiagnostic]),
      };
    }
  }
  const result: PackageExportWorkflowResult = {
    ...emptyPackageExportResult(staged.success ? 'complete' : 'failed'),
    ok: staged.ok,
    success: staged.success,
    profile: null,
    platformProfile: profile,
    outputPath: staged.outputDirectory ?? request.outputDirectory,
    diagnostics: platformStageDiagnostics(staged),
    platformStageResult: staged,
  };
  store.finish(result);
  workspace.setLastExportResult(result);
  workspace.setStatusMessage(
    staged.cancelled
      ? 'Platform export cancelled'
      : staged.success
        ? `Exported ${profile.label}`
        : 'Platform export failed',
  );
  workspace.addTimelineEntry({
    source: 'export',
    message: staged.success
      ? `Exported ${profile.label}`
      : staged.cancelled
        ? 'Platform export cancelled'
        : 'Platform export failed',
    detail: result,
  });
  useBottomPanelStore.getState().setActivePanelId('package-export');
  return staged;
}

/** Complete UI orchestration: all authoring/runtime/shader blockers run before platform staging. */
export async function runPlatformExportWorkflow(
  packageOptions: Omit<RunPackageExportWorkflowOptions, 'outputPath'>,
  request: PlatformStageRequest,
): Promise<PlatformStageResult> {
  const packaged = await runPackageExportWorkflow({
    ...packageOptions,
    outputPath: request.packagePath,
  });
  if (!packaged.success)
    return {
      ok: false,
      success: false,
      cancelled: false,
      operationId: request.operationId,
      diagnostics: classifyProjectValidationDiagnostics(packaged.diagnostics, {
        producer: 'runtime-export',
      }),
    };
  return runPlatformStageWorkflow({
    ...request,
  });
}
