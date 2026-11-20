import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assembleTemplate } from '../../scripts/ci/promote-release-template.mjs';

const sha = 'b'.repeat(40);
const tag = 'v6.2.1';
const digest = (data) => createHash('sha256').update(data).digest('hex');

async function desktopFixture(platform) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-template-'));
  const arch = platform === 'macos' ? 'arm64' : 'x64';
  const id = `${platform}-${arch}-release`;
  const stage = path.join(root, 'build/package/noveltea-player-' + id);
  const destination = path.join(root, 'promoted/noveltea-player-' + id);
  const dist = path.join(root, 'dist');
  const source = 'dev-' + sha;
  const binaryName = `bin/noveltea-player${platform === 'windows' ? '.exe' : ''}`;
  const symbolFile = platform === 'linux' ? 'symbols/noveltea-player.debug' :
    platform === 'windows' ? 'symbols/noveltea-player.pdb' :
      'symbols/noveltea-player.dSYM/Contents/Resources/DWARF/noveltea-player';
  const symbolData = Buffer.from('exact compiled detached symbols from Build: ' + platform);
  const player = Buffer.from('original compiled binary, unmodified: ' + platform);
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { type: 'application', name: 'noveltea-player', version: source } },
    components: [],
  };
  const files = {
    [binaryName]: player,
    [symbolFile]: symbolData,
    'licenses/index.json': Buffer.from('{"format":"noveltea.engine-licenses","components":[]}\n'),
    'SBOM.cdx.json': Buffer.from(JSON.stringify(sbom, null, 2) + '\n'),
  };
  const inventory = Object.entries(files).map(([name, data]) => ({
    path: name, size: data.length, sha256: digest(data),
    mode: name === binaryName ? 0o755 : 0o644,
  }));
  const suffix = platform === 'windows' ? 'zip' : 'tar.gz';
  const descriptor = {
    format: 'noveltea.player-template', formatVersion: 1,
    templateId: id, buildId: source + '-' + id, engineVersion: source,
    provenance: { provider: 'github-attestation', source }, files: inventory,
    artifacts: {
      archive: `noveltea-player-template-${source}-${id}.${suffix}`,
      symbols: `noveltea-player-symbols-${source}-${id}.${suffix}`,
      sbom: 'SBOM.cdx.json', notices: 'licenses/index.json',
    },
  };
  files['template.json'] = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n');
  files['candidate-generated-contracts.json'] = Buffer.from('{}\n');
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(stage, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  await writeFile(path.join(stage, 'noveltea-candidate.json'), JSON.stringify({
    sourceSha: sha,
    files: Object.entries(files).map(([name, data]) => ({
      path: name, size: data.length, sha256: digest(data),
    })),
  }));
  return {
    root, stage, destination, dist, id, suffix, player, binaryName,
    symbolFile, symbolData,
    candidate: {
      id: `${platform}-player-${arch}-release`, kind: 'native-player',
      target: `${platform}-${arch}-player`, variant: 'standard',
    },
  };
}

test('Linux, Windows, and macOS Release packages preserve exact Build executables and detached symbols', async () => {
  for (const platform of ['linux', 'windows', 'macos']) {
    const f = await desktopFixture(platform);
    try {
      const result = await assembleTemplate({
        candidate: f.candidate, stage: f.stage, sourceSha: sha, releaseTag: tag,
        destination: f.destination, dist: f.dist, verify: false,
      });
      assert.equal(result.templateId, f.id);
      const descriptor = JSON.parse(await readFile(path.join(f.destination, 'template.json')));
      assert.equal(descriptor.engineVersion, tag);
      assert.equal(descriptor.buildId, `${tag}-${f.id}`);
      assert.equal(descriptor.provenance.source, tag);
      assert.equal(digest(await readFile(path.join(f.destination, f.binaryName))), digest(f.player));
      assert.equal(digest(await readFile(path.join(f.stage, f.binaryName))), digest(f.player));
      assert.equal((await stat(path.join(f.destination, f.binaryName))).mode & 0o777, 0o755);
      const inside = `noveltea-player-${f.id}/${f.binaryName}`;
      const archived = f.suffix === 'zip' ?
        execFileSync('unzip', ['-p', result.archive, inside]) :
        execFileSync('tar', ['-xOzf', result.archive, inside]);
      assert.deepEqual(archived, f.player, `${platform} executable archive identity`);
      const symbols = path.join(f.dist, `noveltea-player-symbols-${tag}-${f.id}.${f.suffix}`);
      const symPath = `symbols-${tag}-${f.id}/${f.symbolFile.slice('symbols/'.length)}`;
      const extracted = f.suffix === 'zip' ?
        execFileSync('unzip', ['-p', symbols, symPath]) :
        execFileSync('tar', ['-xOzf', symbols, symPath]);
      assert.deepEqual(extracted, f.symbolData, `${platform} exact detached symbols`);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test('native template promotion rejects binary substitution even after descriptor regeneration', async () => {
  const f = await desktopFixture('linux');
  try {
    await writeFile(path.join(f.stage, f.binaryName), 'substituted ELF contents');
    await assert.rejects(assembleTemplate({
      candidate: f.candidate, stage: f.stage, sourceSha: sha, releaseTag: tag,
      destination: f.destination, dist: f.dist, verify: false,
    }), /byte substitution|hash mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
