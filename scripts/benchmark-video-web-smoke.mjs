#!/usr/bin/env node
// Functional Web video smoke. No GPU/FPS thresholds: browser software fallback is valid.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const root = path.resolve(process.argv[2] || 'build/web-benchmark-debug/apps/benchmark');
const mime = {'.html': 'text/html', '.js': 'text/javascript',
              '.wasm': 'application/wasm', '.data': 'application/octet-stream'};
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) || !/\.(html|js|wasm|data)$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {'Content-Type': mime[path.extname(file)]});
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let failed = false;
try {
  for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox]]) {
    if (process.env.NOVELTEA_BENCHMARK_BROWSER &&
        process.env.NOVELTEA_BENCHMARK_BROWSER !== name) continue;
    const browser = await engine.launch({
      headless: true,
      args: name === 'Chromium'
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
      ...(name === 'Firefox' ? {
        firefoxUserPrefs: {
          'webgl.disabled': false,
          'webgl.force-enabled': true,
          'webgl.enable-webgl2': true,
          'webgl.software-rendering': true,
        },
        env: {...process.env, LIBGL_ALWAYS_SOFTWARE: '1', MOZ_WEBRENDER: '1'}
      } : {})
    });
    try {
      const page = await browser.newPage();
      const logs = [];
      page.on('pageerror', error => logs.push('page: ' + error.message));
      page.on('console', message => {
        if (message.type() === 'error') logs.push('console: ' + message.text());
      });
      for (const scenario of ['video-upload', 'video-present']) {
        await page.goto(origin + '/benchmark.html?' +
          new URLSearchParams({scenario, noUi: '1', smoke: '1', repeats: '2',
                               readyTimeout: '30', profile: 'diagnostic'}));
        try {
          await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length >= 1,
                                     null, {timeout: 90000});
        } catch (error) {
          const status = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            log: document.querySelector('#log')?.textContent?.slice(-6000),
            ready: window.NovelTeaBenchmark?.ready,
          }));
          throw new Error(name + ' ' + scenario + ': ' + error.message + ' ' +
                          JSON.stringify(status) + ' ' + logs.join('; '));
        }
        const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
        const workload = report?.scenarios?.[0];
        if (report?.outcome !== 'complete' ||
            workload?.id !== scenario || workload?.aggregate?.measured_frames !== 60 ||
            report?.graphics?.video_decode_backend !== 'browser-media-gpu' ||
            report?.graphics?.video_hardware_decode_confirmed !== null) {
          throw new Error(name + ' ' + scenario + ' incorrect report: ' +
                          JSON.stringify(report).slice(-6000));
        }
        console.log(name + ': ' + scenario + ' 60 frames across two browser-media trials PASS');
      }
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await new Promise(resolve => server.close(resolve));
}
if (failed) process.exitCode = 1;
