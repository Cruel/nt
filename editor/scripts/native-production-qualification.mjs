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

/** A missing addon must never silently downgrade the production gate to a
 * CLI-only smoke. Release builder jobs may deliberately select that subset;
 * host integration jobs must provide the real addon. */
export function resolveProductionCertificationMode(argv, addon) {
  const cliOnly = argv.includes('--cli-only');
  assert.ok(
    cliOnly || addon,
    'Production qualification requires NOVELTEA_AUTHORING_NODE_ADDON; pass --cli-only explicitly for the CLI-only subset.',
  );
  return cliOnly;
}

/** Resolve the exact checked-out source, including inside CI containers whose
 * checkout is owned by a different UID. Trust only this repository directory,
 * never every Git repository on the runner. */
export function readProductionSourceRevision(repositoryRoot, env = process.env) {
  const revision = spawnSync(
    'git',
    ['-c', `safe.directory=${repositoryRoot}`, 'rev-parse', '--verify', 'HEAD'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.ifError(revision.error);
  assert.equal(
    revision.status,
    0,
    `Qualification requires an identifiable source revision: ${revision.stderr.trim()}`,
  );
  const sha = revision.stdout.trim();
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid source revision.');
  if (env.NOVELTEA_BUILD_IDENTITY)
    assert.equal(
      env.NOVELTEA_BUILD_IDENTITY,
      `git:${sha}`,
      'The checked-out source differs from the pinned build identity.',
    );
  return sha;
}

/** Require the installed direct-C++ executable and its companion Test runner.
 * Electron's JS module inventory is certified separately; no JS island belongs
 * to the CLI release artifact. */
export async function assertInstalledNativeCliBuild(cli) {
  const binding = JSON.parse(
    await readFile(path.join(path.dirname(cli), 'native-production-build.json'), 'utf8'),
  );
  const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(
    binding.contract,
    'noveltea.native-cli-production-build.v2',
    'Incorrect installed CLI build provenance.',
  );
  assert.equal(binding.runtime, 'direct-cxx', 'Installed CLI must use the native C++ runtime.');
  const bytes = await readFile(cli);
  assert.equal(
    binding.executableSha256,
    hash(bytes),
    'Installed CLI executable differs from the built executable.',
  );
  // The build record is not proof of a direct native executable: also inspect
  // its actual bytes, including stripped binaries and relocated release inputs.
  const nativeMagic =
    (bytes[0] === 0x7f && bytes.subarray(1, 4).toString() === 'ELF') ||
    (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
    ['feedfacf', 'cffaedfe'].includes(bytes.subarray(0, 4).toString('hex'));
  assert.ok(nativeMagic, 'Installed CLI is not an ELF, PE, or Mach-O native executable.');
  for (const symbol of [
    'scr_island_lre_opaque',
    'JS_RunGC',
    'JS_SetGCThreshold',
    'noveltea_tooling_scriptc_',
  ])
    assert.equal(
      bytes.includes(Buffer.from(symbol)),
      false,
      `Retired CLI runtime symbol: ${symbol}`,
    );
  const runner = path.join(
    path.dirname(cli),
    path.extname(cli).toLowerCase() === '.exe'
      ? 'noveltea-ui-test-runner.exe'
      : 'noveltea-ui-test-runner',
  );
  assert.equal(
    binding.uiTestRunnerSha256,
    hash(await readFile(runner)),
    'Installed CLI Test runner differs from the built executable.',
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

/** Actual stdout/stderr/exit contract of the installed C++ binary. */
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
