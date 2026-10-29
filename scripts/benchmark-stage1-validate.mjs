#!/usr/bin/env node
// Functional certification only: never gate on a CPU/GPU timing or FPS threshold.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export function validateStage1Report(report, fixture, expectedPlatform) {
  assert.equal(report.format, 'noveltea.benchmark.result');
  assert.equal(report.version, 1);
  assert.equal(report.outcome, 'complete');
  const config = structuredClone(report.configuration);
  // The output *destination* is allowed to differ by host/runner. All workload
  // parameters and timing policies must remain exactly the same.
  config.settings.output = fixture.settings.output;
  assert.deepEqual(config, fixture, 'canonical run settings drifted between platforms');
  assert.equal(config.settings.no_ui, true);
  assert.equal(config.settings.profile, 'clean');
  assert.equal(report.build.devtools, false);
  assert.ok(typeof report.build.source_fingerprint_sha256 === 'string');
  assert.equal(report.scenarios.length, 1);
  const scenario = report.scenarios[0];
  assert.equal(scenario.id, fixture.scenario);
  assert.equal(scenario.outcome, 'complete');
  const expectedFrames = fixture.settings.measurement_frames;
  assert.ok(expectedFrames > 0, 'certification fixture must have a fixed frame count');
  assert.equal(scenario.trials.length, fixture.settings.repeats);
  assert.equal(scenario.aggregate.measured_frames, expectedFrames * fixture.settings.repeats);
  assert.equal(scenario.aggregate.cpu_operation_ms.samples, expectedFrames * fixture.settings.repeats);
  assert.equal(scenario.aggregate.frame_wall_ms.samples, expectedFrames * fixture.settings.repeats);
  for (const trial of scenario.trials) {
    assert.equal(trial.outcome, 'complete', trial.reason);
    assert.equal(trial.measured_frames, expectedFrames);
    assert.deepEqual(trial.phases, [
      'preparation', 'ready', 'warmup', 'measurement', 'completion', 'results', 'cleanup'
    ]);
    assert.ok(trial.frame_wall_ms.p95_ms >= trial.frame_wall_ms.p50_ms);
    assert.equal(trial.raw_samples.length, expectedFrames);
    assert.equal(trial.diagnostic, null, 'Clean samples must not contain Diagnostic counters');
  }
  assert.equal(report.timing.profile, 'clean');
  assert.equal(report.timing.gpu_execution_ms, null, 'GPU execution must not be inferred');
  assert.equal(report.timing.presented_frame_count, null, 'presentation FPS is not measured');
  assert.equal(report.timing.bgfx_wait_render_ms, null);
  assert.equal(report.timing.bgfx_wait_submit_ms, null);
  assert.ok(report.graphics && report.graphics.width_pixels > 0);
  assert.ok(report.graphics.height_pixels > 0);
  assert.equal(report.graphics.frame_path, 'bgfx-frame');
  assert.ok(report.graphics.renderer);
  assert.equal(report.graphics.gpu_driver_version, null);
  if (expectedPlatform) assert.equal(report.graphics.platform, expectedPlatform);
  return {platform: report.graphics.platform, renderer: report.graphics.renderer,
    samples: scenario.aggregate.measured_frames};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = key => {
    const index = args.indexOf(key);
    if (index === -1 || index === args.length - 1) throw new Error('missing ' + key);
    return args[index + 1];
  };
  try {
    const [report, fixture] = await Promise.all([
      readFile(flag('--report'), 'utf8').then(JSON.parse),
      readFile(flag('--config'), 'utf8').then(JSON.parse)
    ]);
    const platformIndex = args.indexOf('--platform');
    const platform = platformIndex !== -1 ? flag('--platform') : undefined;
    console.log('[benchmark] Stage 1 certified:',
      validateStage1Report(report, fixture, platform));
  } catch (error) {
    console.error('[benchmark] Stage 1 certification failed:', error.message);
    process.exitCode = 1;
  }
}
