import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { desktopArchiveName } from '../../scripts/ci/materialize-candidate-template.mjs';
import {
  compilerFromCmake,
  produceCandidate,
  resolveCatalogCandidate,
  verifyCandidate,
  verifyTrustedProducerRun,
  verifyPreviewCandidateRun,
} from '../../scripts/ci/release-candidate.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../scripts/ci/release-candidates.json', import.meta.url)));
const presets = JSON.parse(readFileSync(new URL('../../CMakePresets.json', import.meta.url)));
const temp = [];
afterEach(async () => Promise.all(temp.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

test('source-owned inventory separates all shippable platform/variant/ABI configurations', () => {
  const required = [
    'linux-host-cli-x64', 'linux-release-cli-x64', 'windows-release-cli-x64',
    'macos-release-cli-arm64',
    ...['linux', 'windows', 'macos'].flatMap((platform) =>
      ['release', 'devtools'].map((variant) =>
        `${platform}-player-${platform === 'macos' ? 'arm64' : 'x64'}-${variant}`)),
    ...['web-player-threads-release', 'web-player-no-threads-release',
      'web-player-threads-devtools', 'web-player-no-threads-devtools'],
    'linux-editor-x64', 'windows-editor-x64', 'macos-editor-arm64',
    'android-player-arm64-release', 'android-player-arm64-devtools',
    'android-player-x64-debug',
  ];
  assert.deepEqual(Object.keys(catalog.candidates).sort(), required.sort());
  const registered = new Set(presets.configurePresets.map((p) => p.name));
  const roots = new Set();
  const artifacts = new Set();
  for (const [id] of Object.entries(catalog.candidates)) {
    const candidate = resolveCatalogCandidate(catalog, id);
    assert.ok(registered.has(candidate.preset) || ['android-template', 'editor-package'].includes(candidate.kind),
      `${id}: preset missing`);
    assert.ok(candidate.pinFiles.length && candidate.schemaSources.length, id);
    for (const name of [...candidate.pinFiles, ...candidate.schemaSources, candidate.generatedSchema]) {
      if (name.startsWith('build/')) continue;
      assert.ok(readFileSync(new URL(`../../${name}`, import.meta.url)), `${id}: ${name}`);
    }
    // Ubuntu and Debian host CLIs have deliberately separate jobs/runner filesystems.
    if (candidate.root !== 'build/cli/linux')
      assert.ok(!roots.has(candidate.root), `shared artifact root: ${candidate.root}`);
    roots.add(candidate.root);
    assert.ok(!artifacts.has(candidate.artifactName), `shared artifact name: ${candidate.artifactName}`);
    artifacts.add(candidate.artifactName);
  }
  assert.equal(catalog.candidates['linux-player-x64-release'].abiFloor, 'glibc-2.28');
  assert.equal(catalog.candidates['linux-release-cli-x64'].abiFloor, 'glibc-2.36');
  assert.equal(catalog.candidates['linux-host-cli-x64'].abiFloor, 'glibc-2.39');
  assert.equal(catalog.candidates['windows-release-cli-x64'].compilerId, 'GNU');
  assert.equal(catalog.candidates['windows-player-x64-release'].compilerId, 'MSVC');
  assert.equal(catalog.candidates['macos-release-cli-arm64'].abiFloor, 'macos-14.0');
  assert.equal(catalog.candidates['macos-player-arm64-release'].abiFloor, 'macos-11.0');
  assert.equal(catalog.candidates['android-player-x64-debug'].tier, 'diagnostic');
  assert.equal(catalog.candidates['macos-editor-arm64'].abiFloor, 'macos-14.0');
});

test('Release preview consumers authenticate the original branch Build independently of their own workflow', () => {
  const sha = 'a'.repeat(40);
  const producer = {
    repository: 'Cruel/nt', workflow: 'Build', workflowPath: '.github/workflows/build.yml',
    runId: 404, runAttempt: 2, event: 'push', ref: 'refs/heads/ci/build-release-refactor-641',
  };
  const manifest = { producer, sourceSha: sha, tier: 'production' };
  const run = {
    id: 404, run_attempt: 2, name: 'Build', path: '.github/workflows/build.yml',
    repository: { full_name: 'Cruel/nt' }, head_repository: { full_name: 'Cruel/nt' },
    head_sha: sha, head_branch: 'ci/build-release-refactor-641', event: 'push',
    status: 'completed', conclusion: 'success',
  };
  assert.equal(verifyPreviewCandidateRun(manifest, run), true);
  assert.throws(() => verifyTrustedProducerRun(manifest, run), /master/);
  for (const update of [
    { head_sha: 'b'.repeat(40) }, { run_attempt: 3 }, { head_branch: 'master' },
    { conclusion: 'failure' }, { event: 'pull_request' },
    { head_repository: { full_name: 'fork/nt' } },
  ]) assert.throws(() => verifyPreviewCandidateRun(manifest, { ...run, ...update }));
  assert.throws(() => verifyPreviewCandidateRun({ ...manifest, producer: {
    ...producer, ref: 'refs/heads/master',
  } }, run));
});

test('runtime launch archives are reconstructed from verified production player trees', () => {
  const sha = 'f'.repeat(40);
  for (const [id, expected] of [
    ['linux-player-x64-release', `noveltea-player-template-dev-${sha}-linux-x64-release.tar.gz`],
    ['linux-player-x64-devtools', `noveltea-player-template-dev-${sha}-linux-x64-devtools.tar.gz`],
    ['windows-player-x64-release', `noveltea-player-template-dev-${sha}-windows-x64-release.zip`],
    ['macos-player-arm64-devtools', `noveltea-player-template-dev-${sha}-macos-arm64-devtools.tar.gz`],
  ]) {
    assert.equal(desktopArchiveName(resolveCatalogCandidate(catalog, id), sha), expected);
  }
  assert.throws(() => desktopArchiveName(resolveCatalogCandidate(catalog, 'web-player-threads-release'), sha),
    /native desktop/i);
  assert.throws(() => desktopArchiveName(resolveCatalogCandidate(catalog, 'linux-player-x64-release'), 'invalid'),
    /source SHA/i);
});

async function fixture({ kind, bytes, compilerId = 'GNU', buildType = 'Release', flags = '-O3 -DNDEBUG', tier } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nt-candidate-matrix-'));
  temp.push(base);
  const root = path.join(base, 'artifact');
  const repo = path.join(base, 'repo');
  await Promise.all([mkdir(root), mkdir(repo)]);
  await writeFile(path.join(root, 'binary'), bytes);
  await writeFile(path.join(repo, 'pin'), 'pinned');
  const source = path.join(base, 'schema');
  await writeFile(source, 'schema generated by source');
  const candidate = {
    id: 'fixture', kind, target: kind === 'web-player' ? 'web-wasm32-threads' :
      kind === 'android-template' ? 'android-arm64-v8a' : 'linux-x64-player',
    variant: 'standard', tier, artifactName: 'candidate-fixture',
    root, executable: 'binary', preset: 'test-release', compilerId, abiFloor: 'test-abi',
    buildType, pinFiles: ['pin'], schemaSources: ['pin'],
    ...(buildType === 'MinSizeRel' ? { optimization: '-Os' } : {}),
  };
  const producer = {
    repository: 'Cruel/nt', workflow: 'Build', workflowPath: '.github/workflows/build.yml',
    runId: 123, runAttempt: 1, ref: 'refs/heads/master', event: 'push',
  };
  const compiler = { id: compilerId, version: '19.1.0', toolchain: '/usr/bin/clang++',
    buildType, preset: candidate.preset, flags };
  const config = {
    root, repoRoot: repo, candidate, sourceSha: 'a'.repeat(40),
    producer, compiler, generatedSchema: source,
  };
  return config;
}

test('real-format Linux player and wasm bytes pass shared manifest/consumer hashing', async () => {
  for (const [kind, bytes, buildType, flags, compilerId] of [
    ['native-player', Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(32)]), 'Release', '-O3 -DNDEBUG', 'GNU'],
    ['web-player', Buffer.concat([Buffer.from('0061736d', 'hex'), Buffer.alloc(32)]), 'MinSizeRel', '-Os -DNDEBUG', 'Clang'],
  ]) {
    const fixtureConfig = await fixture({ kind, bytes, compilerId, buildType, flags });
    const manifest = await produceCandidate(fixtureConfig);
    assert.equal(manifest.compiler.buildType, buildType);
    assert.equal(manifest.tier, 'production');
    await verifyCandidate(manifest, fixtureConfig);
    const corrupted = Buffer.from(bytes);
    corrupted[0] ^= 0xff;
    await writeFile(path.join(fixtureConfig.root, 'binary'), corrupted);
    await assert.rejects(verifyCandidate(manifest, fixtureConfig), /not a|hash|native binary/i);
  }
});

test('compiler validation separates MSVC optimized and Emscripten MinSizeRel from debug', async () => {
  const ms = await fixture({
    kind: 'native-player', bytes: Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(32)]),
    compilerId: 'MSVC', flags: '/O2 /Ob2 /DNDEBUG',
  });
  assert.equal((await produceCandidate(ms)).compiler.flags, '/O2 /Ob2 /DNDEBUG');
  const web = await fixture({
    kind: 'web-player', bytes: Buffer.concat([Buffer.from('0061736d', 'hex'), Buffer.alloc(32)]),
    compilerId: 'Clang', buildType: 'MinSizeRel', flags: '-Os -DNDEBUG',
  });
  web.compiler.flags = '-O0 -DNDEBUG';
  await assert.rejects(produceCandidate(web), /optimized compiler flags/i);
  web.compiler.flags = '-Os -DNDEBUG';
  web.compiler.buildType = 'Debug';
  await assert.rejects(produceCandidate(web), /build type/i);
});

test('diagnostic Android native binaries cannot be promoted as release candidates', async () => {
  const data = Buffer.alloc(64);
  Buffer.from('7f454c4602010100', 'hex').copy(data);
  data.writeUInt16LE(62, 18);
  const config = await fixture({
    kind: 'android-template', bytes: data, compilerId: 'Clang',
    buildType: 'Debug', flags: '-g -O0', tier: 'diagnostic',
  });
  config.candidate.target = 'android-x86_64';
  const manifest = await produceCandidate(config);
  assert.equal(manifest.tier, 'diagnostic');
  await verifyCandidate(manifest, config);
  assert.throws(() => verifyTrustedProducerRun(manifest, {}), /Diagnostic candidates/i);
  config.candidate.target = 'android-arm64-v8a';
  await assert.rejects(verifyCandidate(manifest, config), /target|architecture/i);
});

test('Android Gradle release candidate records actual optimized NDK compile commands, not empty cache flags', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nt-android-gradle-compiler-'));
  temp.push(base);
  await mkdir(path.join(base, 'CMakeFiles', '3.31.6'), { recursive: true });
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_CXX_COMPILER:FILEPATH=/opt/android/clang++\n' +
    'CMAKE_BUILD_TYPE:STRING=RelWithDebInfo\n' +
    'CMAKE_CXX_FLAGS_RELWITHDEBINFO:STRING=\n');
  await writeFile(path.join(base, 'CMakeFiles', '3.31.6', 'CMakeCXXCompiler.cmake'),
    'set(CMAKE_CXX_COMPILER_ID "Clang")\nset(CMAKE_CXX_COMPILER_VERSION "19.1.0")\n');
  const candidate = {
    kind: 'android-template', id: 'android-player-arm64-release',
    target: 'android-arm64-v8a', compilerId: 'Clang',
    preset: 'android-arm64-release',
  };
  const commands = [{ file: '/source/engine/src/core/compiled_project.cpp',
    command: '/opt/android/clang++ --target=aarch64-none-linux-android24 -O2 -g -DNDEBUG -c compiled_project.cpp' }];
  const setCommands = (items) => writeFile(path.join(base, 'compile_commands.json'), JSON.stringify(items));
  await setCommands(commands);
  const compiler = await compilerFromCmake(base, candidate);
  assert.equal(compiler.buildType, 'RelWithDebInfo');
  assert.match(compiler.flags, /-O2 -DNDEBUG/);
  await setCommands([{ ...commands[0], command: commands[0].command.replace('-O2', '-O0') }]);
  await assert.rejects(compilerFromCmake(base, candidate), /actually compile optimized/i);
  await setCommands([{ ...commands[0], command: commands[0].command.replace('aarch64', 'x86_64') }]);
  await assert.rejects(compilerFromCmake(base, candidate), /compiled ABI or minimum API/i);
  await setCommands([{ ...commands[0], command: commands[0].command.replace('android24', 'android23') }]);
  await assert.rejects(compilerFromCmake(base, candidate), /compiled ABI or minimum API/i);
});

test('CMake compiler records read flags from the actual configured optimization mode', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nt-cmake-compiler-'));
  temp.push(base);
  await mkdir(path.join(base, 'CMakeFiles', '3.31.6'), { recursive: true });
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_CXX_COMPILER:FILEPATH=/opt/toolchain/bin/clang++\n' +
    'CMAKE_BUILD_TYPE:STRING=MinSizeRel\n' +
    'CMAKE_CXX_FLAGS_MINSIZEREL:STRING=-Os -DNDEBUG\n');
  await writeFile(path.join(base, 'CMakeFiles', '3.31.6', 'CMakeCXXCompiler.cmake'),
    'set(CMAKE_CXX_COMPILER_ID "Clang")\nset(CMAKE_CXX_COMPILER_VERSION "19.1.0")\n');
  const info = await compilerFromCmake(base, {
    id: 'web', compilerId: 'Clang', preset: 'web-release', buildType: 'MinSizeRel', optimization: '-Os',
  });
  assert.equal(info.buildType, 'MinSizeRel');
  assert.equal(info.flags, '-Os -DNDEBUG');
});

test('Windows CRLF CMakeCache metadata retains authentic Release/toolchain/flags and rejects unconfigured builds', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nt-windows-candidate-ninja-'));
  temp.push(base);
  await mkdir(path.join(base, 'CMakeFiles', '3.31.6'), { recursive: true });
  const candidate = { id: 'windows-player-x64-release', kind: 'native-player',
    compilerId: 'MSVC', preset: 'windows-release' };
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_GENERATOR:INTERNAL=Ninja\r\n' +
    'CMAKE_BUILD_TYPE:STRING=Release\r\n' +
    'CMAKE_CXX_COMPILER:FILEPATH=C:/msvc/cl.exe\r\n' +
    'CMAKE_CXX_FLAGS_RELEASE:STRING=/O2 /Ob2 /DNDEBUG\r\n');
  await writeFile(path.join(base, 'CMakeFiles', '3.31.6', 'CMakeCXXCompiler.cmake'),
    'set(CMAKE_CXX_COMPILER_ID "MSVC")\nset(CMAKE_CXX_COMPILER_VERSION "19.51.36231")\n');
  const result = await compilerFromCmake(base, candidate);
  assert.equal(result.buildType, 'Release');
  assert.equal(result.toolchain, 'C:/msvc/cl.exe');
  assert.equal(result.flags, '/O2 /Ob2 /DNDEBUG');
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_GENERATOR:INTERNAL=Ninja\r\n' +
    'CMAKE_CXX_COMPILER:FILEPATH=C:/msvc/cl.exe\r\n' +
    'CMAKE_CXX_FLAGS_RELEASE:STRING=/O2 /Ob2 /DNDEBUG\r\n');
  await assert.rejects(compilerFromCmake(base, candidate), /compiler build type mismatch/);
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_GENERATOR:INTERNAL=Ninja\r\n' +
    'CMAKE_BUILD_TYPE:STRING=Debug\r\n' +
    'CMAKE_CXX_COMPILER:FILEPATH=C:/msvc/cl.exe\r\n' +
    'CMAKE_CXX_FLAGS_DEBUG:STRING=/Od\r\n');
  await assert.rejects(compilerFromCmake(base, candidate), /compiler build type mismatch/);
});

test('Emscripten compiler identity is recovered from CMake configured compiler metadata when cache omits it', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'nt-emscripten-compiler-'));
  temp.push(base);
  await mkdir(path.join(base, 'CMakeFiles', '3.31.6'), { recursive: true });
  await writeFile(path.join(base, 'CMakeCache.txt'),
    'CMAKE_BUILD_TYPE:STRING=MinSizeRel\n' +
    'CMAKE_CXX_FLAGS_MINSIZEREL:STRING=-Os -DNDEBUG\n');
  await writeFile(path.join(base, 'CMakeFiles', '3.31.6', 'CMakeCXXCompiler.cmake'),
    'set(CMAKE_CXX_COMPILER_ID "Clang")\n' +
    'set(CMAKE_CXX_COMPILER_VERSION "21.0.0")\n' +
    'set(CMAKE_CXX_COMPILER "/emsdk/upstream/emscripten/em++")\n');
  const candidate = { id: 'web', compilerId: 'Clang', preset: 'web-release',
    buildType: 'MinSizeRel', optimization: '-Os' };
  const result = await compilerFromCmake(base, candidate);
  assert.equal(result.toolchain, '/emsdk/upstream/emscripten/em++');
  await writeFile(path.join(base, 'CMakeFiles', '3.31.6', 'CMakeCXXCompiler.cmake'),
    'set(CMAKE_CXX_COMPILER_ID "Clang")\nset(CMAKE_CXX_COMPILER_VERSION "21.0.0")\n');
  await assert.rejects(compilerFromCmake(base, candidate), /Toolchain identity is missing/);
});
