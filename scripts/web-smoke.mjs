#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const thresholdsPath = path.join(root, 'scripts', 'web-smoke-thresholds.json');
const thresholds = JSON.parse(await fs.readFile(thresholdsPath, 'utf8'));

function fail(message) {
  console.error(`[web-smoke] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    buildDir: 'build/web-debug',
    threshold: 'readback_gallery_debug',
    frames: 12,
    minPerfLines: 2,
    label: 'web-debug',
  };

  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    const readValue = (name) => {
      if (i + 1 >= argv.length) {
        fail(`${name} requires a value`);
      }
      return argv[++i];
    };

    if (arg === '--build-dir') {
      options.buildDir = readValue(arg);
    } else if (arg === '--threshold') {
      options.threshold = readValue(arg);
    } else if (arg === '--frames') {
      options.frames = Number(readValue(arg));
    } else if (arg === '--min-perf-lines') {
      options.minPerfLines = Number(readValue(arg));
    } else if (arg === '--label') {
      options.label = readValue(arg);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`usage: node scripts/web-smoke.mjs [options]\n\n` +
        `Options:\n` +
        `  --build-dir <path>       Web sandbox build directory (default: build/web-debug)\n` +
        `  --threshold <name>       Threshold set from scripts/web-smoke-thresholds.json\n` +
        `  --frames <count>         Runtime frame count URL flag (default: 12)\n` +
        `  --min-perf-lines <count> Required captured [perf] lines (default: 2)\n` +
        `  --label <text>           Label printed in smoke output\n`);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.frames) || options.frames <= 0) {
    fail(`--frames must be a positive integer, got ${options.frames}`);
  }
  if (!Number.isInteger(options.minPerfLines) || options.minPerfLines <= 0) {
    fail(`--min-perf-lines must be a positive integer, got ${options.minPerfLines}`);
  }
  if (!thresholds[options.threshold]) {
    fail(`unknown threshold set '${options.threshold}' in ${thresholdsPath}`);
  }

  options.appDir = path.resolve(root, options.buildDir, 'apps', 'sandbox');
  return options;
}

const options = parseArgs(process.argv.slice(2));

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch (error) {
  fail(`playwright is not installed: ${error instanceof Error ? error.message : String(error)}`);
}

async function requireBuiltApp(appDir) {
  const requiredFiles = ['index.html', 'index.js', 'index.wasm', 'index.data'];
  const missing = [];
  for (const file of requiredFiles) {
    try {
      await fs.access(path.join(appDir, file));
    } catch {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    fail(`missing web build files in ${appDir}: ${missing.join(', ')}. Build the matching preset before running this smoke.`);
  }
}

async function startServer(appDir) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
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
  const values = {};
  const tokenRegex = /([A-Za-z_]+)=([^\s]+)/g;
  for (const match of line.matchAll(tokenRegex)) {
    const [, key, raw] = match;
    const size = raw.match(/^(\d+)x(\d+)$/);
    if (size) {
      values[`${key}_w`] = Number(size[1]);
      values[`${key}_h`] = Number(size[2]);
      continue;
    }
    if (/^\d+$/.test(raw)) {
      values[key] = Number(raw);
      continue;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      values[key] = numeric;
    }
  }
  return values;
}

function requirePerfKeys(values, keys, perf) {
  const missing = keys.filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    fail(`perf line is missing required key(s) ${missing.join(', ')}: ${perf}`);
  }
}

function assertMax(values, key, max, label, perf) {
  if (max === undefined) return;
  if (values[key] === undefined) {
    fail(`perf line is missing required threshold key ${key}: ${perf}`);
  }
  if (values[key] > max) {
    fail(`${label} exceeded threshold (${values[key]} > ${max}): ${perf}`);
  }
}

function assertEquals(values, key, expected, label, perf) {
  if (expected === undefined) return;
  if (values[key] === undefined) {
    fail(`perf line is missing required equality key ${key}: ${perf}`);
  }
  if (values[key] !== expected) {
    fail(`${label} did not match expected value (${values[key]} != ${expected}): ${perf}`);
  }
}

function assertMaxPixels(values, keyPrefix, widthKey, heightKey, maxPixels, label, perf) {
  if (maxPixels === undefined) return;
  const width = values[widthKey];
  const height = values[heightKey];
  if (width === undefined || height === undefined) {
    fail(`perf line is missing required size key(s) ${widthKey}/${heightKey}: ${perf}`);
  }
  const pixels = width * height;
  if (pixels > maxPixels) {
    fail(`${label} exceeded threshold (${keyPrefix}=${width}x${height}, ${pixels} > ${maxPixels}): ${perf}`);
  }
}

function dynamicLimit(scene, values, fixedKey, ratioKey, framebufferKey, fallbackMax) {
  const fixed = scene[fixedKey];
  const ratio = scene[ratioKey];
  const framebuffer = values[framebufferKey];
  const candidates = [];
  if (fixed !== undefined) candidates.push(fixed);
  if (ratio !== undefined && framebuffer !== undefined) candidates.push(Math.ceil(framebuffer * ratio));
  if (candidates.length === 0) return undefined;
  return Math.max(...candidates, fallbackMax ?? 0);
}

function assertMaxDimension(values, key, scene, thresholdPrefix, label, perf) {
  const axis = key.endsWith('_w') ? 'width' : 'height';
  const fixedKey = `${thresholdPrefix}_${axis}`;
  const ratioKey = `${thresholdPrefix}_${axis}_ratio`;
  const framebufferKey = axis === 'width' ? 'fb_w' : 'fb_h';
  const max = dynamicLimit(scene, values, fixedKey, ratioKey, framebufferKey, 0);
  if (max === undefined) return;
  if (values[key] === undefined) {
    fail(`perf line is missing required size key ${key}: ${perf}`);
  }
  if (values[key] > max) {
    fail(`${label} ${axis} exceeded threshold (${values[key]} > ${max}): ${perf}`);
  }
}

await requireBuiltApp(options.appDir);

const { server, port } = await startServer(options.appDir);
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
  url.searchParams.set('frames', String(options.frames));
  url.searchParams.set('renderPerf', '1');
  url.searchParams.set('noImgui', '1');

  console.log(`[web-smoke] running ${options.label}: ${url.toString()}`);
  console.log(`[web-smoke] build dir: ${options.appDir}`);
  console.log(`[web-smoke] threshold: ${options.threshold}`);

  await page.goto(url.toString(), { waitUntil: 'load' });

  const deadline = Date.now() + 120000;
  while (perfLines.length < options.minPerfLines && Date.now() < deadline) {
    await page.waitForTimeout(250);
  }

  const perf = perfLines.at(-1);
  if (!perf) {
    fail('no [perf] line captured from web run');
  }
  if (perfLines.length < options.minPerfLines) {
    fail(`captured ${perfLines.length} [perf] line(s), expected at least ${options.minPerfLines}: ${perf}`);
  }

  const values = parsePerf(perf);
  const scene = thresholds[options.threshold];
  requirePerfKeys(values, scene.required_perf_keys ?? [], perf);

  assertMax(values, 'full_frame_child_layers', scene.max_full_frame_child_layers,
            'full-frame child layers', perf);
  assertMax(values, 'unbounded_layer_fallbacks', scene.max_unbounded_layer_fallbacks,
            'unbounded layer fallbacks', perf);
  assertMax(values, 'unbounded_no_scissor_fallbacks', scene.max_unbounded_no_scissor_fallbacks,
            'no-scissor layer fallbacks', perf);
  assertMax(values, 'unbounded_transform_fallbacks', scene.max_unbounded_transform_fallbacks,
            'transform layer fallbacks', perf);
  assertMax(values, 'unbounded_inverse_clip_fallbacks', scene.max_unbounded_inverse_clip_fallbacks,
            'inverse-clip layer fallbacks', perf);
  assertMax(values, 'full_frame_passes', scene.max_full_frame_passes,
            'full-frame passes', perf);
  assertMax(values, 'full_frame_clear_passes', scene.max_full_frame_clear_passes,
            'full-frame clear passes', perf);
  assertMax(values, 'full_frame_composite_passes', scene.max_full_frame_composite_passes,
            'full-frame composite passes', perf);
  assertMax(values, 'full_frame_postprocess_passes', scene.max_full_frame_postprocess_passes,
            'full-frame postprocess passes', perf);
  assertMax(values, 'full_frame_postprocess_target_uses', scene.max_full_frame_postprocess_target_uses,
            'full-frame postprocess target uses', perf);
  assertMax(values, 'post_px', scene.max_postprocess_pixels,
            'postprocess pixels', perf);
  assertMax(values, 'composite_px', scene.max_composite_pixels,
            'composite pixels', perf);

  assertEquals(values, 'rt_alloc', scene.expected_rt_alloc, 'render-target allocations', perf);
  assertEquals(values, 'rt_destroy', scene.expected_rt_destroy, 'render-target destroys', perf);
  assertEquals(values, 'layer_alloc', scene.expected_layer_alloc, 'layer allocations', perf);
  assertEquals(values, 'layer_destroy', scene.expected_layer_destroy, 'layer destroys', perf);

  assertMaxPixels(values, 'max_rt', 'max_rt_w', 'max_rt_h', scene.max_postprocess_target_pixels,
                  'max postprocess target', perf);
  assertMaxPixels(values, 'max_child_layer', 'max_child_layer_w', 'max_child_layer_h',
                  scene.max_child_layer_pixels, 'max child layer', perf);
  assertMaxPixels(values, 'max_child_rt', 'max_child_rt_w', 'max_child_rt_h',
                  scene.max_child_rt_pixels, 'max child render target', perf);

  assertMaxDimension(values, 'max_child_layer_w', scene, 'max_child_layer', 'max child layer', perf);
  assertMaxDimension(values, 'max_child_layer_h', scene, 'max_child_layer', 'max child layer', perf);
  assertMaxDimension(values, 'max_child_rt_w', scene, 'max_child_rt', 'max child render target', perf);
  assertMaxDimension(values, 'max_child_rt_h', scene, 'max_child_rt', 'max child render target', perf);
  assertMaxDimension(values, 'max_rt_w', scene, 'max_postprocess_target', 'max postprocess target', perf);
  assertMaxDimension(values, 'max_rt_h', scene, 'max_postprocess_target', 'max postprocess target', perf);

  if (scene.max_steady_state_allocations !== undefined &&
      ((values.rt_alloc ?? 0) - (values.rt_destroy ?? 0)) > scene.max_steady_state_allocations) {
    fail(`steady-state render-target allocation churn detected: ${perf}`);
  }
  if (scene.max_steady_state_layer_allocations !== undefined &&
      ((values.layer_alloc ?? 0) - (values.layer_destroy ?? 0)) > scene.max_steady_state_layer_allocations) {
    fail(`steady-state layer allocation churn detected: ${perf}`);
  }

  const repeatedErrors = consoleLines.filter((line) => line.includes('GL_INVALID_OPERATION')).length;
  if (repeatedErrors > scene.max_repeated_feedback_loop_errors) {
    fail(`feedback-loop errors detected in console: ${repeatedErrors}`);
  }
  if (pageErrors.length > 0) {
    fail(`page errors captured: ${pageErrors.join(' | ')}`);
  }

  const fps = values.fps === undefined ? 'unknown' : String(values.fps);
  console.log(`[web-smoke] fps informational only: ${fps}`);
  console.log(`[web-smoke] ok (${options.label}): ${perf}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
