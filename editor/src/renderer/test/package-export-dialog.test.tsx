import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PackageExportDialog } from '@/export/PackageExportDialog';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../shared/project-schema/authoring-shaders';
import { usePackageExportStore } from '@/export/package-export-store';
import { useWorkspaceStore } from '@/stores/workspace-store';

function exportableProject() {
  const project = createAuthoringProject({ name: 'Dialog Export' });
  const room = defaultRoomData('Foyer');
  room.description.source = 'Ready.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: room };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  usePackageExportStore.getState().clear();
  useWorkspaceStore.getState().setLastExportResult(null);
  vi.mocked(window.noveltea.selectPackageOutputPath).mockResolvedValue('/project/dialog-export.ntpkg');
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
    expect(usePackageExportStore.getState().lastResult).toMatchObject({ success: true, outputPath: '/project/dialog-export.ntpkg' });
  });

  it('shows shader options only when the project has shaders or materials', () => {
    const project = exportableProject();
    project.shaders.basic = { id: 'basic', label: 'Basic', tags: [], data: defaultShaderData('Basic') };

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
    project.entrypoint = { collection: 'scenes', id: 'opening' };
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data: {} };

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
    expect(screen.getByText(/Entrypoint collection 'scenes' is not runtime-exportable yet/)).toBeInTheDocument();
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
      diagnostics: [{ severity: 'error', category: 'asset', path: 'textures/missing.png', message: 'Package file entry source does not exist.' }],
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
});
