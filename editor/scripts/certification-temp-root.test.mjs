import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createCertificationRoot, certificationRootPrefix } from './certification-temp-root.mjs';
import { rm } from 'node:fs/promises';

void test('macOS broker roots stay under the Unix socket path limit even with a long runner tmpdir', async () => {
  const longRunnerTemp = '/var/folders/abcdefghijklmnop/T/some-long-runner-temporary-path';
  const prefix = certificationRootPrefix('noveltea-native-cli-commands-', 'darwin', longRunnerTemp);
  assert.equal(prefix, '/tmp/nt-c-');
  const root = `${prefix}ABCDEF`;
  for (const suffix of ['daemon', 'native-daemon', 'oracle-daemon']) {
    const socket = path.posix.join(root, suffix, `daemon-${'a'.repeat(32)}.sock`);
    assert.ok(Buffer.byteLength(socket) < 104, socket);
  }
  assert.equal(
    certificationRootPrefix('noveltea-native-cli-commands-', 'linux', longRunnerTemp),
    path.join(longRunnerTemp, 'noveltea-native-cli-commands-'),
  );
});

void test('real certification root creates a unique removable directory', async () => {
  const root = await createCertificationRoot('noveltea-test-root-');
  try {
    assert.ok(root.length > 0);
    assert.ok(path.isAbsolute(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
