import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { runPackageExportWorkflow } from '@/export/package-export-workflow';
import { runProjectPlatformExportWorkflow } from '@/export/platform-export-workflow';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { usePackageExportStore } from '@/export/package-export-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { editorProjectStateFromProject } from '@/workbench/project-editor-state';
import { editorProjectStateSchema } from '../../shared/project-schema/editor-project-state';

function validProject() {
  const project = createAuthoringProject({ name: 'Workflow Demo' });
  const data = defaultRoomData('Foyer');
  data.description.source = { kind: 'inline', text: 'Ready.' };
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePackageExportStore.getState().clear();
  useWorkspaceStore.getState().setLastExportResult(null);
  useWorkspaceStore.getState().setStatusMessage('');
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
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
    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile,
    });

    expect(result.success).toBe(true);
    expect(window.noveltea.exportPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        project: expect.objectContaining({ name: 'Workflow Demo' }),
        entrypoint: { kind: 'room', room: { kind: 'room', id: 'foyer' } },
      }),
      '/project/out.ntpkg',
      expect.objectContaining({ kind: 'runtime', projectName: 'Workflow Demo' }),
    );
    expect(usePackageExportStore.getState().lastResult).toMatchObject({
      success: true,
      outputPath: '/project/out.ntpkg',
    });
    expect(useWorkspaceStore.getState().lastExportResult).toMatchObject({
      success: true,
      byteCount: 512,
    });
  });

  it('blocks validation errors before native export', async () => {
    const project = createAuthoringProject();
    project.rooms['bad id'] = { id: 'bad id', label: '', data: {} as never };
    const profile = defaultExportProfile(project);
    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile,
    });

    expect(result.success).toBe(false);
    expect(result.validationDiagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(
      true,
    );
    expect(result.validationDiagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.schema.invalid_key',
        severity: 'error',
        path: '/rooms/bad id',
        ownerPaths: ['/rooms/bad id'],
        boundaries: ['authoring', 'runtime-package', 'platform-export'],
      }),
    );
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });

  it('normalizes package publication diagnostics without changing failure behavior', async () => {
    vi.mocked(window.noveltea.exportPackage).mockResolvedValue({
      ok: true,
      success: false,
      diagnostics: [
        {
          severity: 'error',
          category: 'asset-copy',
          path: '/assets/foyer',
          message: 'Asset copy failed.',
        },
      ],
    });
    const project = validProject();
    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile: { ...defaultExportProfile(project), compileShadersBeforeExport: false },
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'package.publication.asset.copy.assets.record',
        severity: 'error',
        path: '/assets/foyer',
        ownerPaths: ['/assets/foyer'],
        boundaries: ['runtime-package', 'platform-export'],
      }),
    );
  });

  it('prepares shader publication outputs without mutating authoring state or command history', async () => {
    const project = validProject();
    project.shaders.basic = {
      id: 'basic',
      label: 'Basic',
      data: defaultShaderData('Basic'),
    };
    const authored = structuredClone(project);
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    vi.mocked(window.noveltea.compileShaders).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      outputs: [
        {
          shader: 'basic',
          stage: 'fragment',
          variant: 'glsl-120',
          sourcePath: '/project/.noveltea/build/basic.fs.sc',
          runtimePath: 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
          outputPath: '/project/shaders/bgfx/glsl-120/basic.fs.bin',
          cacheKey: 'basic-fragment-glsl-120',
          cacheHit: false,
        },
      ],
    });

    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile: {
        ...defaultExportProfile(project),
        compileShadersBeforeExport: true,
        shaderVariants: ['glsl-120'],
      },
    });

    expect(result.success).toBe(true);
    expect(project).toEqual(authored);
    expect(useProjectStore.getState().document).toEqual(authored);
    expect(useCommandStore.getState().history.entries).toEqual([]);
    expect(window.noveltea.exportPackage).toHaveBeenCalledWith(
      expect.anything(),
      '/project/out.ntpkg',
      expect.objectContaining({
        shaderVariants: ['glsl-120'],
        requiredShaderBinaryPaths: ['shaders/bgfx/glsl-120/basic.fs.bin'],
        shaderMaterialMetadata: expect.objectContaining({
          shaders: expect.objectContaining({
            basic: expect.objectContaining({
              stages: expect.objectContaining({
                fragment: expect.objectContaining({
                  compiled: {
                    'glsl-120': 'project:/shaders/bgfx/glsl-120/basic.fs.bin',
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('applies streamed platform export progress for the active operation', async () => {
    const project = validProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    let progress:
      | ((event: {
          operationId: string;
          stage: 'resolving-template' | 'writing-package';
          message: string;
        }) => void)
      | undefined;
    vi.mocked(window.noveltea.onPlatformExportProgress).mockImplementation((callback) => {
      progress = callback as typeof progress;
      return vi.fn();
    });
    const observedStages: string[] = [];
    vi.mocked(window.noveltea.exportProjectToPlatform).mockImplementation(async () => {
      progress?.({
        operationId: 'operation-1',
        stage: 'resolving-template',
        message: 'Resolving template',
      });
      observedStages.push(usePackageExportStore.getState().stage);
      progress?.({
        operationId: 'other-operation',
        stage: 'writing-package',
        message: 'Ignore me',
      });
      observedStages.push(usePackageExportStore.getState().stage);
      return {
        ok: true,
        success: true,
        cancelled: false,
        operationId: 'operation-1',
        diagnostics: [],
      };
    });

    await runProjectPlatformExportWorkflow(
      {
        operationId: 'operation-1',
        project,
        projectRoot: '/project',
        profileId: 'linux-release',
        outputDirectory: '/project/dist/linux-release',
      },
      defaultPlatformExportProfile('linux'),
    );

    expect(observedStages).toEqual(['resolving-template', 'resolving-template']);
    expect(usePackageExportStore.getState().stage).toBe('complete');
  });

  it('preserves diagnostic boundaries and owner paths returned by platform orchestration', async () => {
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValue({
      ok: false,
      success: false,
      cancelled: false,
      operationId: 'contract-failure',
      diagnostics: [
        {
          code: 'authoring.project.name.required',
          severity: 'error',
          path: '/project/name',
          message: 'Project title is required.',
          boundaries: ['authoring', 'platform-export'],
          ownerPaths: ['/project/name'],
        },
      ],
    });

    await runProjectPlatformExportWorkflow(
      {
        operationId: 'contract-failure',
        project: validProject(),
        projectRoot: '/project',
        profileId: 'linux-release',
        outputDirectory: '/project/dist/linux-release',
      },
      defaultPlatformExportProfile('linux'),
    );

    expect(usePackageExportStore.getState().lastResult?.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'authoring.project.name.required',
        severity: 'error',
        path: '/project/name',
        boundaries: ['authoring', 'platform-export'],
        ownerPaths: ['/project/name'],
      }),
    );
  });

  it('records export identity only after successful final publication', async () => {
    const project = validProject();
    project.settings.app = {
      ...projectSettingsFromProject(project).app,
      applicationId: 'org.example.workflow',
      saveNamespace: 'workflow-save',
    };
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValue({
      ok: true,
      success: true,
      cancelled: false,
      operationId: 'successful-export',
      diagnostics: [],
    });

    const result = await runProjectPlatformExportWorkflow(
      {
        operationId: 'successful-export',
        project,
        projectRoot: '/project',
        profileId: 'linux-release',
        outputDirectory: '/project/dist/linux-release',
      },
      defaultPlatformExportProfile('linux'),
    );

    expect(result.success).toBe(true);
    expect(window.noveltea.saveProjectEditorMetadata).toHaveBeenCalledWith(
      '/project/game.json',
      expect.any(String),
      expect.objectContaining({
        lastSuccessfulPlatformExportIdentity: expect.objectContaining({
          applicationId: 'org.example.workflow',
          saveNamespace: 'workflow-save',
        }),
      }),
    );
    expect(useProjectStore.getState().document).toHaveProperty(
      'editor.lastSuccessfulPlatformExportIdentity.applicationId',
      'org.example.workflow',
    );
    const parsedEditorState = editorProjectStateSchema.safeParse(
      (useProjectStore.getState().document as Record<string, unknown>).editor,
    );
    expect(
      parsedEditorState.success,
      parsedEditorState.success ? undefined : JSON.stringify(parsedEditorState.error.issues),
    ).toBe(true);
    expect(
      editorProjectStateFromProject(useProjectStore.getState().document)
        .lastSuccessfulPlatformExportIdentity,
    ).toMatchObject({
      applicationId: 'org.example.workflow',
      saveNamespace: 'workflow-save',
    });
    expect(
      projectSettingsFromProject(useProjectStore.getState().document as typeof project).app,
    ).not.toHaveProperty('lastExportedIdentity');
  });

  it.each([
    {
      label: 'failed',
      result: {
        ok: false,
        success: false,
        cancelled: false,
        operationId: 'failed-export',
        diagnostics: [],
      },
    },
    {
      label: 'cancelled',
      result: {
        ok: false,
        success: false,
        cancelled: true,
        operationId: 'cancelled-export',
        diagnostics: [],
      },
    },
  ])('does not record export identity after a $label export', async ({ result }) => {
    const project = validProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/game.json',
    });
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValue(result);

    await runProjectPlatformExportWorkflow(
      {
        operationId: result.operationId,
        project,
        projectRoot: '/project',
        profileId: 'linux-release',
        outputDirectory: '/project/dist/linux-release',
      },
      defaultPlatformExportProfile('linux'),
    );

    expect(
      editorProjectStateFromProject(useProjectStore.getState().document)
        .lastSuccessfulPlatformExportIdentity,
    ).toBeUndefined();
  });
});
