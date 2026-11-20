import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pinnedVcpkgRevision } from '../../scripts/ci/pin-vcpkg.mjs';

test('vcpkg SDK checkout identity comes from the versioned registry baseline', async () => {
  const pinned = await pinnedVcpkgRevision(process.cwd());
  assert.match(pinned, /^[0-9a-f]{40}$/);
  assert.equal(pinned, '40dd49b0c9c7dbd79dc64cad5e82308eae04f67f');
});

test('missing and non-immutable vcpkg identities reject bootstrap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-vcpkg-pin-'));
  try {
    await mkdir(path.join(root, 'cmake'));
    await writeFile(path.join(root, 'vcpkg-configuration.json'), JSON.stringify({
      'default-registry': { kind: 'builtin', baseline: 'master' },
    }));
    await assert.rejects(pinnedVcpkgRevision(root), /40-character|immutable|pin/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
