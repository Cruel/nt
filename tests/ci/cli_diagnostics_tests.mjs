import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  diagnosticOptions, prepareShaderFreeFixture, recordCommand,
} from '../../scripts/diagnostics/run-cli-diagnostics.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-diagnostics-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('diagnostics bound repetition and reject unsupported scenarios', () => {
  assert.deepEqual(diagnosticOptions({}), { scenario: 'empty-playback', iterations: 20 });
  assert.deepEqual(diagnosticOptions({ NT_DIAGNOSTIC_SCENARIO: 'certification', NT_DIAGNOSTIC_ITERATIONS: '50' }),
    { scenario: 'certification', iterations: 1 });
  assert.equal(diagnosticOptions({ NT_DIAGNOSTIC_SCENARIO: 'feature-lab' }).scenario, 'feature-lab');
  for (const iterations of ['0', '51', '-1', '1.5', 'NaN', ''])
    assert.throws(() => diagnosticOptions({ NT_DIAGNOSTIC_ITERATIONS: iterations }), /integer/);
  assert.throws(() => diagnosticOptions({ NT_DIAGNOSTIC_SCENARIO: 'unknown' }), /Unknown/);
});

test('command capture preserves stdin, separate logs, status, and replay arguments', async (t) => {
  const root = await temporary(t);
  const input = path.join(root, 'input with spaces.json');
  await writeFile(input, '{"steps":[]}\n');
  const args = ['-e', 'process.stdin.pipe(process.stdout); console.error("stderr-only");'];
  const result = await recordCommand({
    command: process.execPath, args, root, label: 'success', stdinPath: input, cwd: root,
  });
  assert.equal(result.success, true);
  const output = path.join(root, 'commands/success');
  assert.equal(await readFile(path.join(output, 'stdout.log'), 'utf8'), '{"steps":[]}\n');
  assert.equal(await readFile(path.join(output, 'stderr.log'), 'utf8'), 'stderr-only\n');
  const record = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
  assert.deepEqual(record.args, args);
  assert.equal(record.stdinPath, input);
  assert.equal(record.exitCode, 0);
});

test('nonzero exit and process launch failure cannot pass diagnostics', async (t) => {
  const root = await temporary(t);
  const failed = await recordCommand({
    command: process.execPath, args: ['-e', 'process.exit(6)'], root, label: 'exit-six',
  });
  assert.equal(failed.success, false);
  assert.equal(failed.exitCode, 6);
  const missing = await recordCommand({ command: path.join(root, 'missing'), args: [], root, label: 'missing' });
  assert.equal(missing.success, false);
  assert.match(missing.spawnError, /ENOENT/);
});

test('hung reproduction is terminated and timeout evidence is retained', async (t) => {
  const root = await temporary(t);
  const result = await recordCommand({
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    root, label: 'timeout', timeoutMs: 100,
  });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  const saved = JSON.parse(await readFile(path.join(root, 'commands/timeout/result.json'), 'utf8'));
  assert.equal(saved.timedOut, true);
});

test('shader-free diagnostic fixture preserves unrelated room and layout data', async (t) => {
  const root = await temporary(t);
  for (const directory of ['shaders', 'materials', 'rooms', 'layouts/fixture-hud'])
    await mkdir(path.join(root, 'records', directory), { recursive: true });
  await writeFile(path.join(root, 'records/rooms/foyer.json'), JSON.stringify({
    id: 'foyer', data: { background: { material: 'test', image: 'keep' }, name: 'preserve' },
  }));
  await writeFile(path.join(root, 'records/layouts/fixture-hud/layout.rml'), '<div/>');
  await prepareShaderFreeFixture(root);
  const foyer = JSON.parse(await readFile(path.join(root, 'records/rooms/foyer.json'), 'utf8'));
  assert.equal(foyer.data.background.material, null);
  assert.equal(foyer.data.background.image, 'keep');
  assert.equal(foyer.data.name, 'preserve');
  await assert.rejects(readFile(path.join(root, 'records/shaders')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'records/layouts/fixture-hud/layout.rml'), 'utf8'), '<div/>');
});
