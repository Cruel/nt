#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[web-screenshot-smoke] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { buildDir: 'build/web-debug' };
  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === '--build-dir') {
      if (i + 1 >= argv.length) fail('--build-dir requires a value');
      options.buildDir = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/web-screenshot-smoke.mjs [--build-dir <path>]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  options.appDir = path.resolve(root, options.buildDir, 'apps', 'sandbox');
  return options;
}

async function requireBuiltApp(appDir) {
  for (const file of ['index.html', 'index.js', 'index.wasm', 'index.data']) {
    try {
      await fs.access(path.join(appDir, file));
    } catch {
      fail(`missing ${file} in ${appDir}; build the matching Web sandbox first`);
    }
  }
}

async function startServer(appDir) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      let relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      if (!relative) relative = 'index.html';
      const filePath = path.normalize(path.join(appDir, relative));
      if (!filePath.startsWith(appDir)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const body = await fs.readFile(filePath);
      const extension = path.extname(filePath);
      const contentType = extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
        : extension === '.wasm' ? 'application/wasm'
        : extension === '.json' ? 'application/json'
        : extension === '.css' ? 'text/css'
        : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed to bind');
  return { server, port: address.port };
}

const options = parseArgs(process.argv.slice(2));
await requireBuiltApp(options.appDir);
const { chromium } = await import('playwright');
const { server, port } = await startServer(options.appDir);
const browser = await chromium.launch({ headless: true });

async function runCase({ name, screenshotMode, screenshotSize, expectedWidth, expectedHeight, noImgui = true }) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  await page.addInitScript(() => {
    globalThis.__novelteaParsePpmHeader = (bytes) => {
      const newline = 0x0a;
      const decoder = new TextDecoder('ascii');
      let lineStart = 0;
      const nextLine = () => {
        const lineEnd = bytes.indexOf(newline, lineStart);
        if (lineEnd < 0) return null;
        const line = decoder.decode(bytes.subarray(lineStart, lineEnd));
        lineStart = lineEnd + 1;
        return line;
      };
      if (nextLine() !== 'P6') return null;
      const dimensions = /^(\d+) (\d+)$/.exec(nextLine() || '');
      if (!dimensions || nextLine() !== '255') return null;
      return {
        width: Number(dimensions[1]),
        height: Number(dimensions[2]),
        pixelOffset: lineStart,
      };
    };
  });
  const consoleLines = [];
  const pageErrors = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const screenshotPath = `/${name}.ppm`;
  const url = new URL(`http://127.0.0.1:${port}/index.html`);
  url.searchParams.set('demo', 'none');
  url.searchParams.set('rmlui-document', 'project:/rmlui/readback_gallery.rml');
  url.searchParams.set('frames', '40');
  url.searchParams.set('screenshot', screenshotPath);
  if (noImgui) url.searchParams.set('noImgui', '1');
  if (screenshotMode) url.searchParams.set('screenshotMode', screenshotMode);
  if (screenshotSize) url.searchParams.set('screenshotSize', screenshotSize);

  try {
    await page.goto(url.toString(), { waitUntil: 'load' });
    const parserHandlesWhitespacePixel = await page.evaluate(() => {
      const header = new TextEncoder().encode('P6\n1 1\n255\n');
      const bytes = new Uint8Array(header.length + 3);
      bytes.set(header);
      bytes.set([0x20, 0x0a, 0x09], header.length);
      const parsed = globalThis.__novelteaParsePpmHeader(bytes);
      return parsed?.width === 1 && parsed?.height === 1 && parsed?.pixelOffset === header.length;
    });
    if (!parserHandlesWhitespacePixel) fail(`${name}: byte-oriented PPM parser regression`);

    const readyDeadline = Date.now() + 120000;
    while (!consoleLines.some((line) => line.includes('[engine] ready')) && Date.now() < readyDeadline) {
      await page.waitForTimeout(50);
    }
    if (!consoleLines.some((line) => line.includes('[engine] ready'))) {
      fail(`${name}: engine did not become ready: ${consoleLines.slice(-20).join(' | ')}`);
    }

    const capacity = await page.evaluate(() => {
      const applied = Module._noveltea_preview_resize(800, 600, 800, 600, 1, 1);
      return {
        applied,
        width: Module._noveltea_preview_backbuffer_width(),
        height: Module._noveltea_preview_backbuffer_height(),
      };
    });
    if (capacity.applied !== 1 || capacity.width < 1280 || capacity.height < 720) {
      fail(`${name}: resize did not retain the larger Web backing capacity: ${JSON.stringify(capacity)}`);
    }

    try {
      await page.waitForFunction((filePath) => {
        try {
          const bytes = Module.FS.readFile(filePath);
          const header = globalThis.__novelteaParsePpmHeader(bytes);
          if (!header) return false;
          const expectedSize = header.pixelOffset + header.width * header.height * 3;
          return bytes.length === expectedSize;
        } catch {
          return false;
        }
      }, screenshotPath, { timeout: 120000 });
    } catch (error) {
      const files = await page.evaluate(() => Module.FS.readdir('/'));
      fail(`${name}: screenshot was not written (${String(error)}); files=${files.join(',')}; console=${consoleLines.slice(-20).join(' | ')}`);
    }

    const capture = await page.evaluate(async (filePath) => {
      const bytes = Module.FS.readFile(filePath);
      const header = globalThis.__novelteaParsePpmHeader(bytes);
      if (!header) return { parseError: 'invalid PPM header' };
      const { width, height, pixelOffset } = header;
      const rgb = bytes.subarray(pixelOffset);
      if (rgb.length !== width * height * 3) {
        return { parseError: `PPM payload length ${rgb.length} != ${width * height * 3}` };
      }
      const pixel = (x, y) => {
        const offset = (y * width + x) * 3;
        return Array.from(rgb.subarray(offset, offset + 3));
      };
      const digest = await crypto.subtle.digest('SHA-256', rgb);
      const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      return {
        width,
        height,
        hash,
        corner: pixel(0, 0),
        orientation: pixel(
          Math.min(Math.max(1, Math.round(width * 5 / 480)), width - 1),
          Math.min(Math.max(1, Math.round(height * 5 / 270)), height - 1),
        ),
        center: pixel(Math.floor(width / 2), Math.floor(height / 2)),
      };
    }, screenshotPath);

    if (pageErrors.length > 0) fail(`${name}: page errors: ${pageErrors.join(' | ')}`);
    if (!capture || capture.width !== expectedWidth || capture.height !== expectedHeight) {
      fail(`${name}: expected ${expectedWidth}x${expectedHeight}, got ${JSON.stringify(capture)}`);
    }
    const closeTo = (actual, expected, tolerance = 8) =>
      actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
    if (!closeTo(capture.corner, [16, 24, 32])) {
      fail(`${name}: capture corner contains bars/stale capacity instead of game content: ${JSON.stringify(capture.corner)}`);
    }
    if (!closeTo(capture.orientation, [255, 59, 48])) {
      fail(`${name}: capture orientation marker mismatch: ${JSON.stringify(capture.orientation)}`);
    }
    if (!closeTo(capture.center, [32, 36, 44])) {
      fail(`${name}: capture center mismatch: ${JSON.stringify(capture.center)}`);
    }
    console.log(`[web-screenshot-smoke] ${name}: retained ${capacity.width}x${capacity.height} -> capture ${capture.width}x${capture.height}`);
    return capture;
  } finally {
    await page.close();
  }
}

try {
  const nativeNoDebug = await runCase({
    name: 'retained-native-no-debug',
    expectedWidth: 800,
    expectedHeight: 450,
  });
  const nativeWithDebug = await runCase({
    name: 'retained-native-with-debug',
    expectedWidth: 800,
    expectedHeight: 450,
    noImgui: false,
  });
  if (nativeNoDebug.hash !== nativeWithDebug.hash) {
    fail('retained-native: debug UI changed captured game pixels');
  }

  const fitNoDebug = await runCase({
    name: 'retained-fit-no-debug',
    screenshotMode: 'fit',
    screenshotSize: '400x400',
    expectedWidth: 400,
    expectedHeight: 225,
  });
  const fitWithDebug = await runCase({
    name: 'retained-fit-with-debug',
    screenshotMode: 'fit',
    screenshotSize: '400x400',
    expectedWidth: 400,
    expectedHeight: 225,
    noImgui: false,
  });
  if (fitNoDebug.hash !== fitWithDebug.hash) {
    fail('retained-fit: debug UI changed captured game pixels');
  }
  console.log('[web-screenshot-smoke] ok');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
