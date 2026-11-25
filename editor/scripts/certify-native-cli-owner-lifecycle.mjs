// #533: exercise a packaged native-only resident owner across a daemon restart,
// then interrupt a generation-pinned disposable command through the public CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCertificationRoot } from './certification-temp-root.mjs';
import { isolatedProductionEnvironment } from './native-production-qualification.mjs';

const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const root = await createCertificationRoot('noveltea-533-owner-');
const project = path.join(root, 'project');
const independentMode = process.argv[4] === '--candidate' || process.argv[4] === '--production';
if (process.argv.length > 5 || (process.argv[4] && !independentMode))
  throw new Error(
    'Usage: certify-native-cli-owner-lifecycle.mjs [cli] [fixture] [--candidate|--production]',
  );
const baseline = independentMode
  ? isolatedProductionEnvironment(process.env, path.join(root, 'home'))
  : {
      ...process.env,
      NOVELTEA_CLI_CERTIFICATION: '1',
      NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
      NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: '1',
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt533-native-${process.pid}`,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'daemon'),
    };
const pinnedEnvironment = {
  ...baseline,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'certification-daemon'),
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function execute(args, env = baseline) {
  const response = spawnSync(
    executable,
    ['--json', ...(args[0] === 'daemon' ? [] : ['--project', project]), ...args],
    {
      env,
      encoding: 'utf8',
      timeout: args[0] === 'daemon' && args[1] === 'status' ? 5000 : 180_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.ifError(response.error);
  assert.ok(response.stdout.trim().startsWith('{'), `${args.join(' ')}: ${response.stderr}`);
  const data = JSON.parse(response.stdout);
  assert.equal(response.status, data.exitCode);
  return data;
}

function residentStatus(env = baseline) {
  const status = execute(['daemon', 'status'], env);
  assert.equal(status.success, true, JSON.stringify(status.diagnostics));
  assert.equal(status.daemon.running, true, 'Project read did not start a resident daemon.');
  assert.equal(status.daemon.state, 'ready');
  assert.ok(status.daemon.projectSessions >= 1, 'Project read did not admit a resident owner.');
  return status.daemon;
}

try {
  if (independentMode)
    await import('node:fs/promises').then(({ mkdir }) =>
      mkdir(path.join(root, 'home/runtime'), { recursive: true, mode: 0o700 }),
    );
  await cp(fixture, project, { recursive: true });
  // platform profiles is a local read, not a resident owner command.
  const initial = execute(['validate']);
  assert.equal(initial.success, true, JSON.stringify(initial.diagnostics));
  const firstOwner = residentStatus();
  const warm = execute(['validate']);
  assert.deepEqual(warm, initial);
  assert.equal(residentStatus().pid, firstOwner.pid);
  const stopped = execute(['daemon', 'stop']);
  assert.equal(stopped.success, true, JSON.stringify(stopped.diagnostics));
  assert.equal(execute(['daemon', 'status']).daemon.running, false);
  const restarted = execute(['validate']);
  assert.deepEqual(restarted, initial, 'Restarted daemon did not reopen the native Project.');
  const restartedOwner = residentStatus();
  console.log('Native-only installed daemon restart and warm scoped Project read PASSED.');

  // The cancellation exercise intentionally uses its own isolated broker root.
  // Establish that broker's Project owner before starting the pinned-worker
  // timer. Warming only the baseline broker leaves this one cold on Windows
  // and confounds broker/owner startup time with worker pinning.
  assert.equal(
    execute(['daemon', 'status'], pinnedEnvironment).daemon.running,
    false,
    'Certification runtime root is not isolated from the resident daemon.',
  );
  const pinnedWarm = execute(['validate'], pinnedEnvironment);
  assert.deepEqual(pinnedWarm, initial, 'Pinned broker failed its own warm Project admission.');
  const pinnedOwner = residentStatus(pinnedEnvironment);
  assert.notEqual(
    pinnedOwner.pid,
    restartedOwner.pid,
    'Pinned broker reused the baseline endpoint.',
  );

  // Force a real pinned worker; the marker belongs to the disposable, not the
  // resident daemon. Interrupt the public CLI, release the worker and reject
  // any report that silently published a completed run after cancellation.
  const marker = path.join(root, 'cancel-after-snapshot');
  const command = spawn(
    executable,
    ['--json', '--project', project, 'shaders', 'compile', '--variant', 'glsl-330'],
    {
      // The instrumentation gate only enables the snapshot interlock. The
      // installed native-only island has no alternate Project authority.
      env: { ...pinnedEnvironment, NOVELTEA_CLI_CERTIFICATION_PINNED_BARRIER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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
    const started = performance.now();
    const transitions = [];
    let nextStatus = 5000;
    while (performance.now() - started < 30_000) {
      if (existsSync(`${marker}.ready`)) {
        pinned = true;
        break;
      }
      if (command.exitCode !== null || command.signalCode !== null) break;
      const elapsed = performance.now() - started;
      if (elapsed >= nextStatus) {
        const sample = spawnSync(executable, ['--json', 'daemon', 'status'], {
          env: pinnedEnvironment,
          encoding: 'utf8',
          timeout: 1000,
        });
        transitions.push({
          elapsedMs: Math.round(elapsed),
          status: sample.stdout?.trim() || sample.stderr?.trim() || sample.error?.message,
        });
        nextStatus = elapsed + 5000;
      }
      await delay(100);
    }
    if (!pinned) {
      const status = spawnSync(executable, ['--json', 'daemon', 'status'], {
        env: pinnedEnvironment,
        encoding: 'utf8',
        timeout: 10_000,
      });
      throw new Error(
        `Disposable worker did not pin a Project (exit ${command.exitCode}, signal ${command.signalCode}).` +
          `\nCLI stdout: ${stdout}\nCLI stderr: ${stderr}` +
          `\nDaemon transitions: ${JSON.stringify(transitions)}` +
          `\nDaemon status: ${status.stdout || status.stderr || status.error?.message || '(no response)'}`,
      );
    }
    const pinnedStatus = residentStatus(pinnedEnvironment);
    assert.ok(
      pinnedStatus.engineeringCounters.snapshotPublications >
        pinnedOwner.engineeringCounters.snapshotPublications &&
        pinnedStatus.engineeringCounters.snapshotHandoffs >
          pinnedOwner.engineeringCounters.snapshotHandoffs,
      'Barrier was not reached through a published and handed-off Project snapshot.',
    );
    assert.ok(pinnedStatus.disposableBusyWorkers >= 1, 'Pinned worker is not busy.');
    console.log(`Pinned disposable worker ready in ${Math.round(performance.now() - started)} ms.`);
    assert.equal(command.kill('SIGINT'), true, 'Could not signal the public CLI.');
    await delay(200);
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
  try {
    const pinnedStopped = execute(['daemon', 'stop'], pinnedEnvironment);
    assert.equal(
      pinnedStopped.success,
      true,
      'Owner lifecycle test failed to stop its pinned daemon.',
    );
  } finally {
    const stopped = execute(['daemon', 'stop']);
    assert.equal(stopped.success, true, 'Owner lifecycle test failed to stop its private daemon.');
    // Daemon shutdown can race with removal of its runtime files on Linux.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}
