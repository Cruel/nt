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
    response.end('<!doctype html><meta charset="utf-8"><title>bootstrap browser contract</title>');
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
    const hex = (buffer) =>
      Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const response = (bytes, knownLength = true) =>
      new Response(bytes, {
        status: 200,
        headers: knownLength ? { 'content-length': String(bytes.byteLength) } : {},
      });
    const packageBytes = encoder.encode('browser-package');
    const config = encoder.encode(
      JSON.stringify({
        format: 'noveltea.player-config',
        formatVersion: 1,
        displayName: 'Browser Bootstrap Test',
        applicationId: 'org.example.browser-bootstrap',
        saveNamespace: 'org.example.browser-bootstrap',
        versionName: '1',
        package: {
          path: 'game.ntpkg',
          sha256: hex(await crypto.subtle.digest('SHA-256', packageBytes)),
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
      }),
    );
    const progress = [];
    const handoffs = [];
    const controller = api.createPlayerBootstrap({
      fetch: async (url) => (url === 'player.json' ? response(config) : response(packageBytes)),
      crypto,
      TextDecoder,
      onProgress: (record) => progress.push(record),
      handoffPackage: async (bytes, operationId) => {
        handoffs.push({ bytes: Uint8Array.from(bytes), operationId });
      },
    });

    await controller.start();
    expect(
      progress.some(
        (record) =>
          record.phase === api.LoadingPhase.DownloadingPackage &&
          record.completedUnits === packageBytes.byteLength &&
          record.totalUnits === packageBytes.byteLength,
      ),
      'browser Response streaming reports package byte progress',
    );
    expect(
      handoffs.length === 1 &&
        handoffs[0].bytes.length === packageBytes.length &&
        handoffs[0].bytes.every((value, index) => value === packageBytes[index]),
      'browser WebCrypto verification hands off the exact package bytes',
    );
    expect(
      controller.snapshot().retainedCompletedPackageBytes === 0,
      'browser bootstrap releases completed package bytes after handoff',
    );

    const operationId = controller.snapshot().operationId;
    controller.acceptProgress({
      operation: { value: operationId },
      phase: api.LoadingPhase.OpeningPackageIndex,
      state: api.LoadingState.Active,
      completedUnits: 1,
      totalUnits: 1,
      retryable: false,
      diagnostics: [],
    });
    controller.acceptProgress({
      operation: { value: operationId },
      phase: api.LoadingPhase.LoadingStartupContent,
      state: api.LoadingState.Completed,
      completedUnits: 1,
      totalUnits: 1,
      retryable: false,
      diagnostics: [],
    });
    expect(
      controller.snapshot().state === api.LoadingState.Completed,
      'browser bootstrap accepts runtime completion for the same operation',
    );

    const cancelProgress = [];
    const cancelController = api.createPlayerBootstrap({
      fetch: async (url, options) => {
        if (url === 'player.json') return response(config);
        return new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            reject(new DOMException('navigation', 'AbortError'));
            return;
          }
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('navigation', 'AbortError')),
            { once: true },
          );
        });
      },
      crypto,
      TextDecoder,
      onProgress: (record) => cancelProgress.push(record),
      handoffPackage: async () => {
        throw new Error('canceled package was handed off');
      },
    });
    const cancelRun = cancelController.start();
    while (
      !cancelProgress.some((record) => record.phase === api.LoadingPhase.DownloadingPackage)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    cancelController.cancel();
    await cancelRun;
    expect(
      cancelProgress.at(-1).state === api.LoadingState.Canceled,
      'browser AbortSignal cancellation reaches the canceled state',
    );

    return checks;
  });

  assert.equal(result.length, 5);
  console.log(`[web-player-bootstrap-browser] ok: ${result.join(', ')}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

process.exitCode = 0;
