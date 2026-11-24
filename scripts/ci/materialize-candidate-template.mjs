#!/usr/bin/env node
// Repackage exactly the manifest-verified desktop candidate tree for launch smoke.
// No compilation, source substitution, or independent release-target selection.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCatalogCandidate } from './release-candidate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function desktopArchiveName(candidate, sourceSha) {
  if (candidate.kind !== 'native-player') throw new Error('Only native desktop player candidates are supported.');
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('Expected exact 40-hex source SHA.');
  const [platform, arch] = candidate.target.split('-');
  if (!['linux', 'windows', 'macos'].includes(platform) || !['release', 'devtools'].includes(candidate.id.split('-').at(-1)))
    throw new Error('Invalid desktop platform or release variant.');
  const suffix = platform === 'windows' ? 'zip' : 'tar.gz';
  return `noveltea-player-template-dev-${sourceSha}-${platform}-${arch}-${candidate.id.endsWith('-devtools') ? 'devtools' : 'release'}.${suffix}`;
}

async function main() {
  const id = process.argv[2];
  if (!id || process.argv.length !== 3) throw new Error('Usage: materialize-candidate-template.mjs <candidate-id>');
  const sha = process.env.GITHUB_SHA;
  const catalog = JSON.parse(await readFile(new URL('release-candidates.json', import.meta.url)));
  const candidate = resolveCatalogCandidate(catalog, id);
  const archive = desktopArchiveName(candidate, sha);
  const stage = path.resolve(root, candidate.root);
  if (!(await stat(path.join(stage, 'noveltea-candidate.json'))).isFile()) {
    throw new Error('Missing verified candidate manifest.');
  }
  execFileSync(process.execPath, [
    path.join(root, 'scripts/ci/release-candidate.mjs'),
    'verify', '--candidate', id, '--stage', 'qualify',
  ], { cwd: root, stdio: 'inherit' });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  const destination = path.join(root, 'dist', archive);
  // Candidate-only provenance files are deliberately outside the published template
  // descriptor. Recreating the archive must preserve exactly the original package tree.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-template-smoke-'));
  try {
    const archiveStage = path.join(scratch, path.basename(stage));
    await cp(stage, archiveStage, { recursive: true, filter: (source) => {
      const relative = path.relative(stage, source);
      return !['noveltea-candidate.json', 'candidate-generated-contracts.json'].includes(relative);
    } });
    const args = ['-E', 'tar', archive.endsWith('.zip') ? 'cf' : 'czf', destination];
    if (archive.endsWith('.zip')) args.push('--format=zip');
    args.push(path.basename(stage));
    execFileSync('cmake', args, { cwd: scratch, stdio: 'inherit' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`Staged verified candidate archive: ${destination}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
