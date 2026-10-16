import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Web launcher transports exact canonical JSON and rejects mixed run flags', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-benchmark-web-config-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const create = async (relative, contents, mode = 0o644) => {
    const dest = path.join(root, relative);
    await mkdir(path.dirname(dest), {recursive: true});
    await writeFile(dest, contents, {mode});
    return dest;
  };
  await create('scripts/run-benchmark-web.sh',
    await readFile(path.join(repository, 'scripts/run-benchmark-web.sh')), 0o755);
  await create('build/web-benchmark-release/apps/benchmark/benchmark.html', '');
  await create('build/web-benchmark-release/apps/benchmark/benchmark.wasm', '');
  await create('bin/python3', '#!/bin/sh\nexit 0\n', 0o755);
  const canonical = await readFile(path.join(repository, 'apps/benchmark/stage1-unattended.json'));
  const filename = await create('configuration with spaces.json', canonical);
  const run = (...args) => spawnSync('bash',
    [path.join(root, 'scripts/run-benchmark-web.sh'), '--no-build', '--no-browser', ...args],
    {encoding: 'utf8', env: {...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH}});
  const success = run('--config', filename);
  assert.equal(success.status, 0, success.stderr);
  const line = success.stdout.match(/serving [^ ]+ at (\S+)/);
  assert.ok(line);
  const url = new URL(line[1]);
  assert.deepEqual(Buffer.from(url.searchParams.get('configB64'), 'base64'), canonical);
  assert.equal(url.searchParams.has('scenario'), false);
  assert.equal(url.searchParams.has('noUi'), false);
  const composition = run('--scenario', 'raw-bgfx-composition',
    '--composition-path', 'offscreen', '--composite-passes', '3',
    '--target-scale', '0.5', '--msaa-samples', '2', '--no-transparent-overlay');
  assert.equal(composition.status, 0, composition.stderr);
  const compositionParams = new URL(composition.stdout.match(/ at (\S+)/)[1]).searchParams;
  assert.equal(compositionParams.get('scenario'), 'raw-bgfx-composition');
  assert.equal(compositionParams.get('compositionPath'), 'offscreen');
  assert.equal(compositionParams.get('compositePasses'), '3');
  assert.equal(compositionParams.get('targetScale'), '0.5');
  assert.equal(compositionParams.get('msaaSamples'), '2');
  assert.equal(compositionParams.get('noTransparentOverlay'), '1');
  const scaling = run('--scenario', 'integrated-rmlui-scaling',
    '--ui-preset', 'contexts-heavy', '--ui-elements', '1024',
    '--ui-text-lines', '128', '--ui-visible-contexts', '2',
    '--ui-empty-contexts', '3', '--ui-hidden-contexts', '4',
    '--ui-text-mode', 'dynamic', '--ui-redraw', 'dirty-only');
  assert.equal(scaling.status, 0, scaling.stderr);
  const scalingParams = new URL(scaling.stdout.match(/ at (\S+)/)[1]).searchParams;
  for (const [key, expected] of Object.entries({
    scenario: 'integrated-rmlui-scaling', uiPreset: 'contexts-heavy',
    uiElements: '1024', uiTextLines: '128', uiVisibleContexts: '2',
    uiEmptyContexts: '3', uiHiddenContexts: '4',
    uiTextMode: 'dynamic', uiRedraw: 'dirty-only',
  })) {
    assert.equal(scalingParams.get(key), expected, key);
  }
  const overridden = run('--config', filename, '--output', 'selected.json');
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(new URL(overridden.stdout.match(/ at (\S+)/)[1]).searchParams.get('output'), 'selected.json');

  for (const bad of [
    ['--config', filename, '--frames', '30'],
    ['--config', filename, '--no-ui'],
    ['--config', '/does/not/exist'],
  ]) {
    const result = run(...bad);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /serving/);
  }
  const empty = await create('empty.json', '');
  assert.equal(run('--config', empty).status, 2);
  const oversized = await create('oversized.json', 'a'.repeat(8193));
  assert.equal(run('--config', oversized).status, 2);
});
