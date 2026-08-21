import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ActiveProjectSessionService } from './active-project-session-service';
import { isSafeProjectAssetPath } from '../../shared/project-schema/authoring-assets';
import {
  PROJECT_ORIGINAL_ASSET_MAX_BYTES,
  projectOriginalAssetBoundaryCode,
  projectOriginalAssetUrl,
  type ProjectOriginalAssetUrlResponse,
  type ProjectOriginalAssetFailureCode,
} from '../../shared/project-original-asset';

export const PROJECT_ORIGINAL_ASSET_SCHEME = 'noveltea-asset';

const readOnlyNoFollowFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

interface ResolvedOriginalAsset {
  handle: FileHandle;
  size: number;
  mimeType: string;
  contentHash: string;
}

interface ResolveContainedOriginalAssetOptions {
  maxBytes?: number;
  requireKind?: 'image' | 'audio';
}

function isContained(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function failure(code: ProjectOriginalAssetFailureCode): ProjectOriginalAssetUrlResponse {
  return { ok: false, code, boundaryCode: projectOriginalAssetBoundaryCode(code) };
}

function authoritativeMime(kind: 'image' | 'audio', sourcePath: string): string | null {
  const extension = path.extname(sourcePath).toLowerCase();
  const image: Record<string, string> = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  const audio: Record<string, string> = {
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.oga': 'audio/ogg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.weba': 'audio/webm',
  };
  return (kind === 'image' ? image : audio)[extension] ?? null;
}

async function hashHandle(handle: FileHandle, expectedBytes: number): Promise<string | null> {
  const hash = createHash('sha256');
  let observedBytes = 0;
  const stream = handle.createReadStream({
    autoClose: false,
    start: 0,
    end: expectedBytes,
  });
  for await (const chunk of stream) {
    observedBytes += chunk.byteLength;
    if (observedBytes > expectedBytes) return null;
    hash.update(chunk);
  }
  if (observedBytes !== expectedBytes) return null;
  return `sha256:${hash.digest('hex')}`;
}

export async function resolveContainedOriginalAsset(
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  assetId: string,
  options: ResolveContainedOriginalAssetOptions = {},
): Promise<ResolvedOriginalAsset | ProjectOriginalAssetFailureCode> {
  if (!sessions.isCurrent(projectSessionId)) return 'stale-or-unknown';
  let authorized;
  try {
    authorized = sessions.requireActiveAsset(projectSessionId, assetId);
  } catch {
    return 'unknown-asset';
  }
  const { kind, sourcePath, byteSize, contentHash } = authorized.asset;
  if (kind !== 'image' && kind !== 'audio') return 'unsupported-kind';
  if (options.requireKind && kind !== options.requireKind) return 'unsupported-kind';
  const maxBytes = options.maxBytes ?? PROJECT_ORIGINAL_ASSET_MAX_BYTES;
  if (!isSafeProjectAssetPath(sourcePath) || !sourcePath.startsWith('assets/')) {
    return 'invalid-source';
  }
  if (
    byteSize === undefined ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    typeof contentHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(contentHash)
  ) {
    return 'invalid-metadata';
  }
  if (byteSize > maxBytes) return 'too-large';
  const mimeType = authoritativeMime(kind, sourcePath);
  if (!mimeType) return 'unsupported-kind';

  let handle: FileHandle | null = null;
  let keepHandle = false;
  try {
    const rootRealPath = await fs.realpath(authorized.root);
    if (path.relative(authorized.root, rootRealPath) !== '') return 'symlink-escape';
    const candidate = path.resolve(rootRealPath, sourcePath);
    if (!isContained(rootRealPath, candidate)) return 'invalid-source';
    const targetRealPath = await fs.realpath(candidate);
    if (!isContained(rootRealPath, targetRealPath)) return 'symlink-escape';
    handle = await fs.open(targetRealPath, readOnlyNoFollowFlags);
    const stat = await handle.stat();
    if (!stat.isFile()) return 'not-regular-file';
    if (stat.size > maxBytes) return 'too-large';
    if (stat.size !== byteSize) return 'size-mismatch';
    const revision = await hashHandle(handle, byteSize);
    if (!revision) return 'size-mismatch';
    if (!sessions.isCurrent(projectSessionId)) return 'stale-or-unknown';
    if (revision !== contentHash) return 'revision-mismatch';
    keepHandle = true;
    return { handle, size: stat.size, mimeType, contentHash };
  } catch {
    return 'not-found';
  } finally {
    if (handle && !keepHandle) await handle.close().catch(() => undefined);
  }
}

export async function resolveProjectOriginalAssetUrl(
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  assetId: string,
): Promise<ProjectOriginalAssetUrlResponse> {
  const resolved = await resolveContainedOriginalAsset(sessions, projectSessionId, assetId);
  if (typeof resolved === 'string') return failure(resolved);
  await resolved.handle.close();
  return { ok: true, url: projectOriginalAssetUrl(projectSessionId, assetId) };
}

function errorResponse(status: number, code: ProjectOriginalAssetFailureCode): Response {
  const boundaryCode = projectOriginalAssetBoundaryCode(code);
  return new Response(boundaryCode, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
      'X-NovelTea-Failure-Code': boundaryCode,
    },
  });
}

export function createProjectOriginalAssetProtocolHandler(sessions: ActiveProjectSessionService) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return errorResponse(405, 'invalid-request');
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, 'invalid-request');
    }
    if (
      url.protocol !== `${PROJECT_ORIGINAL_ASSET_SCHEME}:` ||
      url.hostname !== 'source' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    ) {
      return errorResponse(400, 'invalid-request');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return errorResponse(400, 'invalid-request');
    let projectSessionId: string;
    let assetId: string;
    try {
      projectSessionId = decodeURIComponent(parts[0]!);
      assetId = decodeURIComponent(parts[1]!);
    } catch {
      return errorResponse(400, 'invalid-request');
    }
    const resolved = await resolveContainedOriginalAsset(sessions, projectSessionId, assetId);
    if (typeof resolved === 'string') {
      const status = resolved === 'stale-or-unknown' ? 410 : resolved === 'too-large' ? 413 : 404;
      return errorResponse(status, resolved);
    }
    const headers = {
      'Content-Type': resolved.mimeType,
      'Content-Length': String(resolved.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    };
    if (request.method === 'HEAD') {
      await resolved.handle.close();
      return new Response(null, { status: 200, headers });
    }
    if (resolved.size === 0) {
      await resolved.handle.close();
      return new Response(new Uint8Array(0), { status: 200, headers });
    }
    const nodeStream = resolved.handle.createReadStream({
      autoClose: true,
      start: 0,
      end: resolved.size - 1,
    });
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    request.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
    return new Response(body, { status: 200, headers });
  };
}
