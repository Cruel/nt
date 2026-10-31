import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Certify the installed native-only CLI's daemon against independent local
// execution and source revisions. Native development builds may additionally
// expose internal exact-result counters; release CLI status is not required
// to expose those engineering diagnostics.
// The retired ScriptC-only [native-disk-validation] stderr witness is not a
// public native CLI contract.
const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const oracleExecutable = path.resolve(process.argv[4] ?? executable);
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-validation-'));
const project = path.join(root, 'project');
// macOS's default per-user TMPDIR can exceed the UNIX sun_path limit once
// the broker adds its daemon identity and .sock suffix. Keep the private
// runtime root short, but preserve an independent unique daemon per run.
const daemonRuntimeRoot =
  process.platform === 'darwin' ? await mkdtemp('/tmp/nt-d-') : path.join(root, 'daemon');
const environment = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: 'native-disk-parity-' + process.pid + '-' + Date.now(),
  NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: daemonRuntimeRoot,
};
const candidateEnvironment = {
  ...environment,
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `native-validation-candidate-${process.pid}`,
};
function describeProcess(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.slice(0, 4096),
    stderr: result.stderr?.slice(0, 4096),
    error: result.error?.message,
  });
}
function execute(args) {
  const result = spawnSync(oracleExecutable, args, {
    env: environment,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status === null)
    throw new Error(
      `Standalone CLI terminated during ${args.join(' ')}: ${describeProcess(result)}`,
    );
  return result;
}
function candidate(args) {
  const result = spawnSync(executable, args, {
    env: candidateEnvironment,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status === null)
    throw new Error(
      `Native CLI candidate terminated during ${args.join(' ')}: ${describeProcess(result)}`,
    );
  return result;
}
function checkCandidate(args, oracle) {
  const outcome = candidate(args);
  assert.equal(
    outcome.status,
    oracle.status,
    `Native validation exit mismatch for ${args.join(' ')}: ${describeProcess(outcome)}`,
  );
  const actual = JSON.parse(outcome.stdout);
  const expected = JSON.parse(oracle.stdout);
  assert.equal(actual.success, expected.success);
  const nativeDiagnostics = diagnostics(actual.diagnostics);
  const oracleDiagnostics = diagnostics(expected.diagnostics);
  assert.deepEqual(
    nativeDiagnostics.map(({ line: _line, ...item }) => item),
    oracleDiagnostics.map(({ line: _line, ...item }) => item),
  );
  for (let index = 0; index < nativeDiagnostics.length; index++) {
    const candidateLine = nativeDiagnostics[index].line;
    const oracleLine = oracleDiagnostics[index].line;
    // libfyaml may report the last nonblank line of an unterminated flow
    // collection while the TS parser reports the following EOF line.
    if (
      nativeDiagnostics[index].code === 'WORKSPACE_MANIFEST_INVALID' &&
      Number.isInteger(candidateLine) &&
      Number.isInteger(oracleLine)
    )
      assert.ok(Math.abs(candidateLine - oracleLine) <= 1);
    else assert.equal(candidateLine, oracleLine);
  }
}
function diagnostics(value) {
  return value
    .map((item) => ({
      code: item.code,
      path: item.path,
      severity: item.severity,
      sourceUrl: item.sourceUrl,
      line: item.line,
      column: item.column,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function verify(daemon, oracle) {
  assert.equal(
    daemon.status,
    oracle.status,
    `Native daemon may not alter CLI exit codes: ${describeProcess(daemon)}`,
  );
  assert.deepEqual(JSON.parse(daemon.stdout), JSON.parse(oracle.stdout));
  assert.equal(daemon.stderr, '', 'Native JSON validation wrote unexpected stderr.');
}
function daemonStatus() {
  const outcome = execute(['--json', 'daemon', 'status']);
  assert.equal(outcome.status, 0, describeProcess(outcome));
  const status = JSON.parse(outcome.stdout).daemon;
  assert.ok(status && typeof status === 'object', outcome.stdout);
  return status;
}
try {
  await cp(fixture, project, { recursive: true });
  const manifest = await readFile(path.join(project, 'project.yaml'));
  const argv = ['--project', project, '--json', 'validate'];
  assert.equal(daemonStatus().running, false);
  const oracle = execute(['--no-daemon', ...argv]);
  const cold = execute(argv);
  verify(cold, oracle);
  const started = daemonStatus();
  assert.equal(started.running, true, 'Validation did not start the native daemon.');
  assert.ok(started.projectSessions >= 1, 'Daemon did not retain the native Project owner.');
  const warm = execute(argv);
  verify(warm, oracle);
  const retained = daemonStatus();
  assert.equal(retained.running, true, 'Repeated validation lost its native daemon.');
  assert.ok(retained.projectSessions >= 1, 'Repeated validation lost its native Project owner.');
  // The full Feature Lab is a correctness fixture, not a promise that its
  // broad physical source inventory is eligible for broker exact-result
  // retention on every host. An unproved generation must safely miss. Check
  // exact-result retention with a small independently created Project if the
  // Feature Lab's conservative source proof declined the optimization.
  if (started.exactValidationResults !== undefined || retained.exactValidationResults !== undefined) {
    if (started.exactValidationResults >= 1) {
      assert.ok(retained.exactValidationResults >= 1, 'The native exact result was lost.');
      if (started.engineeringCounters !== undefined || retained.engineeringCounters !== undefined)
        assert.ok(
          retained.engineeringCounters?.exactResultHits > started.engineeringCounters?.exactResultHits,
          'Repeated unchanged validation did not hit the native exact-result cache.',
        );
    } else {
      const simpleProject = path.join(root, 'exact-result-fixture');
      const created = execute(['--json', 'project', 'create', simpleProject, '--name', 'Exact Result Fixture']);
      assert.equal(created.status, 0, describeProcess(created));
      const smallArgs = ['--project', simpleProject, '--json', 'validate'];
      const smallOracle = execute(['--no-daemon', ...smallArgs]);
      verify(execute(smallArgs), smallOracle);
      const first = daemonStatus();
      verify(execute(smallArgs), smallOracle);
      const second = daemonStatus();
      assert.ok(
        first.exactValidationResults >= 1 && second.exactValidationResults >= 1,
        `A stable small Project did not retain an exact result: ${JSON.stringify({ first, second })}`,
      );
      assert.ok(
        second.engineeringCounters?.exactResultHits > first.engineeringCounters?.exactResultHits,
        `A stable small Project did not reuse its exact result: ${JSON.stringify({ first, second })}`,
      );
    }
  }
  checkCandidate(['--no-daemon', ...argv], oracle);
  checkCandidate(argv, oracle);

  // The broker exact-result cache must reject a disk revision change even
  // without trusting OS watcher delivery; the same owner remains resident.
  const lua = path.join(project, 'scripts/notice-board.lua');
  await writeFile(lua, (await readFile(lua, 'utf8')) + '\n-- native CLI revision proof\n');
  const changedOracle = execute(['--no-daemon', ...argv]);
  const changed = execute(argv);
  verify(changed, changedOracle);
  const changedRepeat = execute(argv);
  verify(changedRepeat, changedOracle);
  checkCandidate(argv, changedOracle);
  checkCandidate(['--no-daemon', ...argv], changedOracle);
  // Invalid YAML must retain the public workspace exit class and physical
  // source coordinates. Repair must invalidate the previous native result.
  await writeFile(path.join(project, 'project.yaml'), `${manifest.toString()}\ninvalid: [\n`);
  const invalidOracle = execute(['--no-daemon', ...argv]);
  verify(execute(argv), invalidOracle);
  checkCandidate(argv, invalidOracle);
  checkCandidate(['--no-daemon', ...argv], invalidOracle);
  await writeFile(path.join(project, 'project.yaml'), manifest);
  verify(execute(argv), changedOracle);
  checkCandidate(argv, changedOracle);
  assert.deepEqual(await readFile(path.join(project, 'project.yaml')), manifest);
  console.log('Native CLI daemon cold/warm validation, cache, and direct-execution parity passed.');
} finally {
  try {
    execute(['daemon', 'stop']);
    // The candidate uses an independent daemon identity.
    candidate(['daemon', 'stop']);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (daemonRuntimeRoot !== path.join(root, 'daemon'))
      await rm(daemonRuntimeRoot, { recursive: true, force: true });
  }
}
