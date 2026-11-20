#!/usr/bin/env node
// Canonical producer/consumer boundary for immutable, Build-qualified binaries.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT = 'noveltea-release-candidate';
const VERSION = 1;
const MANIFEST = 'noveltea-candidate.json';
const GENERATED_SCHEMA = 'candidate-generated-contracts.json';
const TRUSTED_REPOSITORY = 'Cruel/nt';
const TRUSTED_WORKFLOW = '.github/workflows/build.yml';
const HEX_SHA = /^[0-9a-f]{40}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function demand(condition, description) {
  if (!condition) throw new Error(description);
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function pinIdentity(root, files) {
  const identity = {};
  for (const name of files) {
    demand(typeof name === 'string' && !path.isAbsolute(name) && !name.split('/').includes('..'),
      'Invalid dependency/schema pin path.');
    identity[name] = await digest(path.join(root, name));
  }
  return identity;
}

async function listFiles(root, subdir = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, subdir), { withFileTypes: true })) {
    const relative = path.posix.join(subdir, entry.name);
    demand(!entry.isSymbolicLink(), `Artifact symbolic link is not supported: ${relative}`);
    demand(!relative.split('/').some((part) => part.startsWith('.')),
      `Hidden artifact paths cannot be uploaded by the current workflow: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else {
      demand(entry.isFile(), `Unsupported artifact entry: ${relative}`);
      if (relative !== MANIFEST) {
        const file = path.join(root, relative);
        files.push({ path: relative, size: (await stat(file)).size, sha256: await digest(file) });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function compare(label, actual, wanted) {
  demand(actual === wanted, `${label} mismatch: expected '${wanted}', received '${actual}'.`);
}

function validateCandidateShape(candidate) {
  demand(candidate && typeof candidate.id === 'string' && candidate.id.length > 0, 'Candidate ID is required.');
  for (const name of ['target', 'variant', 'preset', 'compilerId', 'abiFloor', 'artifactName', 'executable']) {
    demand(typeof candidate[name] === 'string' && candidate[name].length > 0,
      `Candidate ${name} is required.`);
  }
}

function validateProducer(producer) {
  demand(producer && producer.repository === TRUSTED_REPOSITORY, 'Producer repository is not trusted.');
  demand(producer.workflow === 'Build' && producer.workflowPath === TRUSTED_WORKFLOW,
    'Producer workflow is not Build.');
  demand(Number.isSafeInteger(producer.runId) && producer.runId > 0, 'Invalid producer run ID.');
  demand(Number.isSafeInteger(producer.runAttempt) && producer.runAttempt > 0, 'Invalid producer attempt.');
  demand(['push', 'pull_request', 'workflow_dispatch'].includes(producer.event), 'Invalid producer event.');
  demand(typeof producer.ref === 'string' && producer.ref.startsWith('refs/'), 'Invalid producer ref.');
}

function validateCompiler(compiler, candidate) {
  demand(compiler && compiler.id === candidate.compilerId, 'Compiler identity mismatch.');
  demand(/^\d+(?:\.\d+)+$/.test(compiler.version), 'Compiler version is missing or unpinned.');
  compare('compiler preset', compiler.preset, candidate.preset);
  demand(typeof compiler.toolchain === 'string' && compiler.toolchain.length > 0, 'Toolchain identity is missing.');
  demand(compiler.buildType === 'Release', 'Release candidate must use Release build type.');
  demand(typeof compiler.flags === 'string' && compiler.flags.includes('-O3') &&
    compiler.flags.includes('-DNDEBUG'), 'Optimized compiler flags are required.');
  if (candidate.compilerVersion) compare('compiler version', compiler.version, candidate.compilerVersion);
  if (candidate.compilerFlags) compare('compiler flags', compiler.flags, candidate.compilerFlags);
  if (candidate.toolchain) compare('compiler toolchain', compiler.toolchain, candidate.toolchain);
}

export async function produceCandidate({
  root, repoRoot, candidate, sourceSha, producer, compiler, generatedSchema,
}) {
  validateCandidateShape(candidate);
  demand(HEX_SHA.test(sourceSha), 'Invalid source SHA.');
  validateProducer(producer);
  validateCompiler(compiler, candidate);
  demand(candidate.pinFiles?.length > 0 && candidate.schemaSources?.length > 0,
    'Candidate must identify dependency pins and schema sources.');
  demand((await stat(path.join(root, candidate.executable))).isFile(), 'CLI executable is missing.');
  for (const destination of [GENERATED_SCHEMA, MANIFEST]) {
    const existing = await lstat(path.join(root, destination)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    demand(!existing || existing.isFile(), `Candidate output must be a regular file: ${destination}`);
  }
  // Include the exact generated contract bytes in the artifact; consumers never trust a bare digest.
  await copyFile(generatedSchema, path.join(root, GENERATED_SCHEMA));
  const manifest = {
    format: FORMAT,
    version: VERSION,
    candidateId: candidate.id,
    sourceSha,
    target: candidate.target,
    variant: candidate.variant,
    artifactName: candidate.artifactName,
    producer: { ...producer },
    compiler: { ...compiler },
    abi: { floor: candidate.abiFloor },
    dependencies: await pinIdentity(repoRoot, candidate.pinFiles),
    schema: {
      sources: await pinIdentity(repoRoot, candidate.schemaSources),
      generatedFile: GENERATED_SCHEMA,
      generatedSha256: await digest(path.join(root, GENERATED_SCHEMA)),
    },
    files: await listFiles(root),
  };
  await writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyCandidate(manifest, {
  root, repoRoot, candidate, sourceSha, producer, compiler,
}) {
  validateCandidateShape(candidate);
  demand(manifest?.format === FORMAT && manifest.version === VERSION,
    'Unsupported candidate manifest format/version.');
  demand(HEX_SHA.test(manifest.sourceSha), 'Invalid candidate source SHA.');
  compare('source SHA', manifest.sourceSha, sourceSha);
  compare('candidate ID', manifest.candidateId, candidate.id);
  compare('target', manifest.target, candidate.target);
  compare('variant', manifest.variant, candidate.variant);
  compare('artifact name', manifest.artifactName, candidate.artifactName);
  compare('ABI floor', manifest.abi?.floor, candidate.abiFloor);
  validateProducer(manifest.producer);
  if (producer) {
    for (const key of Object.keys(producer)) compare(`producer ${key}`, manifest.producer[key], producer[key]);
  }
  validateCompiler(manifest.compiler, candidate);
  if (compiler) {
    for (const key of Object.keys(compiler)) compare(`compiler ${key}`, manifest.compiler[key], compiler[key]);
  }
  const deps = await pinIdentity(repoRoot, candidate.pinFiles);
  demand(JSON.stringify(manifest.dependencies) === JSON.stringify(deps),
    'Dependency identity mismatch: source-controlled pins changed.');
  const sources = await pinIdentity(repoRoot, candidate.schemaSources);
  demand(JSON.stringify(manifest.schema?.sources) === JSON.stringify(sources),
    'Generated schema source identity mismatch.');
  compare('schema file', manifest.schema.generatedFile, GENERATED_SCHEMA);
  demand(HEX_DIGEST.test(manifest.schema.generatedSha256), 'Generated schema hash is malformed.');
  compare('generated schema', await digest(path.join(root, GENERATED_SCHEMA)), manifest.schema.generatedSha256);
  demand(Array.isArray(manifest.files) && manifest.files.length > 0,
    'Manifest must include hashed artifact files.');
  for (const entry of manifest.files) {
    demand(typeof entry.path === 'string' && entry.path !== MANIFEST &&
      !entry.path.startsWith('/') && !entry.path.split('/').includes('..') &&
      Number.isSafeInteger(entry.size) && entry.size >= 0 && HEX_DIGEST.test(entry.sha256),
      'Invalid artifact file entry.');
  }
  const files = await listFiles(root);
  compare('artifact file count (missing or unexpected file)', files.length, manifest.files.length);
  for (let index = 0; index < files.length; index += 1) {
    compare('artifact path (missing or unexpected file)', files[index].path, manifest.files[index].path);
    compare(`artifact size ${files[index].path}`, files[index].size, manifest.files[index].size);
    compare(`artifact hash ${files[index].path}`, files[index].sha256, manifest.files[index].sha256);
  }
  return manifest;
}

// This is only the semantic trust check. The promotion CLI retrieves this record from
// GitHub's authenticated API, not from candidate-supplied bytes or a JSON file argument.
export function verifyTrustedProducerRun(manifest, run) {
  const producer = manifest.producer;
  validateProducer(producer);
  demand(producer.event === 'push' && producer.ref === 'refs/heads/master',
    'Only trusted master push Build candidates may be promoted.');
  demand(run?.id === producer.runId && run.run_attempt === producer.runAttempt,
    'Trusted producer run/attempt mismatch.');
  demand(run.name === 'Build' && run.path === TRUSTED_WORKFLOW,
    'Trusted producer workflow mismatch.');
  demand(run.repository?.full_name === TRUSTED_REPOSITORY &&
    run.head_repository?.full_name === TRUSTED_REPOSITORY,
    'Trusted producer source repository mismatch.');
  demand(run.head_sha === manifest.sourceSha && run.event === 'push' &&
    run.head_branch === 'master', 'Trusted producer revision/branch mismatch.');
  demand(run.status === 'completed' && run.conclusion === 'success',
    'Trusted producer Build is not successfully completed.');
  return true;
}

async function fetchTrustedRun(manifest) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  demand(token, 'Promoting candidates requires GH_TOKEN to query the trusted Build run.');
  const url = `https://api.github.com/repos/${TRUSTED_REPOSITORY}/actions/runs/${manifest.producer.runId}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  demand(response.ok, `Cannot independently verify producer run (HTTP ${response.status}).`);
  return response.json();
}

export function verifyBuiltCliIdentity(info, sourceSha) {
  demand(info?.success === true, 'CLI build identity probe failed.');
  compare('compiled CLI build identity', info.daemon?.build, `git:${sourceSha}`);
  return true;
}

function probeBuiltCliIdentity(root, candidate, sourceSha) {
  const output = execFileSync(path.join(root, candidate.executable),
    ['--no-daemon', '--json', 'daemon', 'status'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  verifyBuiltCliIdentity(JSON.parse(output), sourceSha);
}

function gitSha(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function requireCleanTrackedSource(repoRoot) {
  for (const args of [['diff', '--quiet'], ['diff', '--cached', '--quiet']]) {
    try {
      execFileSync('git', args, { cwd: repoRoot, stdio: 'ignore' });
    } catch {
      throw new Error('Candidate source contains uncommitted tracked changes; rebuild from a clean SHA.');
    }
  }
}

function compilerFromCmake(buildDirectory, candidate) {
  const fs = execFileSync('cmake', ['--version'], { encoding: 'utf8' }); // Verify the host has CMake.
  demand(fs.includes('cmake version'), 'CMake not installed.');
  return Promise.all([
    readFile(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8'),
    readdir(path.join(buildDirectory, 'CMakeFiles')),
  ]).then(async ([cache, dirs]) => {
    const values = Object.fromEntries(
      cache.split('\n').map((line) => /^([^#/:]+):[^=]+=(.*)$/.exec(line)).filter(Boolean)
        .map((match) => [match[1], match[2]]),
    );
    const versionDir = dirs.find((name) => /^\d+\.\d+/.test(name));
    demand(versionDir, 'CMake compiler identification directory is missing.');
    const identification = await readFile(path.join(buildDirectory, 'CMakeFiles', versionDir, 'CMakeCXXCompiler.cmake'), 'utf8');
    const id = /set\(CMAKE_CXX_COMPILER_ID "([^"]+)"\)/.exec(identification)?.[1];
    const version = /set\(CMAKE_CXX_COMPILER_VERSION "([^"]+)"\)/.exec(identification)?.[1];
    const compiler = {
      id,
      version,
      toolchain: values.CMAKE_CXX_COMPILER,
      buildType: values.CMAKE_BUILD_TYPE,
      flags: values.CMAKE_CXX_FLAGS_RELEASE,
      preset: candidate.preset,
    };
    validateCompiler(compiler, candidate);
    return compiler;
  });
}

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  demand(['produce', 'verify'].includes(verb), 'Usage: release-candidate.mjs produce|verify --candidate <id> [--stage qualify|promote]');
  const options = { verb };
  for (let i = 0; i < rest.length; i += 2) {
    demand(rest[i]?.startsWith('--') && rest[i + 1] && !rest[i + 1].startsWith('--'),
      `Invalid release-candidate option: ${rest[i]}`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = JSON.parse(await readFile(new URL('./release-candidates.json', import.meta.url), 'utf8'));
  demand(catalog.format === 'noveltea-candidate-catalog' && catalog.version === 1,
    'Invalid source-owned candidate catalog.');
  const candidate = catalog.candidates[args.candidate];
  validateCandidateShape(candidate);
  const root = path.resolve(scriptRoot, candidate.root);
  const sourceSha = gitSha(scriptRoot);
  if (process.env.GITHUB_SHA) compare('checked-out source SHA', sourceSha, process.env.GITHUB_SHA);
  const producer = {
    repository: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW,
    workflowPath: TRUSTED_WORKFLOW,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
  };
  const manifestFile = path.join(root, MANIFEST);
  if (args.verb === 'produce') {
    requireCleanTrackedSource(scriptRoot);
    demand(process.env.GITHUB_WORKFLOW_REF?.includes(`/${TRUSTED_WORKFLOW}@`),
      'Only the source-owned Build workflow can produce this candidate.');
    probeBuiltCliIdentity(root, candidate, sourceSha);
    await produceCandidate({
      root, repoRoot: scriptRoot, candidate, sourceSha, producer,
      compiler: await compilerFromCmake(path.join(scriptRoot, 'build', candidate.preset), candidate),
      generatedSchema: path.join(scriptRoot, 'build', candidate.preset,
        'tools/project_authoring/generated/contracts.json'),
    });
  } else {
    probeBuiltCliIdentity(root, candidate, sourceSha);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const stage = args.stage ?? 'qualify';
    demand(['qualify', 'promote'].includes(stage), 'Invalid verification stage.');
    await verifyCandidate(manifest, {
      root, repoRoot: scriptRoot, candidate, sourceSha,
      ...(stage === 'qualify' ? { producer } : {}),
    });
    if (stage === 'promote') verifyTrustedProducerRun(manifest, await fetchTrustedRun(manifest));
  }
  process.stdout.write(`Candidate ${candidate.id}: ${args.verb} succeeded for ${sourceSha}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Candidate contract rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
