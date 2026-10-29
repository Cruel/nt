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
      headless: name !== 'Firefox' || !process.env.NOVELTEA_BENCHMARK_FIREFOX_HEADFUL,
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
      await page.addInitScript(() => {
        window.__benchmarkRafTicks = 0;
        const count = () => {
          ++window.__benchmarkRafTicks;
          requestAnimationFrame(count);
        };
        requestAnimationFrame(count);
      });
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
            report?.configuration?.parameters?.work_units !== 2 ||
            !report?.timing?.frame_wall?.includes('browser scheduling gaps excluded')) {
          throw new Error(name + ' ' + scenario + ' invalid report: ' +
                          JSON.stringify(report).slice(0, 7000));
        }
        console.log(name + ': ' + scenario + ' ' + cache +
                    ' 12 CPU-only batches across two trials PASS');
      }
      // A visibilitychange event may fire while rAF is suspended, with no C++
      // callback until the tab is visible again. Dispatch hide/restore within
      // one JS task so no rAF callback can see document.hidden === true.
      await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
        scenario: 'cpu-lua', noUi: '1', frames: '30000',
        warmup: '0.025', cpuWorkUnits: '16'
      }));
      await page.waitForFunction(() => window.NovelTeaBenchmark?.ready,
                                 null, {timeout: 30000});
      const rafBefore = await page.evaluate(() => window.__benchmarkRafTicks);
      await page.waitForFunction(ticks => window.__benchmarkRafTicks >= ticks + 8,
                                 rafBefore, {timeout: 15000});
      const latchedOnRestore = await page.evaluate(() => {
        const ticks = window.__benchmarkRafTicks;
        Object.defineProperty(document, 'hidden', {configurable: true, value: true});
        document.dispatchEvent(new Event('visibilitychange'));
        const latched = window.NovelTeaBenchmark.backgrounded;
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
        return latched && !document.hidden && window.__benchmarkRafTicks === ticks;
      });
      if (!latchedOnRestore)
        throw new Error(name + ' visibility latch did not survive hide/restore without rAF');
      await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length >= 1,
                                 null, {timeout: 90000});
      const resumed = await page.evaluate(() => ({
        report: window.NovelTeaBenchmark.runs[0].report,
        backgrounded: window.NovelTeaBenchmark.backgrounded
      }));
      const resumedTrial = resumed.report?.scenarios?.[0]?.trials?.[0];
      if (resumed.report?.outcome !== 'complete' ||
          resumedTrial?.interruption_retries !== 1 ||
          !resumedTrial?.interrupted_attempts?.[0]?.reason?.includes('backgrounded') ||
          // A faster optimized build may observe visibility during warmup;
          // that still must discard the attempt and retry from a fresh warmup.
          !(resumedTrial?.interrupted_attempts?.[0]?.warmup_frames > 0) ||
          !(resumedTrial?.warmup_frames > 0) ||
          resumedTrial?.measured_frames !== 30000 ||
          resumed.backgrounded !== false) {
        throw new Error(name + ' missed headless visibility recovery: ' +
                        JSON.stringify(resumed).slice(0, 7000));
      }
      console.log(name + ': headless hide/restore with suspended rAF PASS');

      // The CI responsiveness smoke uses a fixed amount of CPU work, not a
      // duration or throughput target: slow/shared runners and coarse browser
      // clocks must not turn successful work into a performance failure.
      await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
        scenario: 'cpu-lua', noUi: '1', warmup: '0',
        frames: '512', cpuWorkUnits: '16'
      }));
      try {
        await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length >= 1,
                                   null, {timeout: 90000});
      } catch (error) {
        const diagnostic = await page.evaluate(() => ({
          ready: window.NovelTeaBenchmark?.ready,
          ticks: window.__benchmarkRafTicks,
          status: document.querySelector('#status')?.textContent,
          log: document.querySelector('#log')?.textContent?.slice(-5000)
        }));
        throw new Error(name + ' cpu-lua: ' + error.message + ' ' +
                        JSON.stringify(diagnostic) + ' ' + errors.join('; '));
      }
      const cpuReport = await page.evaluate(() => ({
        report: window.NovelTeaBenchmark.runs[0].report,
        rafTicks: window.__benchmarkRafTicks
      }));
      const cpuAggregate = cpuReport.report?.scenarios?.[0]?.aggregate;
      if (cpuReport.report?.outcome !== 'complete' ||
          cpuAggregate?.frame_loop_cadence_hz !== null ||
          !cpuReport.report?.timing?.frame_wall?.includes('browser scheduling gaps excluded') ||
          cpuAggregate?.measured_frames !== 512 ||
          cpuReport.report?.graphics?.renderer !== null ||
          cpuReport.rafTicks < 5) {
        throw new Error(name + ' headless CPU responsiveness invalid: ' +
                        JSON.stringify(cpuReport).slice(0, 7000));
      }
      console.log(name + ': cpu-lua headless rAF responsiveness PASS');

      // Allow headless-only verification on browsers without a usable WebGL2 host.
      if (process.env.NOVELTEA_BENCHMARK_HEADLESS_ONLY === '1')
        continue;
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
            !report?.timing?.frame_wall?.includes('requestAnimationFrame-paced interval') ||
            !report?.timing?.frame_wall?.includes('browser scheduling') ||
            report?.timing?.frame_wall?.includes('scheduling gaps excluded') ||
            report?.graphics?.asset_workload?.source_backend !== 'Web MEMFS' ||
            report?.graphics?.asset_workload?.gpu_upload_execution_ms !== null ||
            aggregate?.frame_loop_cadence_hz !== null ||
            aggregate?.measured_frames !== 12) {
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
