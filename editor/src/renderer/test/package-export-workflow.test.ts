import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { runPackageExportWorkflow } from '@/export/package-export-workflow';
import { runProjectPlatformExportWorkflow } from '@/export/platform-export-workflow';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { usePackageExportStore } from '@/export/package-export-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

function validProject() {
  const project = createAuthoringProject({ name: 'Workflow Demo' });
  const data = defaultRoomData('Foyer');
  data.description.source = 'Ready.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePackageExportStore.getState().clear();
  useWorkspaceStore.getState().setLastExportResult(null);
  useWorkspaceStore.getState().setStatusMessage('');
  vi.mocked(window.noveltea.exportPackage).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    manifest: { format: 'noveltea.runtime-package', entries: [{ path: 'game', size: 64 }] },
    byteCount: 512,
    checksums: { game: 'abcd' },
  });
});

describe('package export workflow', () => {
  it('validates, builds runtime data, writes package, and stores result', async () => {
    const project = validProject();
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const result = await runPackageExportWorkflow({ project, projectRoot: '/project', outputPath: '/project/out.ntpkg', profile });

    expect(result.success).toBe(true);
    expect(window.noveltea.exportPackage).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Workflow Demo', entrypoint: [3, 'foyer'] }),
      '/project/out.ntpkg',
      expect.objectContaining({ kind: 'runtime', projectName: 'Workflow Demo' }),
    );
    expect(usePackageExportStore.getState().lastResult).toMatchObject({ success: true, outputPath: '/project/out.ntpkg' });
    expect(useWorkspaceStore.getState().lastExportResult).toMatchObject({ success: true, byteCount: 512 });
  });

  it('blocks validation errors before native export', async () => {
    const project = createAuthoringProject();
    project.rooms['bad id'] = { id: 'bad id', label: '', tags: [], data: {} };
    const profile = defaultExportProfile(project);
    const result = await runPackageExportWorkflow({ project, projectRoot: '/project', outputPath: '/project/out.ntpkg', profile });

    expect(result.success).toBe(false);
    expect(result.validationDiagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });

  it('applies streamed platform export progress for the active operation', async () => {
    let progress: ((event: { operationId: string; stage: 'resolving-template' | 'writing-package'; message: string }) => void) | undefined;
    vi.mocked(window.noveltea.onPlatformExportProgress).mockImplementation((callback) => {
      progress = callback as typeof progress;
      return vi.fn();
    });
    const observedStages: string[] = [];
    vi.mocked(window.noveltea.exportProjectToPlatform).mockImplementation(async () => {
      progress?.({ operationId: 'operation-1', stage: 'resolving-template', message: 'Resolving template' });
      observedStages.push(usePackageExportStore.getState().stage);
      progress?.({ operationId: 'other-operation', stage: 'writing-package', message: 'Ignore me' });
      observedStages.push(usePackageExportStore.getState().stage);
      return { ok: true, success: true, cancelled: false, operationId: 'operation-1', diagnostics: [] };
    });

    await runProjectPlatformExportWorkflow({
      operationId: 'operation-1',
      project: validProject(),
      projectRoot: '/project',
      profileId: 'linux-release',
      outputDirectory: '/project/dist/linux-release',
    }, defaultPlatformExportProfile('linux'));

    expect(observedStages).toEqual(['resolving-template', 'resolving-template']);
    expect(usePackageExportStore.getState().stage).toBe('complete');
  });
});
