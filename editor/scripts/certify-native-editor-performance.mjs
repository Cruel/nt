// Production-only replacement for the retired #520 TypeScript/native comparison.
// These are real addon and installed-CLI observations, not an interactive editor timer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { editorRoot } from './editor-distribution-lib.mjs';

const addon = process.argv[2] ?? process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(addon, 'Pass the built native authoring Node addon path.');
const cli = path.resolve(process.argv[3] ?? path.join(editorRoot, '../build/cli/linux/noveltea'));
const binding = createRequire(import.meta.url)(path.resolve(addon));
const fixture = path.resolve(editorRoot, '../tests/projects/feature-lab');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-522-editor-performance-'));
const project = path.join(scratch, 'feature-lab');
const observations = [];
let handle;

// The reference values are the native side of #520's last paired run. They
// describe corresponding addon calls, not a time budget across different hosts.
const native520BaselineMs = {
  'cold Project open': 682,
  'one-owner YAML patch and scoped Save': 203,
  'one-source Lua physical Save transaction': 253,
  'saved Project semantic preparation': 3920,
};

function accepted(operation, result) {
  const value = JSON.parse(result);
  assert.equal(value.accepted, true, `${operation}: ${value.error ?? 'rejected'}`);
  return value;
}

async function measure(label, run) {
  const start = performance.now();
  const result = await run();
  const milliseconds = Math.round(performance.now() - start);
  const baselineMs = native520BaselineMs[label];
  observations.push({
    label,
    milliseconds,
    ...(baselineMs === undefined
      ? { comparableTo520: false }
      : {
          referenceNative520Ms: baselineMs,
          referenceRatio: Number((milliseconds / baselineMs).toFixed(2)),
          referenceMaterialSlowdown:
            milliseconds > baselineMs * 3 && milliseconds - baselineMs > 500,
        }),
  });
  return result;
}

try {
  await cp(fixture, project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  const opened = await measure('cold Project open', () => {
    handle = binding.open(project);
    const snapshot = JSON.parse(binding.snapshot(handle));
    assert.equal(snapshot.valid, true, JSON.stringify(snapshot.diagnostics));
    return snapshot;
  });

  const saved = await measure('one-owner YAML patch and scoped Save', () => {
    const patched = accepted(
      'patch',
      binding.patch(
        handle,
        opened.workingRevision,
        JSON.stringify([
          { operation: 'replace', path: '/project/name', value: 'Feature Lab Saved' },
        ]),
      ),
    );
    return accepted(
      'saveOwners',
      binding.saveOwners(handle, patched.snapshot.workingRevision, '["project"]', false, 'keep'),
    );
  });
  assert.match(
    await readFile(path.join(project, 'project.yaml'), 'utf8'),
    /name: "?Feature Lab Saved"?/,
  );

  const lua = 'scripts/feature-lab-bootstrap.lua';
  const original = await readFile(path.join(project, lua), 'utf8');
  const revised = `${original}\n-- #522 production editor Save measurement\n`;
  const savedText = await measure('one-source Lua physical Save transaction', () => {
    const staged = accepted(
      'stageTextSource',
      binding.stageTextSource(handle, saved.snapshot.workingRevision, lua, revised),
    );
    return accepted(
      'saveTextSources',
      binding.saveTextSources(
        handle,
        staged.snapshot.workingRevision,
        JSON.stringify([lua]),
        JSON.stringify({ [lua]: binding.sourceRevision(Buffer.from(original)) }),
      ),
    );
  });
  assert.equal(await readFile(path.join(project, lua), 'utf8'), revised);

  const prepared = await measure('saved Project semantic preparation', () =>
    accepted(
      'prepareCompleteWorking',
      binding.prepareCompleteWorking(handle, savedText.snapshot.workingRevision, ''),
    ),
  );
  assert.equal(prepared.completeProject.project.name, 'Feature Lab Saved');

  // CLI process startup, full artifact compilation and ZIP publication make
  // this deliberately non-comparable to #520's editor-only export preparation.
  const packagePath = path.join(scratch, 'feature-lab.ntpkg');
  await measure('installed Runtime Package publication (different boundary)', () => {
    const result = spawnSync(
      cli,
      [
        '--no-daemon',
        '--json',
        '--project',
        project,
        'package',
        'export',
        '--allow-localization-warnings',
        '--output',
        packagePath,
      ],
      { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, `Runtime Package terminated: ${result.signal}`);
    assert.equal(result.status, 0, `Runtime Package failed: ${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, true, JSON.stringify(payload.diagnostics));
  });
  assert.ok((await stat(packagePath)).size > 0);

  console.log(
    JSON.stringify({
      format: 'noveltea.native-editor-production-performance.v2',
      commit: process.env.GITHUB_SHA ?? null,
      note: 'Historical #520 timings are single-run, different-host native-addon references; no automatic regression waiver or interactive UI timing.',
      observations,
    }),
  );
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
