// #512: installed CLI oracle vs native Project lifecycle, including physical
// archive outcomes and rejected imports. Does not enable native production routing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.resolve(process.argv[2] ?? path.join(repository, 'build/cli/linux/noveltea'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-cli-lifecycle-'));
const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const environments = [false, true].map((native) => ({
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
  NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
  NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: native ? '1' : '0',
  NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `nt512-lifecycle-${process.pid}-${native}`,
  NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
    temporary,
    native ? 'native-daemon' : 'oracle-daemon',
  ),
}));

function execute(native, args, noDaemon = true) {
  const run = spawnSync(cli, [...(noDaemon ? ['--no-daemon'] : []), '--json', ...args], {
    env: environments[Number(native)],
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(run.error);
  assert.ok(run.stdout.trim(), `${args.join(' ')}: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(run.status, result.exitCode, `${run.stdout}\n${run.stderr}`);
  return result;
}

function zipEntries(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0 && end + 22 <= bytes.length, 'Missing complete ZIP central directory.');
  const entries = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const plainSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const contentOffset =
      local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(contentOffset, contentOffset + size);
    const content =
      method === 8
        ? inflateRawSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
        : method === 0
          ? compressed
          : null;
    assert.ok(content, `Unsupported archive compression in ${name}`);
    assert.equal(content.length, plainSize);
    assert.equal(entries.has(name), false, `Duplicate archive entry ${name}`);
    entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function tree(root, prefix = '', result = new Map()) {
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await tree(root, name, result);
    else {
      assert.equal(entry.isFile(), true, `Unexpected imported file type: ${name}`);
      result.set(name, await readFile(path.join(root, name)));
    }
  }
  return result;
}

function normalized(value) {
  if (typeof value === 'string')
    return value
      .replaceAll(path.join(temporary, 'oracle'), '<project>')
      .replaceAll(path.join(temporary, 'native'), '<project>');
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'protocolVersion')
      .map(([key, item]) => [key, normalized(item)]),
  );
}

function compare(oracle, candidate, label, success = true) {
  assert.deepEqual(normalized(candidate), normalized(oracle), label);
  assert.equal(candidate.success, success, `${label}: ${JSON.stringify(candidate.diagnostics)}`);
}

try {
  const roots = [path.join(temporary, 'oracle'), path.join(temporary, 'native')];
  const names = [false, true];
  for (const native of names) {
    const root = roots[Number(native)];
    const created = execute(native, ['project', 'create', root, '--name', 'Native Lifecycle']);
    assert.equal(created.success, true, JSON.stringify(created.diagnostics));
    await mkdir(path.join(root, '.noveltea', 'session'), { recursive: true });
    await writeFile(path.join(root, '.noveltea/session/private.json'), '{"local":true}\n');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git/config'), '[core]\n');
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'dist/not-portable.txt'), 'ignored\n');
  }

  // Both create calls must work independently, but their directory-derived
  // Project identities need not be the same. Compare export implementations
  // from identical authored source bytes rather than two different Projects.
  await cp(roots[0], roots[1], { recursive: true, force: true });

  const archives = [];
  for (const noDaemon of [true, false]) {
    const output = [];
    for (const native of names) {
      const bundle = path.join(
        temporary,
        `${native ? 'native' : 'oracle'}-${noDaemon ? 'local' : 'daemon'}.ntproject`,
      );
      const result = execute(
        native,
        ['--project', roots[Number(native)], 'project', 'export', '--output', bundle],
        noDaemon,
      );
      assert.equal(result.success, true, JSON.stringify(result.diagnostics));
      output.push({ result, bundle, bytes: await readFile(bundle) });
    }
    compare(output[0].result, output[1].result, 'Project export envelope');
    assert.deepEqual(output[1].bytes, output[0].bytes, 'Native export bytes differ from oracle.');
    archives.push(output[1].bytes);
  }
  assert.deepEqual(archives[0], archives[1], 'Local and daemon exports are not deterministic.');

  const members = zipEntries(archives[0]);
  const manifest = JSON.parse(members.get('ntproject.json').toString('utf8'));
  assert.equal(manifest.schema, 'noveltea.project.bundle');
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    [...members.keys()].sort(compareNames),
    ['ntproject.json', ...manifest.files.map((file) => file.path)].sort(compareNames),
    'Archive inventory differs from the declared manifest.',
  );
  for (const file of manifest.files) {
    assert.equal(
      `sha256:${createHash('sha256').update(members.get(file.path)).digest('hex')}`,
      file.sha256,
      `Archive source hash mismatch: ${file.path}`,
    );
  }
  assert.equal(
    [...members.keys()].some(
      (name) =>
        name.startsWith('.git/') || name.startsWith('.noveltea/') || name.startsWith('dist/'),
    ),
    false,
    'Local, session, cache or VCS state leaked into the portable Project.',
  );

  const imported = [];
  for (const native of names) {
    const destination = path.join(temporary, native ? 'native-imported' : 'oracle-imported');
    const importedResult = execute(native, [
      'project',
      'import',
      path.join(temporary, `${native ? 'native' : 'oracle'}-local.ntproject`),
      destination,
    ]);
    assert.equal(importedResult.success, true, JSON.stringify(importedResult.diagnostics));
    imported.push({ result: importedResult, files: await tree(destination) });
    const audited = execute(native, ['--project', destination, 'asset', 'audit']);
    assert.equal(
      audited.success,
      true,
      'The imported Project must reopen through native admission.',
    );
  }
  compare(imported[0].result, imported[1].result, 'Project import envelope');
  assert.deepEqual(imported[1].files, imported[0].files, 'Imported source bytes differ.');
  assert.equal(imported[1].files.has('.noveltea/session/private.json'), false);

  // Destination protection and invalid bundle diagnostics must be identical
  // across the installed oracle and the isolated native candidate.
  for (const native of names) {
    const bundle = path.join(temporary, `${native ? 'native' : 'oracle'}-local.ntproject`);
    const occupied = path.join(temporary, native ? 'native-imported' : 'oracle-imported');
    const conflict = execute(native, ['project', 'import', bundle, occupied]);
    assert.equal(conflict.exitCode, 5);
    assert.equal(conflict.diagnostics[0].code, 'PROJECT_BUNDLE_DESTINATION_CONFLICT');
  }
  const corrupt = path.join(temporary, 'corrupt.ntproject');
  const altered = Buffer.from(archives[0]);
  const sourceMarker = Buffer.from('schemaVersion: 1');
  const markerAt = altered.indexOf(sourceMarker);
  assert.ok(markerAt >= 0, 'Could not locate an uncompressed manifest source for corruption.');
  altered[markerAt + sourceMarker.length - 1] = 0x32;
  await writeFile(corrupt, altered);
  const failed = names.map((native) =>
    execute(native, [
      'project',
      'import',
      corrupt,
      path.join(temporary, native ? 'native-rejected' : 'oracle-rejected'),
    ]),
  );
  assert.equal(failed[0].exitCode, failed[1].exitCode);
  // The two readers describe ZIP corruption differently; stable CLI
  // diagnostics and failure categories, not identical prose, are the contract.
  assert.deepEqual(
    failed[0].diagnostics.map(({ code, severity, path: source }) => ({
      code,
      severity,
      path: source,
    })),
    failed[1].diagnostics.map(({ code, severity, path: source }) => ({
      code,
      severity,
      path: source,
    })),
  );
  assert.equal(failed[1].exitCode, 4);
  for (const destination of ['native-rejected', 'oracle-rejected'])
    assert.equal(await stat(path.join(temporary, destination)).catch(() => null), null);

  const unsafe = path.join(temporary, 'unsafe.ntproject');
  const unsafeBytes = Buffer.from(archives[0]);
  const centralEnd = unsafeBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let central = unsafeBytes.readUInt32LE(centralEnd + 16);
  let renamed = false;
  for (let index = 0; index < unsafeBytes.readUInt16LE(centralEnd + 10); index += 1) {
    const length = unsafeBytes.readUInt16LE(central + 28);
    if (unsafeBytes.toString('utf8', central + 46, central + 46 + length) === 'editor.yaml') {
      const local = unsafeBytes.readUInt32LE(central + 42);
      const unsafeName = Buffer.from('../evil.txt');
      assert.equal(unsafeName.length, length);
      unsafeName.copy(unsafeBytes, central + 46);
      unsafeName.copy(unsafeBytes, local + 30);
      renamed = true;
      break;
    }
    central +=
      46 + length + unsafeBytes.readUInt16LE(central + 30) + unsafeBytes.readUInt16LE(central + 32);
  }
  assert.equal(renamed, true, 'Could not prepare traversal archive fixture.');
  await writeFile(unsafe, unsafeBytes);
  for (const native of names) {
    const destination = path.join(temporary, native ? 'native-unsafe' : 'oracle-unsafe');
    const response = execute(native, ['project', 'import', unsafe, destination]);
    assert.equal(response.exitCode, 4);
    assert.equal(response.diagnostics[0].code, 'PROJECT_BUNDLE_INVALID');
    assert.equal(await stat(destination).catch(() => null), null);
  }
  assert.equal(await stat(path.join(temporary, 'evil.txt')).catch(() => null), null);
  console.log('Native installed CLI lifecycle PASSED: create/export/import, local/daemon,');
  console.log('exact bytes, manifest inventory/hashes, excluded files and failure isolation.');
} finally {
  for (const native of [false, true]) {
    try {
      execute(native, ['daemon', 'stop'], false);
    } catch {
      // Preserve any original certification failure.
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
