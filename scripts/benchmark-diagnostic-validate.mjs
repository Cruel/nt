#!/usr/bin/env node
// Correctness-only verification of owner-specific Diagnostic measurements.
// No latency thresholds, GPU timestamp availability assumptions, or FPS scores.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [filename, scenario] = process.argv.slice(2);
if (!filename || !scenario)
  throw new Error('usage: benchmark-diagnostic-validate.mjs REPORT SCENARIO_ID');
const report = JSON.parse(await readFile(filename, 'utf8'));
assert.equal(report.outcome, 'complete');
assert.equal(report.timing.profile, 'diagnostic');
assert.equal(report.scenarios.length, 1);
assert.equal(report.scenarios[0].id, scenario);
const engine = scenario.startsWith('integrated-') || scenario.startsWith('engine-');
const ui = scenario.includes('rmlui') ||
           scenario === 'engine-compiled-menu' || scenario === 'engine-feature-lab';
const trials = report.scenarios[0].trials;
assert.ok(trials.length > 0);

function observed(diagnostic, key, count) {
  const value = diagnostic[key];
  assert.equal(value?.samples, count, key + ' must be measured on owner thread');
  for (const field of ['mean_ms', 'p50_ms', 'p95_ms', 'p99_ms']) {
    assert.ok(Number.isFinite(value[field]) && value[field] >= 0, key + '.' + field);
  }
}
for (const trial of trials) {
  assert.equal(trial.outcome, 'complete');
  assert.ok(trial.measured_frames > 0);
  const details = trial.diagnostic;
  assert.equal(details.observations, trial.measured_frames);
  for (const key of ['engine_scope', 'rmlui_scope', 'ui_fixture_scope', 'stage_additivity',
                      'stats_scope', 'gpu_scope'])
    assert.equal(typeof details[key], 'string', key);
  for (const key of ['engine_events_ms', 'engine_jobs_ms', 'engine_assets_ms',
                      'engine_update_ms', 'engine_runtime_ms', 'engine_layout_ms', 'engine_render_ms']) {
    if (engine) observed(details, key, trial.measured_frames);
    else assert.equal(details[key], null, key + ' should be unavailable');
  }
  for (const key of ['rmlui_update_ms', 'rmlui_render_ms']) {
    if (ui) observed(details, key, trial.measured_frames);
    else assert.equal(details[key], null, key + ' should be unavailable');
  }
  if (ui && !engine) observed(details, 'ui_fixture_mutation_ms', trial.measured_frames);
  else assert.equal(details.ui_fixture_mutation_ms, null);
  if (engine) assert.equal(details.gpu_execution_ms, null);
  for (const key of ['draw_calls', 'compute_calls', 'blit_calls', 'view_count',
                      'resource_textures', 'resource_framebuffers', 'resource_programs',
                      'bgfx_wait_render_ms', 'bgfx_wait_submit_ms'])
    assert.ok(details[key] === null || typeof details[key] === 'object', key);
}
console.log('diagnostic owner stages and unavailable scopes verified: ' + scenario);
