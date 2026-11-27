import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { msvcCacheIdentity } from '../../scripts/ci/msvc-cache-identity.mjs';

test('MSVC compiler identity survives a runner-image copy but invalidates changed compiler passes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nt-msvc-cache-'));
  try {
    const dirs = ['old image', 'new image'].map(name => path.join(root, name));
    for (const dir of dirs) {
      mkdirSync(dir);
      for (const binary of ['cl.exe', 'c1.dll', 'c1xx.dll', 'c2.dll', 'mspdbcore.dll']) {
        const file = path.join(dir, binary);
        writeFileSync(file, binary);
        const time = new Date(dir === dirs[0] ? '2025-01-01' : '2026-11-01');
        utimesSync(file, time, time);
      }
    }
    const [first, second] = dirs.map(dir => path.join(dir, 'cl.exe'));
    const original = msvcCacheIdentity(first);
    assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(msvcCacheIdentity(second), original);
    // A backend change with unchanged cl.exe must invalidate cache identity.
    const backend = path.join(dirs[1], 'c2.dll');
    writeFileSync(backend, 'C2.dll'); // same size
    const time = new Date('2026-11-01');
    utimesSync(backend, time, time);
    assert.notEqual(msvcCacheIdentity(second), original);
    writeFileSync(backend, 'c2.dll');
    assert.equal(msvcCacheIdentity(second), original);
    writeFileSync(second, 'CL.exe');
    assert.notEqual(msvcCacheIdentity(second), original);
    rmSync(path.join(dirs[1], 'c1xx.dll'));
    assert.throws(() => msvcCacheIdentity(second), /Incomplete MSVC compiler toolchain/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
