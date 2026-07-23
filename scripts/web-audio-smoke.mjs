#!/usr/bin/env node

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[web-audio-smoke] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parseArgs(argv) {
  const options = { buildDir: 'build/web-debug', expectedMode: 'threaded' };
  for (let index = 0; index < argv.length; ++index) {
    const arg = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) fail(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === '--build-dir') options.buildDir = value();
    else if (arg === '--expected-mode') options.expectedMode = value();
    else fail(`unknown argument: ${arg}`);
  }
  if (!['threaded', 'cooperative'].includes(options.expectedMode)) {
    fail(`invalid --expected-mode: ${options.expectedMode}`);
  }
  options.appDir = path.resolve(root, options.buildDir, 'apps', 'sandbox');
  return options;
}

async function startServer(appDir) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
      const requestUrl = new URL(request.url || '/', 'http://localhost');
      let relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      if (relative === '') relative = 'index.html';
      const filePath = path.normalize(path.join(appDir, relative));
      if (!filePath.startsWith(appDir)) fail('request escaped app directory');
      const body = await fs.readFile(filePath);
      const extension = path.extname(filePath);
      const contentType = extension === '.html' ? 'text/html'
        : extension === '.js' ? 'text/javascript'
        : extension === '.wasm' ? 'application/wasm'
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
  if (!address || typeof address === 'string') fail('server failed to bind');
  return { server, port: address.port };
}

const options = parseArgs(process.argv.slice(2));
for (const file of ['index.html', 'index.js', 'index.wasm', 'index.data']) {
  await fs.access(path.join(options.appDir, file));
}

const { chromium } = await import('playwright');
const { server, port } = await startServer(options.appDir);
const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const consoleLines = [];
  const pageErrors = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const url = new URL(`http://127.0.0.1:${port}/index.html`);
  url.searchParams.set('demo', 'none');
  url.searchParams.set('noImgui', '1');
  await page.goto(url.toString(), { waitUntil: 'load' });
  await page.waitForFunction(() =>
    typeof Module !== 'undefined' && typeof Module.ccall === 'function' &&
    Module.calledRun === true,
    undefined, { timeout: 60_000 });
  await page.waitForFunction(() =>
    Module.ccall('noveltea_audio_backend_available', 'number', [], []) === 1,
    undefined, { timeout: 60_000 });

  const policy = await page.evaluate(() => ({
    threads: Module.ccall('noveltea_audio_resource_manager_job_thread_count', 'number', [], []),
    noThreading: Module.ccall('noveltea_audio_resource_manager_no_threading', 'number', [], []),
  }));
  const expected = options.expectedMode === 'threaded'
    ? { threads: 1, noThreading: 0 }
    : { threads: 0, noThreading: 1 };
  if (policy.threads !== expected.threads || policy.noThreading !== expected.noThreading) {
    fail(`resource-manager policy mismatch: ${JSON.stringify(policy)} expected ${JSON.stringify(expected)}`);
  }

  await page.locator('canvas').click({ position: { x: 10, y: 10 } });
  await page.evaluate(() => Module.ccall(
    'noveltea_audio_play_sfx', null, ['string', 'number', 'number'],
    ['project:/audio/notification.mp3', 1, 1]));
  await page.waitForFunction(() =>
    Module.ccall('noveltea_audio_voices_started', 'number', [], []) >= 1,
    undefined, { timeout: 30_000 });
  await page.waitForFunction(() =>
    Module.ccall('noveltea_audio_voices_finished', 'number', [], []) >= 1,
    undefined, { timeout: 60_000 });

  const errors = await page.evaluate(() =>
    Module.ccall('noveltea_audio_backend_errors', 'number', [], []));
  if (errors !== 0) fail(`backend reported ${errors} error(s)`);
  if (pageErrors.length > 0) fail(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleLines.some((line) => line.includes('audio.') && line.includes('failed'))) {
    fail(`audio failure diagnostic observed: ${consoleLines.join(' | ')}`);
  }
  console.log(`[web-audio-smoke] ok (${options.expectedMode}): playback completed`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
