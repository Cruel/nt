import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackageExportDialog } from '@/export/PackageExportDialog';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { usePackageExportStore } from '@/export/package-export-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';

function exportableProject() {
  const project = createAuthoringProject({ name: 'Dialog Export' });
  const room = defaultRoomData('Foyer');
  room.description.source = { kind: 'inline', text: 'Ready.' };
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.assets.icon = {
    id: 'icon',
    label: 'Icon',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/icon.png' },
      aliases: [],
    },
  };
  (project.settings.app as Record<string, unknown>).icon = {
    $ref: { collection: 'assets', id: 'icon' },
  };
  const linuxProfile = defaultPlatformExportProfile('linux');
  project.settings.platformExport = {
    selectedProfileId: linuxProfile.id,
    profiles: [linuxProfile],
  };
  return project;
}

function installedLinuxTemplateResult() {
  const sha = 'a'.repeat(64);
  return {
    success: true as const,
    token: 'linux-x64/build-1',
    diagnostics: [],
    template: {
      status: 'installed' as const,
      entry: {
        format: 'noveltea.template-registry' as const,
        formatVersion: 1 as const,
        templateId: 'linux-x64',
        buildId: 'build-1',
        descriptorSha256: sha,
        archiveSha256: sha,
        installedAt: new Date(0).toISOString(),
        origin: 'test',
        trust: 'official' as const,
        verified: true,
      },
      descriptor: {
        format: 'noveltea.player-template' as const,
        formatVersion: 1 as const,
        templateId: 'linux-x64',
        buildId: 'build-1',
        engineVersion: '1',
        platform: 'linux' as const,
        architecture: 'x64' as const,
        minimumPlatformVersion: 'test',
        graphicsBackends: ['opengl' as const],
        shaderVariants: ['glsl-120' as const],
        runtimePackageApi: { minimum: 2, maximum: 2 },
        playerConfigApi: { minimum: 1, maximum: 1 },
        compiledFeatures: [],
        capabilities: [],
        buildFlavor: 'release' as const,
        packageAccessModes: ['sidecar' as const],
        files: [{ path: 'player', size: 1, mode: 493, sha256: sha, role: 'player' as const }],
        runtimeDependencies: [],
        artifacts: {
          archive: 'template.tar',
          symbols: 'symbols.tar',
          sbom: 'SBOM.json',
          notices: 'NOTICE.txt',
        },
        provenance: { provider: 'github-attestation' as const, source: 'test' },
        host: { assembly: 'any' as const, requiresToolchain: false, tools: [] },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePackageExportStore.getState().clear();
  useWorkspaceStore.getState().setLastExportResult(null);
  useProjectStore.getState().clearProject();
  useCommandStore.getState().resetCommandHistory();
  vi.mocked(window.noveltea.selectPackageOutputPath).mockResolvedValue(
    '/project/dialog-export.ntpkg',
  );
  vi.mocked(window.noveltea.exportPackage).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    manifest: { entries: [{ path: 'game', size: 128 }] },
    byteCount: 256,
    checksums: { game: 'abcd' },
  });
  vi.mocked(window.noveltea.resolvePlayerTemplate).mockResolvedValue({
    success: false,
    diagnostics: [
      {
        code: 'template-missing',
        path: '/template',
        message: 'No compatible template is installed.',
      },
    ],
  });
});

describe('PackageExportDialog', () => {
  it('renders the embedded export surface without requiring dialog context', () => {
    const project = exportableProject();
    delete project.settings.platformExport;
    render(
      <PackageExportDialog
        embedded
        initialMode="platform"
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Export Project' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('No platform export profiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Linux Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Profiles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Duplicate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByText('Profile name')).not.toBeInTheDocument();
  });

  it('keeps profile editing in the dedicated profile manager', () => {
    const project = exportableProject();
    delete project.settings.platformExport;
    render(
      <PackageExportDialog
        embedded
        profileManagementOnly
        initialMode="platform"
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Export Profiles' })).toBeInTheDocument();
    expect(screen.getByText('No platform export profiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Linux Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
    expect(screen.queryByText('Profile name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export Project' })).not.toBeInTheDocument();
  });

  it('performs profile CRUD through command-backed project settings', async () => {
    const project = exportableProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    render(
      <PackageExportDialog
        embedded
        profileManagementOnly
        initialMode="platform"
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Platform export profile' })).toHaveValue(
        'platform-2',
      ),
    );
    const profileNameInput = screen
      .getAllByDisplayValue('Platform Export 2')
      .find((element) => element.tagName === 'INPUT');
    expect(profileNameInput).toBeDefined();
    fireEvent.change(profileNameInput!, { target: { value: 'Android Store' } });
    await waitFor(() => expect(profileNameInput).toHaveValue('Android Store'));

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Platform export profile' })).toHaveValue(
        'platform-2-copy',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Platform export profile' })).toHaveValue(
        'linux-release',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Platform export profile' })).toHaveValue(
        'platform-2',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByText('No platform export profiles')).toBeInTheDocument(),
    );
    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject> | null)?.settings
        .platformExport,
    ).toBeUndefined();
    expect(useCommandStore.getState().history.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('persists the first profile only after the user adds one', async () => {
    const project = exportableProject();
    delete project.settings.platformExport;
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    render(
      <PackageExportDialog
        embedded
        profileManagementOnly
        initialMode="platform"
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject> | null)?.settings
        .platformExport,
    ).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Add Linux Profile' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Platform export profile' })).toHaveValue(
        'linux-release',
      ),
    );
    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject> | null)?.settings
        .platformExport,
    ).toMatchObject({
      selectedProfileId: 'linux-release',
      profiles: [expect.objectContaining({ target: 'linux', buildFlavor: 'release' })],
    });
  });

  it('renders export profile controls and runs an export workflow', async () => {
    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={exportableProject()}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByRole('heading', { name: 'Export Project' })).toBeInTheDocument();
    expect(screen.queryByText('Profile')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Runtime Package')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('/project/dialog-export.ntpkg')).toBeInTheDocument();
    expect(screen.getByText('Manifest preview')).toBeInTheDocument();
    expect(screen.queryByText('Shader variants')).not.toBeInTheDocument();
    expect(screen.queryByText('Compile shaders before export')).not.toBeInTheDocument();
    expect(screen.queryByText('Strip shader sources')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Browse…'));
    await waitFor(() => expect(window.noveltea.selectPackageOutputPath).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    await waitFor(() => expect(window.noveltea.exportPackage).toHaveBeenCalled());
    expect(usePackageExportStore.getState().lastResult).toMatchObject({
      success: true,
      outputPath: '/project/dialog-export.ntpkg',
    });
  });

  it('allows runtime export with platform-only metadata errors and previews generated fallbacks', async () => {
    const project = exportableProject();
    project.project.name = '';
    project.project.version = '';

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByText('[Unnamed Project]')).toBeInTheDocument();
    expect(screen.getByText('0.0.0')).toBeInTheDocument();
    const exportButton = screen.getByRole('button', { name: 'Export Project' });
    expect(exportButton).toBeEnabled();

    fireEvent.click(exportButton);
    await waitFor(() => expect(window.noveltea.exportPackage).toHaveBeenCalled());
    expect(window.noveltea.exportPackage).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ name: '[Unnamed Project]' }) }),
      '/project/new-project.ntpkg',
      expect.objectContaining({
        projectName: '[Unnamed Project]',
        projectVersion: '0.0.0',
      }),
    );
    expect(project.project).toMatchObject({ name: '', version: '' });
  });

  it('shows shader options only when the project has shaders or materials', () => {
    const project = exportableProject();
    project.shaders.basic = { id: 'basic', label: 'Basic', data: defaultShaderData('Basic') };

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByText('Shader variants')).toBeInTheDocument();
    expect(screen.getByText('Compile shaders before export')).toBeInTheDocument();
    expect(screen.getByText('Strip shader sources')).toBeInTheDocument();
  });

  it('disables export and shows blocking diagnostics when preflight fails', () => {
    const project = exportableProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    expect(screen.getByText('Export is blocked')).toBeInTheDocument();
    expect(
      screen.getAllByText(
        /Missing room 'missing-room'|Entrypoint room 'missing-room' does not exist/,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Fix Errors Before Export' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open Project Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fix Errors Before Export' }));
    expect(window.noveltea.exportPackage).not.toHaveBeenCalled();
  });

  it('opens project settings from a missing-entrypoint export blocker', () => {
    const onOpenChange = vi.fn();
    const dispatched: Event[] = [];
    const listener = (event: Event) => dispatched.push(event);
    window.addEventListener('noveltea-workspace-toolbar-command', listener);
    try {
      const project = exportableProject();
      project.entrypoint = null;
      render(
        <PackageExportDialog
          open
          onOpenChange={onOpenChange}
          project={project}
          projectRoot="/project"
          projectFilePath="/project/project.json"
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Open Project Settings' }));
      expect((dispatched[0] as CustomEvent).detail).toBe('project-settings');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      window.removeEventListener('noveltea-workspace-toolbar-command', listener);
    }
  });

  it('keeps the dialog open and shows native package errors when export fails', async () => {
    const onOpenChange = vi.fn();
    vi.mocked(window.noveltea.exportPackage).mockResolvedValue({
      ok: true,
      success: false,
      diagnostics: [
        {
          severity: 'error',
          category: 'asset',
          path: 'textures/missing.png',
          message: 'Package file entry source does not exist.',
        },
      ],
      error: 'Package export failed',
    });

    render(
      <PackageExportDialog
        open
        onOpenChange={onOpenChange}
        project={exportableProject()}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    await waitFor(() => expect(screen.getByText('Last export failed')).toBeInTheDocument());
    expect(screen.getByText('Package file entry source does not exist.')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('runs the playable platform workflow without requiring a manual staging request', async () => {
    vi.mocked(window.noveltea.resolvePlayerTemplate).mockResolvedValue(
      installedLinuxTemplateResult(),
    );
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValue({
      ok: true,
      success: true,
      cancelled: false,
      operationId: 'test',
      outputDirectory: '/project/dist/linux-release',
      diagnostics: [],
    });

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={exportableProject()}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Playable Platform Export' }));
    await waitFor(() => expect(screen.getByText('linux-x64@build-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    await waitFor(() => expect(window.noveltea.exportProjectToPlatform).toHaveBeenCalled());
    const request = vi.mocked(window.noveltea.exportProjectToPlatform).mock.calls[0]![0];
    expect(request).toMatchObject({
      profileId: 'linux-release',
      templateToken: 'linux-x64/build-1',
      projectRoot: '/project',
    });
  });

  it('requires explicit confirmation before staging an application identity change', async () => {
    const project = exportableProject();
    const app = projectSettingsFromProject(project).app;
    project.settings.app = {
      ...app,
      applicationId: 'org.example.changed',
      saveNamespace: 'org.example.changed.saves',
    };
    project.editor = {
      ...emptyEditorProjectState(),
      lastSuccessfulPlatformExportIdentity: {
        applicationId: 'org.example.previous',
        saveNamespace: 'org.example.previous.saves',
      },
    };
    vi.mocked(window.noveltea.resolvePlayerTemplate).mockResolvedValue(
      installedLinuxTemplateResult(),
    );
    vi.mocked(window.noveltea.exportProjectToPlatform).mockResolvedValue({
      ok: false,
      success: false,
      cancelled: false,
      operationId: 'identity-change',
      diagnostics: [],
    });

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={project}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Playable Platform Export' }));
    await waitFor(() => expect(screen.getByText('linux-x64@build-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    expect(
      await screen.findByRole('heading', { name: 'Confirm application identity change' }),
    ).toBeInTheDocument();
    expect(window.noveltea.exportProjectToPlatform).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.noveltea.exportProjectToPlatform).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue Export' }));
    await waitFor(() => expect(window.noveltea.exportProjectToPlatform).toHaveBeenCalledTimes(1));
  });

  it('cancels an active playable export through the platform cancellation service', async () => {
    vi.mocked(window.noveltea.resolvePlayerTemplate).mockResolvedValue(
      installedLinuxTemplateResult(),
    );
    let finishExport!: (
      value: Awaited<ReturnType<typeof window.noveltea.exportProjectToPlatform>>,
    ) => void;
    vi.mocked(window.noveltea.exportProjectToPlatform).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
    );

    render(
      <PackageExportDialog
        open
        onOpenChange={vi.fn()}
        project={exportableProject()}
        projectRoot="/project"
        projectFilePath="/project/project.json"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Playable Platform Export' }));
    await waitFor(() => expect(screen.getByText('linux-x64@build-1')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Export Project' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel Export' });
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(window.noveltea.cancelPlatformExport).toHaveBeenCalledWith(
        expect.stringMatching(/^editor-/),
      ),
    );
    finishExport({
      ok: false,
      success: false,
      cancelled: true,
      operationId: 'test',
      diagnostics: [],
    });
  });
});
