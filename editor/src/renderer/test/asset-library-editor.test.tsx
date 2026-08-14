import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssetLibraryEditor } from '@/editors/assets/AssetLibraryEditor';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { captureWorkbenchTabState, clearWorkbenchTabStates } from '@/workbench/workbench-tab-state';
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
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
      contentHash: `sha256:${'b'.repeat(64)}`,
      imageMetadata: { width: 256, height: 256, hasAlpha: true, orientation: 1 },
    },
  };
  next.assets.click = {
    id: 'click',
    label: 'Click',
    data: {
      kind: 'audio',
      source: { type: 'project-file', path: 'assets/audio/click.mp3' },
      aliases: [],
      extension: '.mp3',
      imageMetadata: null,
    },
  };
  next.editor.recordMetadata = { assets: { logo: { tags: ['Hero'] }, click: { tags: ['sfx'] } } };
  return next;
}

beforeEach(() => {
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
  vi.mocked(window.noveltea.resolveProjectAssetUrl).mockResolvedValue({
    url: 'data:image/png;base64,bW9jaw==',
    absolutePath: '/mock/project/assets/images/logo.png',
  });
  vi.mocked(window.noveltea.requestImageThumbnail).mockResolvedValue({
    ok: true,
    url: 'noveltea-thumbnail://image-v2/aa/card.webp',
    cacheKey: 'a'.repeat(64),
    sourceRevision: `sha256:${'b'.repeat(64)}`,
    profile: 'card',
    width: 256,
    height: 256,
    cacheStatus: 'hit',
    sourceLimited: true,
    cacheEpoch: 0,
  });
});

describe('AssetLibraryEditor', () => {
  it('renders image cards from thumbnail URLs while retaining resolved audio URLs', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    render(<AssetLibraryEditor tab={tab} />);

    await waitFor(() =>
      expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
        source: {
          projectFilePath: '/mock/project/game.json',
          projectRelativePath: 'assets/images/logo.png',
          contentHash: `sha256:${'b'.repeat(64)}`,
          width: 256,
          height: 256,
          orientation: 1,
        },
        variant: { kind: 'profile', profile: 'card' },
      }),
    );
    await waitFor(() =>
      expect(window.noveltea.resolveProjectAssetUrl).toHaveBeenCalledWith(
        '/mock/project/game.json',
        'assets/audio/click.mp3',
      ),
    );
    expect(window.noveltea.resolveProjectAssetUrl).not.toHaveBeenCalledWith(
      '/mock/project/game.json',
      'assets/images/logo.png',
    );
    expect(screen.getByAltText('Logo')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/card.webp',
    );
    expect(screen.getByText('Click')).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeTruthy();
  });

  it('filters assets by type and user tags separately', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    render(<AssetLibraryEditor tab={tab} />);

    await screen.findByText('Logo');
    fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'audio' } });
    expect(screen.getByText('Click')).toBeInTheDocument();
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'all' } });
    fireEvent.change(screen.getByPlaceholderText('Filter by tag'), { target: { value: 'Hero,' } });
    expect(screen.getByText('Logo')).toBeInTheDocument();
    expect(screen.queryByText('Click')).not.toBeInTheDocument();
  });

  it('restores filters after the active-only editor remounts', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    const view = render(<AssetLibraryEditor tab={tab} />);
    await screen.findByText('Logo');
    fireEvent.change(screen.getByLabelText('Asset type'), { target: { value: 'audio' } });
    captureWorkbenchTabState(tab.id);
    view.unmount();

    render(<AssetLibraryEditor tab={tab} />);
    expect(screen.getByLabelText('Asset type')).toHaveValue('audio');
    expect(await screen.findByText('Click')).toBeInTheDocument();
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();
  });

  it('renames an asset inline through the command bus', async () => {
    useProjectStore.getState().loadProjectDocument({
      document: project(),
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    render(<AssetLibraryEditor tab={tab} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name for Logo' }));
    const input = screen.getByRole('textbox', { name: 'Edit name for Logo' });
    fireEvent.change(input, { target: { value: 'Brand Logo' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Brand Logo')).toBeInTheDocument());
    expect(screen.queryByText('Logo')).not.toBeInTheDocument();
    expect(
      (useProjectStore.getState().document as ReturnType<typeof project>).assets.logo.label,
    ).toBe('Brand Logo');
  });
});
