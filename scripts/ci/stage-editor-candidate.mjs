#!/usr/bin/env node
// Stage only verified, platform-specific installer bytes from the exact Editor artifact producer.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCatalogCandidate } from './release-candidate.mjs';
import { readNovelTeaVersion } from '../noveltea-version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function demand(value, message) {
  if (!value) throw new Error(message);
}
async function sha(file) {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(file)) hash.update(piece);
  return hash.digest('hex');
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function stageEditorCandidate({
  repoRoot, candidate, pointer, releaseTag,
}) {
  demand(candidate?.kind === 'editor-package', 'Not a source-owned Editor candidate.');
  const [platform, arch] = [candidate.target.split('-')[0], candidate.target.split('-')[1]];
  const required = { linux: ['.AppImage', '.deb', '.rpm'], windows: ['.exe'], macos: ['.dmg', '.zip'] }[platform];
  demand(required && pointer?.platform === platform && pointer?.architecture === arch,
    'Editor host or architecture differs from the release candidate.');
  demand(pointer.mode === 'artifact' && pointer.releaseTag === releaseTag,
    'Editor distribution mode/tag differs from the release candidate.');
  demand(Array.isArray(pointer.artifacts) && pointer.artifacts.length === required.length,
    'Editor candidate does not contain the exact host distribution inventory.');
  const outputRoot = path.resolve(pointer.outputRoot);
  const editorDistributionRoot = path.join(repoRoot, 'editor', 'out', 'electron-builder', 'artifacts');
  demand(inside(editorDistributionRoot, outputRoot),
    'Editor distribution output is outside the source-owned artifact tree.');
  const checked = [];
  for (const extension of required) {
    const matches = pointer.artifacts.filter((entry) =>
      typeof entry.fileName === 'string' && entry.fileName.endsWith(extension));
    demand(matches.length === 1, `Missing or duplicate Editor ${extension} distribution.`);
    const entry = matches[0];
    demand(entry.fileName === path.basename(entry.fileName) && !entry.fileName.startsWith('.'),
      'Editor distribution filename must be a safe direct child.');
    const source = path.join(outputRoot, entry.fileName);
    const metadata = await stat(source);
    demand(metadata.isFile() && metadata.size > 20 && metadata.size === entry.size,
      `Editor distribution file size mismatch: ${entry.fileName}`);
    demand(await sha(source) === entry.sha256,
      `Editor distribution SHA-256 mismatch: ${entry.fileName}`);
    checked.push({ fileName: entry.fileName, sha256: entry.sha256, size: entry.size, source });
  }
  const root = path.join(repoRoot, candidate.root);
  demand(inside(repoRoot, root), 'Editor candidate stage escaped the checkout.');
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'packages'), { recursive: true });
  for (const entry of checked) {
    await copyFile(entry.source, path.join(root, 'packages', entry.fileName));
  }
  const primary = checked[0];
  // The primary installer is already present under packages/. Keep only a
  // small identity pointer, not a second copy of potentially large installers.
  await writeFile(path.join(root, candidate.executable),
    `${primary.fileName}\n${primary.sha256}\n`);
  await writeFile(path.join(root, 'editor-distribution.json'), JSON.stringify({
    format: 'noveltea-editor-candidate-distribution',
    version: 1, platform, arch, releaseTag,
    primary: primary.fileName,
    artifacts: checked.map(({ fileName, sha256, size }) => ({ fileName, sha256, size })),
  }, null, 2) + '\n');
  return root;
}

export function candidateIdFromArgv(argv) {
  const id = argv[2];
  demand(typeof id === 'string' && id.length > 0 && argv.length === 3,
    'Usage: stage-editor-candidate.mjs <catalog-id>');
  return id;
}

async function main() {
  const id = candidateIdFromArgv(process.argv);
  const releaseTag = readNovelTeaVersion(repo).releaseTag;
  const catalog = JSON.parse(await readFile(new URL('release-candidates.json', import.meta.url)));
  const candidate = resolveCatalogCandidate(catalog, id);
  const pointer = JSON.parse(await readFile(path.join(repo, 'editor/out/electron-builder/latest-artifact.json')));
  const root = await stageEditorCandidate({ repoRoot: repo, candidate, pointer, releaseTag });
  process.stdout.write(`Editor candidate staged at ${root}.\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Editor candidate rejected: ${error.message}\n`); process.exitCode = 1; });
}
