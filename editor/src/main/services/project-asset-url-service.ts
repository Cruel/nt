import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAssetUrlResponse } from '../../shared/project-asset-url';
import { isSafeProjectAssetPath } from '../../shared/project-schema/authoring-assets';

function mimeTypeForPath(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.apng':
      return 'image/apng';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.flac':
      return 'audio/flac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.oga':
    case '.ogg':
      return 'audio/ogg';
    case '.wav':
      return 'audio/wav';
    case '.weba':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

export function resolveProjectAssetUrl(
  projectFilePath: string,
  projectRelativePath: string,
): ProjectAssetUrlResponse | null {
  if (typeof projectFilePath !== 'string' || typeof projectRelativePath !== 'string') return null;
  if (!isSafeProjectAssetPath(projectRelativePath)) return null;
  const projectRoot = path.dirname(projectFilePath);
  const absolutePath = path.resolve(projectRoot, projectRelativePath);
  const relativeToRoot = path.relative(projectRoot, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  let file: Buffer;
  try {
    if (!fs.statSync(absolutePath).isFile()) return null;
    file = fs.readFileSync(absolutePath);
  } catch {
    return null;
  }
  const mimeType = mimeTypeForPath(absolutePath);
  return { url: `data:${mimeType};base64,${file.toString('base64')}`, absolutePath };
}
