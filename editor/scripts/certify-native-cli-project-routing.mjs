// #505 certification: run the installed public transport against the legacy
// oracle and the native-authoritative candidate on disposable Projects.
// No runtime flag is enabled for production callers by this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-cli-native-routing-'));
const legacy = path.join(root, 'legacy');
const candidate = path.join(root, 'candidate');
const baseline = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
};

function execute(project, native, args, noDaemon = true) {
  const run = spawnSync(
    cli,
    [
      ...(noDaemon ? ['--no-daemon'] : []),
      '--json',
      ...(project ? ['--project', project] : []),
      ...args,
    ],
    {
      env: {
        ...baseline,
        NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
        NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-505-${process.pid}-${native ? 'native' : 'legacy'}`,
        NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
          root,
          native ? 'native-daemon' : 'legacy-daemon',
        ),
      },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  assert.ifError(run.error);
  assert.ok(run.stdout.trim(), `${args.join(' ')} had no JSON response: ${run.stderr}`);
  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch {
    throw new Error(`Invalid public CLI JSON: ${args.join(' ')}\n${run.stdout}\n${run.stderr}`);
  }
  assert.equal(run.status, response.exitCode, `${args.join(' ')}: ${run.stdout}\n${run.stderr}`);
  return response;
}

function normalized(value) {
  if (typeof value === 'string')
    return value.replaceAll(legacy, '<project>').replaceAll(candidate, '<project>');
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'protocolVersion')
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}

let verified = 0;
function compare(args, expectSuccess = true, noDaemon = true) {
  const oracle = execute(legacy, false, args, noDaemon);
  const result = execute(candidate, true, args, noDaemon);
  assert.deepEqual(
    normalized(result),
    normalized(oracle),
    `Native CLI command diverged: ${args.join(' ')}`,
  );
  if (expectSuccess) assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  else assert.equal(result.success, false);
  verified += 1;
  return result;
}

try {
  const name = 'Native Parity Workspace';
  const oracle = execute(null, false, ['project', 'create', legacy, '--name', name]);
  const native = execute(null, true, ['project', 'create', candidate, '--name', name]);
  assert.deepEqual(normalized(native), normalized(oracle));
  verified += 1;

  compare(['asset', 'audit']);
  compare(['localization', 'sync', '--dry-run']);
  compare(['fmt', '--check']);
  compare(['entity', 'create', 'rooms', 'intro', '--dry-run']);
  compare(['entity', 'create', 'rooms', 'intro']);
  compare(['entity', 'inspect', 'rooms', 'intro']);
  compare(['usages', 'rooms', 'intro']);
  compare(['entity', 'rename', 'rooms', 'intro', 'other', '--dry-run']);
  compare(['entity', 'delete', 'rooms', 'intro', '--dry-run']);
  compare(['localization', 'sync']);

  const input = path.join(root, 'source.txt');
  await writeFile(input, 'NovelTea native CLI Project input.\n');
  compare(['asset', 'import', input, '--dry-run']);
  compare(['asset', 'import', input]);
  assert.deepEqual(
    await readFile(path.join(candidate, 'assets/text/source.txt')),
    await readFile(path.join(legacy, 'assets/text/source.txt')),
    'Candidate Asset import published different source bytes.',
  );
  compare(['entity', 'inspect', 'rooms', 'missing'], false);

  // Daemon transport must reach the same native Project authority without
  // changing public output, including successive owner reads after a write.
  compare(['entity', 'inspect', 'rooms', 'intro'], true, false);
  compare(['usages', 'rooms', 'intro'], true, false);

  // A malformed sibling source must fail at the actual physical YAML owner,
  // not at the requested record's path, even if that requested record is valid.
  for (const project of [legacy, candidate])
    await writeFile(path.join(project, 'records/rooms/intro.yaml'), 'broken: [\n');
  compare(['entity', 'inspect', 'scripts', 'bootstrap'], false);

  console.log(`Native CLI Project routing differential PASSED: ${verified} public commands.`);
} finally {
  // Both independently configured certification daemons must be stopped;
  // otherwise comparing responses could accidentally reuse the legacy owner.
  for (const native of [false, true]) {
    try {
      execute(null, native, ['daemon', 'stop'], false);
    } catch {
      // Preserve the original assertion failure; removal still happens.
    }
  }
  await rm(root, { recursive: true, force: true });
}
