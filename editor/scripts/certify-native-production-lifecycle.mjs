// #534/#522: independent native command contracts. The candidate mode verifies
// only the native ScriptC island; production mode additionally requires every
// editor/CLI output to have passed the coordinated #521 retirement gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';
import {
  assertProductionInputs,
  checkProductionJsonCommand,
  isolatedProductionEnvironment,
  readPortableZipMembers,
} from './native-production-qualification.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
// Use the checked native-generated record source inventory, not a runtime
// import of the retired/renderer schema authoring implementation.
const generatedContracts = JSON.parse(
  await readFile(
    path.join(repositoryRoot, 'tools/project_authoring/generated/contracts.json'),
    'utf8',
  ),
);
const authoringCollectionKeys = [
  'assets',
  ...Object.keys(generatedContracts.entityRecordSources),
].sort();
assert.equal(
  new Set(authoringCollectionKeys).size,
  16,
  'Generated record family inventory changed.',
);
const candidateMode = process.argv[3] === '--candidate';
const executable = process.argv[2];
if (!executable || process.argv.length > (candidateMode ? 4 : 3))
  throw new Error(
    'Usage: node certify-native-production-lifecycle.mjs <installed-cli> [--candidate]',
  );
const cli = path.resolve(executable);
await assertProductionInputs(cli);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
assert.ifError(revision.error);
assert.equal(revision.status, 0, 'Qualification requires an identifiable source revision.');
assert.match(revision.stdout.trim(), /^[a-f0-9]{40}$/, 'Invalid source revision.');
const cliSha256 = createHash('sha256')
  .update(await readFile(cli))
  .digest('hex');

const artifacts = candidateMode
  ? [path.join(editorRoot, 'dist-scriptc-native-island')]
  : [
      ...['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((name) =>
        path.join(editorRoot, 'dist-electron', name),
      ),
      path.join(editorRoot, 'dist-scriptc-island'),
    ];
// No production eligibility can be inferred from a candidate-only run, or a
// build which omits a provenance artifact for a lazy/worker chunk.
for (const artifact of artifacts) {
  assert.ok(
    (
      await stat(path.join(artifact, 'native-production-provenance.json')).catch(() => null)
    )?.isFile(),
    `Missing current production module evidence: ${artifact}`,
  );
}
const violations = await verifyNativeProductionClosure(artifacts, {
  requireManifestRoots: artifacts,
});
assert.deepEqual(
  violations,
  [],
  `Native ${candidateMode ? 'candidate' : 'production'} provenance is incomplete:\n${violations.join('\n')}`,
);

const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-522-production-'));
const home = path.join(scratch, 'home');
const environment = isolatedProductionEnvironment(process.env, home);
const project = path.join(scratch, 'feature-lab');
const imported = path.join(scratch, 'reimported');
const stages = [];
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function run(projectRoot, command, daemon = false) {
  const argv = [
    ...(daemon ? [] : ['--no-daemon']),
    '--json',
    ...(projectRoot ? ['--project', projectRoot] : []),
    ...command,
  ];
  const began = performance.now();
  const result = checkProductionJsonCommand(cli, argv, {
    env: environment,
    cwd: scratch,
    timeout: 300_000,
  });
  stages.push({
    command: command.join(' '),
    daemon,
    milliseconds: Math.round(performance.now() - began),
  });
  return result;
}

function expectSuccess(result, label) {
  assert.equal(result.success, true, `${label}: ${JSON.stringify(result.diagnostics)}`);
  return result;
}

function assertArchiveSources(members) {
  const manifest = JSON.parse(members.get('ntproject.json')?.toString('utf8') ?? 'null');
  assert.equal(manifest?.schema, 'noveltea.project.bundle');
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    [...members.keys()].sort((a, b) => a.localeCompare(b)),
    ['ntproject.json', ...manifest.files.map((item) => item.path)].sort((a, b) =>
      a.localeCompare(b),
    ),
    'Portable Project members must equal the explicit source inventory.',
  );
  for (const item of manifest.files)
    assert.equal(sha(members.get(item.path)), item.sha256, `Portable source changed: ${item.path}`);
  assert.equal(
    [...members.keys()].some((name) => name.startsWith('.noveltea/') || name.startsWith('.git/')),
    false,
    'Local recovery, cache or VCS metadata leaked into editable transport.',
  );
}

try {
  await mkdir(path.join(home, 'runtime'), { recursive: true, mode: 0o700 });
  await cp(path.join(repositoryRoot, 'tests/projects/feature-lab'), project, { recursive: true });
  // A fresh cold admission must not borrow an existing Project cache from the
  // fixture checkout; the copied Project alone is writable.
  await rm(path.join(project, '.noveltea/cache'), { recursive: true, force: true });

  const cold = expectSuccess(run(project, ['validate']), 'cold Feature Lab validation');
  const cacheFile = path.join(project, '.noveltea/cache/authoring/native-clean-current.json');
  const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
  assert.equal(cache.contract, 'noveltea.native-clean-validation.v1');
  assert.ok(cache.semanticKey && cache.semanticFingerprint);
  assert.equal(
    cache.revisions['project.yaml'],
    sha(await readFile(path.join(project, 'project.yaml'))),
    'Cold cache lacks exact Project source proof.',
  );
  const warm = expectSuccess(
    run(project, ['validate'], true),
    'warm independent daemon validation',
  );
  assert.deepEqual(
    warm.diagnostics,
    cold.diagnostics,
    'Local and daemon Project diagnostics differ.',
  );
  expectSuccess(run(project, ['validate']), 'reused native clean validation');
  await writeFile(cacheFile, '{ corrupt disposable cache');
  expectSuccess(run(project, ['validate']), 'corrupt native clean-cache regeneration');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).contract, cache.contract);

  // Incremental validation uses exact source evidence for both sparse YAML
  // records and directly tracked Lua without changing semantic gameplay.
  const yamlPath = path.join(project, 'records/rooms/world-composition.yaml');
  const yamlBefore = await readFile(yamlPath);
  await writeFile(yamlPath, `${yamlBefore.toString('utf8')}\n# qualification YAML source edit\n`);
  expectSuccess(run(project, ['validate']), 'changed Room YAML validation');
  assert.equal(
    JSON.parse(await readFile(cacheFile, 'utf8')).revisions['records/rooms/world-composition.yaml'],
    sha(await readFile(yamlPath)),
  );
  await writeFile(yamlPath, yamlBefore);

  const luaPath = path.join(project, 'scripts/feature-lab-bootstrap.lua');
  const luaBefore = await readFile(luaPath);
  await writeFile(luaPath, `${luaBefore.toString('utf8')}\n-- qualification Lua source edit\n`);
  expectSuccess(run(project, ['validate']), 'changed Lua source validation');
  assert.equal(
    JSON.parse(await readFile(cacheFile, 'utf8')).revisions['scripts/feature-lab-bootstrap.lua'],
    sha(await readFile(luaPath)),
  );
  await writeFile(luaPath, luaBefore);
  expectSuccess(run(project, ['validate']), 'restored tracked source validation');

  const included = [];
  const missing = [];
  for (const collection of authoringCollectionKeys) {
    const ownerDir = path.join(project, 'records', collection);
    const entries = await readdir(ownerDir, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sample = entries.find((entry) =>
      collection === 'layouts'
        ? entry.isDirectory()
        : entry.isFile() && entry.name.endsWith('.yaml'),
    );
    if (!sample) {
      missing.push(collection);
      continue;
    }
    const id = collection === 'layouts' ? sample.name : sample.name.slice(0, -'.yaml'.length);
    const inspected = expectSuccess(
      run(project, ['entity', 'inspect', collection, id]),
      `Feature Lab ${collection}/${id} inspect`,
    );
    assert.equal(inspected.record?.id, id, `Wrong public ${collection} record.`);
    included.push(collection);
  }
  assert.ok(included.length >= 14, 'Feature Lab record-family inventory unexpectedly shrank.');

  const archive = path.join(scratch, 'feature-lab.ntproject');
  expectSuccess(
    run(project, ['project', 'export', '--output', archive]),
    'editable Project export',
  );
  assertArchiveSources(readPortableZipMembers(await readFile(archive)));
  expectSuccess(run(null, ['project', 'import', archive, imported]), 'editable Project import');
  expectSuccess(run(imported, ['validate']), 'imported Project reopen and validation');
  const originalManifest = await readFile(path.join(project, 'project.yaml'));
  assert.deepEqual(await readFile(path.join(imported, 'project.yaml')), originalManifest);

  const packagePath = path.join(scratch, 'feature-lab.ntpkg');
  const publication = expectSuccess(
    run(project, ['package', 'export', '--allow-localization-warnings', '--output', packagePath]),
    'Feature Lab Runtime Package export',
  );
  assert.ok(publication.native?.manifest && publication.native?.checksums);
  const compiled = JSON.parse(
    readPortableZipMembers(await readFile(packagePath))
      .get('game')
      ?.toString('utf8') ?? 'null',
  );
  assert.equal(compiled?.project?.name, 'Feature Lab', 'Runtime Package gameplay readback failed.');

  // These are real authored native runtime and UI Test runner invocations,
  // not schema-only Test-record validation.
  expectSuccess(
    run(project, ['test', 'run', 'script-and-data-flow']),
    'Feature Lab authored runtime Test playback',
  );
  expectSuccess(
    run(project, ['test', 'run', 'layout-counter-ui']),
    'Feature Lab authored UI Test playback',
  );

  // A malformed required source must never use a validated warm cache. Its
  // repaired exact bytes should recover without adopting the invalid data.
  await writeFile(path.join(project, 'project.yaml'), 'schemaVersion: [invalid\n');
  const rejected = run(project, ['validate']);
  assert.equal(rejected.success, false, 'Malformed required manifest unexpectedly admitted.');
  assert.ok(
    rejected.diagnostics.some((diagnostic) => diagnostic.code && diagnostic.path),
    'Malformed Project had no structured source diagnostics.',
  );
  await writeFile(path.join(project, 'project.yaml'), originalManifest);
  expectSuccess(run(project, ['validate']), 'recovered Project after invalid required source');

  console.log(
    JSON.stringify({
      contract: candidateMode
        ? 'noveltea.native-candidate-contracts'
        : 'noveltea.native-production-smoke',
      version: 1,
      status: 'passed-smoke-not-complete-qualification',
      sourceRevision: revision.stdout.trim(),
      cliSha256,
      host: { platform: process.platform, arch: process.arch, node: process.version },
      recordFamiliesCovered: included,
      recordFamiliesMissingFromFixture: missing,
      stages,
    }),
  );
} finally {
  // Daemon control is a real production command, scoped to the disposable
  // HOME and runtime root. Never stop the user's ordinary resident daemon.
  try {
    run(null, ['daemon', 'stop'], true);
  } catch {
    // Preserve the primary qualification error.
  }
  await rm(scratch, { recursive: true, force: true });
}
