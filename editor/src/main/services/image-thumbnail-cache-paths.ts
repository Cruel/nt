import path from 'node:path';

export const IMAGE_THUMBNAIL_CACHE_DIRECTORY = path.join('thumbnails', 'image-v2');

export const resolveEditorCacheRoot = (systemCachePath: string): string =>
  path.resolve(systemCachePath, 'noveltea-editor');

export function resolveSystemCachePath(
  homePath: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return path.resolve(environment.LOCALAPPDATA ?? path.join(homePath, 'AppData', 'Local'));
  }
  if (platform === 'darwin') return path.resolve(homePath, 'Library', 'Caches');
  return path.resolve(environment.XDG_CACHE_HOME ?? path.join(homePath, '.cache'));
}

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
