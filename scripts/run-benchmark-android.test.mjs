import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const mode of ['release', 'debug', 'pull', 'config']) {
  test(`Android benchmark ${mode} selects its own APK, launcher and private result path`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nt-benchmark-android-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    async function file(relative, contents, executable = false) {
      const location = path.join(root, relative);
      await mkdir(path.dirname(location), { recursive: true });
      await writeFile(location, contents, { mode: executable ? 0o755 : 0o644 });
    }
    await file('scripts/run-benchmark-android.sh',
      await readFile(path.join(repository, 'scripts/run-benchmark-android.sh')), true);
    await file('scripts/android-device.sh',
      await readFile(path.join(repository, 'scripts/android-device.sh')));
    await file('android/benchmark/build/outputs/apk/release/benchmark-release.apk', 'release');
    await file('android/benchmark/build/outputs/apk/debug/benchmark-debug.apk', 'debug');
    const canonical = await readFile(path.join(repository, 'apps/benchmark/stage1-unattended.json'));
    await file('staged/canonical file.json', canonical);
    await file('android/gradlew', `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_ROOT/gradle-actions"
`, true);
    await file('bin/adb', `#!/usr/bin/env bash
set -e
case "$*" in
  'devices -l') printf 'phone-01\\tdevice\\n' ;;
  '-s phone-01 get-state') echo device ;;
  '-s phone-01 shell getprop sys.boot_completed') echo 1 ;;
  '-s phone-01 shell getprop ro.product.cpu.abilist') echo arm64-v8a ;;
  '-s phone-01 shell getprop ro.product.model') echo Phone ;;
  '-s phone-01 shell run-as org.noveltea.benchmark pwd') echo /data/user/0/org.noveltea.benchmark ;;
  *'run-as org.noveltea.benchmark find files'*)
    echo files/NovelTea/Benchmark/results/raw-bgfx-geometry-123.json ;;
  *'exec-out run-as org.noveltea.benchmark cat '*)
    echo '{"format":"noveltea.benchmark.result"}' ;;
  *) printf '%s\\n' "$*" >> "$TEST_ROOT/adb-actions" ;;
esac
`, true);

    const scriptArgs = mode === 'debug' ? ['--debug'] :
      mode === 'pull' ? ['--no-build', '--pull'] :
      mode === 'config' ? ['--no-build', '--', '--config', path.join(root, 'staged/canonical file.json')] :
      ['--', '--scenario', 'raw-bgfx-geometry', '--smoke', '--no-ui'];
    const run = spawnSync('bash', [path.join(root, 'scripts/run-benchmark-android.sh'), ...scriptArgs], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
        TEST_ROOT: root,
        AVD_NAME: 'none',
        ANDROID_ABI: '',
      },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const actions = await readFile(path.join(root, 'adb-actions'), 'utf8');
    const flavor = mode === 'debug' ? 'debug' : 'release';
    assert.match(actions, new RegExp(`install -r .*/benchmark-${flavor}\\.apk`));
    if (mode === 'pull') {
      assert.doesNotMatch(actions, /am start|am force-stop/);
      assert.equal(await readFile(
        path.join(root, 'build/benchmark-android-results/phone-01/raw-bgfx-geometry-123.json'),
        'utf8'), '{"format":"noveltea.benchmark.result"}\n');
    } else {
      if (mode !== 'config') {
        const gradle = await readFile(path.join(root, 'gradle-actions'), 'utf8');
        assert.match(gradle, new RegExp(`:benchmark:assemble${mode === 'debug' ? 'Debug' : 'Release'}`));
        assert.match(gradle, /-PnovelteaAbi=arm64-v8a/);
      }
      assert.match(actions, /am force-stop org\.noveltea\.benchmark/);
      assert.match(actions, /am start -n org\.noveltea\.benchmark\/\.BenchmarkActivity/);
      assert.ok(actions.indexOf("am force-stop org.noveltea.benchmark") <
        actions.indexOf("am start -n org.noveltea.benchmark/.BenchmarkActivity"),
        "fresh Intent cannot be delivered before stopping an existing Activity");
      if (mode === 'release') {
        assert.match(actions, /--scenario raw-bgfx-geometry --smoke --no-ui/);
      } else if (mode === 'config') {
        const match = actions.match(/--es novelteaBenchmarkConfigBase64 '([A-Za-z0-9+/=]+)'/);
        assert.ok(match, 'launch passed a bounded canonical config via its own intent extra');
        assert.deepEqual(Buffer.from(match[1], 'base64'), canonical);
        assert.doesNotMatch(actions, /--es novelteaBenchmarkArgs/);
      }
    }
  });
}

test('Android unattended configuration fails closed before launching', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-benchmark-bad-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const launcher = path.join(root, 'run-benchmark-android.sh');
  await writeFile(launcher, await readFile(path.join(repository, 'scripts/run-benchmark-android.sh')));
  const file = path.join(root, 'config.json');
  await writeFile(file, '{}');
  const run = (...args) => spawnSync('bash', [launcher, '--no-build', '--', ...args], {
    encoding: 'utf8', env: {...process.env, AVD_NAME: 'none'}
  });
  const mixed = run('--config', file, '--smoke');
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /cannot be mixed/);
  const missing = run('--config', path.join(root, 'missing.json'));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read/);
  await writeFile(file, 'x'.repeat(8193));
  const oversized = run('--config', file);
  assert.equal(oversized.status, 2);
  assert.match(oversized.stderr, /8192 bytes/);
});
