import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { useProjectStore } from '@/project/project-store';
import { AssetImageThumbnail } from '@/workspace/AssetImageThumbnail';
import type { EditorCacheEpochEvent, ImageThumbnailResult } from '../../shared/image-thumbnails';

const source = {
  projectRelativePath: 'assets/images/hero.png',
  contentHash: `sha256:${'b'.repeat(64)}`,
  width: 1600,
  height: 900,
  orientation: 1 as const,
};

const readyResult = (url: string, cacheEpoch = 0): ImageThumbnailResult => ({
  ok: true,
  url,
  cacheKey: 'a'.repeat(64),
  sourceRevision: source.contentHash,
  profile: 'compact',
  width: 192,
  height: 108,
  cacheStatus: 'hit',
  sourceLimited: false,
  tierLimited: false,
  cacheEpoch,
});

describe('AssetImageThumbnail', () => {
  beforeEach(() => {
    useProjectStore.getState().loadProjectDocument({
      document: { project: { schema: 'noveltea.authoring.project', version: 2 } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/project.json',
    });
    vi.mocked(window.noveltea.requestImageThumbnail).mockReset();
  });

  it('defers invisible thumbnails without issuing IPC', () => {
    render(
      <AssetImageThumbnail
        label="Hero"
        source={source}
        request={{ kind: 'profile', profile: 'compact' }}
        visible={false}
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
        <AssetImageThumbnail
          label="Hero one"
          source={source}
          request={{ kind: 'profile', profile: 'compact' }}
        />
        <AssetImageThumbnail
          label="Hero two"
          source={source}
          request={{ kind: 'profile', profile: 'compact' }}
        />
      </>,
    );

    await waitFor(() => expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledTimes(1));
    resolve(readyResult('noveltea-thumbnail://image-v1/aa/shared.webp'));
    expect(await screen.findByAltText('Hero one')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v1/aa/shared.webp',
    );
    expect(await screen.findByAltText('Hero two')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v1/aa/shared.webp',
    );
  });

  it('uses DPR-aware physical slot dimensions', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 80,
      height: 48,
      top: 0,
      right: 80,
      bottom: 48,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.stubGlobal('devicePixelRatio', 2.5);
    vi.mocked(window.noveltea.requestImageThumbnail).mockResolvedValue(
      readyResult('noveltea-thumbnail://image-v1/aa/dpr.webp'),
    );

    render(
      <AssetImageThumbnail
        label="Hero"
        source={source}
        request={{ kind: 'slot', fit: 'contain' }}
      />,
    );

    await waitFor(() =>
      expect(window.noveltea.requestImageThumbnail).toHaveBeenCalledWith({
        source: { ...source, projectFilePath: '/mock/project/project.json' },
        variant: { kind: 'minimum-size', widthPx: 200, heightPx: 120, fit: 'contain' },
      }),
    );
  });

  it('ignores a stale result after the source changes', async () => {
    const resolvers: Array<(result: ImageThumbnailResult) => void> = [];
    vi.mocked(window.noveltea.requestImageThumbnail).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const { rerender } = render(
      <AssetImageThumbnail
        label="Hero"
        source={source}
        request={{ kind: 'profile', profile: 'compact' }}
      />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(1));

    const changedSource = { ...source, contentHash: `sha256:${'c'.repeat(64)}` };
    rerender(
      <AssetImageThumbnail
        label="Hero"
        source={changedSource}
        request={{ kind: 'profile', profile: 'compact' }}
      />,
    );
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0]!(readyResult('noveltea-thumbnail://image-v1/aa/stale.webp'));
    expect(screen.queryByAltText('Hero')).not.toBeInTheDocument();
    resolvers[1]!(readyResult('noveltea-thumbnail://image-v1/aa/current.webp'));
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v1/aa/current.webp',
    );
  });

  it('reissues mounted requests after a cache epoch event', async () => {
    vi.mocked(window.noveltea.requestImageThumbnail)
      .mockResolvedValueOnce(readyResult('noveltea-thumbnail://image-v1/aa/old.webp'))
      .mockResolvedValueOnce(readyResult('noveltea-thumbnail://image-v1/aa/new.webp', 1));

    render(
      <AssetImageThumbnail
        label="Hero"
        source={source}
        request={{ kind: 'profile', profile: 'compact' }}
      />,
    );
    expect(await screen.findByAltText('Hero')).toHaveAttribute(
      'src',
      'noveltea-thumbnail://image-v1/aa/old.webp',
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
      'noveltea-thumbnail://image-v1/aa/new.webp',
    );
  });
});
