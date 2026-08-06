import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  createImageThumbnailDerivativeKey,
  imageThumbnailEncoderPolicy,
  imageThumbnailOutputDimensions,
  imageThumbnailPrewarmRequestSchema,
  imageThumbnailRequestSchema,
  parseImageThumbnailPrewarmSource,
  resolveImageThumbnailProfile,
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

describe('image thumbnail V2 contracts', () => {
  it('strictly validates profile-only interactive and prewarm IPC input', () => {
    expect(
      imageThumbnailRequestSchema.safeParse({
        source,
        variant: { kind: 'profile', profile: 'list' },
      }).success,
    ).toBe(true);
    expect(
      imageThumbnailRequestSchema.safeParse({
        source: { ...source, sampling: 'nearest' },
        variant: { kind: 'profile', profile: 'card' },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...source, width: 0 },
      { ...source, orientation: 9 },
      { ...source, sampling: 'cubic' },
      { ...source, contentHash: `sha256:${'A'.repeat(64)}` },
      { ...source, unexpected: true },
    ]) {
      expect(
        imageThumbnailRequestSchema.safeParse({
          source: invalid,
          variant: { kind: 'profile', profile: 'list' },
        }).success,
      ).toBe(false);
    }
    expect(
      imageThumbnailRequestSchema.safeParse({
        source,
        variant: { kind: 'profile', profile: 'large' },
      }).success,
    ).toBe(false);
    expect(
      imageThumbnailRequestSchema.safeParse({
        source,
        variant: { kind: 'minimum-size', widthPx: 96, heightPx: 72, fit: 'cover' },
      }).success,
    ).toBe(false);
    expect(
      imageThumbnailPrewarmRequestSchema.safeParse({ projectGeneration: '', sources: [] }).success,
    ).toBe(false);
    expect(() =>
      parseImageThumbnailPrewarmSource({ ...source, contentHash: undefined }),
    ).not.toThrow();
  });

  it('resolves exact editor presentation profiles', () => {
    expect(resolveImageThumbnailProfile(source, 'list', 'raster')).toEqual({
      profile: 'list',
      width: 96,
      height: 72,
      fit: 'cover',
      sourceLimited: false,
    });
    expect(resolveImageThumbnailProfile(source, 'wide', 'raster')).toMatchObject({
      width: 160,
      height: 96,
    });
    expect(resolveImageThumbnailProfile(source, 'card', 'raster')).toMatchObject({
      width: 320,
      height: 320,
    });
  });

  it('reports raster source limiting while SVG output remains profile-sized', () => {
    const small = { width: 64, height: 32, orientation: 1 as const };
    expect(resolveImageThumbnailProfile(small, 'list', 'raster').sourceLimited).toBe(true);
    expect(resolveImageThumbnailProfile(small, 'list', 'svg').sourceLimited).toBe(false);
    expect(imageThumbnailOutputDimensions(small, 'list', 'raster')).toEqual({
      width: 64,
      height: 32,
    });
    expect(imageThumbnailOutputDimensions(small, 'list', 'svg')).toEqual({
      width: 96,
      height: 72,
    });
  });

  it('uses lossy WebP by default and lossless WebP for nearest-neighbor assets', () => {
    expect(imageThumbnailEncoderPolicy({})).toBe('webp-quality-85-alpha-100-smart-effort-4-v1');
    expect(imageThumbnailEncoderPolicy({ sampling: 'nearest' })).toBe(
      'webp-lossless-effort-4-nearest-v1',
    );
  });

  it('produces stable V2 keys independent of project and source paths', () => {
    const serialized = serializeImageThumbnailDerivativeIdentity(source, 'card', versions);
    expect(JSON.parse(serialized)).toEqual([
      'noveltea.editor.image-thumbnail',
      2,
      hash,
      1600,
      900,
      1,
      'linear',
      'card',
      320,
      320,
      'cover',
      'sharp:0.35.3',
      'vips:8.17.3',
      'srgb-v1',
      'webp-quality-85-alpha-100-smart-effort-4-v1',
      'autorotate-v1',
      'first-frame-v1',
      'svg-self-contained-density-v2',
    ]);
    const first = createImageThumbnailDerivativeKey(source, 'card', versions);
    const moved = createImageThumbnailDerivativeKey(
      {
        contentHash: source.contentHash,
        width: source.width,
        height: source.height,
        orientation: source.orientation,
      },
      'card',
      versions,
    );
    const nearest = createImageThumbnailDerivativeKey(
      { ...source, sampling: 'nearest' },
      'card',
      versions,
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(moved).toBe(first);
    expect(nearest).not.toBe(first);
  });

  it('derives cache paths beneath the dedicated image-v2 root', () => {
    const editorRoot = resolveEditorCacheRoot('/var/cache');
    const imageRoot = resolveImageThumbnailCacheRoot(editorRoot);
    const key = createImageThumbnailDerivativeKey(source, 'list', versions);
    const target = resolveImageThumbnailCachePath(imageRoot, key);
    expect(editorRoot).toBe(path.resolve('/var/cache/noveltea-editor'));
    expect(imageRoot).toBe(path.resolve('/var/cache/noveltea-editor/thumbnails/image-v2'));
    expect(target).toBe(path.join(imageRoot, key.slice(0, 2), `${key}.webp`));
    expect(isStrictlyContainedPath(imageRoot, target)).toBe(true);
    expect(isStrictlyContainedPath(imageRoot, imageRoot)).toBe(false);
    expect(() => resolveImageThumbnailCachePath(imageRoot, '../escape')).toThrow();
  });

  it('resolves the editor cache from platform cache conventions rather than userData', () => {
    expect(resolveSystemCachePath('/home/user', { XDG_CACHE_HOME: '/cache' }, 'linux')).toBe(
      path.resolve('/cache'),
    );
    expect(resolveSystemCachePath('/Users/user', {}, 'darwin')).toBe(
      path.resolve('/Users/user/Library/Caches'),
    );
  });
});
