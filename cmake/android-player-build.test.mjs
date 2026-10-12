import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAndroidPlayerBuild } from './android-player-build.mjs';

async function fixture(t, flavor = 'debug', abi = 'x86_64') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-android-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'android', 'app');
  const variant = flavor === 'debug' ? 'Debug' : 'RelWithDebInfo';
  const cap = flavor[0].toUpperCase() + flavor.slice(1);
  const nativeRoot = path.join(app, 'build/intermediates/merged_native_libs', flavor,
    `merge${cap}NativeLibs/out/lib`, abi);
  async function file(name, content) {
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, content);
  }
  await file(path.join(nativeRoot, 'libnoveltea-player.so'), 'current-player');
  // Old AGP layouts can survive alongside the current merge task's output.
  await file(path.join(app, 'build/intermediates/merged_native_libs', flavor,
    'out/lib', abi, 'libnoveltea-player.so'), 'old-player');
  async function build(hash, content = 'current-player', type = variant) {
    const buildRoot = path.join(app, '.cxx', variant, hash, abi);
    const nativeLibraryPath = path.join(app, 'build/intermediates/cxx', variant, hash,
      'obj', abi, 'libnoveltea-player.so');
    await file(path.join(buildRoot, 'CMakeCache.txt'), `CMAKE_BUILD_TYPE:STRING=${type}\n`);
    await file(nativeLibraryPath, content);
    return { buildRoot, nativeLibraryPath };
  }
  return { root, nativeRoot, build, flavor, abi };
}

test('selects the current merged player among five retained configurations', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.build(`old-${i}`, `old-player-${i}`);
  const current = await f.build('current');
  assert.deepEqual(await resolveAndroidPlayerBuild(f.root, f.abi, f.flavor), {
    nativeRoot: f.nativeRoot, ...current,
  });
});

test('release accepts the AGP RelWithDebInfo variant and arm64 ABI', async (t) => {
  const f = await fixture(t, 'release', 'arm64-v8a');
  const current = await f.build('current');
  assert.deepEqual(await resolveAndroidPlayerBuild(f.root, f.abi, f.flavor), {
    nativeRoot: f.nativeRoot, ...current,
  });
});

test('rejects stale native builds rather than packaging unrelated metadata', async (t) => {
  const f = await fixture(t);
  await f.build('old', 'old-player');
  await assert.rejects(resolveAndroidPlayerBuild(f.root, f.abi, f.flavor), /found 0/);
});

test('does not guess when identical outputs make build provenance ambiguous', async (t) => {
  const f = await fixture(t);
  await f.build('one');
  await f.build('two');
  await assert.rejects(resolveAndroidPlayerBuild(f.root, f.abi, f.flavor), /found 2/);
});

test('rejects a cache with the wrong build type', async (t) => {
  const f = await fixture(t);
  await f.build('wrong-type', 'current-player', 'Release');
  await assert.rejects(resolveAndroidPlayerBuild(f.root, f.abi, f.flavor), /found 0/);
});
