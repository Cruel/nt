import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real standalone ScriptC daemon integration, not a Node authoring imitation.
// The native path is certification-only; the exact CLI envelope must continue
// to agree with the no-daemon TypeScript oracle.
const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-validation-'));
const project = path.join(root, 'project');
const environment = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_NATIVE_DISK_VALIDATION: '1',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: 'native-disk-parity-' + process.pid + '-' + Date.now(),
  NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'daemon'),
};
function execute(args) {
  const result = spawnSync(executable, args, {
    env: environment,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function candidate(args) {
  const result = spawnSync(executable, args, {
    env: {
      ...environment,
      NOVELTEA_CLI_CERTIFICATION_NATIVE_DISK_VALIDATION: '0',
      NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `native-validation-candidate-${process.pid}`,
    },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function checkCandidate(args, oracle) {
  const outcome = candidate(args);
  assert.equal(outcome.status, oracle.status, `Native validation exit mismatch: ${outcome.stderr}`);
  const actual = JSON.parse(outcome.stdout);
  const expected = JSON.parse(oracle.stdout);
  assert.equal(actual.success, expected.success);
  const nativeDiagnostics = diagnostics(actual.diagnostics);
  const oracleDiagnostics = diagnostics(expected.diagnostics);
  assert.deepEqual(
    nativeDiagnostics.map(({ line, ...item }) => item),
    oracleDiagnostics.map(({ line, ...item }) => item),
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
function verify(daemon, oracle, expectedWarm) {
  assert.equal(daemon.status, oracle.status, 'Native certification may not alter CLI exit codes');
  assert.deepEqual(JSON.parse(daemon.stdout), JSON.parse(oracle.stdout));
  const rows = daemon.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-disk-validation] '));
  assert.equal(rows.length, 1, 'Expected one native owner diagnostic: ' + daemon.stderr);
  const native = JSON.parse(rows[0].slice('[native-disk-validation] '.length));
  const expected = JSON.parse(oracle.stdout);
  assert.equal(native.warm, expectedWarm);
  assert.equal(native.valid, expected.success);
  assert.equal(native.oracle.success, expected.success);
  assert.equal(native.oracle.exitCode, expected.exitCode);
  assert.deepEqual(diagnostics(native.cliDiagnostics), diagnostics(expected.diagnostics));
  if (expectedWarm) {
    assert.equal(native.work.recheckedRecords, 0);
    assert.ok(native.work.retainedRecords > 0);
  }
  return native;
}
try {
  await cp(fixture, project, { recursive: true });
  const manifest = await readFile(path.join(project, 'project.yaml'));
  const argv = ['--project', project, '--json', 'validate'];
  const oracle = execute(['--no-daemon', ...argv]);
  const cold = execute(argv);
  verify(cold, oracle, false);
  checkCandidate(['--no-daemon', ...argv], oracle);
  checkCandidate(argv, oracle);

  // The broker exact-result cache must reject a disk revision change even
  // without trusting OS watcher delivery; the same owner remains resident.
  const lua = path.join(project, 'scripts/notice-board.lua');
  await writeFile(lua, (await readFile(lua, 'utf8')) + '\n-- native CLI revision proof\n');
  const changedOracle = execute(['--no-daemon', ...argv]);
  const warm = execute(argv);
  verify(warm, changedOracle, true);
  checkCandidate(argv, changedOracle);
  checkCandidate(['--no-daemon', ...argv], changedOracle);
  // Invalid YAML must retain the public workspace exit class and physical
  // source coordinates. Repair must invalidate the previous native result.
  await writeFile(path.join(project, 'project.yaml'), `${manifest.toString()}\ninvalid: [\n`);
  const invalidOracle = execute(['--no-daemon', ...argv]);
  checkCandidate(argv, invalidOracle);
  checkCandidate(['--no-daemon', ...argv], invalidOracle);
  await writeFile(path.join(project, 'project.yaml'), manifest);
  checkCandidate(argv, changedOracle);
  assert.deepEqual(await readFile(path.join(project, 'project.yaml')), manifest);
  console.log('Native disk Project daemon cold/warm and TypeScript CLI parity passed.');
} finally {
  execute(['daemon', 'stop']);
  await rm(root, { recursive: true, force: true });
}
