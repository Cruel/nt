#!/usr/bin/env node
// Assemble release-tagged descriptors and archives from immutable Build bytes.
// No CMake compilation, alternate player, or replacement executable is allowed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveCatalogCandidate, verifyCandidate } from './release-candidate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shaPattern = /^[0-9a-f]{40}$/;
const releaseTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/;
const manifestNames = new Set(['noveltea-candidate.json', 'candidate-generated-contracts.json']);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function signedFiles(stage) {
  const entries = [];
  async function traverse(subpath) {
    for (const item of await readdir(path.join(stage, subpath), { withFileTypes: true })) {
      const relative = path.posix.join(subpath, item.name);
      assert.ok(!item.isSymbolicLink() && (item.isFile() || item.isDirectory()),
        `Unexpected link or special file: ${relative}`);
      if (item.isDirectory()) await traverse(relative);
      else entries.push(relative);
    }
  }
  await traverse('');
  return entries.sort();
}

function descriptorId(candidate) {
  if (candidate.kind === 'native-player') {
    const [platform, arch] = candidate.target.split('-');
    return `${platform}-${arch}-${candidate.id.endsWith('-devtools') ? 'devtools' : 'release'}`;
  }
  if (candidate.kind === 'web-player') {
    return `web-wasm32${candidate.target.includes('no-threads') ? '' : '-threads'}-${candidate.id.endsWith('-devtools') ? 'devtools' : 'release'}`;
  }
  if (candidate.kind === 'android-template') {
    return `android-${candidate.target === 'android-x86_64' ? 'x86_64' : 'arm64-v8a'}-${candidate.variant === 'debug' ? 'debug' : candidate.variant === 'devtools' ? 'devtools' : 'release'}`;
  }
  throw new Error('Only player templates can be assembled');
}

function renameDescriptor(descriptor, sbom, candidate, sourceSha, releaseTag, isWindows) {
  assert.match(sourceSha, shaPattern);
  assert.match(releaseTag, releaseTagPattern);
  // The Android x86_64 Debug-only producer predates the production candidates
  // and deliberately uses the separate ci-<SHA> diagnostic identity.
  const originalTag = candidate.kind === 'android-template' && candidate.variant === 'debug'
    ? `ci-${sourceSha}` : `dev-${sourceSha}`;
  const id = descriptorId(candidate);
  assert.equal(descriptor.templateId, id);
  assert.equal(descriptor.format, 'noveltea.player-template');
  assert.equal(descriptor.formatVersion, 1);
  assert.equal(descriptor.buildId, `${originalTag}-${id}`);
  assert.equal(descriptor.engineVersion, originalTag);
  assert.equal(descriptor.provenance?.source, originalTag);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.metadata?.component?.version, originalTag);
  const suffix = candidate.kind === 'web-player' || isWindows ? 'zip' : 'tar.gz';
  assert.equal(descriptor.artifacts.archive, `noveltea-player-template-${originalTag}-${id}.${suffix}`);
  assert.equal(descriptor.artifacts.symbols, `noveltea-player-symbols-${originalTag}-${id}.${candidate.kind === 'native-player' && !isWindows ? 'tar.gz' : 'zip'}`);
  descriptor.buildId = `${releaseTag}-${id}`;
  descriptor.engineVersion = releaseTag;
  descriptor.provenance.source = releaseTag;
  descriptor.artifacts.archive = `noveltea-player-template-${releaseTag}-${id}.${suffix}`;
  descriptor.artifacts.symbols = `noveltea-player-symbols-${releaseTag}-${id}.${candidate.kind === 'native-player' && !isWindows ? 'tar.gz' : 'zip'}`;
  sbom.metadata.component.version = releaseTag;
  return { descriptor, sbom, id, suffix };
}

export async function assembleTemplate({
  candidate, stage, sourceSha, releaseTag, destination, dist,
  repoRoot = repo,
  verify = true,
}) {
  assert.ok(['native-player', 'web-player', 'android-template'].includes(candidate.kind));
  assert.match(sourceSha, shaPattern);
  assert.match(releaseTag, releaseTagPattern);
  const original = JSON.parse(await readFile(path.join(stage, 'noveltea-candidate.json')));
  if (verify) {
    await verifyCandidate(original, {
      root: stage, repoRoot, candidate, sourceSha,
    });
  }
  assert.equal(original.sourceSha, sourceSha);
  const manifestFiles = new Map(original.files.map((file) => [file.path, file.sha256]));
  const originalDescriptor = JSON.parse(await readFile(path.join(stage, 'template.json')));
  const originalSbom = JSON.parse(await readFile(path.join(stage, 'SBOM.cdx.json')));
  const isWindows = candidate.target.startsWith('windows-');
  const { descriptor, sbom, id, suffix } = renameDescriptor(
    originalDescriptor, originalSbom, candidate, sourceSha, releaseTag, isWindows);
  assert.ok(!destination.startsWith(stage + path.sep) && destination !== stage,
    'Cannot change qualified candidate in place');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(stage, destination, { recursive: true, filter: (source) => {
    const relative = path.relative(stage, source).split(path.sep).join('/');
    return !manifestNames.has(relative) &&
      !(candidate.kind === 'web-player' && relative.startsWith('symbols/'));
  } });
  // Actions artifacts do not preserve POSIX permissions. Restore modes from
  // the source-owned package descriptor, never from an unverified URL or ZIP.
  for (const entry of descriptor.files) {
    assert.ok(Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777,
      `Invalid declared package mode: ${entry.path}`);
    await chmod(path.join(destination, entry.path), entry.mode);
  }
  const sbomData = JSON.stringify(sbom, null, 2) + '\n';
  await writeFile(path.join(destination, 'SBOM.cdx.json'), sbomData);
  const sbomFile = descriptor.files.find((entry) => entry.path === 'SBOM.cdx.json');
  assert.ok(sbomFile, 'Template descriptor is missing the SBOM identity');
  sbomFile.sha256 = sha256(Buffer.from(sbomData));
  sbomFile.size = Buffer.byteLength(sbomData);
  await writeFile(path.join(destination, 'template.json'), JSON.stringify(descriptor, null, 2) + '\n');

  // Every other package file, including compiled binaries and license texts,
  // must retain its source Build SHA-256 identity after tag metadata assembly.
  const allowedChanges = new Set(['SBOM.cdx.json', 'template.json']);
  if (candidate.kind === 'web-player') {
    for (const file of manifestFiles.keys()) if (file.startsWith('symbols/')) allowedChanges.add(file);
  }
  const expected = [...manifestFiles.keys()].filter((name) =>
    !manifestNames.has(name) && !allowedChanges.has(name)).sort();
  const output = (await signedFiles(destination)).filter((name) =>
    !allowedChanges.has(name)).sort();
  assert.deepEqual(output, expected, 'Compiled/template payload inventory changed during release assembly');
  for (const name of expected) {
    assert.equal(sha256(await readFile(path.join(destination, name))),
      manifestFiles.get(name), `Build candidate byte substitution: ${name}`);
  }
  for (const entry of descriptor.files) {
    const payload = await readFile(path.join(destination, entry.path));
    assert.equal(entry.sha256, sha256(payload), `Staged descriptor hash mismatch: ${entry.path}`);
    assert.equal(entry.size, payload.length, `Staged descriptor size mismatch: ${entry.path}`);
  }

  await mkdir(dist, { recursive: true });
  const archive = path.join(dist, descriptor.artifacts.archive);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-release-archive-'));
  try {
    const archivedStage = path.join(temporary, path.basename(stage));
    await cp(destination, archivedStage, { recursive: true });
    const archiveArgs = ['-E', 'tar', suffix === 'zip' ? 'cf' : 'czf', archive];
    if (suffix === 'zip') archiveArgs.push('--format=zip');
    archiveArgs.push(path.basename(stage));
    execFileSync('cmake', archiveArgs, { cwd: temporary, stdio: 'pipe' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await copyFile(path.join(destination, 'template.json'), path.join(dist, `${id}.template.json`));
  await copyFile(path.join(destination, 'SBOM.cdx.json'), path.join(dist, `${id}.SBOM.cdx.json`));
  await copyFile(path.join(destination, 'licenses/index.json'),
    path.join(dist, `${id}.licenses.index.json`));

  const symbolRootName = candidate.kind === 'android-template' ?
    `${id}-symbols` : `symbols-${releaseTag}-${id}`;
  const symbols = await mkdtemp(path.join(os.tmpdir(), 'noveltea-symbols-'));
  try {
    const dir = path.join(symbols, symbolRootName);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'BUILD_ID'), `${releaseTag}-${id}\n`);
    if (candidate.kind === 'native-player') {
      const files = await signedFiles(stage);
      const matching = files.filter((name) => name.startsWith('symbols/'));
      assert.ok(matching.length > 0, `Missing Build-produced debug symbols: ${id}`);
      for (const name of matching) {
        const target = path.join(dir, name.slice('symbols/'.length));
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(stage, name), target);
      }
    } else if (candidate.kind === 'web-player') {
      const file = 'symbols/player.wasm.debug.wasm';
      assert.ok(manifestFiles.has(file), 'Build candidate omits Web DWARF symbols');
      await copyFile(path.join(stage, file), path.join(dir, 'player.wasm.debug.wasm'));
    } else {
      const abi = candidate.target === 'android-x86_64' ? 'x86_64' : 'arm64-v8a';
      const lib = `source/android/prebuilt-native/${abi}/libnoveltea-player.so`;
      assert.ok(manifestFiles.has(lib), 'Build candidate omits Android native symbols');
      await mkdir(path.join(dir, abi), { recursive: true });
      await copyFile(path.join(stage, lib), path.join(dir, abi, 'libnoveltea-player.so'));
    }
    const out = path.join(dist, descriptor.artifacts.symbols);
    const args = ['-E', 'tar', out.endsWith('.zip') ? 'cf' : 'czf', out];
    if (out.endsWith('.zip')) args.push('--format=zip');
    args.push(symbolRootName);
    execFileSync('cmake', args, { cwd: symbols, stdio: 'pipe' });
  } finally {
    await rm(symbols, { recursive: true, force: true });
  }
  return { archive, sourceHashes: expected.length, templateId: id, descriptor };
}

async function main() {
  const [id, releaseTag] = process.argv.slice(2);
  assert.ok(id && releaseTag && process.argv.length === 4,
    'Usage: promote-release-template.mjs <candidate-id> <version-tag>');
  const catalog = JSON.parse(await readFile(new URL('release-candidates.json', import.meta.url)));
  const candidate = resolveCatalogCandidate(catalog, id);
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  // Production promotion requires the independently authenticated successful
  // master Build run; diagnostic Android Debug is only qualified, never promoted.
  execFileSync(process.execPath, [
    path.join(repo, 'scripts/ci/release-candidate.mjs'), 'verify',
    '--candidate', id, '--stage', candidate.tier === 'diagnostic' ? 'diagnose' : 'promote',
  ], { cwd: repo, stdio: 'inherit' });
  const stage = path.join(repo, candidate.root);
  const result = await assembleTemplate({
    candidate, stage, sourceSha, releaseTag,
    destination: path.join(repo, 'build/release-templates', path.basename(stage)),
    dist: path.join(repo, 'dist'),
  });
  process.stdout.write(`Release template ${result.templateId}: ${result.sourceHashes} original files hash-verified.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Release template denied: ${error.message}`);
    process.exitCode = 1;
  });
}
