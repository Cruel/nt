// Certification-only differential for #501. This never routes production
// authoring commands through native; it exercises two disposable Projects
// against the installed CLI oracle and the parallel native host adapter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const suffix = process.platform === 'win32' ? '.exe' : '';
const cli =
  process.env.NOVELTEA_CLI_PATH ??
  path.join(repository, 'build', 'cli', platform, `noveltea${suffix}`);
const native =
  process.env.NOVELTEA_NATIVE_TOOLING_BRIDGE ??
  path.join(
    repository,
    'build',
    platform === 'linux'
      ? 'linux-authoring-release'
      : platform === 'windows'
        ? 'windows-cli-gnu'
        : 'macos-authoring-release',
    'tools',
    'editor_tool',
    `noveltea-tooling-bridge${suffix}`,
  );

function run(executable, args) {
  const output = spawnSync(executable, args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 240_000,
  });
  if (output.error || output.status !== 0) {
    throw new Error(
      `${executable} ${args.join(' ')} failed: ${output.status}\n${output.stderr}\n${output.stdout}\n${output.error ?? ''}`,
    );
  }
  return output.stdout;
}

async function fileInventory(root, prefix = '', result = new Map()) {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.noveltea') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await fileInventory(root, relative, result);
    else if (entry.isFile()) result.set(relative, await readFile(path.join(root, relative)));
    else throw new Error(`Unexpected fixture file type: ${relative}`);
  }
  return result;
}

function withoutVolatileImportFields(record) {
  const clone = structuredClone(record);
  delete clone.data?.importedAt;
  return clone;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-command-differential-'));
let requestSequence = 0;
async function nativeCommand(action, attributes = {}) {
  const index = ++requestSequence;
  const request = path.join(temporary, `request-${index}.json`);
  const response = path.join(temporary, `response-${index}.json`);
  await writeFile(request, `${JSON.stringify({ action, ...attributes })}\n`);
  run(native, ['native-project-commands', request, response]);
  return JSON.parse(await readFile(response, 'utf8'));
}

function publicCommand(project, ...command) {
  const result = JSON.parse(run(cli, ['--project', project, '--json', ...command]));
  assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  return result;
}

try {
  const oracle = path.join(temporary, 'oracle');
  const test = path.join(temporary, 'native');
  const name = 'Native Parity Workspace';
  const created = JSON.parse(run(cli, ['--json', 'project', 'create', oracle, '--name', name]));
  const nativeCreated = await nativeCommand('project-create', { projectRoot: test, name });
  assert.equal(created.success, true);
  assert.equal(nativeCreated.ok, true, JSON.stringify(nativeCreated));
  assert.equal(nativeCreated.projectId, created.projectId);
  const oracleInventory = await fileInventory(oracle);
  const nativeInventory = await fileInventory(test);
  const comparePaths = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(
    [...nativeInventory.keys()].sort(comparePaths),
    [...oracleInventory.keys()].sort(comparePaths),
  );
  for (const [relative, bytes] of oracleInventory) {
    if (relative === 'project.yaml') {
      assert.deepEqual(
        parseYaml(nativeInventory.get(relative).toString('utf8')),
        parseYaml(bytes.toString('utf8')),
        'Created Project semantic identity differs',
      );
    } else {
      assert.deepEqual(
        nativeInventory.get(relative),
        bytes,
        `Scaffold source differs: ${relative}`,
      );
    }
  }

  const source = path.join(temporary, 'NovelTea Note.txt');
  await writeFile(source, 'Native and public CLI Asset import source bytes.\n');
  for (const dryRun of [true, false]) {
    const oracleImport = publicCommand(
      oracle,
      'asset',
      'import',
      source,
      ...(dryRun ? ['--dry-run'] : []),
    );
    const nativeImport = await nativeCommand('asset-import', {
      projectRoot: test,
      paths: [source],
      dryRun,
    });
    assert.equal(nativeImport.ok, true, JSON.stringify(nativeImport));
    assert.equal(nativeImport.fields.dryRun, oracleImport.dryRun);
    assert.deepEqual(nativeImport.fields.assets, oracleImport.assets);
    const relative = oracleImport.assets[0].projectRelativePath;
    if (dryRun) {
      await assert.rejects(stat(path.join(test, relative)));
      await assert.rejects(stat(path.join(oracle, relative)));
    } else {
      assert.deepEqual(
        await readFile(path.join(test, relative)),
        await readFile(path.join(oracle, relative)),
      );
      const recordPath = `records/assets/${oracleImport.assets[0].assetId}.yaml`;
      assert.deepEqual(
        withoutVolatileImportFields(parseYaml(await readFile(path.join(test, recordPath), 'utf8'))),
        withoutVolatileImportFields(
          parseYaml(await readFile(path.join(oracle, recordPath), 'utf8')),
        ),
        'Imported Asset record effective semantics differ',
      );
    }
  }

  const untracked = 'assets/text/not-registered.txt';
  for (const project of [oracle, test]) {
    await mkdir(path.join(project, 'assets/text'), { recursive: true });
    await writeFile(path.join(project, untracked), 'Untracked asset inventory fixture.\n');
  }
  const oracleAudit = publicCommand(oracle, 'asset', 'audit');
  const nativeAudit = await nativeCommand('asset-audit', { projectRoot: test });
  assert.equal(nativeAudit.ok, true, JSON.stringify(nativeAudit));
  assert.deepEqual(nativeAudit.fields.untrackedFiles, oracleAudit.untrackedFiles);
  console.log('Native Project command differential PASSED: create, import/dry-run, audit.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
