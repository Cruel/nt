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

function verifyUsages(collection, id) {
  const argv = ['--project', project, '--json', 'usages', collection, id];
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const observations = actual.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-usages] '));
  assert.equal(observations.length, 1, 'Missing native usages observation: ' + actual.stderr);
  const observed = JSON.parse(observations[0].slice('[native-cli-usages] '.length));
  assert.equal(observed.native.ok, true, observed.native.error);
  assert.deepEqual(observed.native.usages, observed.oracle);
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

function verifyLocalizationView(status) {
  const argv = [
    '--project',
    project,
    '--json',
    'localization',
    'view',
    'fr',
    ...(status ? ['--status', status] : []),
  ];
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const rows = actual.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-localization-view] '));
  assert.equal(rows.length, 1, 'Expected native localization view: ' + actual.stderr);
  const observed = JSON.parse(rows[0].slice('[native-cli-localization-view] '.length));
  assert.equal(observed.native.ok, true, observed.native.error);
  assert.equal(observed.native.locale, observed.oracle.locale);
  assert.deepEqual(observed.native.messages, observed.oracle.messages);
  assert.equal(observed.native.statusFilter, observed.oracle.statusFilter);
}

function verifyReconcile() {
  const argv = ['--project', project, '--json', 'localization', 'reconcile'];
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const rows = actual.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-reconcile] '));
  assert.equal(rows.length, 1, 'Expected one native reconcile observation: ' + actual.stderr);
  const observed = JSON.parse(rows[0].slice('[native-cli-reconcile] '.length));
  assert.equal(observed.native.ok, true, observed.native.error);
  assert.deepEqual(observed.native.plan, observed.oracle);
  return observed.native.plan;
}

function verifyEntityDryRun(collection, id, operation) {
  const argv = ['--project', project, '--json', 'entity', operation, collection, id, '--dry-run'];
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const observations = actual.stderr
    .split('\n')
    .filter((line) => line.startsWith('[native-cli-entity-edit] '));
  assert.equal(observations.length, 1, 'Expected native dry-run observation: ' + actual.stderr);
  const observed = JSON.parse(observations[0].slice('[native-cli-entity-edit] '.length));
  assert.equal(observed.native.ok, true, observed.native.error);
  assert.equal(observed.native.collection, collection);
  assert.equal(observed.native.id, id);
  assert.equal(observed.native.dryRun, true);
  if (operation === 'create') {
    const expectedPaths =
      collection === 'layouts'
        ? ['layout.lua', 'layout.rcss', 'layout.rml', 'layout.yaml'].map(
            (name) => `records/layouts/${id}/${name}`,
          )
        : [observed.native.sourcePath];
    assert.deepEqual(observed.oracle.plan.writes, expectedPaths);
  }
}

function verifyFormatCheck(relative) {
  const args = ['--project', project, '--json', 'fmt', relative, '--check'];
  const oracle = execute(['--no-daemon', ...args]);
  const actual = execute(args);
  assert.equal(actual.status, oracle.status);
  assert.deepEqual(JSON.parse(actual.stdout), JSON.parse(oracle.stdout));
  const observed = actual.stderr.split('\n').filter((line) => line.startsWith('[native-cli-fmt] '));
  assert.equal(observed.length, 1, 'Expected native fmt check observation: ' + actual.stderr);
  const native = JSON.parse(observed[0].slice('[native-cli-fmt] '.length)).native;
  assert.equal(native.ok, true, native.error);
  const expected = JSON.parse(oracle.stdout);
  assert.deepEqual(native.files, expected.files);
  assert.equal(native.changed, expected.changed > 0);
}

try {
  await cp(fixture, project, { recursive: true });
  inspect('rooms', 'room-lifecycle-roundtrip', true);
  inspect('characters', 'studio-guide', true);
  inspect('rooms', 'room-lifecycle-roundtrip', false);
  verifyUsages('rooms', 'room-lifecycle-roundtrip');
  verifyUsages('materials', 'engine2d-draw-contract');
  verifyUsages('variables', 'world-composition-enabled');
  verifyUsages('assets', 'pilot-room-backdrop');
  verifyUsages('animations', 'custom-board-loop');
  verifyEntityDryRun('variables', 'native-ci-parity-var', 'create');
  verifyEntityDryRun('layouts', 'native-ci-parity-layout', 'create');
  verifyFormatCheck('project.yaml');
  verifyLocalizationView();
  verifyLocalizationView('current');
  verifyLocalizationView('attention');
  // A valid translation may acknowledge an older presentation/guidance
  // generation without changing its semantic source fingerprint. Both native
  // and installed-headless views must surface the same independent attention.
  const frSource = path.join(project, 'i18n/locales/fr.yaml');
  const fr = await readFile(frSource, 'utf8');
  assert.ok(fr.includes('  origin: ai\n'), 'Expected Feature Lab locale entry');
  await writeFile(
    frSource,
    fr.replace(
      '  origin: ai\n',
      '  acknowledgedPresentationFingerprint: fnv1a:00000000000000000000000000000000\n' +
        '  acknowledgedGuidanceFingerprint: fnv1a:00000000000000000000000000000000\n' +
        '  origin: ai\n',
    ),
  );
  verifyLocalizationView();
  verifyLocalizationView('attention');
  const noteSource = path.join(project, 'i18n/usage-notes.yaml');
  await writeFile(
    noteSource,
    '"structured:/rooms/feature-lab-home/data/description/source": "Named usage note"\n',
  );
  verifyLocalizationView();
  const localMessageId = '88888888-8888-4888-8888-888888888888';
  const messagesSource = path.join(project, 'i18n/messages.yaml');
  const messages = await readFile(messagesSource, 'utf8');
  assert.ok(messages.includes('structuredMessageIds: {}'));
  await writeFile(
    messagesSource,
    messages.replace(
      'structuredMessageIds: {}',
      `  ${localMessageId}:\n    kind: local\n    source: Local Message with usage note\nstructuredMessageIds: {}`,
    ),
  );
  await writeFile(
    noteSource,
    '"structured:/rooms/feature-lab-home/data/description/source": "Named usage note"\n' +
      `${localMessageId}: Local usage note\n`,
  );
  verifyLocalizationView();
  assert.equal(verifySync().changed, false);
  assert.deepEqual(verifyReconcile().groups, []);
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
  // Read-only views expose new ephemeral Message identities before the
  // explicit localization sync has materialized tracking for this Lua source.
  verifyLocalizationView();
  assert.equal(verifySync().changed, true);
  const reconcile = verifyReconcile();
  assert.equal(reconcile.deterministicChanged, true);
  console.log('Native CLI inspect/provenance and installed-headless oracle parity passed.');
} finally {
  execute(['daemon', 'stop']);
  await rm(root, { recursive: true, force: true });
}
