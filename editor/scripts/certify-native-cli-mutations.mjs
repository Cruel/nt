import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

// Real two-root oracle for native commit results. The installed CLI remains
// authoritative; the test-only native certify executable has a direct C ABI
// request seam and never affects the installed command parser.
const cli = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const native = path.resolve(
  process.argv[3] ?? 'build/linux-authoring-release/tools/editor_tool/noveltea-cli-native-certify',
);
const fixture = path.resolve(process.argv[4] ?? 'tests/projects/feature-lab');
const temp = await mkdtemp(path.join(os.tmpdir(), 'nt501-native-mutation-parity-'));
const oracleRoot = path.join(temp, 'oracle');
const nativeRoot = path.join(temp, 'native');
const requestPath = path.join(temp, 'request.json');

const environment = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt501-${process.pid}`,
};
function run(executable, args, input) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: environment,
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function oracle(args, input) {
  const result = run(cli, ['--no-daemon', '--project', oracleRoot, '--json', ...args], input);
  assert.equal(
    result.status,
    0,
    `Oracle ${args.join(' ')} failed: ${result.stdout} ${result.stderr}`,
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.success, true, result.stdout);
  return envelope;
}
async function nativeCommand(action, fields = {}, accepted = true) {
  await writeFile(requestPath, JSON.stringify({ action, projectRoot: nativeRoot, ...fields }));
  const result = run(native, ['--request-file', requestPath]);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, accepted, `Native ${action}: ${result.stdout} ${result.stderr}`);
  return response;
}
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = (root, relative) => readFile(path.join(root, relative));
async function identical(relative) {
  assert.deepEqual(
    await source(nativeRoot, relative),
    await source(oracleRoot, relative),
    `Native mutation changed ${relative} differently from the installed CLI`,
  );
}
async function semanticallyIdenticalYaml(relative) {
  // Native's source-aware writer may choose YAML flow style for an unchanged
  // block sequence. Compare the canonical values and keep comment safety as
  // a separate assertion, rather than demanding byte-for-byte formatting.
  const before = (await source(oracleRoot, relative)).toString('utf8');
  const after = (await source(nativeRoot, relative)).toString('utf8');
  assert.deepEqual(parseYaml(after), parseYaml(before), `Native ${relative} semantics differ`);
  const annotations = (text) =>
    text
      .split('\n')
      .filter((line) => /^\s*#/.test(line))
      .map((line) => line.trim());
  assert.deepEqual(
    annotations(after),
    annotations(before),
    `Native ${relative} lost YAML comments`,
  );
}
async function stage(relative, edit) {
  const next = edit((await source(oracleRoot, relative)).toString('utf8'));
  await writeFile(path.join(oracleRoot, relative), next);
  await writeFile(path.join(nativeRoot, relative), next);
}

try {
  await Promise.all([
    cp(fixture, oracleRoot, { recursive: true }),
    cp(fixture, nativeRoot, { recursive: true }),
  ]);

  // Creation, rename and deletion are actual commits on separate Projects.
  // The new YAML owner and every source path touched by those operations must
  // match; checking only operation plans would miss writer differences.
  if (process.env.NOVELTEA_CERT_ONLY_LOCALIZATION !== '1') {
    const variableId = 'native-parity-created';
    oracle(['entity', 'create', 'variables', variableId]);
    await nativeCommand('entity-create', {
      collection: 'variables',
      id: variableId,
      dryRun: false,
    });
    const created = `records/variables/${variableId}.yaml`;
    await identical(created);
    const renamedId = 'native-parity-renamed';
    const renamed = `records/variables/${renamedId}.yaml`;
    oracle(['entity', 'rename', 'variables', variableId, renamedId]);
    await nativeCommand('entity-rename', {
      collection: 'variables',
      id: variableId,
      toId: renamedId,
      dryRun: false,
      sourceRevision: sha(await source(nativeRoot, created)),
    });
    await identical(renamed);
    oracle(['entity', 'delete', 'variables', renamedId]);
    await nativeCommand('entity-delete', {
      collection: 'variables',
      id: renamedId,
      dryRun: false,
      sourceRevision: sha(await source(nativeRoot, renamed)),
    });
    for (const root of [oracleRoot, nativeRoot]) {
      await assert.rejects(source(root, created), { code: 'ENOENT' });
      await assert.rejects(source(root, renamed), { code: 'ENOENT' });
    }

    // Change formatting without changing Project semantics or source comments.
    await stage('project.yaml', (s) => {
      assert.ok(s.includes('name: Feature Lab'));
      return s.replace('name: Feature Lab', 'name:   Feature Lab');
    });
    oracle(['fmt', 'project.yaml']);
    await nativeCommand('fmt', {
      path: 'project.yaml',
      check: false,
      diskPreconditions: { 'project.yaml': sha(await source(nativeRoot, 'project.yaml')) },
    });
    await identical('project.yaml');
  }

  // Managed Lua input is a read dependency, not the YAML file being written.
  const scene = 'records/scenes/localized-story.yaml';
  const anchor =
    "assert(noveltea.layouts.mount('language-board', 'language-board', {owner='session'}))";
  const addMessage = (text) => (s) => {
    assert.ok(s.includes(anchor));
    return s.replace(anchor, `${anchor}; noveltea.notify(Text.tr('${text}'))`);
  };
  await stage(scene, addMessage('Native two-root sync parity'));
  const sync = await nativeCommand('localization-sync', { dryRun: true });
  assert.equal(sync.changed, true);
  oracle(['localization', 'sync']);
  await nativeCommand('localization-sync', {
    dryRun: false,
    sourceRevision: sha(await source(nativeRoot, 'i18n/tracking.yaml')),
    expectedSourceGeneration: sync.sourceGeneration,
  });
  await semanticallyIdenticalYaml('i18n/tracking.yaml');

  if (process.env.NOVELTEA_CERT_ONLY_LOCALIZATION !== '1') {
    await stage(scene, addMessage('Native two-root reconcile parity'));
    const oraclePlan = oracle(['localization', 'reconcile']).plan;
    const reconcile = await nativeCommand('localization-reconcile', {
      workspaceRevision: oraclePlan.expectedWorkspaceRevision,
      dryRun: true,
    });
    assert.deepEqual(reconcile.plan, oraclePlan);
    const input = {
      expectedWorkspaceRevision: oraclePlan.expectedWorkspaceRevision,
      expectedFingerprint: oraclePlan.expectedFingerprint,
      resolutions: {},
    };
    oracle(['localization', 'reconcile', '--apply'], input);
    const affected = ['i18n/tracking.yaml', 'i18n/orphans.yaml'];
    await nativeCommand('localization-reconcile', {
      ...input,
      workspaceRevision: input.expectedWorkspaceRevision,
      expectedSourceGeneration: reconcile.sourceGeneration,
      diskPreconditions: Object.fromEntries(
        await Promise.all(
          affected.map(async (name) => [name, sha(await source(nativeRoot, name))]),
        ),
      ),
      dryRun: false,
    });
    for (const relative of affected) await semanticallyIdenticalYaml(relative);

    // Review is an actual translated-locale write; source identity and content
    // are guarded separately from the locale YAML revision.
    const messageId = '25700000-0000-4000-8000-000000000002';
    const inspection = await nativeCommand('localization-targets', {
      locale: 'ja',
      operation: 'inspect',
      messageIds: [messageId],
    });
    oracle(['localization', 'review', 'ja', messageId]);
    await nativeCommand('localization-targets', {
      locale: 'ja',
      operation: 'review',
      messageIds: [messageId],
      dryRun: false,
      expectedSourceGeneration: inspection.sourceGeneration,
      sourceRevision: sha(await source(nativeRoot, 'i18n/locales/ja.yaml')),
    });
    await identical('i18n/locales/ja.yaml');
  }
  console.log(
    'Native CLI commits match installed-headless create/rename/delete/fmt/sync/reconcile/review.',
  );
} finally {
  if (process.env.NOVELTEA_CERT_KEEP_FAILURE !== '1')
    await rm(temp, { recursive: true, force: true });
  else console.error('Native mutation parity Project copies:', temp);
}
