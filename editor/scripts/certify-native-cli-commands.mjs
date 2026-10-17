import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Real installed-headless Project-owner daemon vs no-daemon CLI oracle.
// Certification must not affect public JSON, stderr diagnostics or exit codes.
const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-commands-'));
const project = path.join(root, 'project');
const environment = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_NATIVE_COMMANDS: '1',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: 'native-cli-commands-' + process.pid + '-' + Date.now(),
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

function inspect(collection, id, provenance) {
  const argv = [
    '--project',
    project,
    '--json',
    'entity',
    'inspect',
    collection,
    id,
    ...(provenance ? ['--provenance'] : []),
  ];
  const oracle = execute(['--no-daemon', ...argv]);
  const result = execute(argv);
  assert.equal(result.status, oracle.status, 'Native certification changed CLI exit status');
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(oracle.stdout));
  const observations = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-inspect] '));
  assert.equal(observations.length, 1, 'Expected native inspection observation: ' + result.stderr);
  const observed = JSON.parse(observations[0].slice('[native-cli-inspect] '.length));
  const expected = JSON.parse(oracle.stdout);
  assert.equal(observed.native.ok, true, observed.native.error);
  assert.deepEqual(observed.native.fields.record, expected.record);
  assert.equal(observed.native.fields.collection, collection);
  assert.equal(observed.native.fields.id, id);
  if (provenance) assert.deepEqual(observed.native.fields.provenance, expected.provenance);
  else assert.equal(Object.hasOwn(observed.native.fields, 'provenance'), false);
}

try {
  await cp(fixture, project, { recursive: true });
  inspect('rooms', 'room-lifecycle-roundtrip', true);
  inspect('characters', 'studio-guide', true);
  inspect('rooms', 'room-lifecycle-roundtrip', false);
  console.log('Native CLI inspect/provenance and installed-headless oracle parity passed.');
} finally {
  execute(['daemon', 'stop']);
  await rm(root, { recursive: true, force: true });
}
