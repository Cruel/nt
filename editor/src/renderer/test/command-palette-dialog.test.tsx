import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CommandPaletteDialog } from '@/workspace/CommandPaletteDialog';
import { useProjectStore } from '@/project/project-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

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
});
