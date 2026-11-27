#!/usr/bin/env node
// Rehydrate the validated Builder pointer from an immutable package candidate;
// the original installer bytes remain untouched when Release stages distributions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCatalogCandidate } from './release-candidate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extensions = {
  linux: ['.AppImage', '.deb', '.rpm'],
  windows: ['.exe'],
  macos: ['.dmg', '.zip'],
};

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function prepareEditorRelease({ root, candidate, releaseTag, destination }) {
  assert.equal(candidate.kind, 'editor-package', 'Expected production Editor installer candidate');
  const [platform, architecture] = candidate.target.split('-');
  const required = extensions[platform];
  assert.ok(required && architecture, 'Unsupported Editor release target');
  const source = JSON.parse(await readFile(path.join(root, 'editor-distribution.json')));
  const manifest = JSON.parse(await readFile(path.join(root, 'noveltea-candidate.json')));
  assert.equal(source.format, 'noveltea-editor-candidate-distribution');
  assert.equal(source.version, 1);
  assert.equal(source.releaseTag, releaseTag, 'Build installer release tag mismatch');
  assert.equal(source.platform, platform);
  assert.equal(source.arch, architecture);
  assert.equal(source.artifacts?.length, required.length, 'Incomplete Editor installer variants');
  const matched = new Map(manifest.files.map((file) => [file.path, file]));
  const packages = path.resolve(root, 'packages');
  const listing = [];
  for (const suffix of required) {
    const found = source.artifacts.filter((entry) =>
      entry.fileName?.endsWith(suffix));
    assert.equal(found.length, 1, `Missing or duplicate Editor ${suffix} installer`);
    const item = found[0];
    assert.equal(item.fileName, path.basename(item.fileName), 'Editor package filename escaped stage');
    const file = path.join(packages, item.fileName);
    const entry = matched.get(`packages/${item.fileName}`);
    assert.ok(entry, 'Installer was not included in the trusted candidate manifest');
    const info = await stat(file);
    assert.ok(info.isFile() && info.size > 20, 'Empty or invalid Editor installer');
    assert.equal(info.size, item.size, 'Editor package size mismatch');
    assert.equal(entry.size, info.size, 'Trusted Editor manifest size mismatch');
    const actual = await digest(file);
    assert.equal(actual, item.sha256, 'Editor package SHA mismatch');
    assert.equal(entry.sha256, actual, 'Editor candidate manifest hash mismatch');
    listing.push({ fileName: item.fileName, sha256: actual, size: info.size });
  }
  const primary = source.primary;
  assert.ok(listing.some((item) => item.fileName === primary), 'Editor primary installer missing');
  const originalPointer = (await readFile(path.join(root, candidate.executable), 'utf8')).trim().split('\n');
  assert.deepEqual(originalPointer, [primary, listing.find((item) => item.fileName === primary).sha256],
    'Primary installer pointer differs from verified manifest');
  const pointer = {
    mode: 'artifact', releaseTag, platform, architecture, outputRoot: packages,
    artifacts: listing,
  };
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(pointer, null, 2) + '\n');
  return pointer;
}

async function main() {
  const [id, tag] = process.argv.slice(2);
  assert.ok(id && tag && process.argv.length === 4,
    'Usage: promote-editor-candidate.mjs <candidate-id> <release-tag>');
  const catalog = JSON.parse(await readFile(new URL('release-candidates.json', import.meta.url)));
  const candidate = resolveCatalogCandidate(catalog, id);
  const preview = process.env.NOVELTEA_RELEASE_PREVIEW === 'true';
  if (preview) {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/ci/build-release-refactor-641');
  }
  execFileSync(process.execPath, [
    path.join(repo, 'scripts/ci/release-candidate.mjs'),
    'verify', '--candidate', id, '--stage', preview ? 'preview' : 'promote',
  ], { cwd: repo, stdio: 'inherit' });
  const pointer = await prepareEditorRelease({
    root: path.join(repo, candidate.root), candidate, releaseTag: tag,
    destination: path.join(repo, 'editor/out/electron-builder/latest-artifact.json'),
  });
  process.stdout.write(`Editor ${id}: ${pointer.artifacts.length} original Build installers hash-verified.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Release Editor rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
