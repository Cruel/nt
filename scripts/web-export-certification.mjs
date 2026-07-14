#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

function fail(message) {
  throw new Error(`[web-export-certification] ${message}`);
}

function parseArgs(argv) {
  const options = { cases: [], output: undefined };
  for (let i = 0; i < argv.length; ++i) {
    if (argv[i] === '--case') {
      const value = argv[++i];
      if (!value) fail('--case requires label:base-path:export-directory');
      const first = value.indexOf(':');
      const second = value.indexOf(':', first + 1);
      if (first < 1 || second < 0) fail(`invalid --case '${value}'`);
      options.cases.push({ label: value.slice(0, first), basePath: value.slice(first + 1, second), directory: path.resolve(value.slice(second + 1)) });
    } else if (argv[i] === '--output') {
      options.output = path.resolve(argv[++i] ?? fail('--output requires a path'));
    } else {
      fail(`unknown argument '${argv[i]}'`);
    }
  }
  if (options.cases.length === 0) fail('at least one --case is required');
  for (const item of options.cases) {
    if (!item.basePath.startsWith('/') || !item.basePath.endsWith('/')) fail(`case '${item.label}' base path must start and end with '/'`);
  }
  return options;
}

const contentType = (file) => ({
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ntpkg': 'application/octet-stream',
}[path.extname(file)] ?? 'application/octet-stream');

async function inspectCase(item) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  }
  await walk(item.directory);
  const packages = files.filter((file) => file.endsWith('.ntpkg'));
  if (packages.length !== 1) fail(`case '${item.label}' contains ${packages.length} .ntpkg files; expected exactly one`);
  const config = JSON.parse(await fs.readFile(path.join(item.directory, 'player.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(item.directory, 'manifest.webmanifest'), 'utf8'));
  if (config.package?.path !== packages[0]) fail(`case '${item.label}' player.json does not identify its only package`);
  if (manifest.start_url !== item.basePath || manifest.scope !== item.basePath) fail(`case '${item.label}' manifest base path does not match ${item.basePath}`);
  return { ...item, files, packagePath: packages[0], packageSha256: config.package.sha256 };
}

async function startServer(cases, requests) {
  const ordered = [...cases].sort((a, b) => b.basePath.length - a.basePath.length);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const item = ordered.find((candidate) => pathname.startsWith(candidate.basePath));
    if (!item) { response.writeHead(404).end('not found'); return; }
    let relative = pathname.slice(item.basePath.length);
    if (!relative) relative = 'index.html';
    const file = path.resolve(item.directory, relative);
    if (file !== item.directory && !file.startsWith(`${item.directory}${path.sep}`)) { response.writeHead(403).end('forbidden'); return; }
    try {
      const body = await fs.readFile(file);
      requests.push({ case: item.label, path: pathname, status: 200 });
      response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
      response.end(body);
    } catch {
      requests.push({ case: item.label, path: pathname, status: 404 });
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

const options = parseArgs(process.argv.slice(2));
const cases = await Promise.all(options.cases.map(inspectCase));
const requests = [];
const { chromium } = await import('playwright');
const { server, port } = await startServer(cases, requests);
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const item of cases) {
    const page = await browser.newPage();
    const consoleLines = [];
    const pageErrors = [];
    page.on('console', (message) => consoleLines.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const url = `http://127.0.0.1:${port}${item.basePath}`;
    await page.goto(url, { waitUntil: 'load' });
    if (!(await page.locator('#launch').isVisible())) fail(`case '${item.label}' did not gate startup behind its launch gesture`);
    if (await page.evaluate(() => typeof window.Module !== 'undefined')) fail(`case '${item.label}' initialized the runtime before the launch gesture`);
    await page.locator('#start').click();
    const expectedPackageUrl = `${item.basePath}${item.packagePath}`;
    const deadline = Date.now() + 120_000;
    while (!consoleLines.some((line) => line.includes('NOVELTEA_PLAYER_READY')) &&
           !(await page.locator('#failure').isVisible()) && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }
    const packageRequests = requests.filter((entry) => entry.case === item.label && entry.path === expectedPackageUrl && entry.status === 200);
    if (packageRequests.length < 1) fail(`case '${item.label}' did not fetch ${expectedPackageUrl}`);
    const unexpectedPackageRequests = requests.filter((entry) => entry.case === item.label && entry.path.endsWith('.ntpkg') && entry.path !== expectedPackageUrl);
    if (unexpectedPackageRequests.length) fail(`case '${item.label}' requested an undeclared package path`);
    if (pageErrors.length) fail(`case '${item.label}' page errors: ${pageErrors.join(' | ')}`);
    const failure = await page.locator('#failure').isVisible();
    if (failure) fail(`case '${item.label}' startup failed: ${await page.locator('#failure-message').textContent()}; recent console: ${consoleLines.slice(-20).join(' | ')}`);
    if (!consoleLines.some((line) => line.includes('NOVELTEA_PLAYER_READY'))) fail(`case '${item.label}' did not reach the player-ready marker; recent console: ${consoleLines.slice(-20).join(' | ')}`);
    results.push({ label: item.label, basePath: item.basePath, packagePath: item.packagePath, packageSha256: item.packageSha256, packageRequest: expectedPackageUrl, launchGestureGated: true, consoleLines });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const evidence = {
  format: 'noveltea.web-export-browser-certification', formatVersion: 1,
  generatedAt: new Date().toISOString(), browser: 'chromium', results, requests,
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (options.output) {
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  await fs.writeFile(options.output, serialized);
}
console.log(`[web-export-certification] passed ${results.length} finalized export case(s); evidence-sha256=${createHash('sha256').update(serialized).digest('hex')}`);
