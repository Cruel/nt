#!/usr/bin/env node
// Exercise the real Electron Node-API working-session boundary on a disposable
// Project supplied by validation_performance.py; no filesystem publication.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const [addonPath, projectRoot, roomId] = process.argv.slice(2);
if (!addonPath || !projectRoot || !roomId)
  throw new Error('Expected <native-addon.node> <disposable-project> <room-id>');

const require = createRequire(import.meta.url);
const binding = require(path.resolve(addonPath));
const roomSource = path.join(projectRoot, 'records', 'rooms', `${roomId}.yaml`);
const before = readFileSync(roomSource);
const session = binding.open(path.resolve(projectRoot));
const snapshots = [];
const observe = (label, revision) => {
  const started = performance.now();
  const value = JSON.parse(binding.validateWorking(session, revision));
  const elapsed = Math.round((performance.now() - started) * 100) / 100;
  assert.equal(value.valid, true, JSON.stringify(value.diagnostics));
  assert.ok(value.work?.sourceCaptures !== undefined, 'No native working counters');
  snapshots.push({ state: label, ms: elapsed, work: value.work });
  // Dirty working owners may lack saved YAML line/column mappings. Compare
  // semantic findings, not presentation coordinates tied to the disk source.
  return JSON.stringify(value.diagnostics.map(({ line: _line, column: _column, ...item }) => item));
};
try {
  const initial = JSON.parse(binding.snapshot(session));
  const baselineDiagnostics = observe('editor-unchanged', initial.workingRevision);
  let revision = initial.workingRevision;
  for (let index = 0; index < 3; index++) {
    const label = `In-memory audit ${index}`;
    const started = performance.now();
    const updated = JSON.parse(
      binding.patch(
        session,
        revision,
        JSON.stringify([{ operation: 'replace', path: `/rooms/${roomId}/label`, value: label }]),
      ),
    );
    assert.equal(updated.accepted, true, JSON.stringify(updated));
    revision = updated.snapshot.workingRevision;
    const patchMs = Math.round((performance.now() - started) * 100) / 100;
    const diagnostics = observe('editor-in-memory', revision);
    snapshots.at(-1).patchMs = patchMs;
    assert.equal(diagnostics, baselineDiagnostics, 'In-memory Room label edit changed diagnostics');
    assert.deepEqual(readFileSync(roomSource), before, 'Working edit modified physical YAML');
  }
  console.log(JSON.stringify({ samples: snapshots }));
} finally {
  binding.close(session);
}
