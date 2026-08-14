import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useProjectStore } from '@/project/project-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import type { EditorCacheEpochEvent, ImageThumbnailResult } from '../../shared/image-thumbnails';

const projectSessionId = '11111111-1111-4111-8111-111111111111';

const source = {
  assetId: 'hero',
  projectRelativePath: 'assets/images/hero.png',
  contentHash: `sha256:${'b'.repeat(64)}`,
  width: 1600,
  height: 900,
  orientation: 1 as const,
};

const readyResult = (url: string, cacheEpoch = 0): Extract<ImageThumbnailResult, { ok: true }> => ({
  ok: true,
  url,
  cacheKey: 'a'.repeat(64),
  sourceRevision: source.contentHash,
  profile: 'list',
  width: 96,
  height: 72,
  cacheStatus: 'hit',
  sourceLimited: false,
  cacheEpoch,
});

describe('AssetImageThumbnail', () => {
  beforeEach(() => {
    vi.stubGlobal('devicePixelRatio', 1);
    useProjectStore.getState().loadProjectDocument({
      document: { project: { schema: 'noveltea.authoring.project', version: 2 } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
      projectSessionId,
    });
    vi.mocked(window.noveltea.requestImageThumbnail).mockReset();
  });

  it('defers invisible thumbnails without issuing IPC', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      <AssetImageThumbnail
        label="Hero"
        source={source}
        request={{ profile: 'list' }}
        requestMode="visible"
      />,
    );

    expect(window.noveltea.requestImageThumbnail).not.toHaveBeenCalled();
    expect(screen.queryByAltText('Hero')).not.toBeInTheDocument();
  });

  it('shares a mounted pending request and renders the protocol URL', async () => {
    let resolve!: (result: ImageThumbnailResult) => void;
    vi.mocked(window.noveltea.requestImageThumbnail).mockReturnValue(
      new Promise((next) => {
        resolve = next;
      }),
    );

    render(
      <>
        <AssetImageThumbnail label="Hero one" source={source} request={{ profile: 'list' }} />
        <AssetImageThumbnail label="Hero two" source={source} request={{ profile: 'list' }} />
      </>,
    );

    await waitFor(() => expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledTimes(1));
    resolve(readyResult('noveltea-thumbnail://image-v2/aa/shared.webp'));
    expect(await screen.findByAltText('Hero one')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/shared.webp',
    );
    expect(await screen.findByAltText('Hero two')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/shared.webp',
    );
  });

  it('requests an explicit wide presentation profile', async () => {
    vi.mocked(window.noveltea.requestImageThumbnail).mockResolvedValue({
      ...readyResult('noveltea-thumbnail://image-v2/aa/wide.webp'),
      profile: 'wide',
    });

    render(<AssetImageThumbnail label="Hero" source={source} request={{ profile: 'wide' }} />);

    await waitFor(() =>
      expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
        source: { ...source, projectSessionId },
        variant: { kind: 'profile', profile: 'wide' },
      }),
    );
  });

  it('omits malformed project hashes and does not re-request equivalent mounted props', async () => {
    vi.mocked(window.noveltea.requestImageThumbnail).mockResolvedValue(
      readyResult('noveltea-thumbnail://image-v2/aa/stable.webp'),
    );
    const malformedSource = { ...source, contentHash: 'SHA256:not-canonical' };
    const { rerender } = render(
      <AssetImageThumbnail label="Hero" source={malformedSource} request={{ profile: 'list' }} />,
    );

    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/stable.webp',
    );
    expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
      source: {
        projectSessionId,
        assetId: source.assetId,
        projectRelativePath: source.projectRelativePath,
        width: source.width,
        height: source.height,
        orientation: source.orientation,
      },
      variant: { kind: 'profile', profile: 'list' },
    });

    rerender(
      <AssetImageThumbnail
        label="Hero"
        source={{ ...malformedSource }}
        request={{ profile: 'list' }}
      />,
    );
    await Promise.resolve();
    expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale result after the source changes', async () => {
    const resolvers: Array<(result: ImageThumbnailResult) => void> = [];
    vi.mocked(window.noveltea.requestImageThumbnail).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { rerender } = render(
      <AssetImageThumbnail label="Hero" source={source} request={{ profile: 'list' }} />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));

    const changedSource = { ...source, contentHash: `sha256:${'c'.repeat(64)}` };
    rerender(
      <AssetImageThumbnail label="Hero" source={changedSource} request={{ profile: 'list' }} />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]!(readyResult('noveltea-thumbnail://image-v2/aa/stale.webp'));
    expect(screen.queryByAltText('Hero')).not.toBeInTheDocument();
    resolvers[1]!(readyResult('noveltea-thumbnail://image-v2/aa/current.webp'));
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/current.webp',
    );
  });

  it('reissues mounted requests after a cache epoch event', async () => {
    vi.mocked(window.noveltea.requestImageThumbnail)
      .mockResolvedValueOnce(readyResult('noveltea-thumbnail://image-v2/aa/old.webp'))
      .mockResolvedValueOnce(readyResult('noveltea-thumbnail://image-v2/aa/new.webp', 1));

    render(<AssetImageThumbnail label="Hero" source={source} request={{ profile: 'list' }} />);
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/old.webp',
    );
    act(() => {
      (
        window as typeof window & {
          __novelteaEditorCacheEpochListener?: (event: EditorCacheEpochEvent) => void;
        }
      ).__novelteaEditorCacheEpochListener?.({ cacheEpoch: 1 });
    });
    await waitFor(() => expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledTimes(2));
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/new.webp',
    );
  });

  it('suppresses a loading result across clear and replaces an already decoded image', async () => {
    const resolvers: Array<(result: ImageThumbnailResult) => void> = [];
    vi.mocked(window.noveltea.requestImageThumbnail).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    render(<AssetImageThumbnail label="Hero" source={source} request={{ profile: 'list' }} />);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    act(() => {
      (
        window as typeof window & {
          __novelteaEditorCacheEpochListener?: (event: EditorCacheEpochEvent) => void;
        }
      ).__novelteaEditorCacheEpochListener?.({ cacheEpoch: 2 });
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]!(readyResult('noveltea-thumbnail://image-v2/aa/stale-loading.webp'));
    expect(screen.queryByAltText('Hero')).not.toBeInTheDocument();
    resolvers[1]!(readyResult('noveltea-thumbnail://image-v2/aa/current-decoded.webp', 2));
    const image = await screen.findByAltText('Hero');
    expect(image).toHaveAttribute('src', 'noveltea-thumbnail://image-v2/aa/current-decoded.webp');
    await act(async () => image.dispatchEvent(new Event('load')));
    act(() => {
      (
        window as typeof window & {
          __novelteaEditorCacheEpochListener?: (event: EditorCacheEpochEvent) => void;
        }
      ).__novelteaEditorCacheEpochListener?.({ cacheEpoch: 3 });
    });
    await waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]!(readyResult('noveltea-thumbnail://image-v2/aa/after-decoded-clear.webp', 3));
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v2/aa/after-decoded-clear.webp',
    );
  });
});
