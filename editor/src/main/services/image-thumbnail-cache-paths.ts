import path from 'node:path';

export const IMAGE_THUMBNAIL_CACHE_DIRECTORY = path.join('thumbnails', 'image-v1');

export const resolveEditorCacheRoot = (systemCachePath: string): string =>
  path.resolve(systemCachePath, 'noveltea-editor');

export const resolveImageThumbnailCacheRoot = (editorCacheRoot: string): string =>
  path.resolve(editorCacheRoot, IMAGE_THUMBNAIL_CACHE_DIRECTORY);

export function isStrictlyContainedPath(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function resolveImageThumbnailCachePath(
  imageThumbnailCacheRoot: string,
  derivativeKey: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(derivativeKey))
    throw new TypeError('Invalid thumbnail derivative key.');
  const target = path.resolve(
    imageThumbnailCacheRoot,
    derivativeKey.slice(0, 2),
    `${derivativeKey}.webp`,
  );
  if (!isStrictlyContainedPath(imageThumbnailCacheRoot, target)) {
    throw new TypeError('Thumbnail cache path escaped its root.');
  }
  return target;
}
