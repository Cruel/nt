import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removePackageSmokeRoot } from '../../editor/scripts/package-smoke-cleanup.mjs';

test('Windows Editor package cleanup retries transient locks after child streams close', async () => {
  const calls = [];
  await removePackageSmokeRoot('C:/temp/noveltea-smoke', {
    platform: 'win32',
    remove: async (root, options) => { calls.push({ root, options }); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.recursive, true);
  assert.equal(calls[0].options.force, true);
  assert.equal(calls[0].options.maxRetries, 30);
  assert.equal(calls[0].options.retryDelay, 200);
});

test('Editor package cleanup rejects persistent locks instead of disguising a bad smoke', async () => {
  const locked = Object.assign(new Error('Locked working directory'), { code: 'EBUSY' });
  await assert.rejects(
    removePackageSmokeRoot('C:/temp/noveltea-smoke', {
      platform: 'win32', remove: async () => { throw locked; },
    }),
    (error) => error === locked,
  );
});

test('Non-Windows package cleanup does not introduce platform-specific retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-package-cleanup-'));
  await writeFile(path.join(root, 'temp.txt'), 'test');
  assert.equal(await readFile(path.join(root, 'temp.txt'), 'utf8'), 'test');
  await removePackageSmokeRoot(root, { platform: 'linux' });
  await assert.rejects(readFile(path.join(root, 'temp.txt')), { code: 'ENOENT' });
});
