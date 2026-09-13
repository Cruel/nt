import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareSnapshot, publishSnapshot } from '../../scripts/development-snapshot.mjs';

const revision = 'a'.repeat(40);
function input(overrides = {}) {
  return {
    revision,
    runNumber: 20,
    createdAt: '2026-09-12T00:00:00.000Z',
    version: '1.0.0',
    cli: Buffer.from('abc'),
    cliIdentity: { success: true, version: '1.0.0', protocolVersion: 1 },
    player: Buffer.from('template zip'),
    descriptor: {
      format: 'noveltea.player-template',
      formatVersion: 1,
      engineVersion: `dev-${revision}`,
      buildId: `dev-${revision}-web-wasm32-threads-release`,
      templateId: 'web-wasm32-threads-release',
      platform: 'web',
      architecture: 'wasm32',
      buildFlavor: 'release',
      compiledFeatures: ['web-threads'],
      compiledProjectFormatVersion: 1,
      playerRuntimeApiVersion: 1,
    },
    ...overrides,
  };
}
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.get(key)?.body ?? null;
    },
    async put(key, body) {
      objects.set(key, { body: Buffer.from(body), last_modified: '2026-09-12T00:00:00.000Z' });
    },
    async list(prefix) {
      return [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, last_modified: value.last_modified }));
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

test('a complete snapshot exposes exact toolchain identity and verifiable artifact bytes', async () => {
  const snapshot = prepareSnapshot(input());
  const store = bucket();
  await publishSnapshot(store, snapshot);
  const pointer = JSON.parse(await store.get('development/toolchains/current.json'));
  assert.equal(pointer.revision, revision);
  const manifest = JSON.parse(await store.get(pointer.manifest.key));
  assert.equal(manifest.revision, revision);
  assert.equal(manifest.compatibility.playerRuntimeApiVersion, 1);
  assert.equal(
    manifest.artifacts.cli.sha256,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(manifest.artifacts.cli.size, 3);
  assert.deepEqual(await store.get(manifest.artifacts.cli.key), Buffer.from('abc'));
  assert.deepEqual(await store.get(manifest.artifacts.player.key), Buffer.from('template zip'));
});

test('publication failure preserves current and retries never replace immutable bytes', async () => {
  const store = bucket();
  const snapshot = prepareSnapshot(input());
  const put = store.put.bind(store);
  store.put = async (key, bytes) => {
    if (key.endsWith('snapshot.json')) throw new Error('upload interrupted');
    await put(key, bytes);
  };
  await assert.rejects(publishSnapshot(store, snapshot), /interrupted/);
  assert.equal(await store.get('development/toolchains/current.json'), null);
  store.put = put;
  await publishSnapshot(store, snapshot);
  const pointer = await store.get('development/toolchains/current.json');
  await publishSnapshot(store, snapshot);
  await assert.rejects(
    publishSnapshot(store, prepareSnapshot(input({ cli: Buffer.from('changed') }))),
    /immutable/,
  );
  assert.deepEqual(await store.get('development/toolchains/current.json'), pointer);
});

test('mismatched revision, compatibility, and non-threaded player inputs are rejected', () => {
  for (const changes of [
    { revision: '../other' },
    { runNumber: 0 },
    { createdAt: 'invalid' },
    { cliIdentity: { success: true, version: 'other', protocolVersion: 1 } },
    { descriptor: { ...input().descriptor, engineVersion: 'dev-other' } },
    { descriptor: { ...input().descriptor, compiledFeatures: ['web-single-threaded'] } },
    { descriptor: { ...input().descriptor, playerRuntimeApiVersion: 2 } },
    { cli: Buffer.alloc(0) },
  ])
    assert.throws(() => prepareSnapshot(input(changes)));
});

test('cleanup protects current, recently retired and recent uploads without rolling current backward', async () => {
  const store = bucket();
  const now = new Date('2026-09-12T00:00:00.000Z');
  await publishSnapshot(store, prepareSnapshot(input()), { now });
  const next = prepareSnapshot(
    input({
      revision: 'b'.repeat(40),
      runNumber: 21,
      descriptor: {
        ...input().descriptor,
        engineVersion: `dev-${'b'.repeat(40)}`,
        buildId: `dev-${'b'.repeat(40)}-web-wasm32-threads-release`,
      },
    }),
  );
  for (const object of store.objects.values()) object.last_modified = '2026-01-01T00:00:00.000Z';
  const obsolete = `development/toolchains/${'c'.repeat(40)}/partial-upload`;
  const recent = `development/toolchains/${'d'.repeat(40)}/partial-upload`;
  await store.put(obsolete, Buffer.from('old'));
  store.objects.get(obsolete).last_modified = '2026-01-01T00:00:00.000Z';
  await store.put(recent, Buffer.from('recent'));
  await store.put('examples/pr-5/file', Buffer.from('unrelated'));
  await publishSnapshot(store, next, { now });
  assert.equal(await store.get(obsolete), null);
  assert.ok(await store.get(recent));
  assert.ok(await store.get('examples/pr-5/file'));
  assert.ok(await store.get(`development/toolchains/${revision}/snapshot.json`));
  await publishSnapshot(store, prepareSnapshot(input()), { now });
  assert.equal(
    JSON.parse(await store.get('development/toolchains/current.json')).revision,
    'b'.repeat(40),
  );
  await publishSnapshot(store, next, { now: new Date('2026-09-20T00:00:00.000Z') });
  assert.equal(await store.get(`development/toolchains/${revision}/snapshot.json`), null);
  assert.ok(await store.get(next.manifestKey));
});

test('corrupt uploads and malformed current metadata cannot advance publication or delete snapshots', async () => {
  const store = bucket();
  const originalPut = store.put.bind(store);
  store.put = (key) => originalPut(key, Buffer.from('corrupt'));
  await assert.rejects(publishSnapshot(store, prepareSnapshot(input())), /verification failed/);
  assert.equal(await store.get('development/toolchains/current.json'), null);
  store.put = originalPut;
  await store.put(
    'development/toolchains/current.json',
    Buffer.from(
      JSON.stringify({
        format: 'noveltea.development-toolchain-pointer',
        revision,
        runNumber: 1,
        retired: [],
        manifest: { key: '../bad', sha256: 'invalid', size: 0 },
      }),
    ),
  );
  await assert.rejects(
    publishSnapshot(store, prepareSnapshot(input())),
    /Invalid current snapshot pointer/,
  );
});

test('an older successful Build still publishes its immutable snapshot without replacing newer current', async () => {
  const store = bucket();
  await publishSnapshot(store, prepareSnapshot(input()));
  const olderRevision = 'e'.repeat(40);
  const older = prepareSnapshot(
    input({
      revision: olderRevision,
      runNumber: 19,
      descriptor: {
        ...input().descriptor,
        engineVersion: `dev-${olderRevision}`,
        buildId: `dev-${olderRevision}-web-wasm32-threads-release`,
      },
    }),
  );
  const pointer = await store.get('development/toolchains/current.json');
  await publishSnapshot(store, older);
  assert.ok(await store.get(older.manifestKey));
  assert.deepEqual(await store.get('development/toolchains/current.json'), pointer);
});
