// #505 certification: run the installed public transport against the legacy
// oracle and the native-authoritative candidate on disposable Projects.
// No runtime flag is enabled for production callers by this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCertificationRoot } from './certification-temp-root.mjs';
import { normalizeCertificationPathAliases } from './certification-path-aliases.mjs';

const cli = path.resolve(process.argv[2] ?? 'build/cli/linux/noveltea');
const fixture = path.resolve(process.argv[3] ?? 'tests/projects/feature-lab');
const legacyOracleCli = path.resolve(process.argv[4] ?? cli);
const root = await createCertificationRoot('noveltea-cli-native-routing-');
const realRoot = await realpath(root);
const legacy = path.join(root, 'legacy');
const candidate = path.join(root, 'candidate');
const fixtureLegacy = path.join(root, 'fixture-legacy');
const fixtureCandidate = path.join(root, 'fixture-native');
const pathAliases = [
  [legacy, path.join(realRoot, 'legacy'), '<project>'],
  [candidate, path.join(realRoot, 'candidate'), '<project>'],
  [fixtureLegacy, path.join(realRoot, 'fixture-legacy'), '<fixture>'],
  [fixtureCandidate, path.join(realRoot, 'fixture-native'), '<fixture>'],
];
const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = {
  ...process.env,
  NOVELTEA_CLI_CERTIFICATION: '1',
};

function execute(project, native, args, noDaemon = true) {
  const argv = [
    ...(noDaemon ? ['--no-daemon'] : []),
    '--json',
    ...(project ? ['--project', project] : []),
    ...args,
  ];
  const env = {
    ...baseline,
    NOVELTEA_CLI_CERTIFICATION_NATIVE_LIFECYCLE: native ? '1' : '0',
    NOVELTEA_CLI_CERTIFICATION_POISON_LEGACY_WORKSPACE: native ? '1' : '0',
    NOVELTEA_CLI_CERTIFICATION_DAEMON_ID: `noveltea-505-${process.pid}-${native ? 'native' : 'legacy'}`,
    NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT: path.join(
      root,
      native ? 'native-daemon' : 'legacy-daemon',
    ),
  };
  const run = spawnSync(native ? cli : legacyOracleCli, argv, {
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
  assert.ifError(run.error);
  assert.ok(
    run.stdout.trim(),
    `${native ? 'native' : 'legacy'} ${args.join(' ')} had no JSON response (status=${run.status}, signal=${run.signal ?? 'none'}, error=${run.error?.message ?? 'none'}): ${run.stderr}`,
  );
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
  if (typeof value === 'string') return normalizeCertificationPathAliases(value, pathAliases);
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'protocolVersion')
      .map(([key, entry]) => [key, normalized(entry)]),
  );
}
// Shader paths in CLI JSON use forward slashes even on Windows. Certify that
// the comparison erases only the disposable root, not a genuine output diff.
assert.equal(
  normalized(
    path.join(fixtureCandidate, '.noveltea', 'build', 'example.bin').replaceAll('\\', '/'),
  ),
  '<fixture>/.noveltea/build/example.bin',
);
assert.equal(
  normalized(path.join(fixtureLegacy, '.noveltea', 'build', 'example.bin')),
  '<fixture>' + path.sep + '.noveltea' + path.sep + 'build' + path.sep + 'example.bin',
);
assert.equal(
  normalized(path.join(realRoot, 'fixture-native', '.noveltea', 'build', 'example.bin')),
  '<fixture>' + path.sep + '.noveltea' + path.sep + 'build' + path.sep + 'example.bin',
);

let verified = 0;
function compare(args, expectSuccess = true, noDaemon = true, projects = [legacy, candidate]) {
  const oracle = execute(projects[0], false, args, noDaemon);
  const result = execute(projects[1], true, args, noDaemon);
  assert.deepEqual(
    normalized(result),
    normalized(oracle),
    `Native CLI command diverged: ${args.join(' ')}`,
  );
  if (expectSuccess === true)
    assert.equal(result.success, true, JSON.stringify(result.diagnostics));
  else if (expectSuccess === false) assert.equal(result.success, false);
  verified += 1;
  console.log(`  ${verified}: ${noDaemon ? 'cold' : 'daemon'} ${args.join(' ')}`);
  return result;
}

try {
  const name = 'Native Parity Workspace';
  const oracle = execute(null, false, ['project', 'create', legacy, '--name', name]);
  const native = execute(null, true, ['project', 'create', candidate, '--name', name]);
  assert.deepEqual(normalized(native), normalized(oracle));
  verified += 1;
  console.log(`  ${verified}: cold project create`);

  compare(['asset', 'audit']);
  compare(['platform', 'profiles']);
  compare(['shaders', 'compile', '--variant', 'essl-300']);
  compare(['shaders', 'compile', '--variant', 'unsupported'], false);
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
  compare(['entity', 'inspect', 'rooms', 'intro'], true, false);
  for (const project of [legacy, candidate]) {
    const source = path.join(project, 'records/rooms/intro.yaml');
    await writeFile(
      source,
      (await readFile(source, 'utf8')) + '\n# Native owner changed-source proof\n',
    );
  }
  compare(['entity', 'inspect', 'rooms', 'intro'], true, false);
  compare(['usages', 'rooms', 'intro'], true, false);
  compare(['platform', 'profiles'], true, false);

  // A malformed sibling source must fail at the actual physical YAML owner,
  // not at the requested record's path. The native candidate's scoped-read
  // semantics intentionally improve on the legacy all-record admission:
  // an unrelated malformed Room must not prevent inspection of a Script.
  for (const project of [legacy, candidate])
    await writeFile(path.join(project, 'records/rooms/intro.yaml'), 'broken: [\n');
  const isolatedArgs = ['entity', 'inspect', 'scripts', 'bootstrap'];
  const legacyIsolated = execute(legacy, false, isolatedArgs, false);
  const nativeIsolated = execute(candidate, true, isolatedArgs, false);
  // The retired resident owner can retain an already coherent read generation,
  // while its cold all-record admission reports the malformed sibling. Either
  // oracle result is legitimate here, but it may never return a wrong Script.
  assert.ok([0, 3].includes(legacyIsolated.exitCode));
  if (legacyIsolated.exitCode === 3)
    assert.ok(legacyIsolated.diagnostics.some((item) => item.path === '/records/rooms/intro.yaml'));
  else assert.equal(legacyIsolated.record?.id, 'bootstrap');
  assert.equal(nativeIsolated.success, true, JSON.stringify(nativeIsolated.diagnostics));
  assert.equal(nativeIsolated.record?.id, 'bootstrap');
  verified += 1;
  console.log(`  ${verified}: native isolated Script read with unrelated malformed Room`);
  // Scoped platform discovery must likewise ignore unrelated broken records
  // without falling through to the retired TypeScript Project authority.
  compare(['platform', 'profiles'], true, false);

  // Populate both owners with the authored Feature Lab fixture. These real
  // families include cross-record refs, sparse fields, locale fragments and
  // nontrivial usages that the public blank scaffold cannot exercise.
  await Promise.all([
    cp(fixture, fixtureLegacy, { recursive: true }),
    cp(fixture, fixtureCandidate, { recursive: true }),
  ]);
  const family = (command, success = true) =>
    compare(command, success, false, [fixtureLegacy, fixtureCandidate]);
  family(['entity', 'inspect', 'rooms', 'room-lifecycle-roundtrip']);
  family(['entity', 'inspect', 'rooms', 'room-lifecycle-roundtrip']);
  for (const project of [fixtureLegacy, fixtureCandidate]) {
    const source = path.join(project, 'records/rooms/room-lifecycle-roundtrip.yaml');
    await writeFile(
      source,
      (await readFile(source, 'utf8')) + '\n# Native owner changed-source proof\n',
    );
  }
  family(['entity', 'inspect', 'rooms', 'room-lifecycle-roundtrip']);
  family(['entity', 'inspect', 'characters', 'pilot-guide']);
  family(['entity', 'inspect', 'materials', 'engine2d-draw-contract']);
  family(['entity', 'inspect', 'variables', 'world-composition-enabled']);
  family(['platform', 'profiles']);
  family(['usages', 'rooms', 'room-lifecycle-roundtrip']);
  family(['usages', 'assets', 'pilot-room-backdrop']);
  // The collection list is generated from the Project schema inventory, not
  // manually frozen at the handful of families covered by earlier CLI tests.
  const collectionSource = await readFile(
    path.join(editorRoot, 'src/shared/project-schema/authoring-collections.ts'),
    'utf8',
  );
  const collections = collectionSource.match(
    /export const authoringCollectionKeys = \[([^\]]+)\]/s,
  );
  assert.ok(collections, 'Cannot read generated authoring collection inventory.');
  for (const [, collection] of collections[1].matchAll(/'([^']+)'/g)) {
    const directory = path.join(fixtureLegacy, 'records', collection);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const source = entries.find((entry) => entry.isFile() && entry.name.endsWith('.yaml'));
    const grouped = entries.find((entry) => entry.isDirectory());
    let id = source?.name.slice(0, -'.yaml'.length) ?? grouped?.name;
    if (!id) {
      id = `native-519-${collection}`;
      family(['entity', 'create', collection, id, '--dry-run']);
      family(['entity', 'create', collection, id]);
    }
    family(['entity', 'inspect', collection, id]);
    family(['usages', collection, id]);
  }
  // Non-record Project owners are as important as JSON record families:
  // retain manifests, Traits, editor metadata and split locale/tracking YAML.
  for (const source of [
    'project.yaml',
    'traits.yaml',
    'editor.yaml',
    'i18n/project.yaml',
    'i18n/messages.yaml',
    'i18n/tracking.yaml',
    'i18n/orphans.yaml',
  ]) {
    const oracleBytes = await readFile(path.join(fixtureLegacy, source));
    assert.deepEqual(await readFile(path.join(fixtureCandidate, source)), oracleBytes);
    family(['fmt', source, '--check'], null);
  }
  family(['localization', 'view', 'fr']);
  family(['localization', 'sync', '--dry-run']);
  family(['entity', 'create', 'variables', 'native-cutover-dry-run', '--dry-run']);
  family(['fmt', 'project.yaml', '--check']);
  // Verify both local and daemon generation-pinned compilation. Daemon preparation
  // belongs to the resident owner, not a disposable worker reopening current disk.
  compare(['shaders', 'compile', '--variant', 'essl-300'], true, true, [
    fixtureLegacy,
    fixtureCandidate,
  ]);
  compare(['shaders', 'compile', '--variant', 'essl-300'], true, false, [
    fixtureLegacy,
    fixtureCandidate,
  ]);
  // Source generation must advance for shader bytes and non-.sc includes in
  // both transports; a warmed owner must never compile its previous generation.
  for (const project of [fixtureLegacy, fixtureCandidate]) {
    const stage = path.join(project, 'shaders/lab-grade.fs.sc');
    await writeFile(stage, `${await readFile(stage, 'utf8')}\n// revised generation\n`);
    await writeFile(
      path.join(project, 'shaders/native-routing-probe.sh'),
      '// included inventory\n',
    );
  }
  compare(['shaders', 'compile', '--variant', 'essl-300'], true, true, [
    fixtureLegacy,
    fixtureCandidate,
  ]);
  compare(['shaders', 'compile', '--variant', 'essl-300'], true, false, [
    fixtureLegacy,
    fixtureCandidate,
  ]);

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
