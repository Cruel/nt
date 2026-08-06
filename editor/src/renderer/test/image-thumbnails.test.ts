import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  createImageThumbnailDerivativeKey,
  imageThumbnailOutputDimensions,
  imageThumbnailPhysicalSlot,
  imageThumbnailPrewarmRequestSchema,
  imageThumbnailRequestSchema,
  parseImageThumbnailPrewarmSource,
  selectImageThumbnailTier,
  serializeImageThumbnailDerivativeIdentity,
} from '../../shared/image-thumbnails';
import {
  isStrictlyContainedPath,
  resolveEditorCacheRoot,
  resolveImageThumbnailCachePath,
  resolveImageThumbnailCacheRoot,
  resolveSystemCachePath,
} from '../../main/services/image-thumbnail-cache-paths';

const hash = `sha256:${'a'.repeat(64)}`;
const source = {
  projectFilePath: '/projects/a/project.json',
  projectRelativePath: 'assets/images/hero.png',
  contentHash: hash,
  width: 1600,
  height: 900,
  orientation: 1 as const,
};
const versions = { sharpVersion: '0.35.3', vipsVersion: '8.17.3' };

describe('image thumbnail Phase 2 contracts', () => {
  it('strictly validates interactive and prewarm IPC input', () => {
    expect(
      imageThumbnailRequestSchema.safeParse({
        source,
        variant: { kind: 'minimum-size', widthPx: 256, heightPx: 144, fit: 'cover' },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...source, width: 0 },
      { ...source, orientation: 9 },
      { ...source, contentHash: `sha256:${'A'.repeat(64)}` },
      { ...source, unexpected: true },
    ]) {
      expect(
        imageThumbnailRequestSchema.safeParse({
          source: invalid,
          variant: { kind: 'profile', profile: 'compact' },
        }).success,
      ).toBe(false);
    }
    expect(
      imageThumbnailRequestSchema.safeParse({
        source,
        variant: { kind: 'minimum-size', widthPx: 8193, heightPx: 1, fit: 'contain' },
      }).success,
    ).toBe(false);
    expect(
      imageThumbnailPrewarmRequestSchema.safeParse({ projectGeneration: '', sources: [] }).success,
    ).toBe(false);
    expect(
      imageThumbnailPrewarmRequestSchema.safeParse({
        projectGeneration: 'a',
        sources: Array.from({ length: 50_001 }),
      }).success,
    ).toBe(false);
    expect(() =>
      parseImageThumbnailPrewarmSource({ ...source, contentHash: undefined }),
    ).not.toThrow();
    expect(() => parseImageThumbnailPrewarmSource({ ...source, width: Number.NaN })).toThrow();
  });

  it('selects deterministic tiers for profile, orientation, fit, and high-DPR vectors', () => {
    expect(
      selectImageThumbnailTier(source, { kind: 'profile', profile: 'card' }, 'raster'),
    ).toMatchObject({
      profile: 'card',
      requiredLongEdge: 384,
      sourceLimited: false,
      tierLimited: false,
    });
    expect(
      selectImageThumbnailTier(
        { width: 1600, height: 900, orientation: 1 },
        { kind: 'minimum-size', widthPx: 300, heightPx: 300, fit: 'cover' },
        'raster',
      ),
    ).toMatchObject({ profile: 'large', requiredLongEdge: 534, tierLimited: false });
    expect(
      selectImageThumbnailTier(
        { width: 1600, height: 900, orientation: 1 },
        { kind: 'minimum-size', widthPx: 300, heightPx: 300, fit: 'contain' },
        'raster',
      ),
    ).toMatchObject({ profile: 'card', requiredLongEdge: 300 });
    expect(
      selectImageThumbnailTier(
        { width: 80, height: 120, orientation: 6 },
        { kind: 'minimum-size', widthPx: 500, heightPx: 500, fit: 'cover' },
        'raster',
      ),
    ).toMatchObject({
      normalizedSourceWidth: 120,
      normalizedSourceHeight: 80,
      profile: 'large',
      sourceLimited: true,
    });
    expect(imageThumbnailPhysicalSlot(100, 75, 5)).toEqual({ widthPx: 400, heightPx: 300 });
    expect(imageThumbnailPhysicalSlot(100, 75, Number.NaN)).toEqual({ widthPx: 100, heightPx: 75 });
  });

  it('reports raster source limiting while SVG output remains tier-sized', () => {
    const small = { width: 64, height: 32, orientation: 1 as const };
    expect(
      selectImageThumbnailTier(small, { kind: 'profile', profile: 'compact' }, 'raster')
        .sourceLimited,
    ).toBe(true);
    expect(
      selectImageThumbnailTier(small, { kind: 'profile', profile: 'compact' }, 'svg').sourceLimited,
    ).toBe(false);
    expect(imageThumbnailOutputDimensions(small, 192, 'raster')).toEqual({ width: 64, height: 32 });
    expect(imageThumbnailOutputDimensions(small, 192, 'svg')).toEqual({ width: 192, height: 96 });
  });

  it('produces stable content-addressed keys independent of project and source paths', () => {
    const serialized = serializeImageThumbnailDerivativeIdentity(source, 384, versions);
    expect(JSON.parse(serialized)).toEqual([
      'noveltea.editor.image-thumbnail',
      1,
      hash,
      1600,
      900,
      1,
      384,
      'sharp:0.35.3',
      'vips:8.17.3',
      'srgb-v1',
      'webp-lossless-effort-4',
      'autorotate-v1',
      'first-frame-v1',
      'svg-self-contained-density-v1',
    ]);
    const first = createImageThumbnailDerivativeKey(source, 384, versions);
    const moved = createImageThumbnailDerivativeKey(
      {
        contentHash: source.contentHash,
        width: source.width,
        height: source.height,
        orientation: source.orientation,
      },
      384,
      versions,
    );
    const changed = createImageThumbnailDerivativeKey(
      { ...source, contentHash: `sha256:${'b'.repeat(64)}` },
      384,
      versions,
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(moved).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('derives cache paths beneath the dedicated image-v1 root', () => {
    const editorRoot = resolveEditorCacheRoot('/var/cache');
    const imageRoot = resolveImageThumbnailCacheRoot(editorRoot);
    const key = createImageThumbnailDerivativeKey(source, 192, versions);
    const target = resolveImageThumbnailCachePath(imageRoot, key);
    expect(editorRoot).toBe(path.resolve('/var/cache/noveltea-editor'));
    expect(imageRoot).toBe(path.resolve('/var/cache/noveltea-editor/thumbnails/image-v1'));
    expect(target).toBe(path.join(imageRoot, key.slice(0, 2), `${key}.webp`));
    expect(isStrictlyContainedPath(imageRoot, target)).toBe(true);
    expect(isStrictlyContainedPath(imageRoot, imageRoot)).toBe(false);
    expect(isStrictlyContainedPath(imageRoot, path.resolve(imageRoot, '..', 'outside'))).toBe(
      false,
    );
    expect(() => resolveImageThumbnailCachePath(imageRoot, '../escape')).toThrow();
  });

  it('resolves the editor cache from platform cache conventions rather than userData', () => {
    expect(resolveSystemCachePath('/home/user', { XDG_CACHE_HOME: '/cache' }, 'linux')).toBe(
      path.resolve('/cache'),
    );
    expect(resolveSystemCachePath('/Users/user', {}, 'darwin')).toBe(
      path.resolve('/Users/user/Library/Caches'),
    );
    expect(resolveSystemCachePath('C:\\Users\\user', { LOCALAPPDATA: 'D:\\Cache' }, 'win32')).toBe(
      path.resolve('D:\\Cache'),
    );
  });
});
