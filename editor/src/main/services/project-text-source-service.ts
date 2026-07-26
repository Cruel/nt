import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
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

export class ProjectTextSourceReadSessionService {
  private active: { id: string; root: string } | null = null;

  assignProjectFile(projectFilePath: string): string {
    const root = path.dirname(path.resolve(projectFilePath));
    if (this.active?.root === root) return this.active.id;
    this.active = { id: randomUUID(), root };
    return this.active.id;
  }

  clear(): void {
    this.active = null;
  }

  currentSessionId(): string | null {
    return this.active?.id ?? null;
  }

  async read(request: ReadProjectTextSourcesRequest): Promise<ReadProjectTextSourcesResponse> {
    const entries = [...request.entries];
    if (!this.active || request.projectReadSessionId !== this.active.id) {
      return {
        entries: entries.map((entry) =>
          unavailable(entry, 'stale-session', 'Project read session is stale or unknown.'),
        ),
      };
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
        const candidate = path.resolve(this.active.root, entry.projectRelativePath);
        const relative = path.relative(this.active.root, candidate);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          results.push(
            unavailable(entry, 'unsafe-path', 'Text source escapes the active project root.'),
          );
          continue;
        }
        const realRoot = await fs.realpath(this.active.root);
        const realFile = await fs.realpath(candidate);
        const realRelative = path.relative(realRoot, realFile);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
          results.push(
            unavailable(
              entry,
              'symlink-escape',
              'Text source resolves outside the active project root.',
            ),
          );
          continue;
        }
        const stat = await fs.stat(realFile);
        if (!stat.isFile()) {
          results.push(unavailable(entry, 'not-file', 'Text source is not a regular file.'));
          continue;
        }
        if (stat.size > PROJECT_TEXT_SOURCE_LIMITS.maxSourceBytes) {
          results.push(
            unavailable(entry, 'source-limit', 'Text source exceeds the per-source byte limit.'),
          );
          continue;
        }
        if (aggregateBytes + stat.size > PROJECT_TEXT_SOURCE_LIMITS.maxAggregateBytes) {
          results.push(
            unavailable(
              entry,
              'aggregate-limit',
              'Text source batch exceeds the aggregate byte limit.',
            ),
          );
          continue;
        }
        const bytes = await fs.readFile(realFile);
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
        const code = error instanceof TypeError ? 'invalid-utf8' : 'read-failed';
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
