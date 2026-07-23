#!/usr/bin/env node

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import('playwright');

const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('<!doctype html><meta charset="utf-8"><title>bootstrap contracts</title>');
    return;
  }
  response.writeHead(404);
  response.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('browser test server failed to bind');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
  await page.addScriptTag({ path: path.join(root, 'web/player_bootstrap.js') });

  const result = await page.evaluate(async () => {
    const api = globalThis.NovelTeaPlayerBootstrap;
    const encoder = new TextEncoder();
    const checks = [];
    const expect = (condition, message) => {
      if (!condition) throw new Error(message);
      checks.push(message);
    };
    const equalBytes = (left, right) =>
      left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
    const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    const configBytes = async (packageBytes) => encoder.encode(JSON.stringify({
      format: 'noveltea.player-config',
      formatVersion: 2,
      displayName: 'Browser Bootstrap Test',
      applicationId: 'org.example.browser-bootstrap',
      saveNamespace: 'org.example.browser-bootstrap',
      versionName: '1',
      package: {
        path: 'game.ntpkg',
        sha256: hex(await crypto.subtle.digest('SHA-256', packageBytes)),
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
    const response = (bytes, knownLength = true, status = 200) => new Response(bytes, {
      status,
      headers: knownLength ? { 'content-length': String(bytes.byteLength) } : {},
    });

    async function successHarness(value, knownLength) {
      const packageBytes = encoder.encode(value);
      const config = await configBytes(packageBytes);
      const progress = [];
      const handoffs = [];
      const controller = api.createPlayerBootstrap({
        fetch: async (url) => url === 'player.json'
          ? response(config)
          : response(packageBytes, knownLength),
        crypto,
        TextDecoder,
        onProgress: (record) => progress.push(record),
        handoffPackage: async (bytes, operationId) => {
          handoffs.push({ bytes: Uint8Array.from(bytes), operationId });
        },
      });
      await controller.start();
      return { packageBytes, progress, handoffs, controller };
    }

    const known = await successHarness('known-browser-package', true);
    expect(known.progress.some((record) =>
      record.phase === api.LoadingPhase.DownloadingPackage &&
      record.completedUnits === known.packageBytes.byteLength &&
      record.totalUnits === known.packageBytes.byteLength),
    'known-length byte progress');
    expect(known.handoffs.length === 1 && equalBytes(known.handoffs[0].bytes, known.packageBytes),
      'successful package handoff');

    const unknown = await successHarness('unknown-browser-package', false);
    const unknownDownload = unknown.progress.filter((record) =>
      record.phase === api.LoadingPhase.DownloadingPackage);
    expect(unknownDownload.some((record) =>
      record.completedUnits === unknown.packageBytes.byteLength), 'unknown-length byte progress');
    expect(unknownDownload.every((record) => record.totalUnits === null),
      'unknown-length indeterminate state');

    const retryBytes = encoder.encode('retry-browser-package');
    const retryConfig = await configBytes(retryBytes);
    const retryProgress = [];
    const retryHandoffs = [];
    let attempts = 0;
    const retryController = api.createPlayerBootstrap({
      fetch: async (url) => {
        if (url === 'player.json') return response(retryConfig);
        attempts += 1;
        return attempts === 1
          ? response(encoder.encode('unavailable'), true, 503)
          : response(retryBytes);
      },
      crypto,
      TextDecoder,
      onProgress: (record) => retryProgress.push(record),
      handoffPackage: async (bytes, operationId) => retryHandoffs.push({ bytes, operationId }),
    });
    await retryController.start();
    const failedOperation = retryProgress.at(-1).operation.value;
    expect(retryProgress.at(-1).state === api.LoadingState.Failed &&
      retryProgress.at(-1).retryable, 'retryable network failure');
    await retryController.retry();
    expect(retryHandoffs.length === 1 && retryHandoffs[0].operationId > failedOperation,
      'retry creates a new operation');

    const expectedBytes = encoder.encode('expected-browser-package');
    const checksumConfig = await configBytes(expectedBytes);
    const checksumProgress = [];
    let checksumHandoffs = 0;
    const checksumController = api.createPlayerBootstrap({
      fetch: async (url) => url === 'player.json'
        ? response(checksumConfig)
        : response(encoder.encode('tampered-browser-package')),
      crypto,
      TextDecoder,
      onProgress: (record) => checksumProgress.push(record),
      handoffPackage: async () => { checksumHandoffs += 1; },
    });
    await checksumController.start();
    expect(checksumProgress.at(-1).phase === api.LoadingPhase.VerifyingPackage &&
      checksumProgress.at(-1).state === api.LoadingState.Failed &&
      !checksumProgress.at(-1).retryable && checksumHandoffs === 0,
    'fatal checksum failure');

    const cancelBytes = encoder.encode('cancel-browser-package');
    const cancelConfig = await configBytes(cancelBytes);
    const cancelProgress = [];
    const cancelController = api.createPlayerBootstrap({
      fetch: async (url, options) => {
        if (url === 'player.json') return response(cancelConfig);
        return new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            reject(new DOMException('navigation', 'AbortError'));
            return;
          }
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('navigation', 'AbortError')), { once: true });
        });
      },
      crypto,
      TextDecoder,
      onProgress: (record) => cancelProgress.push(record),
      handoffPackage: async () => { throw new Error('canceled package was handed off'); },
    });
    const cancelRun = cancelController.start();
    while (!cancelProgress.some((record) =>
      record.phase === api.LoadingPhase.DownloadingPackage)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    cancelController.cancel();
    await cancelRun;
    expect(cancelProgress.at(-1).state === api.LoadingState.Canceled,
      'navigation cancellation');

    expect(known.controller.snapshot().retainedCompletedPackageBytes === 0,
      'no retained browser package duplicate');
    const operationId = known.controller.snapshot().operationId;
    known.controller.acceptProgress({
      operation: { value: operationId },
      phase: api.LoadingPhase.OpeningPackageIndex,
      state: api.LoadingState.Active,
      completedUnits: 1,
      totalUnits: 1,
      retryable: false,
      diagnostics: [],
    });
    known.controller.acceptProgress({
      operation: { value: operationId },
      phase: api.LoadingPhase.LoadingStartupContent,
      state: api.LoadingState.Completed,
      completedUnits: 1,
      totalUnits: 1,
      retryable: false,
      diagnostics: [],
    });
    expect(known.controller.snapshot().state === api.LoadingState.Completed,
      'successful startup completion');
    return checks;
  });

  assert.equal(result.length, 10);
  console.log(`[web-player-bootstrap-browser] ok: ${result.join(', ')}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

process.exitCode = 0;
