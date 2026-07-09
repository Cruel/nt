import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandPaletteDialog } from '@/workspace/CommandPaletteDialog';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildComfyUiWorkflowsTab, buildSettingsTab } from '@/workbench/editor-registry';

beforeEach(() => {
  useProjectStore.getState().clearProject();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockClear();
});

describe('CommandPaletteDialog', () => {
  it('renders image asset thumbnails in command results', async () => {
    const project = createAuthoringProject();
    project.assets.logo = {
      id: 'logo',
      label: 'Logo',
      tags: [],
      data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
    };
    useProjectStore.getState().loadProjectDocument({ document: project, projectPath: '/mock', projectFilePath: '/mock/project.json' });

    render(<CommandPaletteDialog open project={project} onOpenChange={vi.fn()} onOpenTab={vi.fn()} />);

    expect(screen.getByText('Logo')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByAltText('Logo')).toBeInTheDocument());
    expect(window.noveltea.resolveProjectAssetUrl).toHaveBeenCalledWith('/mock/project.json', 'assets/images/logo.png');
  });

  it('opens settings as a workbench tab', async () => {
    const onOpenTab = vi.fn();
    render(<CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(onOpenTab).toHaveBeenCalledWith(buildSettingsTab());
  });

  it('opens ComfyUI workflow manager without a project', async () => {
    const onOpenTab = vi.fn();
    render(<CommandPaletteDialog open project={null} onOpenChange={vi.fn()} onOpenTab={onOpenTab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage ComfyUI Workflows' }));

    expect(onOpenTab).toHaveBeenCalledWith(buildComfyUiWorkflowsTab());
  });
});
