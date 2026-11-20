import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  authorizeRelease, checkBuildArtifacts, releaseMayPublish, requiredArtifacts,
  selectBuild, selectExtended, validateTrustedBuild, validateTrustedExtended,
  waitForExtended, verifyPinnedAuthority,
} from '../../scripts/ci/release-promotion.mjs';
import { assembleTemplate } from '../../scripts/ci/promote-release-template.mjs';
import { makeReceipt } from '../../scripts/ci/extended-qualification.mjs';

const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const tag = 'v2.3.4';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const buildRun = {
  id: 42, run_attempt: 3, name: 'Build',
  path: '.github/workflows/build.yml',
  repository: { full_name: 'Cruel/nt' }, head_repository: { full_name: 'Cruel/nt' },
  head_sha: sourceSha, head_branch: 'master', event: 'push',
  status: 'completed', conclusion: 'success',
};
const extendedRun = {
  id: 108, run_attempt: 2, name: 'Extended Qualification',
  path: '.github/workflows/extended-qualification.yml',
  repository: { full_name: 'Cruel/nt' }, head_repository: { full_name: 'Cruel/nt' },
  head_sha: workflowSha, head_branch: 'master', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', created_at: '2026-11-20T00:00:00Z',
};
const jobs = JSON.parse(await readFile(
  new URL('../../scripts/ci/extended-qualification-contract.json', import.meta.url))).jobs;
const extendedReceipt = makeReceipt({
  sourceSha, workflowSha, repository: 'Cruel/nt', workflow: 'Extended Qualification',
  ref: 'refs/heads/master', event: 'workflow_dispatch', runId: 108, attempt: 2,
  buildRunId: 42,
}, Object.fromEntries(jobs.filter((name) => name !== 'source')
  .map((name) => [name, { result: 'success' }])));

const catalog = {
  format: 'noveltea-candidate-catalog', version: 1,
  candidates: {
    example: {
      id: 'example', kind: 'native-player', target: 'linux-x64-player',
      variant: 'standard', preset: 'linux-release', compilerId: 'GNU',
      abiFloor: 'glibc-2.28', executable: 'bin/noveltea-player',
      artifactName: 'noveltea-candidate-example',
    },
    debug: {
      id: 'debug', kind: 'android-template', target: 'android-x86_64',
      variant: 'debug', tier: 'diagnostic', preset: 'android-x64-debug',
      compilerId: 'Clang', abiFloor: 'android-api-24',
      executable: 'source/android/prebuilt-native/x86_64/libnoveltea-player.so',
      artifactName: 'noveltea-candidate-android-debug',
    },
  },
};
const artifact = (name, id = 1) => ({ name, id, size_in_bytes: 100, expired: false });

test('only an authenticated successful master push Build run is eligible', () => {
  assert.equal(validateTrustedBuild(buildRun, sourceSha), 42);
  for (const update of [
    { head_branch: 'feature' }, { event: 'pull_request' },
    { event: 'workflow_dispatch' }, { head_sha: workflowSha },
    { conclusion: 'failure' }, { status: 'in_progress' },
    { head_repository: { full_name: 'fork/nt' } },
    { path: '.github/workflows/other.yml' },
  ]) assert.throws(() => validateTrustedBuild({ ...buildRun, ...update }, sourceSha));
});

test('complete exact producer inventory rejects missing, duplicate, expired and empty artifacts', () => {
  const expected = requiredArtifacts(catalog);
  assert.deepEqual(expected, ['noveltea-candidate-example', 'noveltea-candidate-android-debug',
    'noveltea-web-editor-preview', 'noveltea-shader-assets',
    'noveltea-build-windows-tooling-bridge-release',
    'noveltea-build-windows-tooling-bridge-devtools']);
  const complete = expected.map((name, index) => artifact(name, index + 1));
  assert.ok(checkBuildArtifacts(complete, expected));
  assert.throws(() => checkBuildArtifacts(complete.slice(1), expected), /Missing or duplicate/);
  assert.throws(() => checkBuildArtifacts([...complete, artifact(expected[0], 5)], expected), /duplicate/);
  assert.throws(() => checkBuildArtifacts([{ ...complete[0], expired: true }, complete[1]], expected), /Expired/);
  assert.throws(() => checkBuildArtifacts([{ ...complete[0], size_in_bytes: 0 }, complete[1]], expected), /Empty/);
});

test('qualification receipt requires the same selected Build run and independently trusted Extended run', () => {
  assert.equal(validateTrustedExtended(extendedReceipt, extendedRun, sourceSha, 42), 108);
  assert.throws(() => validateTrustedExtended(extendedReceipt, extendedRun, sourceSha, 40),
    /did not qualify/);
  assert.throws(() => validateTrustedExtended(extendedReceipt,
    { ...extendedRun, conclusion: 'failure' }, sourceSha, 42));
  assert.throws(() => validateTrustedExtended(extendedReceipt,
    { ...extendedRun, head_sha: sourceSha }, sourceSha, 42));
});

function client(options = {}) {
  return {
    runs: async (workflow) => workflow === 'build.yml' ?
      (options.buildRuns ?? [buildRun]) : (options.extendedRuns ?? [extendedRun]),
    artifacts: async (runId) => runId === 42 ?
      (options.buildArtifacts ?? [
        artifact('noveltea-candidate-example', 1),
        artifact('noveltea-candidate-android-debug', 2),
        artifact('noveltea-web-editor-preview', 3),
        artifact('noveltea-shader-assets', 4),
        artifact('noveltea-build-windows-tooling-bridge-release', 5),
        artifact('noveltea-build-windows-tooling-bridge-devtools', 6),
      ]) : (options.extendedArtifacts ?? [artifact('noveltea-extended-qualification', 3)]),
    receipt: async () => options.receipt ?? extendedReceipt,
    dispatchExtended: async () => { options.dispatch?.(); },
    call: async (route) => route === 'actions/runs/42' ?
      (options.pinnedBuild ?? buildRun) : (options.pinnedExtended ?? extendedRun),
  };
}

test('positive producer to exact-SHA qualification path authorizes the correct artifact run', async () => {
  const authority = await authorizeRelease(client(), { sourceSha, catalog, requestExtended: false });
  assert.deepEqual(authority, {
    format: 'noveltea-release-authority', version: 1, sourceSha,
    buildRunId: 42, buildRunAttempt: 3, extendedRunId: 108, extendedRunAttempt: 2,
  });
});

test('post-qualification inventory and publication independently recheck pinned exact run/attempt evidence', async () => {
  const authority = await authorizeRelease(client(), { sourceSha, catalog, requestExtended: false });
  assert.deepEqual(await verifyPinnedAuthority(client(), authority, sourceSha, catalog), authority);
  await assert.rejects(verifyPinnedAuthority(client(), { ...authority, sourceSha: workflowSha }, sourceSha, catalog));
  await assert.rejects(verifyPinnedAuthority(client({ pinnedBuild: { ...buildRun, conclusion: 'failure' } }), authority, sourceSha, catalog));
  await assert.rejects(verifyPinnedAuthority(client({ pinnedBuild: { ...buildRun, run_attempt: 4 } }), authority, sourceSha, catalog), /attempt changed/);
  await assert.rejects(verifyPinnedAuthority(client({ pinnedExtended: { ...extendedRun, run_attempt: 3 } }), authority, sourceSha, catalog), /attempt changed/);
  await assert.rejects(verifyPinnedAuthority(client({ extendedArtifacts: [] }), authority, sourceSha, catalog), /missing or expired/);
  await assert.rejects(verifyPinnedAuthority(client({ receipt: { ...extendedReceipt, trustedBuildRunId: 33 } }), authority, sourceSha, catalog), /did not qualify/);
});

test('untrusted or unavailable producer and Extended evidence fail closed', async () => {
  await assert.rejects(selectBuild(client({ buildRuns: [{ ...buildRun, event: 'pull_request' }] }),
    sourceSha, requiredArtifacts(catalog)), /No complete trusted/);
  await assert.rejects(selectBuild(client({
    buildArtifacts: [artifact('noveltea-candidate-example')],
  }), sourceSha, requiredArtifacts(catalog)), /No complete trusted/);
  assert.equal(await selectExtended(client({
    receipt: { ...extendedReceipt, trustedBuildRunId: 88 },
  }), sourceSha, 42), null);
  await assert.rejects(authorizeRelease(client({ extendedRuns: [] }),
    { sourceSha, catalog, requestExtended: false }), /No successful exact-SHA/);
});

test('missing Extended evidence dispatches exactly one selected-SHA qualification, then checks receipt', async () => {
  let dispatched = 0;
  let queried = 0;
  const api = client({ extendedRuns: [] });
  api.dispatchExtended = async (sha) => {
    assert.equal(sha, sourceSha); dispatched++;
  };
  api.runs = async () => ++queried > 1 ? [{ ...extendedRun, created_at: new Date().toISOString() }] : [];
  const qualified = await waitForExtended(api, sourceSha, 42, {
    sleep: async () => {}, maxPolls: 3,
  });
  assert.equal(qualified.id, 108);
  assert.equal(dispatched, 1);
});

test('manual dispatch cannot publish even after full qualification; tag push requires exact tag SHA', () => {
  assert.equal(releaseMayPublish('workflow_dispatch', 'refs/heads/master', sourceSha, sourceSha), false);
  assert.equal(releaseMayPublish('push', 'refs/heads/master', sourceSha, sourceSha), false);
  assert.equal(releaseMayPublish('push', 'refs/tags/v2.3.4', sourceSha, sourceSha), true);
  assert.throws(() => releaseMayPublish('push', 'refs/tags/v2.3.4', sourceSha, workflowSha),
    /tag must resolve/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-release-test-'));
  const stage = path.join(root, 'build/package/noveltea-player-web-wasm32-threads-release');
  const out = path.join(root, 'release/noveltea-player-web-wasm32-threads-release');
  const dist = path.join(root, 'dist');
  await mkdir(path.join(stage, 'licenses'), { recursive: true });
  await mkdir(path.join(stage, 'symbols'), { recursive: true });
  const original = `dev-${sourceSha}`;
  const files = {
    'player.wasm': Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.alloc(24)]),
    'player.js': Buffer.from('export const player = 1;\n'),
    'player.data': Buffer.from('runtime payload'),
    'licenses/index.json': Buffer.from('{"format":"noveltea.engine-licenses","components":[]}\n'),
    'symbols/player.wasm.debug.wasm': Buffer.from('true DWARF bytes'),
  };
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { type: 'application', name: 'noveltea-player', version: original } },
    components: [],
  };
  files['SBOM.cdx.json'] = Buffer.from(JSON.stringify(sbom, null, 2) + '\n');
  const inventory = Object.entries(files)
    .filter(([name]) => !name.startsWith('symbols/'))
    .map(([name, buffer]) => ({ path: name, size: buffer.length, mode: 0o644, sha256: hash(buffer) }));
  const id = 'web-wasm32-threads-release';
  const descriptor = {
    format: 'noveltea.player-template', formatVersion: 1, templateId: id,
    buildId: `${original}-${id}`, engineVersion: original,
    files: inventory, provenance: { provider: 'github-attestation', source: original },
    artifacts: {
      archive: `noveltea-player-template-${original}-${id}.zip`,
      symbols: `noveltea-player-symbols-${original}-${id}.zip`,
      sbom: 'SBOM.cdx.json', notices: 'licenses/index.json',
    },
  };
  files['template.json'] = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n');
  files['candidate-generated-contracts.json'] = Buffer.from('{}\n');
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(stage, name), bytes);
  }
  const manifest = { sourceSha, files: Object.entries(files).map(([name, bytes]) =>
    ({ path: name, size: bytes.length, sha256: hash(bytes) })) };
  await writeFile(path.join(stage, 'noveltea-candidate.json'), JSON.stringify(manifest));
  return { root, stage, out, dist, files, descriptor, manifest };
}

test('release archive and symbols retain verified Build binaries while rebinding only tag metadata', async () => {
  const f = await fixture();
  try {
    const candidate = {
      id: 'web-player-threads-release', kind: 'web-player',
      target: 'web-wasm32-threads', variant: 'standard',
    };
    const result = await assembleTemplate({
      candidate, stage: f.stage, sourceSha, releaseTag: tag,
      destination: f.out, dist: f.dist, verify: false,
    });
    assert.equal(result.templateId, 'web-wasm32-threads-release');
    const descriptor = JSON.parse(await readFile(path.join(f.out, 'template.json')));
    assert.equal(descriptor.engineVersion, tag);
    assert.equal(descriptor.buildId, `${tag}-web-wasm32-threads-release`);
    assert.equal(descriptor.files.find((file) => file.path === 'player.wasm').sha256,
      hash(f.files['player.wasm']));
    assert.equal(hash(await readFile(path.join(f.stage, 'player.wasm'))), hash(f.files['player.wasm']));
    assert.equal(JSON.parse(await readFile(path.join(f.stage, 'template.json'))).engineVersion,
      `dev-${sourceSha}`, 'Build candidate must remain immutable');
    const wasm = execFileSync('unzip', ['-p', result.archive,
      'noveltea-player-web-wasm32-threads-release/player.wasm']);
    assert.deepEqual(wasm, f.files['player.wasm']);
    assert.ok((await readFile(path.join(f.dist,
      `noveltea-player-symbols-${tag}-web-wasm32-threads-release.zip`))).length > 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test('assembly rejects a Build byte substitution and missing separate Web symbols', async () => {
  const f = await fixture();
  const candidate = {
    id: 'web-player-threads-release', kind: 'web-player',
    target: 'web-wasm32-threads', variant: 'standard',
  };
  try {
    await writeFile(path.join(f.stage, 'player.wasm'), 'tampered');
    await assert.rejects(assembleTemplate({
      candidate, stage: f.stage, sourceSha, releaseTag: tag,
      destination: f.out, dist: f.dist, verify: false,
    }), /byte substitution|hash mismatch/);
    await writeFile(path.join(f.stage, 'player.wasm'), f.files['player.wasm']);
    const manifest = { ...f.manifest, files: f.manifest.files.filter((item) =>
      item.path !== 'symbols/player.wasm.debug.wasm') };
    await writeFile(path.join(f.stage, 'noveltea-candidate.json'), JSON.stringify(manifest));
    await assert.rejects(assembleTemplate({
      candidate, stage: f.stage, sourceSha, releaseTag: tag,
      destination: f.out, dist: f.dist, verify: false,
    }), /omits Web DWARF/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
