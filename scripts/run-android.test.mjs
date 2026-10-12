import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const [input, abi, cliMode = 'explicit'] of [
  ['file', 'x86_64'], ['directory', 'x86_64'], ['directory', 'arm64-v8a'],
  ['directory', 'arm64-v8a', 'existing-default'], ['directory', 'arm64-v8a', 'missing-default'],
]) {
  test(`exports the specified Project ${input} for ${abi} using ${cliMode} CLI and launches its APK`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nt-android-run-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    const workspace = path.join(root, 'feature-lab');
    async function file(relative, content, executable = false) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { mode: executable ? 0o755 : 0o644 });
      return target;
    }
    await file('scripts/run-android.sh', await readFile(path.join(repository, 'scripts/run-android.sh')), true);
    await file('scripts/android-device.sh', await readFile(path.join(repository, 'scripts/android-device.sh')));
    await mkdir(workspace);
    await cp(path.join(repository, 'tests/projects/feature-lab/project.json'), path.join(workspace, 'project.json'));
    await file('android/gradlew', '#!/usr/bin/env bash\n[[ " $* " == *" -PnovelteaAbi=$TEST_ABI "* ]]\n', true);
    await file(`android/app/build/noveltea-native/debug/${abi}/libnoveltea-player.so`, 'player');
    await file(`android/app/build/noveltea-native/debug/${abi}/libSDL3.so`, 'SDL');
    await mkdir(path.join(root, 'android/app/build/generated/noveltea/shaders'), { recursive: true });
    const shaderRoot = path.join(root, 'shader-includes');
    await file('shader-includes/bgfx_shader.sh', 'shader');
    const jar = await file('bundletool.jar', 'mock bundletool');
    // Mock external tools; this test protects script orchestration, not their implementations.
    await file('bin/sha256sum', '#!/usr/bin/env bash\nwhile read -r line; do :; done\n', true);
    await file('bin/cmake', `#!/usr/bin/env bash
set -eu
found=0
for arg in "$@"; do
  [ "$arg" != "-DNOVELTEA_BUNDLETOOL_JAR=$NOVELTEA_BUNDLETOOL_JAR" ] || found=1
done
[ "$found" = 1 ]
mkdir -p "$TEST_ROOT/dist"
touch "$TEST_ROOT/dist/noveltea-player-template-local-run-android-android-$TEST_ABI-debug.tar.gz"
`, true);
    await file('bin/pnpm', `#!/usr/bin/env bash
if [[ " $* " == *" noveltea:build "* ]]; then
  echo build >> "$TEST_ROOT/cli-builds"
  mkdir -p "$TEST_ROOT/build/cli/linux"
  cp "$TEST_ROOT/bin/noveltea" "$TEST_ROOT/build/cli/linux/noveltea"
fi
`, true);
    await file('bin/adb', `#!/usr/bin/env bash
if [ "$1" = '-s' ]; then
  [ "$2" = "$TEST_SERIAL" ] || exit 20
  shift 2
elif [ "$1" != devices ]; then
  exit 21
fi
case "$*" in
  'devices -l') printf '%s\\tdevice\\n' "$TEST_SERIAL" ;;
  get-state) echo device ;;
  'shell getprop sys.boot_completed') echo 1 ;;
  'shell getprop ro.product.cpu.abilist') echo "$TEST_ABI" ;;
  'shell getprop ro.product.model') echo Emulator ;;
  logcat) echo 'noveltea: mock app running' ;;
  *) printf '%s\\n' "$*" >> "$TEST_ROOT/adb-actions" ;;
esac
`, true);
    const cli = await file('bin/noveltea', `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('export')) {
  const project = args[args.indexOf('--project') + 1];
  if (project !== process.env.TEST_WORKSPACE) process.exit(10);
  const document = JSON.parse(fs.readFileSync(path.join(project, 'project.json'), 'utf8'));
  const profile = args[args.indexOf('--profile') + 1];
  const expected = process.env.TEST_ABI === 'arm64-v8a' ? 'android-arm64-debug' : 'android-emulator-debug';
  if (profile !== expected || !document.export.profiles.some(p => p.id === profile)) process.exit(11);
  const output = args[args.indexOf('--output') + 1];
  fs.mkdirSync(output, {recursive:true});
  fs.writeFileSync(path.join(output, 'feature-lab.apk'), 'mock apk');
  fs.writeFileSync(path.join(process.env.TEST_ROOT, 'export-project'), project);
}
`, true);
    if (cliMode === 'existing-default') {
      await mkdir(path.join(root, 'build/cli/linux'), { recursive: true });
      await cp(cli, path.join(root, 'build/cli/linux/noveltea'));
    }
    const result = spawnSync('bash', [path.join(root, 'scripts/run-android.sh'), '--project',
      input === 'file' ? path.join(workspace, 'project.json') : workspace], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        NOVELTEA_CLI: cliMode === 'explicit' ? cli : '',
        NOVELTEA_BUNDLETOOL_JAR: jar,
        BGFX_SHADER_INCLUDE_DIR: shaderRoot,
        JAVA_HOME: root,
        TEST_ROOT: root,
        TEST_WORKSPACE: workspace,
        PKG: 'org.noveltea.featurelab',
        APK: '',
        ANDROID_ABI: '',
        TEST_ABI: abi,
        TEST_SERIAL: abi === 'arm64-v8a' ? 'network-phone:1234' : 'emulator-5554',
        ACTIVITY: 'org.noveltea.player.MainActivity',
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const builds = await readFile(path.join(root, 'cli-builds'), 'utf8').catch(() => '');
    assert.equal(builds, cliMode === 'missing-default' ? 'build\n' : '');
    assert.equal(await readFile(path.join(root, 'export-project'), 'utf8'), workspace);
    const adb = await readFile(path.join(root, 'adb-actions'), 'utf8');
    assert.match(adb, /install -r .*feature-lab\.apk/);
    assert.match(adb, /shell am start -n org\.noveltea\.featurelab\/org\.noveltea\.player\.MainActivity/);
  });
}
