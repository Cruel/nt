import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await import(path.join(root, 'web/player_bootstrap.js'));

const { LoadingPhase, LoadingState, createPlayerBootstrap } =
  globalThis.NovelTeaPlayerBootstrap;
const encoder = new TextEncoder();

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function configBytes(packageBytes) {
  return encoder.encode(JSON.stringify({
    format: 'noveltea.player-config',
    formatVersion: 2,
    displayName: 'Bootstrap Test',
    applicationId: 'org.example.bootstrap',
    saveNamespace: 'org.example.bootstrap',
    versionName: '1',
    package: {
      path: 'game.ntpkg',
      sha256: sha256(packageBytes),
      runtimePackageApi: 2,
    },
    capabilities: [],
    display: {
      referenceResolution: { width: 1920, height: 1080 },
      worldRasterPolicy: 'capped',
      barColor: '#000000',
    },
    accessibility: {
      uiScale: { enabled: true, minimum: 1, maximum: 2 },
      textScale: { enabled: true, minimum: 1, maximum: 2 },
    },
  }));
}

function response(bytes, knownLength = true, status = 200) {
  const headers = knownLength ? { 'content-length': String(bytes.byteLength) } : {};
  return new Response(bytes, { status, headers });
}

function successfulHarness(packageBytes, options = {}) {
  const progress = [];
  const handoffs = [];
  const config = configBytes(packageBytes);
  const controller = createPlayerBootstrap({
    fetch: async (url) => {
      if (url === 'player.json') return response(config);
      if (url === 'game.ntpkg') return response(packageBytes, options.knownLength !== false);
      return response(encoder.encode('not found'), true, 404);
    },
    crypto: webcrypto,
    TextDecoder,
    onProgress: (record) => progress.push(record),
    handoffPackage: async (bytes, operationId) => {
      handoffs.push({ bytes: Uint8Array.from(bytes), operationId });
    },
  });
  return { controller, progress, handoffs };
}

test('known-length package download reports truthful byte progress', async () => {
  const packageBytes = encoder.encode('known-length-package');
  const harness = successfulHarness(packageBytes);
  await harness.controller.start();

  const download = harness.progress.filter(
    (record) => record.phase === LoadingPhase.DownloadingPackage,
  );
  assert.ok(download.some((record) =>
    record.completedUnits === packageBytes.byteLength &&
    record.totalUnits === packageBytes.byteLength));
  assert.equal(harness.handoffs.length, 1);
  assert.deepEqual(harness.handoffs[0].bytes, packageBytes);
});

test('unknown-length package download remains indeterminate', async () => {
  const packageBytes = encoder.encode('unknown-length-package');
  const harness = successfulHarness(packageBytes, { knownLength: false });
  await harness.controller.start();

  const download = harness.progress.filter(
    (record) => record.phase === LoadingPhase.DownloadingPackage,
  );
  assert.ok(download.some((record) => record.completedUnits === packageBytes.byteLength));
  assert.ok(download.every((record) => record.totalUnits === null));
});

test('retryable failure starts a new loading operation', async () => {
  const packageBytes = encoder.encode('retry-package');
  const config = configBytes(packageBytes);
  const progress = [];
  const handoffs = [];
  let packageAttempts = 0;
  const controller = createPlayerBootstrap({
    fetch: async (url) => {
      if (url === 'player.json') return response(config);
      packageAttempts += 1;
      return packageAttempts === 1
        ? response(encoder.encode('unavailable'), true, 503)
        : response(packageBytes);
    },
    crypto: webcrypto,
    TextDecoder,
    onProgress: (record) => progress.push(record),
    handoffPackage: async (bytes, operationId) => handoffs.push({ bytes, operationId }),
  });

  await controller.start();
  const failed = progress.at(-1);
  assert.equal(failed.state, LoadingState.Failed);
  assert.equal(failed.retryable, true);
  const failedOperation = failed.operation.value;

  await controller.retry();
  assert.equal(handoffs.length, 1);
  assert.ok(handoffs[0].operationId > failedOperation);
  assert.equal(controller.snapshot().operationId, handoffs[0].operationId);
});

test('checksum failure is fatal and does not hand off bytes', async () => {
  const expectedBytes = encoder.encode('expected-package');
  const downloadedBytes = encoder.encode('tampered-package');
  const progress = [];
  let handoffs = 0;
  const controller = createPlayerBootstrap({
    fetch: async (url) => url === 'player.json'
      ? response(configBytes(expectedBytes))
      : response(downloadedBytes),
    crypto: webcrypto,
    TextDecoder,
    onProgress: (record) => progress.push(record),
    handoffPackage: async () => { handoffs += 1; },
  });

  await controller.start();
  const failed = progress.at(-1);
  assert.equal(failed.phase, LoadingPhase.VerifyingPackage);
  assert.equal(failed.state, LoadingState.Failed);
  assert.equal(failed.retryable, false);
  assert.match(failed.diagnostics[0].message, /checksum/i);
  assert.equal(handoffs, 0);
});

test('navigation cancellation terminates the active operation', async () => {
  const packageBytes = encoder.encode('cancel-package');
  const config = configBytes(packageBytes);
  const progress = [];
  const controller = createPlayerBootstrap({
    fetch: async (url, options) => {
      if (url === 'player.json') return response(config);
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) {
          reject(new DOMException('navigation', 'AbortError'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('navigation', 'AbortError'));
        }, { once: true });
      });
    },
    crypto: webcrypto,
    TextDecoder,
    onProgress: (record) => progress.push(record),
    handoffPackage: async () => assert.fail('canceled bytes must not be handed off'),
  });

  const started = controller.start();
  while (!progress.some((record) => record.phase === LoadingPhase.DownloadingPackage)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  controller.cancel();
  await started;
  assert.equal(progress.at(-1).state, LoadingState.Canceled);
  assert.equal(progress.at(-1).retryable, false);
});

test('completed package buffer is released after one handoff', async () => {
  const packageBytes = encoder.encode('single-resident-package');
  const harness = successfulHarness(packageBytes);
  await harness.controller.start();

  assert.equal(harness.handoffs.length, 1);
  assert.equal(harness.controller.snapshot().retainedCompletedPackageBytes, 0);
  const preJs = await readFile(path.join(root, 'web/player_pre.js'), 'utf8');
  assert.match(preJs, /FS\.writeFile\('\/player\.json'/);
  assert.doesNotMatch(preJs, /FS\.writeFile\([^\n]*package/i);
});

test('browser and runtime phases form one successful startup operation', async () => {
  const packageBytes = encoder.encode('successful-startup-package');
  const harness = successfulHarness(packageBytes);
  await harness.controller.start();
  const operationId = harness.controller.snapshot().operationId;

  harness.controller.acceptProgress({
    operation: { value: operationId },
    phase: LoadingPhase.OpeningPackageIndex,
    state: LoadingState.Active,
    completedUnits: 1,
    totalUnits: 1,
    retryable: false,
    diagnostics: [],
  });
  harness.controller.acceptProgress({
    operation: { value: operationId },
    phase: LoadingPhase.LoadingStartupContent,
    state: LoadingState.Active,
    completedUnits: 0,
    totalUnits: null,
    retryable: false,
    diagnostics: [],
  });
  harness.controller.acceptProgress({
    operation: { value: operationId },
    phase: LoadingPhase.LoadingStartupContent,
    state: LoadingState.Completed,
    completedUnits: 1,
    totalUnits: 1,
    retryable: false,
    diagnostics: [],
  });

  assert.equal(harness.controller.snapshot().state, LoadingState.Completed);
  assert.deepEqual(
    [...new Set(harness.progress.map((record) => record.phase))],
    [
      LoadingPhase.DownloadingPackage,
      LoadingPhase.VerifyingPackage,
      LoadingPhase.OpeningPackageIndex,
      LoadingPhase.LoadingStartupContent,
    ],
  );
});
