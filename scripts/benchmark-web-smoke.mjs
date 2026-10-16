#!/usr/bin/env node
// Functional browser smoke only: never enforce FPS or GPU performance thresholds.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import {validateStage1Report} from './benchmark-stage1-validate.mjs';

const directory = path.resolve(process.argv[2] || 'build/web-benchmark-release/apps/benchmark');
const canonicalBytes = await readFile(new URL('../apps/benchmark/stage1-unattended.json', import.meta.url));
const canonical = JSON.parse(canonicalBytes.toString('utf8'));
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.data': 'application/octet-stream'};
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(directory, '.' + pathname);
  if (!file.startsWith(directory + path.sep) || !/\.(html|js|wasm|data)$/.test(file)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'});
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let failures = 0;
for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox]]) {
  if (process.env.NOVELTEA_BENCHMARK_BROWSER &&
      process.env.NOVELTEA_BENCHMARK_BROWSER !== name) continue;
  let browser;
  try {
    browser = await engine.launch({
      headless: name !== 'Firefox' || !process.env.NOVELTEA_BENCHMARK_FIREFOX_HEADFUL,
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
    const page = await browser.newPage({acceptDownloads: true});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') console.error(name + ': ' + message.text());
    });

    await page.goto(origin + '/benchmark.html', {waitUntil: 'load'});
    try {
      await page.waitForFunction(() => window.NovelTeaBenchmark?.ready, null, {timeout: 30000});
    } catch (error) {
      const state = await page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        log: document.querySelector('#log')?.textContent,
        webgl2: !!document.createElement('canvas').getContext('webgl2')
      }));
      throw new Error(error.message + '; browser state: ' + JSON.stringify(state) +
                      '; page errors: ' + errors.join('; '));
    }
    const image = await page.screenshot();
    if (image.length < 10000) throw new Error('dashboard visual smoke is unexpectedly blank');
    console.log(name + ': dashboard responsive and screenshot ' + image.length + ' bytes');

    // Launch the exact same JSON bytes as Linux/Android. No noUi or scenario
    // URL flags are supplied: the native decoder alone determines the run.
    await page.goto(origin + '/benchmark.html?configB64=' +
                    encodeURIComponent(canonicalBytes.toString('base64')));
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                               {timeout: 60000});
    const canonicalReport = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    validateStage1Report(canonicalReport, canonical, 'Emscripten');
    console.log(name + ': unattended canonical JSON and measured report certified');

    // Inspect actual reference pixels outside any timed benchmark interval.
    const previewPixels = async scenario => {
      await page.goto(origin + '/benchmark.html?ui=1&scenario=' + scenario);
      await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
      await page.waitForTimeout(200);
      const canvasBounds = await page.locator('#canvas').boundingBox();
      return page.screenshot({clip: {
        x: Math.floor(canvasBounds.x + canvasBounds.width * 0.74),
        y: Math.floor(canvasBounds.y + canvasBounds.height * 0.25),
        width: Math.floor(canvasBounds.width * 0.08),
        height: Math.floor(canvasBounds.height * 0.08)
      }});
    };
    const emptyPreview = await previewPixels('raw-bgfx-empty');
    const geometryPreview = await previewPixels('raw-bgfx-geometry');
    if (emptyPreview.equals(geometryPreview))
      throw new Error('raw geometry preview pixels match the empty bgfx reference');
    console.log(name + ': raw geometry visibly differs from empty reference');
    // Verify real textured and offscreen-composited output independently of
    // the benchmark clock, so no screenshot or readback enters sampled frames.
    const texturedPreview = await previewPixels('raw-bgfx-textured');
    const offscreenPreview = await previewPixels('raw-bgfx-offscreen');
    if (texturedPreview.equals(emptyPreview) || offscreenPreview.equals(emptyPreview))
      throw new Error('raw textured or offscreen reference appears blank');
    console.log(name + ': textured and offscreen composite produce visible pixels');

    const downloads = [];
    page.on('download', download => downloads.push(download));
    await page.goto(origin + '/benchmark.html?scenario=raw-bgfx-geometry&frames=45&warmup=0&noUi=1&rawSamples=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    const activeCallbacks = await page.evaluate(async () => {
      let callbacks = 0;
      while (!window.NovelTeaBenchmark.runs.length && callbacks < 200) {
        await new Promise(resolve => setTimeout(resolve, 20));
        callbacks++;
      }
      return callbacks;
    });
    if (activeCallbacks < 3)
      throw new Error('the browser event loop did not advance during sampling');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 45000});
    const geometry = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (geometry.outcome !== 'complete' || geometry.scenarios[0].aggregate.measured_frames !== 45)
      throw new Error('no-UI raw geometry: ' + JSON.stringify({outcome: geometry.outcome, scenarios: geometry.scenarios.map(s => ({outcome:s.outcome, frames:s.aggregate.measured_frames, trials:s.trials.map(t=>({outcome:t.outcome,reason:t.reason}))}))}));
    if (!geometry.timing.frame_wall.includes('requestAnimationFrame'))
      throw new Error('rAF pacing missing from report');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1);
    if (downloads.length < 1 || !(await downloads[0].suggestedFilename()).endsWith('.json'))
      throw new Error('browser did not offer JSON artifact download');
    const alive = await page.evaluate(async () => {
      let callbacks = 0;
      await new Promise(resolve => {
        const id = setInterval(() => { callbacks++; if (callbacks >= 3) {clearInterval(id); resolve();} }, 20);
      });
      return callbacks;
    });
    if (alive < 3) throw new Error('browser event loop stalled after unattended run');
    console.log(name + ': no-UI geometry, JSON download, and live event loop passed');

    await page.goto(origin + '/benchmark.html?scenario=raw-bgfx-draw-calls&drawCalls=7&quadCount=9&textureSize=64&coverage=0.375&frames=12&warmup=0&noUi=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                               {timeout: 45000});
    const scaledRaw = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    const scaledWork = scaledRaw.scenarios[0]?.graphics?.raw_workload;
    if (scaledRaw.outcome !== 'complete' ||
        scaledWork?.draw_submissions_per_frame !== 7 ||
        scaledWork?.vertices_submitted_per_frame !== 7 * 9 * 4 ||
        scaledWork?.texture_edge_pixels !== 64 ||
        scaledWork?.linear_coverage !== 0.375)
      throw new Error('scaled real-WebGL workload metadata mismatch: ' + JSON.stringify(scaledWork));
    console.log(name + ': scaled WebGL workload and draw/geometry/texture counters passed');

    // Exercise the actual WebGL composition path, not merely its C++ build.
    await page.goto(origin + '/benchmark.html?scenario=raw-bgfx-composition&compositionPath=offscreen&compositePasses=3&targetScale=0.5&msaaSamples=0&noTransparentOverlay=1&coverage=0.375&textureSize=64&frames=12&warmup=0&noUi=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                               {timeout: 45000});
    const compositionReport = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    const compositionWork = compositionReport.scenarios[0]?.graphics?.raw_workload;
    if (compositionReport.outcome !== 'complete' ||
        compositionWork?.composition_path !== 'offscreen' ||
        compositionWork?.composite_passes !== 3 ||
        compositionWork?.target_scale !== 0.5 ||
        compositionWork?.render_target_count !== 3 ||
        compositionWork?.draw_submissions_per_frame !== 4 ||
        compositionWork?.transparent_overlay !== false ||
        compositionWork?.semantically_equivalent_to_direct !== false ||
        compositionWork?.linear_coverage !== 0.375)
      throw new Error('real-WebGL composition path/report mismatch: ' + JSON.stringify(compositionWork));
    console.log(name + ': scaled multi-pass WebGL composition and metadata passed');

    // Simulate a tab being hidden then restored. The visibility event must
    // remain latched even if no rAF callback ran while the page was hidden.
    await page.goto(origin + '/benchmark.html?noUi=1&frames=60&repeats=3&warmup=0&rawSamples=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(180);
    const hiddenRuns = await page.evaluate(() => window.NovelTeaBenchmark.runs.length);
    if (hiddenRuns !== 0) throw new Error('benchmark completed while page hidden');
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                               {timeout: 30000});
    const interrupted = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (interrupted.outcome !== 'complete' ||
        interrupted.scenarios[0].aggregate.measured_frames !== 180 ||
        !interrupted.scenarios[0].trials.some(t => t.interruption_retries > 0))
      throw new Error('hidden-tab run was not retried with fresh samples: ' + JSON.stringify(interrupted.scenarios[0].trials));
    console.log(name + ': hidden-tab interruption waits, recovers, and retries all repeats');

    // WEBGL_lose_context exposes real browser resource invalidation. No
    // measurements can be accepted until bgfx and its resources are rebuilt.
    await page.goto(origin + '/benchmark.html?noUi=1&scenario=raw-bgfx-geometry&frames=90&repeats=2&warmup=0&rawSamples=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    const extensionPresent = await page.evaluate(() => {
      const gl = document.querySelector('#canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      window.__lossExtension = ext;
      ext.loseContext();
      return true;
    });
    if (!extensionPresent) throw new Error('WEBGL_lose_context unavailable; cannot verify recovery');
    await page.waitForFunction(() => window.NovelTeaBenchmark.contextLost);
    await page.waitForTimeout(200);
    if (await page.evaluate(() => window.NovelTeaBenchmark.runs.length))
      throw new Error('successful report emitted during context loss');
    await page.evaluate(() => window.__lossExtension.restoreContext());
    await page.waitForFunction(() => !window.NovelTeaBenchmark.contextLost, null, {timeout: 15000});
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 45000});
    const restored = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (restored.outcome !== 'complete' || restored.scenarios[0].aggregate.measured_frames !== 180 ||
        !restored.scenarios[0].trials.some(t => t.interruption_retries > 0))
      throw new Error('context restoration included invalid samples: ' + JSON.stringify(restored.scenarios[0].trials));
    console.log(name + ': WebGL context loss discards affected samples and rebuilds graphics');

    // Exercise context-loss recovery while the production Engine, rather than
    // the lightweight benchmark host, owns the SDL window and bgfx device.
    await page.goto(origin + '/benchmark.html?noUi=1&scenario=engine-empty&frames=90&repeats=2&warmup=0');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    await page.waitForTimeout(140);
    await page.evaluate(() => {
      const extension = document.querySelector('#canvas').getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Engine WebGL context-loss extension unavailable');
      window.__engineLoss = extension;
      extension.loseContext();
    });
    await page.waitForFunction(() => window.NovelTeaBenchmark.contextLost);
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__engineLoss.restoreContext());
    await page.waitForFunction(() => !window.NovelTeaBenchmark.contextLost, null, {timeout: 15000});
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 60000});
    const engineRecovered = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (engineRecovered.outcome !== 'complete' ||
        engineRecovered.scenarios[0].aggregate.measured_frames !== 180 ||
        !engineRecovered.scenarios[0].trials.some(trial => trial.interruption_retries > 0))
      throw new Error('Engine WebGL context recovery failed: ' +
        JSON.stringify(engineRecovered.scenarios[0].trials));
    console.log(name + ': Engine-owned WebGL context loss retries without stale samples');

    // Escape must generate a terminal report even if the browser never
    // restores WebGL. Cleanup/destruction of GPU resources is deferred.
    await page.goto(origin + '/benchmark.html?noUi=1&scenario=raw-bgfx-geometry&frames=300&repeats=3&warmup=0&rawSamples=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    await page.locator('#canvas').focus();
    await page.evaluate(() => {
      const ext = document.querySelector('#canvas').getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!ext) throw new Error('context-loss extension unavailable during cancellation');
      window.__cancelLoss = ext;
      ext.loseContext();
    });
    await page.waitForFunction(() => window.NovelTeaBenchmark.contextLost);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 15000});
    const cancelledWhileLost = await page.evaluate(() => ({
      lost: window.NovelTeaBenchmark.contextLost,
      recoveryNeeded: window.NovelTeaBenchmark.contextRecoveryNeeded,
      report: window.NovelTeaBenchmark.runs[0].report,
      status: document.querySelector('#status').textContent
    }));
    if (!cancelledWhileLost.lost || !cancelledWhileLost.recoveryNeeded ||
        cancelledWhileLost.report.outcome !== 'cancelled' ||
        cancelledWhileLost.report.scenarios[0].trials.length !== 1 ||
        cancelledWhileLost.report.scenarios[0].trials[0].outcome !== 'cancelled' ||
        !cancelledWhileLost.status.includes('cancelled'))
      throw new Error('cancellation did not finalize before WebGL restoration: ' +
                      JSON.stringify(cancelledWhileLost));
    await page.waitForTimeout(150);
    if (await page.evaluate(() => window.NovelTeaBenchmark.runs.length) !== 1)
      throw new Error('unrestored context re-exported a cancelled trial');
    await page.evaluate(() => window.__cancelLoss.restoreContext());
    await page.waitForFunction(() => !window.NovelTeaBenchmark.contextLost &&
                                    !window.NovelTeaBenchmark.contextRecoveryNeeded, null,
                               {timeout: 15000});
    console.log(name + ': Escape exports cancellation before WebGL recovery; graphics cleanup deferred');

    await page.goto(origin + '/benchmark.html?noUi=1&frames=300&repeats=3&warmup=0');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    await page.locator('#canvas').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 15000});
    const cancelled = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (cancelled.outcome !== 'cancelled' || cancelled.scenarios[0].trials.length !== 1 ||
        cancelled.scenarios[0].trials[0].outcome !== 'cancelled')
      throw new Error('Escape failed to cancel outstanding repeats: ' + JSON.stringify(cancelled.scenarios[0].trials));
    console.log(name + ': Escape cancels the collection without additional repeats');

    // The idle preview must also rebuild resources after loss. A subsequent
    // benchmark should not inherit a destroyed context from the dashboard.
    await page.goto(origin + '/benchmark.html?ui=1&scenario=raw-bgfx-geometry');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.ready);
    await page.evaluate(() => {
      const ext = document.querySelector('#canvas').getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if (!ext) throw new Error('context-loss extension unavailable during preview');
      window.__previewLoss = ext;
      ext.loseContext();
    });
    await page.waitForFunction(() => window.NovelTeaBenchmark.contextLost);
    await page.evaluate(() => window.__previewLoss.restoreContext());
    await page.waitForFunction(() => !window.NovelTeaBenchmark.contextLost &&
                                    !window.NovelTeaBenchmark.contextRecoveryNeeded, null,
                               {timeout: 15000});
    const previewRecovered = await page.screenshot();
    if (previewRecovered.length < 10000)
      throw new Error('preview did not recover after idle context loss');
    console.log(name + ': idle dashboard recovers from WebGL context loss');

    await page.goto(origin + '/benchmark.html?dashboardSmoke=1&smoke=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 3, null, {timeout: 60000});
    const reports = await page.evaluate(() => window.NovelTeaBenchmark.runs.map(x => x.report));
    if (reports.some(r => r.outcome !== 'complete' || r.scenarios[0].aggregate.measured_frames !== 30))
      throw new Error('dashboard lifecycle failed one of its three trials');
    const names = reports.map(r => r.scenarios[0].id);
    if (new Set(names).size !== 3)
      throw new Error('dashboard smoke did not exercise distinct rendering backends');
    const resultsScreenshot = await page.screenshot();
    if (resultsScreenshot.length < 10000 || resultsScreenshot.equals(image))
      throw new Error('dashboard results were not visibly restored after benchmark cycles');
    if (errors.length) throw new Error('page errors: ' + errors.join('; '));
    console.log(name + ': dashboard teardown/recreate + scenario switches passed: ' + names.join(', '));

    await page.goto(origin + '/benchmark.html?quickSuite=1&smoke=1&noUi=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 60000});
    const quick = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    const referenceOrder = [
      'raw-bgfx-empty', 'raw-bgfx-geometry', 'standalone-rmlui-simple',
      'engine-empty', 'integrated-rmlui-controlled', 'integrated-rmlui-production'
    ];
    if (quick.outcome !== 'complete' ||
        quick.scenarios.map(s => s.id).join(',') !== referenceOrder.join(',') ||
        quick.scenarios.some(s => s.outcome !== 'complete' || s.aggregate.measured_frames !== 30) ||
        quick.graphics !== null ||
        quick.scenarios[0].graphics.frame_path !== 'bgfx-frame' ||
        quick.scenarios[2].graphics.ui_render_path === null)
      throw new Error('Quick Suite scenario isolation/report failure: ' + JSON.stringify(quick.scenarios.map(s => ({id:s.id, outcome:s.outcome, frames:s.aggregate.measured_frames}))));
    console.log(name + ': all six Stage 1 scenarios and raw-to-Engine-to-raw ownership transfers passed');

    for (const scenario of ['engine-empty', 'integrated-rmlui-controlled', 'integrated-rmlui-production']) {
      await page.goto(origin + '/benchmark.html?scenario=' + scenario + '&smoke=1&noUi=1');
      await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null, {timeout: 60000});
      const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
      if (report.outcome !== 'complete' || report.scenarios[0]?.aggregate.measured_frames !== 30 ||
          report.scenarios[0].graphics?.frame_path !== 'engine-tick' ||
          JSON.stringify(report.graphics) !== JSON.stringify(report.scenarios[0].graphics))
        throw new Error('Web Engine single-scenario failure: ' + JSON.stringify([scenario, report.outcome,
            report.scenarios[0]?.trials?.map(t => t.reason)]));
    }
    console.log(name + ': individual no-UI production Engine and integrated RmlUi trials passed');

    // Exercise the same advanced RML fixture through both WebGL2 hosts. Check
    // actual RmlUi backend activity, not just requested CSS or run success.
    for (const scenario of ['standalone-rmlui-effects', 'integrated-rmlui-effects']) {
      await page.goto(origin + '/benchmark.html?scenario=' + scenario +
        '&uiClipping=1&uiTransforms=1&uiGradients=1&uiFilters=1&uiMasks=1&uiNestedLayers=1' +
        '&frames=12&warmup=0&noUi=1');
      await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                                 {timeout: 60000});
      const report = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
      const actual = report.scenarios[0]?.graphics?.ui_effect_backend_callbacks;
      if (report.outcome !== 'complete' || report.scenarios[0]?.aggregate.measured_frames !== 12 ||
          !actual || actual.backend_errors !== 0 || actual.clipping_calls < 1 ||
          actual.transforms < 1 || actual.gradient_draws < 1 ||
          actual.filtered_composites < 1 || actual.mask_saves < 1 ||
          actual.max_layer_depth < 2 ||
          JSON.stringify(report.graphics) !== JSON.stringify(report.scenarios[0].graphics))
        throw new Error('Web advanced RmlUi effects failed: ' +
          JSON.stringify({scenario, outcome: report.outcome, actual,
            trials: report.scenarios[0]?.trials.map(t => t.reason)}));
    }
    console.log(name + ': standalone and integrated advanced RmlUi effects passed');

    // Regression: selecting offscreen composition before Quick Suite must not
    // leak composition-only knobs into raw, RmlUi, or Engine reference presets.
    await page.goto(origin + '/benchmark.html?scenario=raw-bgfx-composition&compositionPath=offscreen&compositePasses=2&quickSuite=1&smoke=1&noUi=1');
    await page.waitForFunction(() => window.NovelTeaBenchmark?.runs.length === 1, null,
                               {timeout: 60000});
    const switched = await page.evaluate(() => window.NovelTeaBenchmark.runs[0].report);
    if (switched.outcome !== 'complete' ||
        switched.scenarios.map(s => s.id).join(',') !== referenceOrder.join(',') ||
        switched.scenarios.some(s => s.outcome !== 'complete' ||
          s.aggregate.measured_frames !== 30) ||
        switched.configuration.parameters.composition_path !== 'direct' ||
        switched.configuration.parameters.composite_passes !== 0 ||
        switched.configuration.parameters.target_scale !== 1 ||
        switched.configuration.parameters.msaa_samples !== 0 ||
        switched.configuration.parameters.transparent_overlay !== true)
      throw new Error('composition-to-Quick-Suite normalization failed: ' +
        JSON.stringify(switched.scenarios.map(s => [s.id, s.outcome, s.trials[0]?.reason])));
    console.log(name + ': composition-to-Quick-Suite scenario normalization passed');
    await page.close();
  } catch (error) {
    failures++;
    console.error(name + ' browser smoke failed: ' + error.stack);
  } finally {
    await browser?.close();
  }
}
server.close();
if (failures) process.exitCode = 1;
