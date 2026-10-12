import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./android-device.sh', import.meta.url));

async function select(t, { listing = '', serial = '', abi = '', abis = 'arm64-v8a', input = '', interactive = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-adb-select-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'adb'), `#!/usr/bin/env bash
set -eu
if [ "$1" = devices ]; then printf '%s\\n' "$TEST_DEVICES"; exit; fi
[ "$1" = -s ] || exit 30
printf '%s\\n' "$2" >> "$TEST_ACTIONS"
shift 2
case "$*" in
  get-state) echo device ;;
  'shell getprop sys.boot_completed') printf '1\\r\\n' ;;
  'shell getprop ro.product.cpu.abilist') printf '%s\\r\\n' "$TEST_ABIS" ;;
  'shell getprop ro.product.model') echo 'Pixel 6a' ;;
  *) exit 31 ;;
esac
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'emulator'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$TEST_EMULATOR_ACTIONS"\nexec sleep 1\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-c', `set -euo pipefail
source "$1"
DEVICE_SERIAL="$TEST_SERIAL"
AVD_NAME=noveltea_api35
${interactive ? 'android_require_terminal() { :; }' : ''}
android_select_target
printf 'SELECTED=%s ABI=%s EMULATOR_PID=%s\\n' "$DEVICE_SERIAL" "$ANDROID_ABI" "\${EMULATOR_PID:-}"
`, 'test', helper], {
    encoding: 'utf8', input,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ANDROID_ABI: abi,
      TMPDIR: root, TEST_EMULATOR_ACTIONS: path.join(root, 'emulator-actions'),
      TEST_DEVICES: listing, TEST_SERIAL: serial, TEST_ABIS: abis, TEST_ACTIONS: path.join(root, 'actions') },
  });
  const pid = /EMULATOR_PID=(\d+)/.exec(result.stdout)?.[1];
  if (pid) { try { process.kill(Number(pid)); } catch {} }
  return { ...result, actions: await readFile(path.join(root, 'actions'), 'utf8').catch(() => ''),
    emulatorActions: await readFile(path.join(root, 'emulator-actions'), 'utf8').catch(() => '') };
}

test('automatically selects a single network Pixel and detects arm64', async (t) => {
  const r = await select(t, { listing: '192.0.2.1:1234\tdevice model:Pixel_6a' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SELECTED=192\.0\.2\.1:1234 ABI=arm64-v8a/);
  assert.ok(r.actions.split('\n').filter(Boolean).every(s => s === '192.0.2.1:1234'));
});

test('reuses an online emulator and detects x86_64', async (t) => {
  const r = await select(t, { listing: 'emulator-5554\tdevice', abis: 'x86_64,x86' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SELECTED=emulator-5554 ABI=x86_64/);
});

test('multiple devices prompt for a numbered selection and retry invalid choices', async (t) => {
  const r = await select(t, { listing: 'phone\tdevice\nemulator-5554\tdevice',
    interactive: true, input: '0\nabc\n2\n', abis: 'x86_64' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\) phone/);
  assert.match(r.stdout, /2\) emulator-5554/);
  assert.match(r.stdout, /SELECTED=emulator-5554/);
});

test('explicit serial bypasses an ambiguous list', async (t) => {
  const r = await select(t, { listing: 'phone\tdevice\nemulator-5554\tdevice', serial: 'phone' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SELECTED=phone ABI=arm64-v8a/);
});

test('noninteractive ambiguity fails before querying or building', async (t) => {
  const r = await select(t, { listing: 'phone\tdevice\nemulator-5554\tdevice' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /pass --device SERIAL/);
  assert.equal(r.actions, '');
});

test('declining an emulator exits without querying a target', async (t) => {
  const r = await select(t, { interactive: true, input: 'n\n' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /cancelled; nothing built/);
  assert.equal(r.actions, '');
});

test('accepting emulator launch pins its allocated serial and detects its ABI', async (t) => {
  const r = await select(t, { interactive: true, input: 'y\n', abis: 'x86_64' });
  assert.equal(r.status, 0, r.stderr);
  const serial = /SELECTED=(emulator-\d+)/.exec(r.stdout)?.[1];
  assert.ok(serial);
  assert.ok(r.actions.split('\n').filter(Boolean).every(s => s === serial));
  assert.match(r.emulatorActions, /@noveltea_api35 -port \d+/);
  assert.match(r.stdout, /ABI=x86_64/);
});

test('no devices without a terminal does not silently launch an emulator', async (t) => {
  const r = await select(t);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires a terminal/);
});

for (const state of ['offline', 'unauthorized']) {
  test(`${state} targets produce an error, not an emulator fallback`, async (t) => {
    const r = await select(t, { listing: `phone\t${state}` });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /authorize\/reconnect/);
    assert.equal(r.actions, '');
  });
}

test('incompatible explicit ABI is rejected', async (t) => {
  const r = await select(t, { listing: 'phone\tdevice', abi: 'x86_64' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /incompatible ABI/);
});
