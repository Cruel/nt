import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
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
import { admitNativeRendererCommandFixture } from '../test-support/native-acknowledged-command-fixture';

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
  vi.mocked(window.noveltea.nativeProjectExportPackage).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    byteCount: 512,
    manifest: { format: 'noveltea.runtime-package', entries: [] },
  });
});

describe('package export workflow', () => {
  it('routes native package export through native admission without renderer TypeScript compilation', async () => {
    const project = validProject();
    const profile = defaultExportProfile(project);
    admitNativeRendererCommandFixture(project);
    useCommandStore.getState().enableNativeCommandMode(7);
    {
      const result = await runPackageExportWorkflow({
        project,
        projectRoot: '/project',
        outputPath: '/project/native.ntpkg',
        profile,
      });
      expect(result).toMatchObject({ success: true, byteCount: 512 });
      expect(window.noveltea.nativeProjectExportPackage).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        7,
        '/project/native.ntpkg',
      );
      expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
    }
  });

  it('hands native platform export to main without renderer-side compilation or prepared artifacts', async () => {
    const project = validProject();
    admitNativeRendererCommandFixture(project);
    useCommandStore.getState().enableNativeCommandMode(5);
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValueOnce({
      ok: false,
      success: false,
      cancelled: false,
      operationId: 'native-platform',
      diagnostics: [],
    });
    {
      const result = await runProjectPlatformExportWorkflow(
        {
          operationId: 'native-platform',
          project,
          projectRoot: '/project',
          profileId: 'linux-release',
          outputDirectory: '/project/dist/linux',
        },
        defaultPlatformExportProfile('linux'),
      );
      expect(result.success).toBe(false);
      expect(window.noveltea.exportProjectToPlatform).toHaveBeenCalledWith(
        '11111111-1111-4111-8111-111111111111',
        expect.objectContaining({
          project,
          preparedRuntimeArtifact: undefined,
          profileId: 'linux-release',
        }),
      );
    }
  });
  it('delegates licensing and original-byte notice handling exclusively to the native exporter', async () => {
    const project = validProject();
    project.settings.distributionNotices = [{ path: 'support/licenses/TERMS.md' }];
    admitNativeRendererCommandFixture(project);
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile,
    });
    expect(result.success).toBe(true);
    expect(window.noveltea.nativeProjectExportPackage).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      0,
      '/project/out.ntpkg',
    );
    expect(window.noveltea.readProjectTextSources).not.toHaveBeenCalled();
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });
  it('uses revision-bound native export and stores the publication result', async () => {
    const project = validProject();
    admitNativeRendererCommandFixture(project);
    const profile = { ...defaultExportProfile(project), compileShadersBeforeExport: false };
    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile,
    });

    expect(result.success).toBe(true);
    expect(window.noveltea.nativeProjectExportPackage).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      0,
      '/project/out.ntpkg',
    );
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
    expect(usePackageExportStore.getState().lastResult).toMatchObject({
      success: true,
      outputPath: '/project/out.ntpkg',
    });
    expect(useWorkspaceStore.getState().lastExportResult).toMatchObject({
      success: true,
      byteCount: 512,
    });
  });

  it('surfaces native structural admission diagnostics without a TypeScript validation pass', async () => {
    const project = createAuthoringProject();
    project.rooms['bad id'] = { id: 'bad id', label: '', data: {} as never };
    admitNativeRendererCommandFixture(project);
    vi.mocked(window.noveltea.nativeProjectExportPackage).mockResolvedValueOnce({
      ok: false,
      success: false,
      diagnostics: [
        {
          code: 'authoring.schema.invalid_key',
          severity: 'error',
          path: '/rooms/bad id',
          message: 'Invalid Room ID',
          ownerPaths: ['/rooms/bad id'],
        },
      ],
    });
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
        boundaries: ['runtime-package', 'platform-export'],
      }),
    );
    expect(window.noveltea.nativeProjectExportPackage).toHaveBeenCalledOnce();
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });

  it('normalizes package publication diagnostics without changing failure behavior', async () => {
    vi.mocked(window.noveltea.nativeProjectExportPackage).mockResolvedValue({
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
    admitNativeRendererCommandFixture(project);
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

  it('delegates shader package preparation to native without mutating editor state', async () => {
    const project = validProject();
    project.materials.basic = {
      id: 'basic',
      label: 'Basic',
      data: {
        ...defaultMaterialData('Basic', 'engine-2d'),
        shader: {
          vertex: { kind: 'project', path: 'shaders/basic.vs.sc' },
          fragment: { kind: 'project', path: 'shaders/basic.fs.sc' },
        },
      },
    };
    const authored = structuredClone(project);
    admitNativeRendererCommandFixture(project);
    vi.mocked(window.noveltea.compileShaders).mockImplementation(async (_session, request) => {
      const programs = (
        request as { programs: Record<string, { vertexSource: string; fragmentSource: string }> }
      ).programs;
      const program = Object.keys(programs)[0]!;
      return {
        ok: true,
        success: true,
        diagnostics: [],
        outputs: (['vertex', 'fragment'] as const).map((stage) => ({
          program,
          programIdentity: 'basic-program-identity',
          stage,
          variant: 'glsl-330',
          sourceIdentity:
            programs[program]![stage === 'vertex' ? 'vertexSource' : 'fragmentSource'],
          dependencies: [],
          dependencyRevisions: [],
          runtimePath: `project:/shaders/derived/glsl-330/basic-program-identity.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
          outputPath: `/project/.noveltea/build/shaders/derived/glsl-330/basic-program-identity.${stage === 'vertex' ? 'vs' : 'fs'}.bin`,
          cacheKey: `basic-${stage}-glsl-330`,
          byteHash: `sha256:${(stage === 'vertex' ? 'b' : 'a').repeat(64)}` as `sha256:${string}`,
          byteSize: 4,
          reflectedInputs: [],
          cacheHit: false,
        })),
      };
    });

    const result = await runPackageExportWorkflow({
      project,
      projectRoot: '/project',
      outputPath: '/project/out.ntpkg',
      profile: {
        ...defaultExportProfile(project),
        compileShadersBeforeExport: true,
        shaderVariants: ['glsl-330'],
      },
    });

    expect(result.success).toBe(true);
    expect(project).toEqual(authored);
    expect(useProjectStore.getState().document).toEqual(authored);
    expect(useCommandStore.getState().history.entries).toEqual([]);
    expect(window.noveltea.nativeProjectExportPackage).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      0,
      '/project/out.ntpkg',
    );
    expect(window.noveltea.compileShaders).not.toHaveBeenCalled();
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });

  it('applies streamed platform export progress for the active operation', async () => {
    const project = validProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/game.json',
      projectSessionId: 'test-project-session',
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
    admitNativeRendererCommandFixture(validProject());
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
      projectSessionId: 'test-project-session',
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
      'test-project-session',
      expect.objectContaining({
        lastSuccessfulPlatformExportIdentity: expect.objectContaining({
          applicationId: 'org.example.workflow',
          saveNamespace: 'workflow-save',
        }),
      }),
      {},
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
    admitNativeRendererCommandFixture(project);
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
