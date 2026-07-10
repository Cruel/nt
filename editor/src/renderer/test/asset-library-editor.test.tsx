import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssetLibraryEditor } from '@/editors/assets/AssetLibraryEditor';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

const tab: WorkbenchTab = {
  id: 'tab:assets',
  title: 'Assets',
  editorType: 'asset-library',
  resource: { kind: 'tool', stableId: 'utility:assets' },
};

function project() {
  const next = createAuthoringProject();
  next.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: ['Hero'],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  next.assets.click = {
    id: 'click',
    label: 'Click',
    tags: ['sfx'],
    data: { kind: 'audio', source: { type: 'project-file', path: 'assets/audio/click.mp3' }, aliases: [], extension: '.mp3' },
  };
  return next;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockResolvedValue({ url: 'data:image/png;base64,bW9jaw==', absolutePath: '/mock/project/assets/images/logo.png' });
});

describe('AssetLibraryEditor', () => {
  it('renders compact image thumbnails and audio controls from resolved project asset URLs', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
    render(<AssetLibraryEditor tab={tab} />);

    await waitFor(() => expect(window.noveltea.resolveProjectAssetUrl).toHaveBeenCalledWith('/mock/project/game.json', 'assets/images/logo.png'));
    await waitFor(() => expect(window.noveltea.resolveProjectAssetUrl).toHaveBeenCalledWith('/mock/project/game.json', 'assets/audio/click.mp3'));
    expect(screen.getByAltText('Logo')).toHaveAttribute('src', 'data:image/png;base64,bW9jaw==');
    expect(screen.getByText('Click')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeTruthy();
  });

  it('filters assets by type and user tags separately', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
    render(<AssetLibraryEditor tab={tab} />);

    fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'audio' } });
    expect(screen.getByText('Click')).toBeInTheDocument();
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'all' } });
    fireEvent.change(screen.getByPlaceholderText('Filter by tag'), { target: { value: 'Hero,' } });
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.queryByText('Click')).not.toBeInTheDocument();
  });

  it('renames an asset inline through the command bus', async () => {
    useProjectStore.getState().loadProjectDocument({ document: project(), projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
    render(<AssetLibraryEditor tab={tab} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit name for Logo' }));
    const input = screen.getByRole('textbox', { name: 'Edit name for Logo' });
    fireEvent.change(input, { target: { value: 'Brand Logo' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Brand Logo')).toBeInTheDocument());
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();
    expect((useProjectStore.getState().document as ReturnType<typeof project>).assets.logo.label).toBe('Brand Logo');
  });

});
