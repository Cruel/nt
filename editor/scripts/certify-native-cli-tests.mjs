// #515: installed CLI differential against the retired runner and native-authoritative candidate.
// Small disposable Project fixtures avoid unrelated Feature Lab shader-build cost;
// the Feature Lab authored cases remain covered by the separate native Tests gate.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCertificationRoot } from './certification-temp-root.mjs';

const cli = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build/cli/linux/noveltea');
const root = await createCertificationRoot('noveltea-515-tests-');
const legacy = path.join(root, 'legacy');
const candidate = path.join(root, 'candidate');
const projects = [legacy, candidate];
const baseline = { ...process.env, NOVELTEA_CLI_CERTIFICATION: '1' };

function execute(project, native, args, noDaemon = true, stdin) {
  const processResult = spawnSync(
    cli,
    [...(noDaemon ? ['--no-daemon'] : []), '--json', '--project', project, ...args],
    {
      env: {
        ...baseline,
        NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: native ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-515-${process.pid}-${native ? 'native' : 'legacy'}`,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
          root,
          native ? 'native-daemon' : 'legacy-daemon',
        ),
      },
      encoding: 'utf8',
      ...(stdin !== undefined ? { input: stdin } : {}),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  assert.ifError(processResult.error);
  assert.ok(processResult.stdout.trim(), `${args.join(' ')} had no JSON: ${processResult.stderr}`);
  const payload = JSON.parse(processResult.stdout);
  assert.equal(
    processResult.status,
    payload.exitCode,
    `${args.join(' ')}: ${processResult.stdout}`,
  );
  return payload;
}

function projection(response) {
  return {
    success: response.success,
    exitCode: response.exitCode,
    diagnostics: response.diagnostics
      ?.filter((item) => item.severity === 'error')
      .map(({ code, path, message }) => ({ code, path, message })),
    report: response.native?.report
      ? {
          passed: response.native.report.passed,
          counts: response.native.report.counts,
          entries: response.native.report.entries?.map(({ id, status }) => ({ id, status })),
        }
      : null,
  };
}

let verified = 0;
function compareTest(args, noDaemon, stdin) {
  const oracle = execute(legacy, false, args, noDaemon, stdin);
  const actual = execute(candidate, true, args, noDaemon, stdin);
  assert.deepEqual(
    projection(actual),
    projection(oracle),
    `Test parity diverged: ${args.join(' ')}`,
  );
  verified += 1;
  console.log(`  ${verified}: ${noDaemon ? 'local' : 'daemon'} ${args.join(' ')}`);
  return actual;
}

try {
  for (const [index, project] of projects.entries()) {
    const create = spawnSync(
      cli,
      ['--no-daemon', '--json', 'project', 'create', project, '--name', 'Native Test Differential'],
      {
        encoding: 'utf8',
        env: {
          ...baseline,
          NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: index ? '1' : '0',
          NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: index ? '1' : '0',
        },
        timeout: 30_000,
      },
    );
    assert.equal(create.status, 0, create.stderr || create.stdout);
    const room = spawnSync(
      cli,
      ['--no-daemon', '--json', '--project', project, 'entity', 'create', 'rooms', 'start'],
      {
        encoding: 'utf8',
        env: {
          ...baseline,
          NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: index ? '1' : '0',
          NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: index ? '1' : '0',
        },
        timeout: 30_000,
      },
    );
    assert.equal(room.status, 0, room.stderr || room.stdout);
    const manifest = path.join(project, 'project.yaml');
    await writeFile(
      manifest,
      `${await readFile(manifest, 'utf8')}\nentrypoint:\n  kind: room\n  id: start\n`,
    );
    const directory = path.join(project, 'records/tests');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'semantic.yaml'),
      'id: semantic\nlabel: Semantic\ndata:\n  displayName: Semantic\n  steps:\n    - id: start\n      input: tick\n      label: Start\n',
    );
    await writeFile(
      path.join(directory, 'ui.yaml'),
      'id: ui\nlabel: UI\ndata:\n  displayName: UI\n  steps:\n    - id: click\n      input: ui-click\n      label: Click\n      uiClick:\n        documentId: runtime_game\n        selector: "#target"\n',
    );
  }
  const playback = `${JSON.stringify({
    schema: 'noveltea.editor.playback',
    version: 1,
    id: 'native-515-stdin',
    steps: [],
    finalExpectations: [],
  })}\n`;
  for (const noDaemon of [true, false]) {
    compareTest(['test', 'run', 'semantic'], noDaemon);
    compareTest(['test', 'run', 'ui'], noDaemon);
    compareTest(['test', 'run-spec'], noDaemon, playback);
    compareTest(['test', 'run-ui-spec'], noDaemon, playback);
    compareTest(['test', 'run'], noDaemon);
  }
  // A Test-only source edit changes the catalog, not the compiled runtime
  // artifact. Warm cache and both transport paths must retain the same verdict.
  for (const project of projects) {
    const source = path.join(project, 'records/tests/semantic.yaml');
    await writeFile(
      source,
      (await readFile(source, 'utf8')).replace('label: Start', 'label: Updated'),
    );
  }
  for (const noDaemon of [true, false]) {
    const updated = compareTest(['test', 'run', 'semantic'], noDaemon);
    assert.equal(updated.runtimeCache?.status, 'hit', JSON.stringify(updated.runtimeCache));
    compareTest(['test', 'run-spec'], noDaemon, playback);
  }
  // Schema-invalid but well-formed stdin enters the native runner and must
  // produce an explicit infrastructure error, not a fake failed expectation.
  for (const noDaemon of [true, false]) {
    const invalid = compareTest(['test', 'run-spec'], noDaemon, '{}\n');
    assert.equal(invalid.exitCode, 6);
    assert.ok(invalid.diagnostics.some((item) => item.code.startsWith('native.editor_protocol.')));
  }
  // The native cache probe must never execute tampered compiled artifact bytes.
  // Both generations are isolated and must recover independently.
  for (const project of projects) {
    const cache = path.join(project, '.noveltea/cache/runtime');
    const generation = (await readFile(path.join(cache, 'current'), 'utf8')).trim();
    await writeFile(
      path.join(cache, 'generations', generation, 'artifact.json'),
      '{"tampered":true}\n',
    );
  }
  for (const noDaemon of [true, false]) {
    const recovered = compareTest(['test', 'run', 'semantic'], noDaemon);
    assert.equal(recovered.exitCode, 0);
  }
  // The real disposable daemon worker must use its pinned generation after
  // a newer authored source is promoted by the owner. Publication is rejected
  // when the live inventory no longer matches the worker's captured inputs.
  await rm(path.join(candidate, '.noveltea/cache/runtime'), { recursive: true, force: true });
  const marker = path.join(root, 'native-test-snapshot-pinned');
  const child = spawn(cli, ['--json', '--project', candidate, 'test', 'run', 'semantic'], {
    env: {
      ...baseline,
      NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: '1',
      NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: '1',
      NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-515-${process.pid}-native`,
      NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(root, 'native-daemon'),
      NOVELTEA_CLI_CERTIFICATION_PINNED_BARRIER: marker,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  try {
    let observed = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      if (existsSync(`${marker}.ready`)) {
        observed = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(observed, `Pinned Test worker did not reach its snapshot boundary: ${stderr}`);
    const source = path.join(candidate, 'records/rooms/start.yaml');
    await writeFile(source, `${await readFile(source, 'utf8')}\n# edited after Test pin\n`);
    const owner = execute(candidate, true, ['usages', 'rooms', 'start'], false);
    assert.equal(owner.exitCode, 0);
  } finally {
    await writeFile(`${marker}.release`, 'release');
  }
  const raceExit = await finished;
  assert.equal(raceExit, 0, `Pinned Test execution failed: ${stdout}\n${stderr}`);
  const race = JSON.parse(stdout);
  assert.equal(race.success, true);
  assert.equal(race.runtimeCache?.published, false, JSON.stringify(race.runtimeCache));
  verified++;
  console.log(`  ${verified}: daemon pinned Test source race`);
  const failure = `${JSON.stringify({
    schema: 'noveltea.editor.playback',
    version: 1,
    id: 'native-515-fail',
    steps: [],
    finalExpectations: [
      { id: 'missing-room', type: 'current-room', operator: 'eq', roomId: 'missing-room' },
    ],
  })}\n`;
  for (const noDaemon of [true, false]) {
    const failed = compareTest(['test', 'run-spec'], noDaemon, failure);
    assert.equal(failed.exitCode, 6);
    assert.equal(failed.native?.report?.passed, false);
    const uiFailed = compareTest(['test', 'run-ui-spec'], noDaemon, failure);
    assert.equal(uiFailed.exitCode, 6);
  }
  for (const project of projects)
    await writeFile(
      path.join(project, 'records/tests/blocked.yaml'),
      'id: blocked\nlabel: Blocked\ndata:\n  displayName: Blocked\n  steps: []\n',
    );
  for (const noDaemon of [true, false]) {
    const blocked = compareTest(['test', 'run', 'blocked'], noDaemon);
    assert.equal(blocked.success, false);
    assert.ok(blocked.diagnostics.some((item) => item.code === 'native.test.spec'));
    const suite = compareTest(['test', 'run'], noDaemon);
    assert.ok(
      suite.native?.report?.entries?.some(
        (entry) => entry.id === 'blocked' && entry.status === 'blocked',
      ),
    );
  }
  // A failed authored Test must retain a full report; the suite must also
  // return a failed count rather than accepting the native transport's ok.
  for (const project of projects) {
    const source = path.join(project, 'records/tests/semantic.yaml');
    await writeFile(
      source,
      `${await readFile(source, 'utf8')}  finalExpectations:\n    - id: wrong-room\n      type: current-room\n      operator: ne\n      currentRoom:\n        roomId: start\n`,
    );
  }
  for (const noDaemon of [true, false]) {
    const failed = compareTest(['test', 'run', 'semantic'], noDaemon);
    assert.equal(failed.exitCode, 6);
    assert.equal(failed.native?.report?.passed, false);
    const suite = compareTest(['test', 'run'], noDaemon);
    assert.equal(suite.exitCode, 6);
    assert.ok(
      suite.native?.report?.entries?.some(
        (entry) => entry.id === 'semantic' && entry.status === 'failed',
      ),
    );
  }
  // Empty suites are a successful no-op, not a preparation error or runner crash.
  for (const project of projects)
    for (const id of ['blocked', 'semantic', 'ui'])
      await rm(path.join(project, `records/tests/${id}.yaml`));
  for (const noDaemon of [true, false]) {
    const empty = compareTest(['test', 'run'], noDaemon);
    assert.equal(empty.exitCode, 0);
    assert.equal(empty.native?.report?.counts?.total, 0);
  }
  console.log(`Native Test CLI differential PASSED: ${verified} public calls.`);
} finally {
  for (const native of [false, true]) {
    try {
      execute(native ? candidate : legacy, native, ['daemon', 'stop'], false);
    } catch {
      /* preserve test failure */
    }
  }
  // A successful daemon stop can precede the worker's final filesystem
  // cleanup. Without retries, concurrently removed/created runtime files
  // intermittently produce ENOTEMPTY on Linux after all assertions pass.
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
