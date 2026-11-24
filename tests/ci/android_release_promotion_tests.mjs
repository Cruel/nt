import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assembleTemplate } from '../../scripts/ci/promote-release-template.mjs';
import { verifyTrustedDiagnosticRun, verifyTrustedProducerRun } from '../../scripts/ci/release-candidate.mjs';

const sourceSha = 'a'.repeat(40);
const tag = 'v1.2.3';
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('Android x86_64 Debug diagnosis authenticates master Build but cannot promote as optimized', () => {
  const manifest = {
    tier: 'diagnostic', sourceSha,
    producer: {
      repository: 'Cruel/nt', workflow: 'Build', workflowPath: '.github/workflows/build.yml',
      runId: 41, runAttempt: 2, event: 'push', ref: 'refs/heads/master',
    },
  };
  const run = {
    id: 41, run_attempt: 2, name: 'Build', path: '.github/workflows/build.yml',
    repository: { full_name: 'Cruel/nt' }, head_repository: { full_name: 'Cruel/nt' },
    head_sha: sourceSha, head_branch: 'master', event: 'push',
    status: 'completed', conclusion: 'success',
  };
  assert.equal(verifyTrustedDiagnosticRun(manifest, run), true);
  assert.throws(() => verifyTrustedProducerRun(manifest, run), /Diagnostic/);
  assert.throws(() => verifyTrustedDiagnosticRun(manifest, { ...run, event: 'pull_request' }));
  assert.throws(() => verifyTrustedDiagnosticRun(manifest, { ...run, conclusion: 'failure' }));
  assert.throws(() => verifyTrustedDiagnosticRun({ ...manifest, tier: 'production' }, run), /limited/);
});

test('Android Debug ci-SHA descriptor maps to versioned release diagnostics with identical ELF bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-release-android-'));
  try {
    const id = 'android-x86_64-debug';
    const stage = path.join(root, 'build/package', id);
    const destination = path.join(root, 'release', id);
    const dist = path.join(root, 'dist');
    const lib = 'source/android/prebuilt-native/x86_64/libnoveltea-player.so';
    await mkdir(path.join(stage, 'licenses'), { recursive: true });
    await mkdir(path.dirname(path.join(stage, lib)), { recursive: true });
    const binary = Buffer.alloc(80);
    binary[0] = 0x7f; binary.write('ELF', 1);
    binary[5] = 1; binary.writeUInt16LE(62, 18);
    const original = 'ci-' + sourceSha;
    const sbom = {
      bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
      metadata: { component: { type: 'application', name: 'noveltea-player', version: original } },
      components: [],
    };
    const payload = {
      [lib]: binary,
      'licenses/index.json': Buffer.from('{"format":"noveltea.engine-licenses","components":[]}\n'),
      'SBOM.cdx.json': Buffer.from(JSON.stringify(sbom, null, 2) + '\n'),
    };
    const files = Object.entries(payload).map(([name, bytes]) =>
      ({ path: name, mode: name === lib ? 0o755 : 0o644, sha256: sha(bytes), size: bytes.length }));
    const descriptor = {
      format: 'noveltea.player-template', formatVersion: 1,
      templateId: id, buildId: original + '-' + id, engineVersion: original,
      provenance: { provider: 'github-attestation', source: original },
      artifacts: {
        archive: 'noveltea-player-template-' + original + '-' + id + '.tar.gz',
        symbols: 'noveltea-player-symbols-' + original + '-' + id + '.zip',
        sbom: 'SBOM.cdx.json', notices: 'licenses/index.json',
      }, files,
    };
    payload['template.json'] = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n');
    for (const [name, bytes] of Object.entries(payload))
      await writeFile(path.join(stage, name), bytes);
    await writeFile(path.join(stage, 'noveltea-candidate.json'), JSON.stringify({
      sourceSha, files: Object.entries(payload).map(([name, bytes]) =>
        ({ path: name, sha256: sha(bytes), size: bytes.length })),
    }));
    const candidate = {
      id: 'android-player-x64-debug', kind: 'android-template',
      target: 'android-x86_64', variant: 'debug', tier: 'diagnostic',
    };
    const result = await assembleTemplate({
      candidate, stage, sourceSha, releaseTag: tag, destination, dist, verify: false,
    });
    assert.equal(result.templateId, id);
    const actual = JSON.parse(await readFile(path.join(destination, 'template.json')));
    assert.equal(actual.engineVersion, tag);
    assert.equal(actual.provenance.source, tag);
    assert.equal(sha(await readFile(path.join(destination, lib))), sha(binary));
    const archived = execFileSync('tar', ['-xOzf', result.archive, id + '/' + lib]);
    assert.deepEqual(archived, binary);
    const symbols = path.join(dist, 'noveltea-player-symbols-' + tag + '-' + id + '.zip');
    const detached = execFileSync('unzip', ['-p', symbols, id + '-symbols/x86_64/libnoveltea-player.so']);
    assert.deepEqual(detached, binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
