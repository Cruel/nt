import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliRelocationCleanupOptions, removeCliRelocation } from './cleanup-cli-relocation.mjs';

void test('Windows CLI relocation cleanup retries transient executable locks', () => {
  assert.deepEqual(cliRelocationCleanupOptions('win32'), {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
  assert.equal(cliRelocationCleanupOptions('linux').maxRetries, 0);
  assert.equal(cliRelocationCleanupOptions('darwin').maxRetries, 0);
});

void test('CLI relocation cleanup removes an executable held by a short-lived child', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea media cleanup '));
  const executable = path.join(root, path.basename(process.execPath));
  let child;
  try {
    await copyFile(process.execPath, executable);
    if (process.platform !== 'win32') await chmod(executable, 0o755);
    child = spawn(
      executable,
      ['-e', 'process.stdout.write("ready\\n"); setTimeout(() => {}, 650)'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Relocated CLI fixture exited before startup (code ${code}).`);
      }),
    ]);
    assert.match(String(ready), /ready/);
    await removeCliRelocation(root);
    await assert.rejects(stat(root), { code: 'ENOENT' });
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
