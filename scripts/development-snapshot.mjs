import { createHash } from 'node:crypto';

const namespace = 'development/toolchains/';
const currentKey = `${namespace}current.json`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const record = (key, bytes) => ({ key, size: bytes.length, sha256: sha256(bytes) });

export function prepareSnapshot(input) {
  const { revision, runNumber, createdAt, version, cli, cliIdentity, player, descriptor } = input;
  if (
    !/^[0-9a-f]{40}$/.test(revision) ||
    !Number.isSafeInteger(runNumber) ||
    runNumber < 1 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
    !Buffer.isBuffer(cli) ||
    !cli.length ||
    !Buffer.isBuffer(player) ||
    !player.length ||
    cliIdentity.success !== true ||
    cliIdentity.version !== version ||
    cliIdentity.protocolVersion !== 1 ||
    descriptor.format !== 'noveltea.player-template' ||
    descriptor.formatVersion !== 1 ||
    descriptor.engineVersion !== `dev-${revision}` ||
    descriptor.buildId !== `dev-${revision}-web-wasm32-threads-release` ||
    descriptor.templateId !== 'web-wasm32-threads-release' ||
    descriptor.platform !== 'web' ||
    descriptor.architecture !== 'wasm32' ||
    descriptor.buildFlavor !== 'release' ||
    !descriptor.compiledFeatures?.includes('web-threads') ||
    descriptor.compiledFeatures.includes('web-single-threaded') ||
    descriptor.compiledProjectFormatVersion !== 1 ||
    descriptor.playerRuntimeApiVersion !== 1
  ) {
    throw new Error('Invalid or mismatched development toolchain inputs');
  }
  const prefix = `${namespace}${revision}/`;
  const files = new Map([
    [`${prefix}noveltea-linux-x64`, cli],
    [`${prefix}player-web-wasm32-threads-release.zip`, player],
    [`${prefix}template.json`, json(descriptor)],
  ]);
  const manifest = {
    format: 'noveltea.development-toolchain',
    revision,
    runNumber,
    createdAt,
    version,
    compatibility: {
      cliJsonProtocolVersion: cliIdentity.protocolVersion,
      playerTemplateFormatVersion: descriptor.formatVersion,
      compiledProjectFormatVersion: descriptor.compiledProjectFormatVersion,
      playerRuntimeApiVersion: descriptor.playerRuntimeApiVersion,
    },
    playerBuildId: descriptor.buildId,
    artifacts: Object.fromEntries(
      ['cli', 'player', 'descriptor'].map((name, index) => {
        const [key, bytes] = [...files][index];
        return [name, record(key, bytes)];
      }),
    ),
  };
  const manifestKey = `${prefix}snapshot.json`;
  files.set(manifestKey, json(manifest));
  return { manifest, manifestKey, files };
}

const graceMs = 7 * 24 * 60 * 60 * 1000;

function readPointer(bytes) {
  if (!bytes) return null;
  const pointer = JSON.parse(bytes);
  if (
    !pointer ||
    Object.keys(pointer).sort().join(',') !== 'format,manifest,retired,revision,runNumber' ||
    pointer.manifest?.key !== `${namespace}${pointer.revision}/snapshot.json` ||
    !/^[0-9a-f]{64}$/.test(pointer.manifest?.sha256) ||
    !Number.isSafeInteger(pointer.manifest?.size) ||
    pointer.manifest.size < 1 ||
    Object.keys(pointer.manifest).sort().join(',') !== 'key,sha256,size' ||
    pointer.format !== 'noveltea.development-toolchain-pointer' ||
    !/^[0-9a-f]{40}$/.test(pointer.revision) ||
    !Number.isSafeInteger(pointer.runNumber) ||
    pointer.runNumber < 1 ||
    !Array.isArray(pointer.retired) ||
    pointer.retired.some(
      (item) =>
        !item ||
        Object.keys(item).sort().join(',') !== 'retiredAt,revision' ||
        !/^[0-9a-f]{40}$/.test(item.revision) ||
        !Number.isFinite(Date.parse(item.retiredAt)),
    )
  ) {
    throw new Error('Invalid current snapshot pointer; refusing publication and cleanup');
  }
  return pointer;
}

// All writers and cleanup share the workflow's non-cancelling concurrency group.
export async function publishSnapshot(store, snapshot, { now = new Date() } = {}) {
  const previous = readPointer(await store.get(currentKey));
  if (
    previous?.runNumber === snapshot.manifest.runNumber &&
    previous.revision !== snapshot.manifest.revision
  ) {
    throw new Error('Build run identity conflicts with current snapshot');
  }
  for (const [key, bytes] of snapshot.files) {
    const existing = await store.get(key);
    if (existing && !existing.equals(bytes))
      throw new Error(`Refusing to replace immutable object ${key}`);
    if (!existing) await store.put(key, bytes);
    const stored = await store.get(key);
    if (!stored?.equals(bytes)) throw new Error(`Uploaded object verification failed: ${key}`);
  }
  if (previous && previous.runNumber > snapshot.manifest.runNumber) return;
  const { revision, runNumber } = snapshot.manifest;
  const retired = (previous?.retired ?? []).filter(
    (item) => Date.parse(item.retiredAt) > now.getTime() - graceMs && item.revision !== revision,
  );
  if (previous && previous.revision !== revision) {
    retired.push({ revision: previous.revision, retiredAt: now.toISOString() });
  }
  await store.put(
    currentKey,
    json({
      format: 'noveltea.development-toolchain-pointer',
      revision,
      runNumber,
      manifest: record(snapshot.manifestKey, snapshot.files.get(snapshot.manifestKey)),
      retired,
    }),
  );
  const protectedRevisions = new Set([revision, ...retired.map((item) => item.revision)]);
  const objects = await store.list(namespace);
  const groups = new Map();
  for (const object of objects) {
    const match = /^development\/toolchains\/([0-9a-f]{40})\//.exec(object.key);
    if (!match) continue;
    const group = groups.get(match[1]) ?? [];
    group.push(object);
    groups.set(match[1], group);
  }
  for (const [candidate, group] of groups) {
    if (
      protectedRevisions.has(candidate) ||
      group.some(
        (object) =>
          !Number.isFinite(Date.parse(object.last_modified)) ||
          Date.parse(object.last_modified) > now.getTime() - graceMs,
      )
    )
      continue;
    for (const object of group) await store.delete(object.key);
  }
}
