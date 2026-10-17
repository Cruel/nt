import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function verifySync() {
  const argv = ['--project', project, '--json', 'localization', 'sync', '--dry-run'];
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const rows = actual.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-localization-sync] '));
  assert.equal(rows.length, 1, 'Expected one native localization observation: ' + actual.stderr);
  const observed = JSON.parse(rows[0].slice('[native-cli-localization-sync] '.length));
  assert.equal(observed.native.ok, true, observed.native.error);
  const expected = JSON.parse(oracle.stdout);
  for (const key of [
    'changed',
    'materializedMessageIds',
    'preservedMessageIds',
    'unresolved',
    'structuredMessageCount',
  ])
    assert.deepEqual(
      observed.native[key],
      expected[key],
      `Native localization sync differs at ${key}`,
    );
  return observed.native;
}

try {
  await cp(fixture, project, { recursive: true });
  inspect('rooms', 'room-lifecycle-roundtrip', true);
  inspect('characters', 'studio-guide', true);
  inspect('rooms', 'room-lifecycle-roundtrip', false);
  assert.equal(verifySync().changed, false);
  const outputPath = path.join(root, 'oracle.ntproject');
  const bundle = execute([
    '--project',
    project,
    '--json',
    'project',
    'export',
    '--output',
    outputPath,
  ]);
  assert.equal(bundle.status, 0, bundle.stderr);
  const observations = bundle.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-bundle] '));
  assert.equal(
    observations.length,
    1,
    'Expected native archive parity observation: ' + bundle.stderr,
  );
  const result = JSON.parse(observations[0].slice('[native-cli-bundle] '.length));
  assert.equal(result.exported.ok, true);
  assert.equal(result.imported.ok, true);
  assert.deepEqual(result.exported.manifest, result.imported.manifest);
  assert.deepEqual(await readFile(result.nativeOutput), await readFile(outputPath));
  assert.deepEqual(
    await readFile(path.join(result.nativeDestination, 'project.yaml')),
    await readFile(path.join(project, 'project.yaml')),
  );
  const scenePath = path.join(project, 'records/scenes/localized-story.yaml');
  const original = await readFile(scenePath, 'utf8');
  const anchor =
    "assert(noveltea.layouts.mount('language-board', 'language-board', {owner='session'}))";
  assert.equal(original.split(anchor).length, 2, 'Expected exact Fixture managed Lua anchor');
  await writeFile(
    scenePath,
    original.replace(
      anchor,
      `${anchor}; noveltea.notify(Text.tr('Native sync parity new marker'))`,
    ),
  );
  assert.equal(verifySync().changed, true);
  console.log('Native CLI inspect/provenance and installed-headless oracle parity passed.');
} finally {
  execute(['daemon', 'stop']);
  await rm(root, { recursive: true, force: true });
}
