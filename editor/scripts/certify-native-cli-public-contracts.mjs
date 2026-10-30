// #534: independent installed native CLI contracts. No imported Project
// validator, TypeScript reference executable, differential or candidate flag.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertProductionInputs,
  checkProductionJsonCommand,
  isolatedProductionEnvironment,
} from './native-production-qualification.mjs';
import { assertInstalledNativeCliBuild } from './native-production-qualification.mjs';

if (process.argv.length !== 3 && (process.argv.length !== 4 || process.argv[3] !== '--production'))
  throw new Error(
    'Usage: certify-native-cli-public-contracts.mjs <installed-native-cli> [--production]',
  );
const cli = path.resolve(process.argv[2]);
await assertProductionInputs(cli);
await assertInstalledNativeCliBuild(cli);

const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-534-public-contracts-'));
const project = path.join(scratch, 'project');
const home = path.join(scratch, 'home');
const environment = isolatedProductionEnvironment(process.env, home);
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let checked = 0;

function json(args, { daemon = false, projectRoot = project, env = {} } = {}) {
  const response = checkProductionJsonCommand(
    cli,
    [
      ...(daemon ? [] : ['--no-daemon']),
      '--json',
      ...(projectRoot ? ['--project', projectRoot] : []),
      ...args,
    ],
    { env: { ...environment, ...env }, timeout: 180_000 },
  );
  assert.equal(
    response.diagnostics.some((item) => item.code === 'CLI_NATIVE_CANDIDATE_UNCLAIMED'),
    false,
    `Unimplemented native route: ${args.join(' ')}`,
  );
  checked += 1;
  return response;
}

function success(response, label) {
  assert.equal(response.success, true, `${label}: ${JSON.stringify(response.diagnostics)}`);
  assert.equal(response.exitCode, 0);
  return response;
}

function error(response, exitCode, expectedCode, expectedPath) {
  assert.equal(response.success, false);
  assert.equal(response.exitCode, exitCode);
  assert.ok(
    response.diagnostics.some(
      (item) =>
        item.code === expectedCode &&
        item.severity === 'error' &&
        (expectedPath === undefined || item.path === expectedPath),
    ),
    `Missing golden diagnostic ${expectedCode}: ${JSON.stringify(response.diagnostics)}`,
  );
}

try {
  await mkdir(path.join(home, 'runtime'), { recursive: true, mode: 0o700 });
  const help = spawnSync(cli, ['--help'], { env: environment, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^NovelTea headless CLI\n\nUsage:/);
  assert.match(help.stdout, /\bcomfyui workflows\b/);
  assert.match(help.stdout, /\bplatform export\b/);
  assert.equal(help.stderr, '');
  assert.doesNotMatch(help.stdout, /__editor-native/);
  // The packaged Electron editor uses the same installed native CLI for its
  // private operations; this is not a public command in the 39-path inventory.
  const internal = (operation, payload) => {
    const invocation = spawnSync(cli, ['__editor-native', operation], {
      env: environment,
      encoding: 'utf8',
      input: JSON.stringify(payload),
      timeout: 30_000,
    });
    assert.ifError(invocation.error);
    assert.equal(invocation.status, 0, `${operation}: ${invocation.stderr}`);
    assert.equal(invocation.stderr, '', `${operation}: unexpected stderr`);
    return JSON.parse(invocation.stdout);
  };
  assert.deepEqual(internal('path-metadata', { path: path.join(scratch, 'absent') }), {
    ok: true,
    kind: 'missing',
  });
  assert.deepEqual(internal('path-metadata', {}), {
    ok: false,
    error: 'Path metadata request requires path.',
  });
  assert.deepEqual(internal('unsupported-internal-operation', {}), {
    ok: false,
    error: 'unknown native operation',
  });
  error(json(['--not-a-global-option'], { projectRoot: null }), 2, 'CLI_USAGE', '/');
  error(json(['validate', '--invalid'], { projectRoot: null }), 2, 'CLI_USAGE', '/');

  const created = success(
    json(['project', 'create', project, '--name', 'Contract Fixture'], { projectRoot: null }),
    'Project creation',
  );
  assert.equal(created.projectId, 'contract-fixture');
  assert.equal(created.projectRoot, project);
  assert.equal(created.projectFilePath, path.join(project, 'project.yaml'));
  assert.equal((await stat(created.projectFilePath)).isFile(), true);
  const originalManifest = await readFile(created.projectFilePath, 'utf8');
  assert.match(originalManifest, /^schemaVersion: 1$/m);
  error(json(['validate']), 4, 'COMPILER_ENTRYPOINT_REQUIRED', '/entrypoint');

  const create = success(json(['entity', 'create', 'rooms', 'start']), 'Room creation');
  assert.deepEqual(create.plan.writes, ['records/rooms/start.yaml']);
  assert.deepEqual(create.plan.deletes, []);
  assert.equal(create.dryRun, false);
  const roomFile = path.join(project, 'records/rooms/start.yaml');
  assert.match(await readFile(roomFile, 'utf8'), /^id: start$/m);
  const inspect = success(json(['entity', 'inspect', 'rooms', 'start']), 'Room inspection');
  assert.equal(inspect.record.id, 'start');
  assert.equal(inspect.record.data.kind, 'room');
  assert.deepEqual(inspect.record.data.presentationSpace.size, { width: 1920, height: 1080 });
  assert.equal(inspect.record.data.description.source.text, '');
  error(
    json(['entity', 'inspect', 'rooms', 'absent']),
    4,
    'authoring.entity.not_found',
    '/rooms/absent',
  );
  error(json(['entity', 'inspect', 'bogus', 'start']), 2, 'CLI_USAGE', '/');

  await writeFile(
    created.projectFilePath,
    `${originalManifest}\nentrypoint:\n  kind: room\n  id: start\n`,
  );
  const cold = success(json(['validate']), 'Cold native validation');
  const warm = success(json(['validate'], { daemon: true }), 'Daemon native validation');
  assert.deepEqual(warm.diagnostics, cold.diagnostics, 'Local and daemon diagnostics diverged.');
  assert.deepEqual(success(json(['validate'])).diagnostics, cold.diagnostics);
  const cacheFile = path.join(project, '.noveltea/cache/authoring/native-clean-current.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cache.contract, 'noveltea.native-clean-validation.v1');
  assert.equal(cache.revisions['project.yaml'], hash(await readFile(created.projectFilePath)));
  assert.equal(cache.revisions['records/rooms/start.yaml'], hash(await readFile(roomFile)));
  await writeFile(cacheFile, '{not a native cache');
  success(json(['validate']), 'Rejected corrupt disposable cache');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).contract, cache.contract);

  const needsFormat = json(['fmt', 'project.yaml', '--check']);
  assert.equal(needsFormat.success, false);
  assert.notEqual(needsFormat.exitCode, 0);
  assert.ok(
    needsFormat.diagnostics.some(
      (item) =>
        item.code === 'FMT_CHANGE' && item.path === '/project.yaml' && item.severity === 'warning',
    ),
  );
  success(json(['fmt', 'project.yaml']), 'Native format write');
  const fmt = success(json(['fmt', 'project.yaml', '--check']), 'Formatting check');
  assert.deepEqual(
    { checked: fmt.checked, changed: fmt.changed, files: fmt.files },
    { checked: 1, changed: 0, files: [] },
  );
  assert.deepEqual(success(json(['asset', 'audit'])).untrackedFiles, []);
  assert.deepEqual(success(json(['platform', 'profiles'], { daemon: true })).profiles, []);
  const dryRun = success(json(['localization', 'sync', '--dry-run']));
  assert.equal(dryRun.changed, false);
  assert.deepEqual(dryRun.writes, []);
  const workflows = success(json(['comfyui', 'workflows']));
  assert.ok(workflows.workflows.some((item) => item.id === 'flux2-klein-text-to-image'));
  assert.ok(workflows.workflows.some((item) => item.id === 'flux2-klein-image-edit'));
  error(json(['test', 'run', 'not-found']), 6, 'native.test.spec', '/tests/not-found');

  const renamed = success(json(['entity', 'rename', 'rooms', 'start', 'renamed']), 'Native rename');
  assert.equal(renamed.id ?? renamed.toId ?? 'renamed', 'renamed');
  await assert.rejects(readFile(roomFile), { code: 'ENOENT' });
  const renamedFile = path.join(project, 'records/rooms/renamed.yaml');
  assert.match(await readFile(renamedFile, 'utf8'), /^id: renamed$/m);
  const referencedDelete = json(['entity', 'delete', 'rooms', 'renamed']);
  error(referencedDelete, 4, 'authoring.entity.delete', '/rooms/renamed');
  assert.equal((await stat(renamedFile)).isFile(), true, 'Rejected delete altered disk.');
  // An explicit author decision to remove the entrypoint reference makes
  // deletion legal; the native transaction must not silently do that for us.
  await writeFile(created.projectFilePath, originalManifest);
  success(json(['entity', 'delete', 'rooms', 'renamed']), 'Native delete');
  await assert.rejects(readFile(renamedFile), { code: 'ENOENT' });
  error(json(['validate'], { daemon: true }), 4, 'COMPILER_ENTRYPOINT_REQUIRED', '/entrypoint');

  await writeFile(created.projectFilePath, 'schemaVersion: [invalid\n');
  const invalid = json(['validate']);
  assert.equal(invalid.success, false, 'Malformed required Project owner was admitted.');
  assert.ok(
    invalid.diagnostics.some((item) => item.severity === 'error' && item.code && item.path),
  );
  await writeFile(created.projectFilePath, originalManifest);
  error(json(['validate']), 4, 'COMPILER_ENTRYPOINT_REQUIRED', '/entrypoint');
  console.log(
    `Native candidate public golden/semantic/filesystem contracts PASSED (${checked} JSON commands, human help).`,
  );
} finally {
  try {
    json(['daemon', 'stop'], { projectRoot: null, daemon: true });
  } catch {
    /* Retain first error. */
  }
  await rm(scratch, { recursive: true, force: true });
}
