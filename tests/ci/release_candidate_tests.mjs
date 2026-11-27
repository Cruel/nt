import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  produceCandidate,
  verifyCandidate,
  verifyTrustedProducerRun,
  verifyBuiltCliIdentity,
} from '../../scripts/ci/release-candidate.mjs';

const tempRoots = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha = 'a'.repeat(40);
const producer = {
  repository: 'Cruel/nt',
  workflow: 'Build',
  workflowPath: '.github/workflows/build.yml',
  runId: 123,
  runAttempt: 1,
  event: 'push',
  ref: 'refs/heads/master',
};

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'noveltea-candidate-'));
  tempRoots.push(dir);
  const repo = path.join(dir, 'repo');
  const root = path.join(dir, 'artifact');
  await mkdir(repo);
  await mkdir(root);
  await writeFile(path.join(repo, 'pin.json'), '{"revision":"pinned"}');
  await writeFile(path.join(repo, 'schema.ts'), 'export const schemaVersion = 1;');
  await writeFile(path.join(root, 'noveltea'), 'real binary bytes');
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets', 'default.txt'), 'one');
  const generatedSchema = path.join(dir, 'contracts.json');
  await writeFile(generatedSchema, '{"generated":"schema"}');
  const config = {
    repoRoot: repo,
    root,
    candidate: {
      id: 'linux-host-cli-x64',
      target: 'linux-x64-host-cli',
      variant: 'optimized',
      artifactName: 'noveltea-host-cli-linux-x64',
      preset: 'linux-authoring-release',
      compilerId: 'GNU',
      abiFloor: 'glibc-2.39',
      executable: 'noveltea',
      pinFiles: ['pin.json'],
      schemaSources: ['schema.ts'],
    },
    sourceSha: sha,
    producer,
    compiler: {
      id: 'GNU',
      version: '13.3.0',
      toolchain: '/usr/bin/c++',
      buildType: 'Release',
      flags: '-O3 -DNDEBUG',
      preset: 'linux-authoring-release',
    },
    generatedSchema,
  };
  return config;
}

function expected(config) {
  return {
    repoRoot: config.repoRoot,
    root: config.root,
    sourceSha: sha,
    candidate: config.candidate,
    producer,
  };
}

test('a built CLI and generated schema pass the producer -> manifest -> consumer boundary', async () => {
  const config = await fixture();
  const manifest = await produceCandidate(config);
  assert.equal(manifest.format, 'noveltea-release-candidate');
  assert.equal(manifest.files.some((entry) => entry.path === 'noveltea'), true);
  assert.equal(manifest.compiler.flags, '-O3 -DNDEBUG');
  assert.equal(manifest.abi.floor, 'glibc-2.39');
  assert.equal(manifest.producer.runId, 123);
  assert.ok(manifest.schema.generatedSha256);
  assert.equal((await verifyCandidate(manifest, expected(config))).files.length, manifest.files.length);
});

test('mismatched source, producer, target, variant, compiler, ABI and schema identities fail', async () => {
  const config = await fixture();
  const manifest = await produceCandidate(config);
  for (const [key, patch, message] of [
    ['SHA', { sourceSha: 'b'.repeat(40) }, /source SHA/i],
    ['producer', { producer: { ...producer, runId: 124 } }, /producer/i],
    ['target', { candidate: { ...config.candidate, target: 'windows-cli' } }, /target/i],
    ['variant', { candidate: { ...config.candidate, variant: 'debug' } }, /variant/i],
    ['compiler', { candidate: { ...config.candidate, compilerId: 'Clang' } }, /compiler/i],
    ['ABI', { candidate: { ...config.candidate, abiFloor: 'glibc-2.28' } }, /ABI/i],
  ]) {
    await assert.rejects(verifyCandidate(manifest, { ...expected(config), ...patch }), message, key);
  }
  await writeFile(path.join(config.repoRoot, 'schema.ts'), 'changed schema');
  await assert.rejects(verifyCandidate(manifest, expected(config)), /schema/i);
});

test('tampered, missing, or additional artifact bytes cannot be qualified', async () => {
  const config = await fixture();
  const manifest = await produceCandidate(config);
  await writeFile(path.join(config.root, 'noveltea'), 'tampered');
  await assert.rejects(verifyCandidate(manifest, expected(config)), /hash|size/i);
  await writeFile(path.join(config.root, 'noveltea'), 'real binary bytes');
  await writeFile(path.join(config.root, 'injected'), 'surprise');
  await assert.rejects(verifyCandidate(manifest, expected(config)), /unexpected/i);
});

test('mutable dependency pins are rehashed rather than believed from the manifest', async () => {
  const config = await fixture();
  const manifest = await produceCandidate(config);
  await writeFile(path.join(config.repoRoot, 'pin.json'), '{"revision":"different"}');
  await assert.rejects(verifyCandidate(manifest, expected(config)), /dependency/i);
});

test('unsafe symlink entries are rejected, not followed outside the artifact root', async () => {
  const config = await fixture();
  await symlink(path.join(config.repoRoot, 'pin.json'), path.join(config.root, 'outside'));
  await assert.rejects(produceCandidate(config), /symbolic link|symlink/i);
});

test('a pre-existing output symlink cannot redirect the manifest writer', async () => {
  const config = await fixture();
  await symlink(path.join(config.repoRoot, 'pin.json'), path.join(config.root, 'noveltea-candidate.json'));
  await assert.rejects(produceCandidate(config), /regular file/i);
});

test('a hidden artifact file fails admission before the manifest can be uploaded', async () => {
  const config = await fixture();
  await writeFile(path.join(config.root, '.hidden'), 'unsafe-to-upload');
  await assert.rejects(produceCandidate(config), /Hidden artifact/i);
});

test('embedded native CLI identity must be the exact clean source SHA', () => {
  assert.equal(verifyBuiltCliIdentity({ success: true, daemon: { build: `git:${sha}` } }, sha), true);
  assert.throws(() => verifyBuiltCliIdentity({ success: true, daemon: { build: `git:${'b'.repeat(40)}` } }, sha), /compiled CLI build identity/i);
  assert.throws(() => verifyBuiltCliIdentity({ success: true, daemon: { build: `git:${sha}:dirty:untracked` } }, sha), /compiled CLI build identity/i);
  assert.throws(() => verifyBuiltCliIdentity({ success: false }, sha), /probe failed/i);
});

test('promotion requires an independently trusted completed master Build at the exact revision', async () => {
  const config = await fixture();
  const manifest = await produceCandidate(config);
  const run = {
    id: 123,
    run_attempt: 1,
    name: 'Build',
    path: '.github/workflows/build.yml',
    event: 'push',
    head_sha: sha,
    head_branch: 'master',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: 'Cruel/nt' },
    head_repository: { full_name: 'Cruel/nt' },
  };
  assert.equal(verifyTrustedProducerRun(manifest, run), true);
  for (const [label, change] of [
    ['PR', { event: 'pull_request' }],
    ['branch', { head_branch: 'other' }],
    ['fork', { head_repository: { full_name: 'other/nt' } }],
    ['SHA', { head_sha: 'b'.repeat(40) }],
    ['workflow', { path: '.github/workflows/other.yml' }],
    ['unsuccessful', { conclusion: 'failure' }],
    ['attempt', { run_attempt: 2 }],
  ]) {
    assert.throws(() => verifyTrustedProducerRun(manifest, { ...run, ...change }), /trusted|producer|mismatch|success|revision/i, label);
  }
  assert.throws(
    () => verifyTrustedProducerRun({ ...manifest, producer: { ...producer, event: 'pull_request' } }, run),
    /trusted/i,
  );
});
