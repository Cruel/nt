import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackageExportDialog } from '@/export/PackageExportDialog';
import { usePackageExportStore } from '@/export/package-export-store';
import { useTemplateRegistryStore } from '@/export/template-registry-store';
import { useCommandStore } from '@/commands/command-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';

function exportableProject(withPlatformProfile = true) {
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
      imageMetadata: { width: 1024, height: 1024, hasAlpha: true, orientation: 1 },
    },
  };
  (project.settings.app as Record<string, unknown>).icon = {
    $ref: { collection: 'assets', id: 'icon' },
  };
  if (withPlatformProfile) {
    const profile = defaultPlatformExportProfile('linux');
    project.export.profiles = [profile];
  }
  return project;
}

function installedLinuxTemplate() {
  const sha = 'a'.repeat(64);
  return {
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
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
      compiledFeatures: [],
      capabilities: ['external-url' as const],
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
  };
}

function renderExport(
  project = exportableProject(),
  initialMode: 'runtime' | 'platform' = 'runtime',
) {
  return render(
    <PackageExportDialog
      embedded
      initialMode={initialMode}
      open
      onOpenChange={vi.fn()}
      project={project}
      projectRoot="/project"
      projectFilePath="/project/project.json"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  usePackageExportStore.getState().clear();
  useProjectStore.getState().clearProject();
  useProjectStore.setState({ projectSessionId: '11111111-1111-4111-8111-111111111111' });
  useCommandStore.getState().resetCommandHistory();
  usePreferencesStore.getState().resetToDefaults();
  useTemplateRegistryStore.setState({
    templates: [],
    loaded: true,
    loading: false,
    error: null,
  });
  vi.mocked(window.noveltea.loadUserExportConfig).mockResolvedValue({
    toolchains: {},
    signingProfiles: [],
  });
  vi.mocked(window.noveltea.selectPackageOutputPath).mockResolvedValue(
    '/project/custom/dialog-export.ntpkg',
  );
  vi.mocked(window.noveltea.exportPackage).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    manifest: { entries: [{ path: 'game', size: 128 }] },
    byteCount: 256,
    checksums: { game: 'abcd' },
  });
});

describe('PackageExportDialog', () => {
  it('uses one unified Export surface with the built-in Runtime Package pinned in the sidebar', () => {
    renderExport(exportableProject(false), 'platform');

    expect(screen.queryByRole('heading', { name: 'Export' })).not.toBeInTheDocument();
    expect(screen.getByText('Profiles')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Runtime Package/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Duplicate profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete profile' })).toBeDisabled();
    expect(screen.getByText('No platform export profiles')).toBeInTheDocument();
    expect(screen.queryByText('Export Profiles')).not.toBeInTheDocument();
  });

  it('keeps runtime output local and defaults it under dist', async () => {
    renderExport();
    expect(screen.getByDisplayValue('/project/dist/dialog-export.ntpkg')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    await waitFor(() => expect(window.noveltea.selectPackageOutputPath).toHaveBeenCalled());
    expect(screen.getByDisplayValue('/project/custom/dialog-export.ntpkg')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        usePreferencesStore.getState().exportPreferences.profileOutputDirectories,
      ).toMatchObject({
        '/project/project.json::runtime-package': '/project/custom/dialog-export.ntpkg',
      }),
    );
  });

  it('creates a profile as Name + Platform followed by the shared profile editor', async () => {
    const project = exportableProject(false);
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    renderExport(project, 'platform');

    fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
    expect(screen.getByRole('heading', { name: 'New Export Profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Windows');
    expect(screen.getByLabelText('Platform')).toHaveValue('windows');
    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject>).export.profiles,
    ).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Create Profile' })).toBeInTheDocument();
    expect(screen.getByText('Platform: Windows')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Windows');

    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));
    await waitFor(() =>
      expect(
        (useProjectStore.getState().document as ReturnType<typeof exportableProject>).export
          .profiles,
      ).toEqual([expect.objectContaining({ label: 'Windows', target: 'windows' })]),
    );
    expect(screen.getByRole('heading', { name: 'Windows' })).toBeInTheDocument();
  });

  it('edits an existing profile in-place and disables sidebar management until Done or Cancel', () => {
    const project = exportableProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    renderExport(project, 'platform');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
    expect(screen.getByRole('heading', { name: 'Edit Profile' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeDisabled();
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: 'Linux Shipping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.getByRole('heading', { name: 'Linux Shipping' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add profile' })).toBeEnabled();
    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject>).export
        .profiles[0]?.label,
    ).toBe('Linux Shipping');
  });

  it('derives output from the current profile name until the user chooses a custom path', () => {
    const project = exportableProject();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    renderExport(project, 'platform');

    expect(screen.getByLabelText('Output directory')).toHaveValue('/project/dist/linux');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Linux Shipping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText('Output directory')).toHaveValue('/project/dist/linux-shipping');

    fireEvent.change(screen.getByLabelText('Output directory'), {
      target: { value: '/custom/linux-output' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Linux Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByLabelText('Output directory')).toHaveValue('/custom/linux-output');
  });

  it('keeps Web base-path text editable but refuses Done until it is valid', () => {
    const project = exportableProject();
    const web = defaultPlatformExportProfile('web');
    project.export.profiles = [web];
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/project',
      projectFilePath: '/project/project.json',
    });
    renderExport(project, 'platform');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
    const input = screen.getByLabelText('Base path');
    fireEvent.change(input, { target: { value: '/game' } });
    expect(input).toHaveValue('/game');
    expect(
      screen.getByText('Base path must begin and end with / (for example /game/).'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();

    fireEvent.change(input, { target: { value: '/game/' } });
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      (useProjectStore.getState().document as ReturnType<typeof exportableProject>).export
        .profiles[0],
    ).toMatchObject({ web: { basePath: '/game/' } });
  });

  it('shows exceptional package controls only in Developer Mode', () => {
    const project = exportableProject();
    const first = renderExport(project);
    expect(screen.queryByText('Exclude Unused Assets')).not.toBeInTheDocument();
    first.unmount();

    usePreferencesStore.getState().setDeveloperMode(true);
    renderExport(project);
    expect(screen.getByText('Exclude Unused Assets')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Exclude Unused Assets' })).toBeChecked();
  });

  it('uses the application template cache without rechecking on profile switches or remounts', async () => {
    const installed = installedLinuxTemplate();
    useTemplateRegistryStore.setState({
      templates: [installed],
      loaded: true,
      loading: false,
      error: null,
    });
    const project = exportableProject();
    const linux = project.export.profiles[0]!;
    const windows = defaultPlatformExportProfile('windows');
    project.export.profiles = [linux, windows];

    const first = renderExport(project, 'platform');
    expect(await screen.findByText('linux-x64@build-1')).toBeInTheDocument();
    expect(window.noveltea.listPlayerTemplates).not.toHaveBeenCalled();
    expect(window.noveltea.resolvePlayerTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Windows/ }));
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Linux/ }));
    expect(screen.getByText('linux-x64@build-1')).toBeInTheDocument();
    expect(window.noveltea.listPlayerTemplates).not.toHaveBeenCalled();
    expect(window.noveltea.resolvePlayerTemplate).not.toHaveBeenCalled();

    first.unmount();
    renderExport(project, 'platform');
    expect(await screen.findByText('linux-x64@build-1')).toBeInTheDocument();
    expect(window.noveltea.listPlayerTemplates).not.toHaveBeenCalled();
    expect(window.noveltea.resolvePlayerTemplate).not.toHaveBeenCalled();
  });

  it('restores the last selected export profile after the Export tab remounts', async () => {
    const project = exportableProject();
    const linux = project.export.profiles[0]!;
    const windows = defaultPlatformExportProfile('windows');
    project.export.profiles = [linux, windows];

    const first = renderExport(project, 'platform');
    fireEvent.click(await screen.findByRole('button', { name: /Windows/ }));
    expect(screen.getByRole('heading', { name: 'Windows' })).toBeInTheDocument();
    expect(usePreferencesStore.getState().exportPreferences.selectedProfileIds).toMatchObject({
      '/project/project.json': windows.id,
    });
    first.unmount();

    renderExport(project, 'platform');
    expect(await screen.findByRole('heading', { name: 'Windows' })).toBeInTheDocument();
  });

  it('keeps the Export action label stable while a developer packaging change is reassessed', async () => {
    usePreferencesStore.getState().setDeveloperMode(true);
    renderExport(exportableProject(), 'runtime');
    const toggle = await screen.findByRole('checkbox', { name: 'Exclude Unused Assets' });
    expect(await screen.findByRole('button', { name: 'Export' })).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.queryByText('Checking Readiness…')).not.toBeInTheDocument();
    expect(screen.queryByText('Fix Errors Before Export')).not.toBeInTheDocument();
  });

  it('shows Download and Install actions inline when no compatible template is installed', async () => {
    renderExport(exportableProject(), 'platform');
    expect(await screen.findByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install…' })).toBeInTheDocument();
    expect(screen.getByText('A compatible installed player template is required.')).toBeVisible();
  });

  it('automatically uses the sole compatible template and only shows a chooser when needed', async () => {
    const installed = installedLinuxTemplate();
    useTemplateRegistryStore.setState({
      templates: [installed],
      loaded: true,
      loading: false,
      error: null,
    });
    renderExport(exportableProject(), 'platform');

    expect(await screen.findByText('linux-x64@build-1')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /template/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('populates signing identities from the shared user export configuration', async () => {
    vi.mocked(window.noveltea.loadUserExportConfig).mockResolvedValue({
      toolchains: {},
      signingProfiles: [
        {
          id: 'windows-release',
          label: 'Windows Release Certificate',
          target: 'windows',
          command: 'signtool',
          args: ['sign', '{executable}'],
          verifyCommand: 'signtool',
          verifyArgs: ['verify', '{executable}'],
        },
      ],
    });
    const project = exportableProject();
    const windows = defaultPlatformExportProfile('windows');
    project.export.profiles = [windows];
    renderExport(project, 'platform');

    const signing = await screen.findByLabelText('Signing identity');
    expect(signing).toHaveTextContent('Windows Release Certificate');
    expect(signing).toHaveTextContent('None / Unsigned');
  });
});
