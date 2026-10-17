#!/usr/bin/env node
// Check browser PNG download and production Engine ownership outside timed runs.
// No FPS or GPU timing thresholds are involved.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const directory = path.resolve(process.argv[2] || 'build/web-benchmark-debug/apps/benchmark');
const mime = {'.html': 'text/html', '.js': 'text/javascript',
              '.wasm': 'application/wasm', '.data': 'application/octet-stream'};
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(directory, '.' + pathname);
  if (!file.startsWith(directory + path.sep) ||
      !/\.(html|js|wasm|data)$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, {'Content-Type': mime[path.extname(file)]});
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  // Keep the browser canvas at 1280x720 (the responsive narrow default
  // viewport otherwise shrinks it to a non-16:9 rectangle).
  const page = await browser.newPage({acceptDownloads: true,
                                      viewport: {width: 1600, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const scenario of ['raw-bgfx-geometry', 'standalone-rmlui-simple',
                          'integrated-rmlui-controlled', 'integrated-rmlui-production']) {
    await page.goto('http://127.0.0.1:' + server.address().port +
                    '/benchmark.html?ui=1&scenario=' + scenario);
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready, null, {timeout: 30000});
    await page.locator('#canvas').focus();
    await page.keyboard.press('F9');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.screenshots.length === 1,
                               null, {timeout: 60000});
    const captured = await page.evaluate(scenario => {
      const item = window.NovelTeaBenchmark.screenshots[0];
      const source = item.bytes;
      const asText = new TextDecoder('latin1').decode(source);
      const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
      return {
        name: item.name,
        size: source.byteLength,
        magic: Array.from(source.subarray(0, 8)),
        width: view.getUint32(16),
        height: view.getUint32(20),
        hasMetadata: asText.includes('NovelTea benchmark') &&
                     asText.includes('untimed-inspection') &&
                     asText.includes(scenario) &&
                     asText.includes('configuration'),
        dashboardRestored: !!document.querySelector('#canvas')
      };
    }, scenario);
    if (captured.size < 1000 ||
        captured.magic.join() !== [137, 80, 78, 71, 13, 10, 26, 10].join() ||
        captured.width !== 1280 || captured.height !== 720 ||
        !captured.hasMetadata || !captured.dashboardRestored)
      throw new Error(scenario + ': invalid PNG capture ' + JSON.stringify(captured));
    // Verify the explicit browser download action, not only the in-memory
    // screenshot hook (browsers may block automatic downloads).
    const downloadReady = page.waitForEvent('download');
    await page.locator('#download-png').click();
    const downloaded = await downloadReady;
    const downloadBytes = await readFile(await downloaded.path());
    if (downloaded.suggestedFilename() !== captured.name ||
        downloadBytes.length !== captured.size)
      throw new Error(scenario + ': downloaded PNG differs from capture');
    if (scenario.startsWith('integrated-')) {
      await page.waitForTimeout(200);
      await page.keyboard.press('F9');
      await page.waitForFunction(() => window.NovelTeaBenchmark?.screenshots.length === 2,
                                 null, {timeout: 60000});
    }
    console.log('[benchmark] web inspection ' + scenario + ' OK (' +
                captured.size + ' PNG bytes)');
  }
  if (errors.length)
    throw new Error('Browser errors: ' + errors.join('; '));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
