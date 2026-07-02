import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  next.assets.click = {
    id: 'click',
    label: 'Click',
    tags: [],
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
});
