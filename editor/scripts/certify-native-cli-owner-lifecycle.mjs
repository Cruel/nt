// #533: exercise a packaged native-only resident owner across a daemon restart,
// then interrupt a generation-pinned disposable command through the public CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCertificationRoot } from './certification-temp-root.mjs';

const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const root = await createCertificationRoot('noveltea-533-owner-');
const project = path.join(root, 'project');
const baseline = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
  NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: '1',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt533-native-${process.pid}`,
  NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'daemon'),
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function execute(args) {
  const response = spawnSync(
    executable,
    ['--json', ...(args[0] === 'daemon' ? [] : ['--project', project]), ...args],
    { env: baseline, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  assert.ifError(response.error);
  assert.ok(response.stdout.trim().startsWith('{'), `${args.join(' ')}: ${response.stderr}`);
  const data = JSON.parse(response.stdout);
  assert.equal(response.status, data.exitCode);
  return data;
}

try {
  await cp(fixture, project, { recursive: true });
  const initial = execute(['platform', 'profiles']);
  assert.equal(initial.success, true, JSON.stringify(initial.diagnostics));
  const warm = execute(['platform', 'profiles']);
  assert.deepEqual(warm, initial);
  const stopped = execute(['daemon', 'stop']);
  assert.equal(stopped.success, true, JSON.stringify(stopped.diagnostics));
  const restarted = execute(['platform', 'profiles']);
  assert.deepEqual(restarted, initial, 'Restarted daemon did not reopen the native Project.');
  console.log('Native-only installed daemon restart and warm scoped Project read PASSED.');

  // Force a real pinned worker; the marker belongs to the disposable, not the
  // resident daemon. Interrupt the public CLI, release the worker and reject
  // any report that silently published a completed run after cancellation.
  const marker = path.join(root, 'cancel-after-snapshot');
  const command = spawn(executable, ['--json', '--project', project, 'test', 'run', 'semantic'], {
    env: { ...baseline, NOVELTEA_CLI_CERTIFICATION_AFTER_SNAPSHOT_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  command.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  command.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve, reject) => {
    command.once('error', reject);
    command.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    let pinned = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (existsSync(marker)) {
        pinned = true;
        break;
      }
      if (command.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(pinned, `Disposable worker did not pin a Project: ${stderr}`);
    assert.equal(command.kill('SIGINT'), true, 'Could not signal the public CLI.');
    for (let attempt = 0; attempt < 50 && !existsSync(`${marker}.cancelled`); attempt++)
      await delay(100);
  } finally {
    await writeFile(`${marker}.release`, 'release');
  }
  const result = await completed;
  assert.notEqual(result.code, 0, `Cancelled request reported success: ${stdout}\n${stderr}`);
  if (stdout.trim().startsWith('{')) {
    const data = JSON.parse(stdout);
    assert.equal(data.success, false);
    assert.notEqual(data.runtimeCache?.published, true);
  }
  console.log('Native-only installed pinned-worker cancellation PASSED.');
} finally {
  const stopped = execute(['daemon', 'stop']);
  assert.equal(stopped.success, true, 'Owner lifecycle test failed to stop its private daemon.');
  await rm(root, { recursive: true, force: true });
}
