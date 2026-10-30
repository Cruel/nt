import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCertificationRoot } from './certification-temp-root.mjs';

// Real installed-headless Project-owner daemon vs no-daemon CLI oracle.
// Certification must not affect public JSON, stderr diagnostics or exit codes.
const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const root = await createCertificationRoot('noveltea-native-cli-commands-');
const project = path.join(root, 'project');
// Host smoke can target the exact first installed inspect witness without
// paying for the subsequent complete Feature Lab differential suite.
const firstInspectOnly = process.env.NOVELTEA_CLI_INSPECT_FIRST_ONLY === '1';
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
  if (result.error || result.status === null)
    throw new Error(
      `Installed CLI terminated during ${args.join(' ')}: ${JSON.stringify({
        error: result.error?.message,
        signal: result.signal,
        status: result.status,
        stderr: result.stderr?.slice(0, 4096),
        stdout: result.stdout?.slice(0, 4096),
      })}`,
      { cause: result.error },
    );
  return result;
}

// The native-only CLI no longer emits ScriptC's private [native-cli-*] stderr
// witnesses. Certify its actual public result on both the resident daemon and
// direct execution paths, then assert each command's semantic contract.
function comparePublic(argv) {
  const oracle = execute(['--no-daemon', ...argv]);
  const actual = execute(argv);
  assert.equal(actual.status, oracle.status, `CLI exit mismatch: ${argv.join(' ')}`);
  assert.equal(actual.stderr, oracle.stderr, `CLI stderr mismatch: ${argv.join(' ')}`);
  const expected = JSON.parse(oracle.stdout);
  const result = JSON.parse(actual.stdout);
  assert.deepEqual(result, expected, `CLI JSON mismatch: ${argv.join(' ')}`);
  assert.equal(result.success, true, `CLI command failed: ${argv.join(' ')}`);
  assert.equal(result.exitCode, 0);
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
  const result = comparePublic(argv);
  assert.equal(result.collection, collection);
  assert.equal(result.id, id);
  assert.equal(result.record?.id, id, 'Native inspection omitted the requested record.');
  if (provenance) assert.ok(result.provenance && typeof result.provenance === 'object');
  else assert.equal(Object.hasOwn(result, 'provenance'), false);
}

function verifyUsages(collection, id) {
  const argv = ['--project', project, '--json', 'usages', collection, id];
  const result = comparePublic(argv);
  assert.equal(result.collection, collection);
  assert.equal(result.id, id);
  assert.ok(Array.isArray(result.usages), 'Native usages omitted the reference graph.');
  for (const usage of result.usages) {
    assert.equal(typeof usage.edgeId, 'string');
    assert.equal(typeof usage.sourcePath, 'string');
  }
}

function verifySync() {
  const argv = ['--project', project, '--json', 'localization', 'sync', '--dry-run'];
  const result = comparePublic(argv);
  assert.equal(result.dryRun, true);
  assert.equal(typeof result.changed, 'boolean');
  assert.ok(Array.isArray(result.materializedMessageIds));
  assert.ok(Array.isArray(result.preservedMessageIds));
  assert.ok(Array.isArray(result.unresolved));
  assert.ok(Number.isInteger(result.structuredMessageCount));
  return result;
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
  const result = comparePublic(argv);
  assert.equal(result.locale, 'fr');
  assert.ok(Array.isArray(result.messages), 'Native localization view omitted its messages.');
  if (status) {
    assert.ok(
      result.messages.every(
        (message) =>
          message.status === status || (status === 'attention' && message.attention?.length > 0),
      ),
    );
  }
}

function verifyReconcile() {
  const argv = ['--project', project, '--json', 'localization', 'reconcile'];
  const result = comparePublic(argv);
  assert.ok(result.plan && Array.isArray(result.plan.groups));
  assert.ok(Array.isArray(result.writes));
  return result.plan;
}

function verifyEntityDryRun(collection, id, operation) {
  const argv = ['--project', project, '--json', 'entity', operation, collection, id, '--dry-run'];
  const result = comparePublic(argv);
  assert.equal(result.collection, collection);
  assert.equal(result.id, id);
  assert.equal(result.dryRun, true);
  assert.ok(result.plan && Array.isArray(result.plan.writes));
  if (operation === 'create') {
    const expectedPaths =
      collection === 'layouts'
        ? ['layout.lua', 'layout.rcss', 'layout.rml', 'layout.yaml'].map(
            (name) => `records/layouts/${id}/${name}`,
          )
        : [`records/${collection}/${id}.yaml`];
    assert.deepEqual(result.plan.writes, expectedPaths);
  }
}

function verifyFormatCheck(relative) {
  const args = ['--project', project, '--json', 'fmt', relative, '--check'];
  const result = comparePublic(args);
  assert.equal(result.check, true);
  assert.ok(Array.isArray(result.files));
  assert.ok(Number.isInteger(result.changed));
}

try {
  await cp(fixture, project, { recursive: true });
  inspect('rooms', 'room-lifecycle-roundtrip', true);
  if (!firstInspectOnly) {
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
    // Differential regression: Project-level fallback Text and effective
    // instance Archetype overrides must be part of the native Message view.
    const manifestFile = path.join(project, 'project.yaml');
    const originalManifest = await readFile(manifestFile, 'utf8');
    const fallbackBefore =
      'undefinedInteractionProgram:\n  instructions: []\n  completion:\n    kind: return\n  outcome: unhandled';
    const fallbackAfter =
      'undefinedInteractionProgram:\n  instructions:\n    - id: native-review-fallback\n' +
      '      kind: notify\n      message:\n        source:\n          kind: inline\n' +
      '          text: Native Project fallback Message\n        markup: plain\n' +
      '  completion:\n    kind: return\n  outcome: handled';
    assert.ok(originalManifest.includes(fallbackBefore));
    const instanceFile = path.join(
      project,
      'records/interactables/lab-archetype-instance-definition.yaml',
    );
    const originalInstance = await readFile(instanceFile, 'utf8');
    assert.ok(originalInstance.includes('archetypeOverrides: {}'));
    await writeFile(manifestFile, originalManifest.replace(fallbackBefore, fallbackAfter));
    await writeFile(
      instanceFile,
      originalInstance.replace(
        'archetypeOverrides: {}',
        'archetypeOverrides:\n  /data/displayName: Native Archetype instance override',
      ),
    );
    verifyLocalizationView();
    await writeFile(manifestFile, originalManifest);
    await writeFile(instanceFile, originalInstance);
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
    assert.equal(JSON.parse(bundle.stdout).success, true);
    const exportedBytes = await readFile(outputPath);
    assert.ok(exportedBytes.length > 100, 'Native Project archive is unexpectedly empty.');
    assert.equal(exportedBytes.subarray(0, 4).toString('hex'), '504b0304');
    const directOutput = path.join(root, 'direct.ntproject');
    const directBundle = execute([
      '--no-daemon',
      '--project',
      project,
      '--json',
      'project',
      'export',
      '--output',
      directOutput,
    ]);
    assert.equal(directBundle.status, 0, directBundle.stderr);
    assert.equal(JSON.parse(directBundle.stdout).success, true);
    assert.deepEqual(
      exportedBytes,
      await readFile(directOutput),
      'Native daemon and direct Project archives differ.',
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
  }
  console.log(
    firstInspectOnly
      ? 'Native CLI first inspect/provenance parity passed.'
      : 'Native CLI inspect/provenance and installed-headless oracle parity passed.',
  );
} finally {
  execute(['daemon', 'stop']);
  await rm(root, { recursive: true, force: true });
}
