#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { buildDir: 'build/web-debug' };
  for (let index = 0; index < argv.length; ++index) {
    if (argv[index] === '--build-dir') {
      if (index + 1 >= argv.length) throw new Error('--build-dir requires a value');
      options.buildDir = argv[++index];
    } else if (argv[index] === '--package') {
      if (index + 1 >= argv.length) throw new Error('--package requires a value');
      options.packagePath = path.resolve(argv[++index]);
    } else if (argv[index] === '--video') {
      options.video = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  options.buildDir = path.resolve(root, options.buildDir);
  return options;
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

const options = parseArgs(process.argv.slice(2));
const startupTimeoutMs = Math.max(
  1,
  Number.parseInt(process.env.NOVELTEA_WEB_PLAYER_SMOKE_TIMEOUT_MS || '120000', 10) || 120000,
);
const playerRoot = path.join(options.buildDir, 'apps', 'player');
const packageSource = options.packagePath || path.join(
  options.buildDir,
  'runtime-assets',
  'project',
  'projects',
  'runtime_presentation_package.ntpkg',
);
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-web-player-smoke-'));
const required = ['player.html', 'player.js', 'player.wasm', 'player.data'];

try {
  for (const file of required) {
    await fs.copyFile(path.join(playerRoot, file), path.join(stage, file));
  }
  const packageBytes = await fs.readFile(packageSource);
  await fs.writeFile(path.join(stage, 'game.ntpkg'), packageBytes);
  const checksum = createHash('sha256').update(packageBytes).digest('hex');
  const config = {
    format: 'noveltea.player-config',
    formatVersion: 1,
    displayName: 'NovelTea Web Package Smoke',
    applicationId: 'org.noveltea.web-package-smoke',
    saveNamespace: 'org.noveltea.web-package-smoke',
    versionName: '1.0.0',
    package: {
      path: 'game.ntpkg',
      sha256: checksum,
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
  };
  await fs.writeFile(path.join(stage, 'player.json'), `${JSON.stringify(config)}\n`);

  const requests = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '') || 'player.html';
    requests.set(`/${relative}`, (requests.get(`/${relative}`) || 0) + 1);
    const filePath = path.normalize(path.join(stage, relative));
    if (!filePath.startsWith(stage + path.sep)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    try {
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        'content-type': contentType(filePath),
        'content-length': body.byteLength,
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('smoke server failed to bind');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.addInitScript((videoSmoke) => {
      globalThis.__novelteaLoadingRecords = [];
      globalThis.__novelteaVideoSamples = [];
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
        if (source instanceof HTMLVideoElement) {
          globalThis.__novelteaVideoSamples.push({
            time: source.currentTime, paused: source.paused,
            width: source.videoWidth, height: source.videoHeight,
            blob: source.currentSrc.startsWith('blob:'),
          });
        }
        return drawImage.call(this, source, ...args);
      };
      let moduleValue;
      Object.defineProperty(globalThis, 'Module', {
        configurable: true,
        get() { return moduleValue; },
        set(value) {
          if (value && !value.__novelteaProgressCaptureInstalled) {
            if (videoSmoke) value.arguments = ['--smoke-run-runtime'];
            const original = value.onNovelTeaLoadingProgress;
            value.onNovelTeaLoadingProgress = (record) => {
              globalThis.__novelteaLoadingRecords.push({
                operation: record.operation.value,
                phase: record.phase,
                state: record.state,
                completedUnits: record.completedUnits,
                totalUnits: record.totalUnits,
                retryable: record.retryable,
                diagnostics: record.diagnostics.map((item) => item.message),
              });
              if (typeof original === 'function') original(record);
            };
            Object.defineProperty(value, '__novelteaProgressCaptureInstalled', { value: true });
          }
          moduleValue = value;
        },
      });
    }, Boolean(options.video));

    await page.goto(`http://127.0.0.1:${address.port}/player.html`, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() =>
        globalThis.__novelteaLoadingRecords.some((record) =>
          record.phase === 'LoadingStartupContent' && record.state === 'Completed'),
      undefined, { timeout: startupTimeoutMs });
    } catch (error) {
      const timeoutState = await page.evaluate(() => ({
        records: globalThis.__novelteaLoadingRecords,
        calledRun: Boolean(globalThis.Module && globalThis.Module.calledRun),
        loadingTitle: document.getElementById('loading-title')?.textContent,
        loadingPhase: document.getElementById('loading-phase')?.textContent,
        loadingDetail: document.getElementById('loading-detail')?.textContent,
      }));
      throw new Error(
        `startup timeout: ${JSON.stringify(timeoutState)}; page errors: ${pageErrors.join(' | ')}; ` +
        `console errors: ${consoleErrors.join(' | ')}; requests: ${JSON.stringify([...requests])}`,
        { cause: error },
      );
    }

    if (options.video) {
      // Use the debug player's direct-start smoke mode, independent of title-screen interaction.
      // The fixture isolates Feature Lab's opaque panel in a neutral camera World Composition Room.
      const colors = new Set();
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline && colors.size < 3) {
        const image = (await page.screenshot({ type: 'png' })).toString('base64');
        const color = await page.evaluate(async (encoded) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          // Center of the authored video-gameplay panel, away from its bounds/letterbox edges.
          const pixel = context.getImageData(Math.floor(bitmap.width * 0.685), Math.floor(bitmap.height * 0.415), 1, 1).data;
          bitmap.close();
          const channels = Array.from(pixel).slice(0, 3);
          const strongest = channels.indexOf(Math.max(...channels));
          return channels[strongest] > 80 && channels.every((value, index) => index === strongest || value < channels[strongest] / 2) ? strongest : -1;
        }, image);
        if (color >= 0) colors.add(color);
        await page.waitForTimeout(250);
      }
      const samples = await page.evaluate(() => globalThis.__novelteaVideoSamples);
      if (colors.size !== 3 || samples.length < 2 || samples.some((sample) => !sample.paused || !sample.blob || sample.width !== 96 || sample.height !== 64)) {
        if (process.env.NOVELTEA_WEB_VIDEO_SMOKE_CAPTURE) {
          await page.screenshot({ path: process.env.NOVELTEA_WEB_VIDEO_SMOKE_CAPTURE });
        }
        throw new Error(`opaque browser video did not reach ordinary raster rendering: colors=${[...colors]}, samples=${JSON.stringify(samples.slice(-10))}; console=${consoleErrors.join(' | ')}`);
      }
      console.log(`[web-player-package-smoke] browser video: ${samples.length} time-directed samples; red/green/blue reached the raster Visual panel`);
    }

    const result = await page.evaluate(() => ({
      records: globalThis.__novelteaLoadingRecords,
      calledRun: Boolean(globalThis.Module && globalThis.Module.calledRun),
      retainedBootstrapBytes: globalThis.Module._noveltea_player_retained_package_bytes(),
      pendingBrowserPackage: globalThis.Module.novelteaCompletedPackageBytes,
      packageInVfs: globalThis.Module.FS.analyzePath('/game.ntpkg').exists,
      configInVfs: globalThis.Module.FS.analyzePath('/player.json').exists,
      loadingHidden: document.getElementById('loading').style.display === 'none',
    }));

    const phases = [...new Set(result.records.map((record) => record.phase))];
    for (const phase of [
      'DownloadingPackage',
      'VerifyingPackage',
      'OpeningPackageIndex',
      'LoadingStartupContent',
    ]) {
      if (!phases.includes(phase)) throw new Error(`startup did not report ${phase}`);
    }
    const knownDownload = result.records.find((record) =>
      record.phase === 'DownloadingPackage' &&
      record.completedUnits === packageBytes.byteLength &&
      record.totalUnits === packageBytes.byteLength);
    if (!knownDownload) throw new Error('startup did not report final package byte progress');
    if (!result.calledRun) throw new Error('Emscripten runtime did not start');
    if (result.retainedBootstrapBytes !== 0) {
      throw new Error(`browser handoff retained ${result.retainedBootstrapBytes} duplicate bytes`);
    }
    if (result.pendingBrowserPackage !== null) {
      throw new Error('browser retained the completed package after native handoff');
    }
    if (result.packageInVfs) throw new Error('game.ntpkg was written into Emscripten VFS');
    if (!result.configInVfs) throw new Error('player.json bootstrap metadata is missing from VFS');
    if (!result.loadingHidden) throw new Error('loading shell did not dismiss after startup');
    if (requests.get('/game.ntpkg') !== 1) {
      throw new Error(`game.ntpkg request count was ${requests.get('/game.ntpkg') || 0}`);
    }
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    const relevantConsoleErrors = consoleErrors.filter((line) =>
      !line.includes('favicon.ico') &&
      !line.includes('AudioContext was not allowed') &&
      /(?:Aborted|Uncaught|RuntimeError|player_bootstrap|startup failed|initialization failed)/i.test(line));
    if (relevantConsoleErrors.length > 0) {
      throw new Error(`console errors: ${relevantConsoleErrors.join(' | ')}`);
    }
    console.log(
      `[web-player-package-smoke] ok: ${packageBytes.byteLength} package bytes, phases ${phases.join(' -> ')}`,
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
