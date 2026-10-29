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
    } else if (argv[index] === '--alpha') {
      options.alpha = true;
    } else if (argv[index] === '--start-via-title') {
      options.startViaTitle = true;
    } else if (argv[index] === '--imgui') {
      options.imgui = true;
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  if (options.startViaTitle && !options.video) throw new Error('--start-via-title requires --video');
  if (options.alpha && !options.video) throw new Error('--alpha requires --video');
  if (options.imgui && options.video) throw new Error('--imgui and --video are separate smoke modes');
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
    args: ['--autoplay-policy=no-user-gesture-required',
      ...(process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND
        ? ['--use-gl=angle', `--use-angle=${process.env.NOVELTEA_WEB_SMOKE_ANGLE_BACKEND}`] : [])],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.addInitScript(({ videoSmoke, startViaTitle, alphaSmoke }) => {
      globalThis.__novelteaStartViaTitle = startViaTitle;
      globalThis.__novelteaAlphaMode = alphaSmoke;
      globalThis.__novelteaLoadingRecords = [];
      globalThis.__novelteaVideoSamples = [];
      globalThis.__novelteaR8Uploads = [];
      const upload = WebGL2RenderingContext.prototype.texSubImage2D;
      const occurrences = new WeakMap();
      const seeks = new WeakMap();
      const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        ...currentTime,
        set(value) {
          const timing = { began: performance.now(), ready: null };
          seeks.set(this, timing);
          this.addEventListener('seeked', () => { timing.ready = performance.now(); }, { once: true });
          currentTime.set.call(this, value);
        },
      });
      let nextOccurrence = 1;
      WebGL2RenderingContext.prototype.texSubImage2D = function(...args) {
        const source = args.at(-1);
        if (args.some((value) => value === this.RED) && args.some((value) => value === this.UNSIGNED_BYTE))
          globalThis.__novelteaR8Uploads.push({ at: performance.now(), args: args.length });
        if (source instanceof HTMLVideoElement) {
          if (!occurrences.has(source)) occurrences.set(source, nextOccurrence++);
          globalThis.__novelteaVideoSamples.push({
            occurrence: occurrences.get(source),
            seekToUploadMs: performance.now() - (seeks.get(source)?.began || performance.now()),
            readyToUploadMs: performance.now() - (seeks.get(source)?.ready || performance.now()),
            time: source.currentTime, paused: source.paused,
            width: source.videoWidth, height: source.videoHeight,
            blob: source.currentSrc.startsWith('blob:'),
          });
        }
        return upload.apply(this, args);
      };
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
        if (source instanceof HTMLVideoElement) throw new Error('Video CPU raster fallback is forbidden');
        return drawImage.call(this, source, ...args);
      };
      let moduleValue;
      Object.defineProperty(globalThis, 'Module', {
        configurable: true,
        get() { return moduleValue; },
        set(value) {
          if (value && !value.__novelteaProgressCaptureInstalled) {
            if (videoSmoke && !globalThis.__novelteaStartViaTitle) value.arguments = ['--smoke-run-runtime'];
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
    }, { videoSmoke: Boolean(options.video), startViaTitle: Boolean(options.startViaTitle), alphaSmoke: Boolean(options.alpha) });

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

    if (options.imgui) {
      // Verify the standalone Web player's devtools-enabled ImGui frontend renders,
      // not just that F10 reaches an input handler. Two toggles must restore the scene.
      await page.locator('#canvas').focus();
      await page.waitForTimeout(500);
      const before = await page.screenshot();
      await page.keyboard.press('F10');
      await page.waitForTimeout(600);
      const shown = await page.screenshot();
      await page.keyboard.press('F10');
      await page.waitForTimeout(600);
      const hidden = await page.screenshot();
      const differences = await page.evaluate(async (screenshots) => {
        const pixels = async (base64) => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${base64}`)).blob(),
          );
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [baseline, visible, restored] = await Promise.all(screenshots.map(pixels));
        const fractionChanged = (left, right) => {
          let changed = 0;
          for (let index = 0; index < left.length; index += 4) {
            const rgbDelta = Math.abs(left[index] - right[index]) +
              Math.abs(left[index + 1] - right[index + 1]) +
              Math.abs(left[index + 2] - right[index + 2]);
            if (rgbDelta > 60) ++changed;
          }
          return changed / (left.length / 4);
        };
        return {
          visible: fractionChanged(baseline, visible),
          restored: fractionChanged(baseline, restored),
        };
      }, [before, shown, hidden].map((screenshot) => screenshot.toString('base64')));
      if (differences.visible < 0.03 || differences.restored > differences.visible * 0.25) {
        throw new Error(`ImGui F10 show/hide did not change and restore the Web frame: ${JSON.stringify(differences)}`);
      }
      console.log(`[web-player-package-smoke] F10 opens and closes ImGui: changed ${(differences.visible * 100).toFixed(1)}%, restored ${(differences.restored * 100).toFixed(1)}%`);
    }

    if (options.startViaTitle) {
      // Release builds have no debug direct-start switch. The package uses the default title UI.
      await page.waitForTimeout(1500);
      await page.mouse.click(480, 248);
    }
    if (options.video) {
      // The package isolates Feature Lab's opaque panel in a neutral-camera World Composition Room.
      const colors = new Set();
      const alphaSamples = [];
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline && (options.alpha ? alphaSamples.length < 36 : colors.size < 3)) {
        const image = (await page.screenshot({ type: 'png' })).toString('base64');
        const color = await page.evaluate(async (encoded) => {
          const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          // Center of the authored video-gameplay panel, away from its bounds/letterbox edges.
          const pixel = context.getImageData(Math.floor(bitmap.width * (globalThis.__novelteaAlphaMode ? 0.724 : 0.685)), Math.floor(bitmap.height * 0.415), 1, 1).data;
          bitmap.close();
          const channels = Array.from(pixel).slice(0, 3);
          const strongest = channels.indexOf(Math.max(...channels));
          return channels[strongest] > 80 && channels.every((value, index) => index === strongest || value < channels[strongest] / 2) ? strongest : -1;
        }, image);
        if (color >= 0) colors.add(color);
        if (options.alpha) {
          const samples = await page.evaluate(async (encoded) => {
            const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            const y = Math.floor(bitmap.height * 0.415);
            const pixels = Array.from({ length: 26 }, (_, index) => 0.60 + index * 0.01).map((x) =>
              Array.from(ctx.getImageData(Math.floor(bitmap.width * x), y, 1, 1).data).slice(0, 3));
            bitmap.close();
            return pixels;
          }, image);
          alphaSamples.push(samples);
        }
        await page.waitForTimeout(250);
      }
      const samples = await page.evaluate(() => globalThis.__novelteaVideoSamples);
      if ((!options.alpha && colors.size !== 3) || samples.length < 2 || samples.some((sample) => !sample.paused || !sample.blob || sample.width !== 96 || sample.height !== 64)) {
        if (process.env.NOVELTEA_WEB_VIDEO_SMOKE_CAPTURE) {
          await page.screenshot({ path: process.env.NOVELTEA_WEB_VIDEO_SMOKE_CAPTURE });
        }
        throw new Error(`opaque browser video did not reach ordinary raster rendering: colors=${[...colors]}, samples=${JSON.stringify(samples.slice(-10))}; page errors=${pageErrors.join(' | ')}; console=${consoleErrors.join(' | ')}`);
      }
      console.log(`[web-player-package-smoke] browser video: ${samples.length} time-directed samples; color video reached raster Visual panel`);
      if (options.alpha) {
        // The camera/framing and colored scene can change between screenshots.
        // Within one image, the authored Material's transparent/half/opaque
        // strips must satisfy premultiplied-alpha compositing. These three
        // positions are interior to the Feature Lab video's left/middle/right
        // thirds after its World camera transform.
        const valid = alphaSamples.slice(-12).map((row) => {
          const clear = row[5]; // x=.65, 0% alpha
          const half = row[7];  // x=.67, 50% alpha
          const full = row[12]; // x=.72, 100% alpha
          return full.some((value, channel) => Math.abs(value - clear[channel]) > 90) &&
            half.every((value, channel) =>
              Math.abs(value - (clear[channel] + full[channel]) * 0.5) < 27);
        });
        const uploads = await page.evaluate(() => globalThis.__novelteaR8Uploads.length);
        if (uploads < 1 || valid.filter(Boolean).length < Math.min(3, valid.length))
          throw new Error(`Web transparent video compositing failed: R8Uploads=${uploads}, matched=${valid.filter(Boolean).length}/${valid.length}, samples=${JSON.stringify(alphaSamples.slice(-3))}`);
        console.log(`[web-player-package-smoke] transparent R8 compositing confirmed: uploads=${uploads}, matched=${valid.filter(Boolean).length}/${valid.length}`);
      }
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
