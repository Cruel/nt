import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** #522 certification must never infer production routing from candidate-only switches. */
export async function assertProductionInputs(cli, env = process.env) {
  const candidate = Object.keys(env).filter(
    (key) =>
      key.startsWith('NOVELTEA_CLI_CERTIFICATION') ||
      key.startsWith('NOVELTEA_EDITOR_CERTIFICATION'),
  );
  assert.equal(
    candidate.length,
    0,
    `Unexpected certification environment: ${candidate.join(', ')}`,
  );
  assert.ok(path.isAbsolute(cli), 'Pass an absolute installed CLI executable path.');
  assert.ok((await stat(cli).catch(() => null))?.isFile(), `Missing installed CLI: ${cli}`);
}

/** An ordinary installed CLI must match the exact ScriptC bundle whose
 * module provenance was inspected. Build provenance alone is not a native
 * authority claim: strict whole-editor closure remains a separate gate. */
export async function assertInstalledCliBundleBinding(cli, islandManifest, mode) {
  assert.ok(mode === 'candidate' || mode === 'production', 'Unknown native CLI build mode.');
  const binding = JSON.parse(
    await readFile(
      path.join(
        path.dirname(cli),
        mode === 'candidate' ? 'native-candidate-build.json' : 'native-production-build.json',
      ),
      'utf8',
    ),
  );
  const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(
    binding.contract,
    mode === 'candidate'
      ? 'noveltea.native-cli-candidate-build.v1'
      : 'noveltea.native-cli-production-build.v1',
    'Incorrect installed CLI build provenance.',
  );
  assert.equal(
    binding.executableSha256,
    hash(await readFile(cli)),
    'Installed CLI executable differs from the built executable.',
  );
  assert.equal(
    binding.islandProvenanceSha256,
    hash(await readFile(islandManifest)),
    'Installed CLI does not match inspected ScriptC provenance.',
  );
}

export function isolatedProductionEnvironment(base, home) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (key.startsWith('NOVELTEA_CLI_CERTIFICATION') || key === 'NOVELTEA_CLI_NO_DAEMON')
      delete env[key];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_RUNTIME_DIR: path.join(home, 'runtime'),
  };
}

/** Actual stdout/stderr/exit contract of the installed ScriptC binary. */
export function checkProductionJsonCommand(cli, args, options = {}) {
  assert.equal(
    args.includes('--json'),
    true,
    'The production transport witness requires JSON mode.',
  );
  assert.equal(
    args.some((argument) => argument.startsWith('--certify-native-authoring')),
    false,
    'Production certification cannot use candidate editor switches.',
  );
  const run = spawnSync(cli, args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...options,
  });
  assert.ifError(run.error);
  assert.equal(run.signal, null, `CLI process interrupted: ${args.join(' ')}`);
  assert.equal(
    run.stderr,
    '',
    `Production JSON CLI wrote stderr: ${args.join(' ')}: ${run.stderr}`,
  );
  let result;
  try {
    result = JSON.parse(run.stdout.trim());
  } catch {
    throw new Error(
      `Production CLI emitted invalid or multiple JSON completions: ${args.join(' ')}`,
    );
  }
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.equal(typeof result.success, 'boolean');
  assert.equal(result.protocolVersion, 1, 'Unsupported public CLI protocol.');
  assert.ok(Array.isArray(result.diagnostics));
  assert.equal(
    run.status,
    result.exitCode,
    `Production CLI exit category mismatch: ${args.join(' ')}`,
  );
  assert.equal(
    result.success,
    run.status === 0,
    `CLI success/exit disagreement: ${args.join(' ')}`,
  );
  return result;
}

/** Strict archive readback independent of the Project authoring implementation. */
export function readPortableZipMembers(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0 && end + 22 <= bytes.length, 'ZIP central directory terminator is missing.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  assert.ok(count > 0, 'Empty portable archive.');
  for (let index = 0; index < count; index += 1) {
    assert.ok(offset + 46 <= end, 'ZIP central entry exceeds archive.');
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'Invalid ZIP central entry.');
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28);
    const extraSize = bytes.readUInt16LE(offset + 30);
    const commentSize = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    assert.ok(next <= end, 'ZIP central entry length exceeds archive.');
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
    assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..'));
    assert.equal(entries.has(name), false, `Duplicate ZIP entry: ${name}`);
    const local = bytes.readUInt32LE(offset + 42);
    assert.ok(local + 30 <= end, 'ZIP local entry exceeds archive.');
    assert.equal(bytes.readUInt32LE(local), 0x04034b50, 'Invalid ZIP local entry.');
    const contentStart =
      local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    assert.ok(contentStart + compressedSize <= end, 'ZIP payload exceeds archive.');
    const compressed = bytes.subarray(contentStart, contentStart + compressedSize);
    const decoded =
      compression === 8
        ? inflateRawSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
        : compression === 0
          ? compressed
          : null;
    assert.ok(decoded, `Unsupported ZIP compression for ${name}.`);
    assert.equal(decoded.length, uncompressedSize, `ZIP entry size mismatch: ${name}`);
    entries.set(name, decoded);
    offset = next;
  }
  return entries;
}
