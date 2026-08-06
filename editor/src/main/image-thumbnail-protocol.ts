import fs from 'node:fs/promises';
import {
  isStrictlyContainedPath,
  resolveImageThumbnailCachePath,
} from './services/image-thumbnail-cache-paths';

export const IMAGE_THUMBNAIL_SCHEME = 'noveltea-thumbnail';

const responseHeaders = {
  'Content-Type': 'image/webp',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export function createImageThumbnailUrl(cacheKey: string, cacheEpoch: number): string {
  return `${IMAGE_THUMBNAIL_SCHEME}://cache/image-v2/${cacheKey.slice(0, 2)}/${cacheKey}.webp?epoch=${cacheEpoch}`;
}

export function createImageThumbnailProtocolHandler(imageCacheRoot: string) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Method not allowed');
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'Invalid thumbnail URL');
    }
    if (
      url.protocol !== `${IMAGE_THUMBNAIL_SCHEME}:` ||
      url.hostname !== 'cache' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return errorResponse(400, 'Invalid thumbnail URL');
    }
    const parameters = [...url.searchParams.entries()];
    if (
      parameters.length !== 1 ||
      parameters[0]?.[0] !== 'epoch' ||
      !/^(0|[1-9][0-9]*)$/.test(parameters[0]?.[1] ?? '')
    ) {
      return errorResponse(400, 'Invalid thumbnail epoch');
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return errorResponse(400, 'Invalid thumbnail path');
    }
    const match = /^\/image-v2\/([0-9a-f]{2})\/([0-9a-f]{64})\.webp$/.exec(pathname);
    if (!match || match[1] !== match[2]?.slice(0, 2)) {
      return errorResponse(400, 'Invalid thumbnail path');
    }
    const target = resolveImageThumbnailCachePath(imageCacheRoot, match[2]);
    try {
      const [rootRealPath, targetRealPath, stat, targetEntry] = await Promise.all([
        fs.realpath(imageCacheRoot),
        fs.realpath(target),
        fs.stat(target),
        fs.lstat(target),
      ]);
      if (
        !stat.isFile() ||
        !targetEntry.isFile() ||
        !isStrictlyContainedPath(rootRealPath, targetRealPath)
      ) {
        return errorResponse(404, 'Thumbnail not found');
      }
      const body = request.method === 'HEAD' ? null : await fs.readFile(targetRealPath);
      return new Response(body, { status: 200, headers: responseHeaders });
    } catch {
      return errorResponse(404, 'Thumbnail not found');
    }
  };
}
