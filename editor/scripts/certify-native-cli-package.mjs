import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const cli = path.resolve(process.argv[2] ?? path.join(repositoryRoot, 'build/cli/linux/noveltea'));
const fixture = path.resolve(
  process.argv[3] ?? path.join(repositoryRoot, 'tests/projects/feature-lab'),
);
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-cli-native-package-'));
const coldProject = path.join(root, 'cold');
const daemonProject = path.join(root, 'daemon');
const daemonRoot = path.join(root, 'daemon-runtime');
const daemonId = `noveltea-516-${process.pid}`;

const baseline = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
  NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: '1',
};

function execute(project, args, noDaemon) {
  const run = spawnSync(
    cli,
    [...(noDaemon ? ['--no-daemon'] : []), '--json', '--project', project, ...args],
    {
      env: {
        ...baseline,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: daemonId,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: daemonRoot,
      },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  assert.ifError(run.error);
  assert.ok(run.stdout.trim(), `package export had no JSON response:\n${run.stderr}`);
  const response = JSON.parse(run.stdout);
  assert.equal(run.status, response.exitCode, `${run.stdout}\n${run.stderr}`);
  return response;
}

function runtimePackageEntry(bytes, wanted) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0 && end + 22 <= bytes.length, 'Runtime Package ZIP has no complete EOCD.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    assert.equal(
      bytes.readUInt32LE(offset),
      0x02014b50,
      'Runtime Package central directory is corrupt.',
    );
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
    if (name === wanted) {
      const local = bytes.readUInt32LE(offset + 42);
      assert.equal(bytes.readUInt32LE(local), 0x04034b50, `Missing local header for '${wanted}'.`);
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const payload = bytes.subarray(start, start + compressedSize);
      const decoded =
        compression === 8
          ? inflateRawSync(payload, { maxOutputLength: 128 * 1024 * 1024 })
          : compression === 0
            ? payload
            : null;
      assert.ok(decoded, `Unsupported compression for '${wanted}'.`);
      assert.equal(decoded.length, uncompressedSize, `Runtime Package '${wanted}' size mismatch.`);
      return decoded;
    }
    offset += 46 + nameSize + extraSize + commentSize;
  }
  assert.fail(`Runtime Package is missing '${wanted}'.`);
}

async function certifyVariant(name, extraOptions = []) {
  const coldOutput = path.join(root, `${name}-cold.ntpkg`);
  const daemonOutput = path.join(root, `${name}-daemon.ntpkg`);
  const args = ['package', 'export', '--allow-localization-warnings', ...extraOptions];
  const cold = execute(coldProject, [...args, '--output', coldOutput], true);
  const daemon = execute(daemonProject, [...args, '--output', daemonOutput], false);
  assert.equal(cold.success, true, JSON.stringify(cold.diagnostics));
  assert.equal(daemon.success, true, JSON.stringify(daemon.diagnostics));
  assert.deepEqual(daemon.diagnostics, cold.diagnostics, `${name} diagnostics diverged.`);
  assert.deepEqual(daemon.native?.manifest, cold.native?.manifest, `${name} manifest diverged.`);
  assert.deepEqual(daemon.native?.checksums, cold.native?.checksums, `${name} checksums diverged.`);
  const coldBytes = await readFile(coldOutput);
  const daemonBytes = await readFile(daemonOutput);
  assert.deepEqual(daemonBytes, coldBytes, `${name} package bytes diverged.`);
  const compiled = JSON.parse(runtimePackageEntry(coldBytes, 'game').toString('utf8'));
  assert.equal(compiled.project?.name, 'Feature Lab', `${name} package gameplay readback failed.`);
  console.log(
    `  ${name}: cold/daemon package bytes, manifest, checksums, diagnostics and gameplay match`,
  );
}

try {
  await Promise.all([
    cp(fixture, coldProject, { recursive: true }),
    cp(fixture, daemonProject, { recursive: true }),
  ]);
  await Promise.all([
    rm(path.join(coldProject, '.noveltea'), { recursive: true, force: true }),
    rm(path.join(daemonProject, '.noveltea'), { recursive: true, force: true }),
  ]);
  await certifyVariant('default');
  await certifyVariant('developer-overrides', [
    '--include-unused-assets',
    '--include-shader-sources',
  ]);

  // A disposable worker must not publish an older pinned Project over an
  // existing package after the resident owner observes an authored edit.
  const existing = path.join(root, 'default-daemon.ntpkg');
  const previousBytes = await readFile(existing);
  const marker = path.join(root, 'package-snapshot-pinned');
  const child = spawn(
    cli,
    [
      '--json',
      '--project',
      daemonProject,
      'package',
      'export',
      '--allow-localization-warnings',
      '--output',
      existing,
    ],
    {
      env: {
        ...baseline,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: daemonId,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: daemonRoot,
        NOVELTEA_CLI_CERTIFICATION_AFTER_SNAPSHOT_MARKER: marker,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text) => {
    stdout += text;
  });
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve(status));
  });
  try {
    let pinned = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (existsSync(marker)) {
        pinned = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(pinned, `Package worker never pinned a generation: ${stderr}`);
    const room = path.join(daemonProject, 'records/rooms/active-text-finish.yaml');
    await writeFile(room, `${await readFile(room, 'utf8')}\n# changed after package pin\n`);
    const promoted = execute(daemonProject, ['usages', 'rooms', 'active-text-finish'], false);
    assert.equal(promoted.exitCode, 0, JSON.stringify(promoted.diagnostics));
  } finally {
    await writeFile(`${marker}.release`, 'release');
  }
  const status = await finished;
  assert.notEqual(status, 0, `Stale pinned package was published: ${stdout}\n${stderr}`);
  const verdict = JSON.parse(stdout);
  assert.ok(
    verdict.diagnostics?.some(
      (item) =>
        item.code === 'export.pinned_input_changed' || item.code === 'WORKSPACE_REVISION_CONFLICT',
    ),
    `Stale package returned the wrong failure: ${stdout}\n${stderr}`,
  );
  assert.deepEqual(
    await readFile(existing),
    previousBytes,
    'Stale worker replaced existing package.',
  );
  console.log('  pinned daemon package source drift rejected without overwriting prior bytes');
  console.log('Native CLI Runtime Package certification PASSED.');
} finally {
  try {
    spawnSync(cli, ['--json', 'daemon', 'stop'], {
      env: {
        ...baseline,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: daemonId,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: daemonRoot,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch {
    // Preserve the original certification result.
  }
  await rm(root, { recursive: true, force: true });
}
