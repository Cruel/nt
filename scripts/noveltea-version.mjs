import { readFileSync } from 'node:fs';
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
