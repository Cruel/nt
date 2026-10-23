// #519: installed transport/error evidence, rather than only semantic success.
// Distinct disposable Projects and broker roots make accidental shared authority
// or one side's cache satisfying the other side observable.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCertificationRoot } from './certification-temp-root.mjs';
const executable = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
if (process.argv.length > 3)
  throw new Error('The transport/error contract uses its own disposable minimal Project.');
const root = await createCertificationRoot('noveltea-519-transport-');
const oracle = path.join(root, 'oracle');
const candidate = path.join(root, 'candidate');
const base = { ...process.env, NOVELTEA_CLI_CERTIFICATION: '1' };

function execute(project, native, args, { daemon = false, human = false, environment = {} } = {}) {
  const result = spawnSync(
    executable,
    [
      ...(daemon ? [] : ['--no-daemon']),
      ...(human ? [] : ['--json']),
      ...(project ? ['--project', project] : []),
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...base,
        NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: native ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt519-${process.pid}-${native ? 'native' : 'oracle'}`,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
          root,
          native ? 'native-daemon' : 'oracle-daemon',
        ),
        ...environment,
      },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  if (!human) {
    assert.equal(result.stderr, '', `--json stderr must be empty: ${args.join(' ')}`);
    assert.ok(
      result.stdout.trim().startsWith('{'),
      `Missing JSON: ${args.join(' ')}; native=${native}; daemon=${daemon}; status=${result.status}; signal=${result.signal}; stdout=${JSON.stringify(result.stdout)}; stderr=${JSON.stringify(result.stderr)}`,
    );
    const data = JSON.parse(result.stdout);
    assert.equal(result.status, data.exitCode, `Exit mismatch: ${result.stdout}`);
    assert.equal(typeof data.success, 'boolean');
    assert.ok(Array.isArray(data.diagnostics));
    assert.equal(data.protocolVersion, 1);
    // JSON.parse of the *complete* stdout also rejects duplicate JSON
    // completions, banners and progress messages interspersed with JSON.
    return { data, status: result.status };
  }
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout || result.stderr, `No human output: ${args.join(' ')}`);
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function projection(value) {
  const replace = (text) =>
    [oracle, candidate].reduce(
      (current, root) =>
        current.replaceAll(root, '<project>').replaceAll(root.replaceAll('\\', '/'), '<project>'),
      text,
    );
  return {
    success: value.success,
    exitCode: value.exitCode,
    diagnostics: value.diagnostics
      .map(({ code, severity, path: pointer }) => ({ code, severity, path: replace(pointer) }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

let cases = 0;
function compare(args, options = {}) {
  const expected = execute(oracle, false, args, options);
  const actual = execute(candidate, true, args, options);
  assert.deepEqual(
    projection(actual.data),
    projection(expected.data),
    `Transport/exit category mismatch: ${args.join(' ')}`,
  );
  assert.ok(
    !actual.data.diagnostics.some(({ code }) => code === 'CLI_NATIVE_CANDIDATE_UNCLAIMED'),
    `Unclaimed Project authoring handler: ${args.join(' ')}`,
  );
  cases += 1;
  console.log(`  ${options.daemon ? 'daemon' : 'local'}: ${args.join(' ')}`);
  return actual.data;
}

try {
  // A minimal real Project keeps transport/error certification independent of
  // Feature Lab's expensive whole-Project daemon admission and shader graph.
  for (const [project, native] of [
    [oracle, false],
    [candidate, true],
  ]) {
    const create = execute(null, native, [
      'project',
      'create',
      project,
      '--name',
      'Transport Parity',
    ]);
    assert.equal(create.data.success, true, JSON.stringify(create.data.diagnostics));
    const room = execute(project, native, ['entity', 'create', 'rooms', 'sample']);
    assert.equal(room.data.success, true, JSON.stringify(room.data.diagnostics));
  }
  // Usage and semantic failures must remain distinct in both installed hosts.
  for (const args of [
    ['validate', '--unknown'],
    ['entity', 'inspect', 'rooms'],
    ['entity', 'create', 'rooms'],
    ['entity', 'inspect', 'no-such-collection', 'id'],
    ['entity', 'inspect', 'rooms', 'absent'],
    ['localization', 'view'],
    ['localization', 'accept', 'fr'],
    ['fmt', '--unknown'],
    ['shaders', 'compile', '--variant', 'unsupported'],
    ['platform', 'export', '--profile', 'not-a-profile', '--check'],
    ['package', 'export'],
  ]) {
    const result = compare(args);
    assert.equal(result.success, false, `${args.join(' ')} unexpectedly passed.`);
  }
  for (const args of [
    ['entity', 'inspect', 'rooms', 'sample'],
    ['usages', 'rooms', 'sample'],
  ]) {
    compare(args);
    compare(args, { daemon: true });
    compare(args, { daemon: true, environment: { NOVELTEA_NO_DAEMON: '1' } });
  }
  for (const project of [oracle, candidate]) {
    const source = path.join(project, 'records/rooms/sample.yaml');
    await writeFile(source, `${await readFile(source, 'utf8')}\nmalformed: [\n`);
  }
  for (const daemon of [false, true]) {
    assert.equal(compare(['validate'], { daemon }).success, false);
    assert.equal(compare(['entity', 'inspect', 'rooms', 'sample'], { daemon }).success, false);
  }
  // Negative admission must not accidentally use a coherent cached Project
  // after the required malformed Room is repaired and the manifest itself
  // changes. Exercise the fixed owner through both the local and resident paths.
  for (const project of [oracle, candidate]) {
    const room = path.join(project, 'records/rooms/sample.yaml');
    const roomText = await readFile(room, 'utf8');
    await writeFile(room, roomText.replace(/\nmalformed: \[\n$/u, '\n'));
    const manifest = path.join(project, 'project.yaml');
    const original = await readFile(manifest, 'utf8');
    assert.match(original, /^schemaVersion: 1$/mu);
    await writeFile(manifest, original.replace(/^schemaVersion: 1$/mu, 'schemaVersion: 999'));
  }
  for (const daemon of [false, true]) {
    const invalid = compare(['validate'], { daemon });
    assert.equal(invalid.success, false, 'Unsupported Project schema was accepted.');
    assert.ok(invalid.diagnostics.length > 0, 'Unsupported Project schema had no diagnostic.');
    assert.equal(compare(['entity', 'inspect', 'rooms', 'sample'], { daemon }).success, false);
    assert.equal(compare(['platform', 'profiles'], { daemon }).success, false);
  }
  const human = execute(null, true, ['--help'], { human: true });
  assert.match(human.stdout, /NovelTea headless CLI/);
  const wrongGlobals = execute(null, true, ['--not-a-global-option']);
  assert.equal(wrongGlobals.data.exitCode, 2);
  console.log(`Native CLI transport parity PASSED: ${cases} local/daemon error and success cases.`);
} finally {
  for (const native of [false, true]) {
    try {
      execute(null, native, ['daemon', 'stop'], { daemon: true });
    } catch {
      // Keep the original assertion failure; dispose both daemons and roots.
    }
  }
  await rm(root, { recursive: true, force: true });
}
