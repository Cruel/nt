#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'build', 'web-debug', 'apps', 'sandbox');
const thresholdsPath = path.join(root, 'scripts', 'web-smoke-thresholds.json');
const thresholds = JSON.parse(await fs.readFile(thresholdsPath, 'utf8'));

function fail(message) {
  console.error(`[web-smoke] ${message}`);
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  fail(`playwright is not installed: ${error instanceof Error ? error.message : String(error)}`);
}

async function startServer() {
const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://localhost');
      let rel = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
      if (rel === '') rel = 'index.html';
      const filePath = path.normalize(path.join(appDir, rel));
      if (!filePath.startsWith(appDir)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html'
        : ext === '.js' ? 'text/javascript'
        : ext === '.wasm' ? 'application/wasm'
        : ext === '.json' ? 'application/json'
        : ext === '.css' ? 'text/css'
        : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('web smoke server failed to bind');
  }
  return { server, port: address.port };
}

function parsePerf(line) {
  const matchers = {
    full_frame_postprocess_targets: /full_frame_postprocess_targets=(\d+)/,
    full_frame_layers: /full_layers=(\d+)/,
    postprocess_pixels: /post_px=(\d+)/,
    composite_pixels: /composite_px=(\d+)/,
    rt_alloc: /rt_alloc=(\d+)/,
    rt_destroy: /rt_destroy=(\d+)/,
    layer_alloc: /layer_alloc=(\d+)/,
    layer_destroy: /layer_destroy=(\d+)/,
  };
  const out = {};
  for (const [key, regex] of Object.entries(matchers)) {
    const match = line.match(regex);
    if (match) out[key] = Number(match[1]);
  }
  return out;
}

const { server, port } = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

try {
  const consoleLines = [];
  const pageErrors = [];
  const perfLines = [];

  page.on('console', (message) => {
    const text = message.text();
    consoleLines.push(text);
    if (text.includes('[perf]')) perfLines.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const url = new URL(`http://127.0.0.1:${port}/index.html`);
  url.searchParams.set('demo', 'none');
  url.searchParams.set('rmlui-document', 'project:/rmlui/readback_gallery.rml');
  url.searchParams.set('frames', '6');
  url.searchParams.set('renderPerf', '1');
  url.searchParams.set('noImgui', '1');

  await page.goto(url.toString(), { waitUntil: 'load' });

  const deadline = Date.now() + 120000;
  while (perfLines.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }

  const perf = perfLines.at(-1);
  if (!perf) {
    fail('no [perf] line captured from web run');
  }

  const values = parsePerf(perf);
  const scene = thresholds.readback_gallery;
  if ((values.full_frame_postprocess_targets ?? 0) > scene.max_full_frame_postprocess_targets) {
    fail(`full-frame postprocess targets exceeded threshold: ${perf}`);
  }
  if ((values.full_frame_layers ?? 0) > scene.max_full_frame_child_layers) {
    fail(`full-frame child layers exceeded threshold: ${perf}`);
  }
  if ((values.postprocess_pixels ?? 0) > scene.max_postprocess_pixels) {
    fail(`postprocess pixels exceeded threshold: ${perf}`);
  }
  if ((values.composite_pixels ?? 0) > scene.max_composite_pixels) {
    fail(`composite pixels exceeded threshold: ${perf}`);
  }
  if (((values.rt_alloc ?? 0) - (values.rt_destroy ?? 0)) > scene.max_steady_state_allocations) {
    fail(`steady-state render-target allocation churn detected: ${perf}`);
  }

  const repeatedErrors = consoleLines.filter((line) => line.includes('GL_INVALID_OPERATION')).length;
  if (repeatedErrors > scene.max_repeated_feedback_loop_errors) {
    fail(`feedback-loop errors detected in console: ${repeatedErrors}`);
  }
  if (pageErrors.length > 0) {
    fail(`page errors captured: ${pageErrors.join(' | ')}`);
  }

  console.log(`[web-smoke] ok: ${perf}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
