#!/usr/bin/env node
// Functional WebGL2 production Renderer, text and shader/material/postprocess smoke.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, firefox} from 'playwright';

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
const cases = [
  {scenario: 'native-2d-geometry', nativeQuads: '48', nativeTextureSize: '64'},
  {scenario: 'native-2d-text-static', nativeGlyphs: '48'},
  {scenario: 'native-2d-text-dynamic', nativeGlyphs: '48'},
  {scenario: 'native-shader-material', nativeQuads: '48'},
  {scenario: 'native-postprocess', compositionPath: 'offscreen',
   compositePasses: '2', shaderTint: '0.8', shaderScope: 'world'}
];
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
      const errors = [];
      page.on('pageerror', error => errors.push('page: ' + error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push('console: ' + message.text());
      });
      for (const config of cases) {
        await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
          ...config, noUi: '1', frames: '8', warmup: '0', repeats: '2',
          width: '640', height: '480', readyTimeout: '30'
        }));
        try {
          await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length > 0,
                                     null, {timeout: 90000});
        } catch (error) {
          const status = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            log: document.querySelector('#log')?.textContent?.slice(-5000),
            ready: window.NovelTeaBenchmark?.ready
          }));
          throw new Error(name + ' ' + config.scenario + ' stalled: ' +
                          JSON.stringify(status) + '; ' + errors.join('; '));
        }
        const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
        const scenario = report?.scenarios?.[0];
        if (report?.outcome !== 'complete' || scenario?.id !== config.scenario ||
            scenario?.aggregate?.measured_frames !== 16 ||
            scenario?.trials?.length !== 2 || scenario.trials.some(t => t.outcome !== 'complete') ||
            !scenario.graphics?.renderer || scenario.graphics?.platform !== 'Emscripten') {
          throw new Error(name + ' ' + config.scenario + ': ' +
                          JSON.stringify(report).slice(-7000) + '; ' + errors.join('; '));
        }
        console.log(name + ': ' + config.scenario + ' 16 production Renderer frames PASS');
      }
      // Exercise the interactive dashboard's graphics ownership transfer,
      // including headless CPU and source-asset batches while ImGui is absent.
      for (const scenario of ['native-2d-geometry', 'cpu-lua', 'asset-source-read']) {
        await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
          scenario, dashboardSmoke: '1',
          ...(scenario === 'native-2d-geometry' ? {} : {cpuWorkUnits: '2'}),
          width: '640', height: '480', readyTimeout: '30'
        }));
        try {
          await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 3,
                                     null, {timeout: 90000});
        } catch (error) {
          const status = await page.evaluate(() => ({
            status: document.querySelector('#status')?.textContent,
            log: document.querySelector('#log')?.textContent?.slice(-5000),
            completed: window.NovelTeaBenchmark?.runs.length
          }));
          throw new Error(name + ' dashboard ' + scenario + ': ' +
                          JSON.stringify(status) + '; ' + errors.join('; '));
        }
        const reports = await page.evaluate(() => window.NovelTeaBenchmark.runs.map(r => r.report));
        if (reports[0]?.scenarios?.[0]?.id !== scenario ||
            reports.some(report => report.outcome !== 'complete'))
          throw new Error(name + ' dashboard run mismatch ' + scenario + ': ' +
                          JSON.stringify(reports).slice(-3000));
        console.log(name + ': ' + scenario + ' dashboard ownership cycles PASS');
      }
      // An interrupted production Renderer must discard affected samples,
      // release its WebGL owner, and prepare a fresh renderer after restore.
      await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
        scenario: 'native-2d-geometry', nativeQuads: '48', noUi: '1',
        frames: '90', repeats: '2', warmup: '0', width: '640', height: '480'
      }));
      await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
      await page.waitForTimeout(130);
      await page.evaluate(() => {
        const ext = document.querySelector('#canvas').getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!ext) throw new Error('Native Renderer WebGL context-loss extension unavailable');
        window.__nativeLossExtension = ext;
        ext.loseContext();
      });
      await page.waitForFunction(() => window.NovelTeaBenchmark.contextLost);
      await page.waitForTimeout(150);
      if (await page.evaluate(() => window.NovelTeaBenchmark.runs.length))
        throw new Error(name + ': reported complete samples during native Renderer context loss');
      await page.evaluate(() => window.__nativeLossExtension.restoreContext());
      await page.waitForFunction(() => !window.NovelTeaBenchmark.contextLost, null, {timeout: 15000});
      await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1,
                                 null, {timeout: 90000});
      const recovered = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
      if (recovered.outcome !== 'complete' ||
          recovered.scenarios?.[0]?.aggregate?.measured_frames !== 180 ||
          !recovered.scenarios[0].trials.some(t => t.interruption_retries > 0))
        throw new Error(name + ': Native Renderer recovery did not discard interrupted samples: ' +
                        JSON.stringify(recovered).slice(-5000));
      console.log(name + ': native Renderer WebGL context loss and fresh-trial recovery PASS');

      await page.goto(origin + '/benchmark.html?' + new URLSearchParams({
        scenario: 'native-shader-material', nativeQuads: '24',
        width: '640', height: '480', inspectionSmoke: '1'
      }));
      try {
        await page.waitForFunction(() => window.NovelTeaBenchmark?.screenshots.length > 0,
                                   null, {timeout: 45000});
      } catch (error) {
        const status = await page.evaluate(() => ({
          status: document.querySelector('#status')?.textContent,
          log: document.querySelector('#log')?.textContent?.slice(-5000)
        }));
        throw new Error(name + ' native Renderer PNG capture: ' +
                        JSON.stringify(status) + '; ' + errors.join('; '));
      }
      const screenshot = await page.evaluate(() => {
        const image = window.NovelTeaBenchmark.screenshots[0];
        return {name: image.name, length: image.bytes.length,
                magic: Array.from(image.bytes.slice(0, 8))};
      });
      if (screenshot.name !== 'native-shader-material-reference.png' ||
          screenshot.length < 1000 ||
          screenshot.magic.join(',') !== '137,80,78,71,13,10,26,10')
        throw new Error(name + ' invalid native screenshot: ' + JSON.stringify(screenshot));
      console.log(name + ': native Renderer untimed PNG readback PASS');
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
