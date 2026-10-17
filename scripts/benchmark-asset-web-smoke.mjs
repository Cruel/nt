#!/usr/bin/env node
// Browser functional regression for real production asset realization.
// No performance threshold: WebGL software rendering is a valid test backend.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';

const root = path.resolve(process.argv[2] || 'build/web-benchmark-debug/apps/benchmark');
const types = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream'
};
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) || !types[path.extname(file)]) {
    response.writeHead(404).end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, {'Content-Type': types[path.extname(file)]});
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
        firefoxUserPrefs: {'webgl.disabled': false, 'webgl.force-enabled': true,
                           'webgl.enable-webgl2': true, 'webgl.software-rendering': true},
        env: {...process.env, LIBGL_ALWAYS_SOFTWARE: '1', MOZ_WEBRENDER: '1'}
      } : {})
    });
    try {
      const page = await browser.newPage({acceptDownloads: true});
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
      // Both headless cases must export reports without initializing SDL video.
      for (const [scenario, cache] of [
        ['asset-source-read', 'cold'],
        ['asset-project-prepare', 'warm']
      ]) {
        await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
          scenario, noUi: '1', frames: '6', warmup: '0', repeats: '2',
          cpuWorkUnits: '2', assetCache: cache
        }));
        await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length >= 1,
                                   null, {timeout: 90000});
        const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
        if (report?.outcome !== 'complete' || report?.scenarios?.[0]?.id !== scenario ||
            report?.scenarios?.[0]?.aggregate?.measured_frames !== 12 ||
            report?.graphics?.renderer !== null ||
            report?.configuration?.parameters?.cache !== cache ||
            report?.configuration?.parameters?.work_units !== 2) {
          throw new Error(name + ' ' + scenario + ' invalid report: ' +
                          JSON.stringify(report).slice(0, 7000));
        }
        console.log(name + ': ' + scenario + ' ' + cache +
                    ' 12 CPU-only batches across two trials PASS');
      }
      for (const cache of ['warm', 'cold']) {
        await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
          scenario: 'asset-texture-realize', noUi: '1', frames: '6',
          warmup: '0', repeats: '2', cpuWorkUnits: '2', assetCache: cache,
          readyTimeout: '30', profile: 'diagnostic'
        }));
        try {
          await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length >= 1,
                                     null, {timeout: 90000});
        } catch (error) {
          const status = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            log: document.querySelector('#log')?.textContent?.slice(-6000),
            ready: window.NovelTeaBenchmark?.ready
          }));
          throw new Error(name + ' ' + cache + ': ' + error.message + ' ' +
                          JSON.stringify(status) + ' ' + errors.join('; '));
        }
        const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
        const scenario = report?.scenarios?.[0];
        const aggregate = scenario?.aggregate;
        if (report?.outcome !== 'complete' ||
            scenario?.id !== 'asset-texture-realize' ||
            aggregate?.measured_frames !== 12 ||
            scenario?.trials?.length !== 2 ||
            report?.configuration?.parameters?.cache !== cache ||
            report?.configuration?.parameters?.work_units !== 2 ||
            report?.graphics?.asset_workload?.source_backend !== 'Web MEMFS' ||
            report?.graphics?.asset_workload?.gpu_upload_execution_ms !== null ||
            aggregate?.frame_loop_cadence_hz !== null ||
            !(aggregate?.asset_work_batches_per_second > 0)) {
          throw new Error(name + ' ' + cache + ' invalid report: ' +
                          JSON.stringify(report).slice(0, 7000));
        }
        console.log(name + ': asset-texture-realize ' + cache +
                    ' 12 batches across two trials PASS');
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
