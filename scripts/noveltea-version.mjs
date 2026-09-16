import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseNovelTeaVersion(value) {
  const version = value.trim();
  const match = versionPattern.exec(version);
  if (!match) {
    throw new Error(
      `Invalid NovelTea version ${JSON.stringify(version)} in VERSION; expected MAJOR.MINOR.PATCH[-prerelease].`,
    );
  }
  return {
    version,
    coreVersion: `${match[1]}.${match[2]}.${match[3]}`,
    releaseTag: `v${version}`,
  };
}

export function readNovelTeaVersion(root = repositoryRoot) {
  return parseNovelTeaVersion(readFileSync(path.join(root, 'VERSION'), 'utf8'));
}

export function novelTeaDevelopmentVersion(version, revision) {
  const parsed = parseNovelTeaVersion(version);
  const suffix = /^[0-9a-f]{7,}$/i.test(revision) ? revision.slice(0, 12) : 'unknown';
  return parsed.version.includes('-')
    ? `${parsed.version}.dev.${suffix}`
    : `${parsed.version}-dev.${suffix}`;
}

export function readNovelTeaBuildIdentity(root = repositoryRoot) {
  const override = process.env.NOVELTEA_BUILD_IDENTITY?.trim();
  if (override) return override;
  try {
    const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const diff = execFileSync('git', ['-C', root, 'diff', '--binary', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untracked = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    const hash = createHash('sha256');
    hash.update(diff);
    let dirty = diff.length > 0;
    for (const relative of untracked) {
      const absolute = path.join(root, relative);
      const metadata = lstatSync(absolute);
      if (metadata.isDirectory()) continue;
      dirty = true;
      hash.update('\0');
      hash.update(relative);
      hash.update('\0');
      if (metadata.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(readlinkSync(absolute));
      } else {
        hash.update(readFileSync(absolute));
      }
    }
    const dirtyIdentity = hash.digest('hex');
    return dirty ? `git:${revision}:dirty:${dirtyIdentity}` : `git:${revision}`;
  } catch {
    return `build:unknown:${randomUUID()}`;
  }
}
