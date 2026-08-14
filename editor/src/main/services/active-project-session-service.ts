import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { isSafeProjectAssetPath } from '../../shared/project-schema/authoring-assets';
import {
  isSha256Digest,
  PROJECT_TEXT_SOURCE_LIMITS,
  type ProjectTextSourceReadEntry,
  type ReadProjectTextSourcesRequest,
  type ReadProjectTextSourcesResponse,
} from '../../shared/project-text-sources';

const decoder = new TextDecoder('utf-8', { fatal: true });
const readOnlyNoFollowFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

class TextSourceReadFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ActiveProjectSessionService {
  private active: { id: string; root: string } | null = null;
  private projectActivationGeneration = 0;

  beginProjectActivation(): number {
    this.projectActivationGeneration += 1;
    return this.projectActivationGeneration;
  }

  async activateProjectFile(
    projectFilePath: string,
    expectedActivationGeneration?: number,
  ): Promise<string> {
    const canonicalProjectFile = await fs.realpath(path.resolve(projectFilePath));
    const projectFileStat = await fs.stat(canonicalProjectFile);
    if (!projectFileStat.isFile()) throw new Error('Project manifest is not a regular file.');
    this.assertProjectActivationCurrent(expectedActivationGeneration);
    const canonicalRoot = path.dirname(canonicalProjectFile);
    if (this.active?.root === canonicalRoot) return this.active.id;
    this.active = { id: randomUUID(), root: canonicalRoot };
    return this.active.id;
  }

  currentSessionId(): string | null {
    return this.active?.id ?? null;
  }

  requireActiveProjectRoot(projectSessionId: string): string {
    const active = this.active;
    if (!active || projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }
    return active.root;
  }

  isCurrent(projectSessionId: string): boolean {
    return this.active?.id === projectSessionId;
  }

  async refreshActiveProject(projectSessionId: string, projectFilePath: string): Promise<string> {
    const active = this.active;
    if (!active || projectSessionId !== active.id) {
      throw new Error('Project session is stale or unknown.');
    }
    const canonicalProjectFile = await fs.realpath(path.resolve(projectFilePath));
    const projectFileStat = await fs.stat(canonicalProjectFile);
    if (!projectFileStat.isFile()) throw new Error('Project manifest is not a regular file.');
    const canonicalRoot = path.dirname(canonicalProjectFile);
    if (canonicalRoot !== active.root) {
      throw new Error('Project result does not belong to the active Project session.');
    }
    if (this.active !== active) throw new Error('Project session is stale or unknown.');
    return active.id;
  }

  async attachToSuccessfulResult<
    Result extends { ok?: boolean; success?: boolean; projectFilePath?: string },
  >(result: Result, activationGeneration: number): Promise<Result & { projectSessionId?: string }> {
    if (result.success !== true || result.ok === false) return result;
    if (!result.projectFilePath) {
      throw new Error('Successful Project lifecycle result omitted the Project manifest path.');
    }
    const projectSessionId = await this.activateProjectFile(
      result.projectFilePath,
      activationGeneration,
    );
    this.assertProjectActivationCurrent(activationGeneration);
    return { ...result, projectSessionId };
  }

  async refreshSuccessfulSessionResult<
    Result extends { ok?: boolean; success?: boolean; projectFilePath?: string },
  >(projectSessionId: string, result: Result): Promise<Result & { projectSessionId?: string }> {
    if (result.success !== true || result.ok === false) return result;
    if (!result.projectFilePath) {
      throw new Error('Successful Project persistence result omitted the Project manifest path.');
    }
    await this.refreshActiveProject(projectSessionId, result.projectFilePath);
    return { ...result, projectSessionId };
  }

  closeActiveProject(): void {
    this.projectActivationGeneration += 1;
    this.active = null;
  }

  dispose(): void {
    this.closeActiveProject();
  }

  private assertProjectActivationCurrent(expectedActivationGeneration?: number): void {
    if (
      expectedActivationGeneration !== undefined &&
      expectedActivationGeneration !== this.projectActivationGeneration
    ) {
      throw new Error('Project activation was superseded.');
    }
  }

  async read(request: ReadProjectTextSourcesRequest): Promise<ReadProjectTextSourcesResponse> {
    const entries = [...request.entries];
    const active = this.active;
    if (!active || request.projectSessionId !== active.id) {
      return staleSessionResponse(entries);
    }
    if (entries.length > PROJECT_TEXT_SOURCE_LIMITS.maxEntries) {
      return {
        entries: entries.map((entry) =>
          unavailable(entry, 'request-limit', 'Text source batch exceeds the entry limit.'),
        ),
      };
    }

    let aggregateBytes = 0;
    const results: ProjectTextSourceReadEntry[] = [];
    for (const entry of entries) {
      if (this.active !== active) return staleSessionResponse(entries);
      if (!entry.readKey || !isSha256Digest(entry.expectedContentHash)) {
        results.push(unavailable(entry, 'invalid-request', 'Text source request is malformed.'));
        continue;
      }
      if (!isSafeProjectAssetPath(entry.projectRelativePath)) {
        results.push(
          unavailable(entry, 'unsafe-path', 'Project-relative text source path is unsafe.'),
        );
        continue;
      }
      try {
        const candidate = path.resolve(active.root, entry.projectRelativePath);
        const relative = path.relative(active.root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          results.push(
            unavailable(entry, 'unsafe-path', 'Text source escapes the active Project root.'),
          );
          continue;
        }
        const realFile = await fs.realpath(candidate);
        if (this.active !== active) return staleSessionResponse(entries);
        const realRelative = path.relative(active.root, realFile);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          results.push(
            unavailable(
              entry,
              'symlink-escape',
              'Text source resolves outside the active Project root.',
            ),
          );
          continue;
        }
        const remainingAggregateBytes =
          PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes - aggregateBytes;
        const opened = await openAndReadContainedFile(
          active.root,
          realFile,
          Math.min(PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes, remainingAggregateBytes),
        );
        if (this.active !== active) return staleSessionResponse(entries);
        if (!opened.isFile) {
          results.push(unavailable(entry, 'not-file', 'Text source is not a regular file.'));
          continue;
        }
        if (opened.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes) {
          results.push(
            unavailable(entry, 'source-limit', 'Text source exceeds the per-source byte limit.'),
          );
          continue;
        }
        if (aggregateBytes + opened.size > PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes) {
          results.push(
            unavailable(
              entry,
              'aggregate-limit',
              'Text source batch exceeds the aggregate byte limit.',
            ),
          );
          continue;
        }
        const bytes = opened.bytes;
        if (bytes.byteLength > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes) {
          results.push(
            unavailable(entry, 'source-limit', 'Text source exceeds the per-source byte limit.'),
          );
          continue;
        }
        if (aggregateBytes + bytes.byteLength > PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes) {
          results.push(
            unavailable(
              entry,
              'aggregate-limit',
              'Text source batch exceeds the aggregate byte limit.',
            ),
          );
          continue;
        }
        aggregateBytes += bytes.byteLength;
        const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
        if (digest !== entry.expectedContentHash) {
          results.push(
            unavailable(
              entry,
              'hash-mismatch',
              'Text source bytes do not match the recorded content hash.',
            ),
          );
          continue;
        }
        const hadUtf8Bom =
          bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        const text = decoder.decode(hadUtf8Bom ? bytes.subarray(3) : bytes);
        results.push({
          status: 'ready',
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: digest,
          text,
          hadUtf8Bom,
        });
      } catch (error) {
        const code =
          error instanceof TextSourceReadFailure
            ? error.code
            : error instanceof TypeError
              ? 'invalid-utf8'
              : 'read-failed';
        results.push(
          unavailable(
            entry,
            code,
            error instanceof Error ? error.message : 'Text source read failed.',
          ),
        );
      }
    }
    return { entries: results };
  }
}

async function openAndReadContainedFile(
  root: string,
  filePath: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; isFile: boolean; size: number }> {
  let file;
  try {
    file = await fs.open(filePath, readOnlyNoFollowFlags);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ELOOP') {
      throw new TextSourceReadFailure(
        'symlink-escape',
        'Text source changed to a symbolic link before it could be opened.',
      );
    }
    throw error;
  }
  try {
    const openedPath = await fs.realpath(filePath);
    const relative = path.relative(root, openedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TextSourceReadFailure(
        'symlink-escape',
        'Text source resolves outside the active Project root.',
      );
    }
    const [descriptorStat, openedPathStat] = await Promise.all([file.stat(), fs.stat(openedPath)]);
    if (descriptorStat.dev !== openedPathStat.dev || descriptorStat.ino !== openedPathStat.ino) {
      throw new TextSourceReadFailure(
        'read-failed',
        'Text source changed while it was being opened.',
      );
    }
    if (!descriptorStat.isFile() || descriptorStat.size > maxBytes) {
      return {
        bytes: Buffer.alloc(0),
        isFile: descriptorStat.isFile(),
        size: descriptorStat.size,
      };
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const result = await file.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    return { bytes: bytes.subarray(0, total), isFile: true, size: descriptorStat.size };
  } finally {
    await file.close();
  }
}

function staleSessionResponse(
  entries: ReadProjectTextSourcesRequest['entries'],
): ReadProjectTextSourcesResponse {
  return {
    entries: entries.map((entry) =>
      unavailable(entry, 'stale-session', 'Project session is stale or unknown.'),
    ),
  };
}

function unavailable(
  entry: ReadProjectTextSourcesRequest['entries'][number],
  code: string,
  message: string,
): ProjectTextSourceReadEntry {
  return {
    status: 'unavailable',
    readKey: entry.readKey,
    projectRelativePath: entry.projectRelativePath,
    expectedContentHash: entry.expectedContentHash ?? null,
    code,
    message,
  };
}
