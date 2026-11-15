// Release-only real Node-API benchmark of consecutive unsaved Room Patches.
// Unlike the scoped Save benchmark, this models editing several fields before
// persisting them. All files live in a disposable Feature Lab Project copy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const addon = path.resolve(
  process.argv[2] ??
    process.env.NOVELTEA_AUTHORING_NODE_ADDON ??
    path.join(root, 'build/native-authoring-host/noveltea-authoring-node.node'),
);
const binding = createRequire(import.meta.url)(addon);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-localization-patches-'));
const project = path.join(temporary, 'feature-lab');
let handle;

const accepted = (label, text) => {
  const result = JSON.parse(text);
  assert.equal(result.accepted, true, `${label}: ${result.error}`);
  return result;
};

function summarize(samples) {
  const warm = samples.slice(1).sort((a, b) => a - b);
  assert.equal(warm.length, 19);
  return {
    warmCount: warm.length,
    medianMs: Number(warm[9].toFixed(3)),
    p95Ms: Number(warm[17].toFixed(3)),
    maxMs: Number(warm[18].toFixed(3)),
  };
}

try {
  await cp(path.join(root, 'tests/projects/feature-lab'), project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  const results = {};
  const owner = 'rooms/properties-and-traits';
  const additionalFlag = process.argv.find((argument) =>
    argument.startsWith('--additional-inspected='),
  );
  const additionalInspected = Number(additionalFlag?.split('=')[1] ?? 0);
  assert.ok(Number.isInteger(additionalInspected) && additionalInspected >= 0);
  const roomNames = (await readdir(path.join(project, 'records/rooms')))
    .filter((file) => file.endsWith('.yaml') && file !== 'properties-and-traits.yaml')
    .map((file) => file.slice(0, -'.yaml'.length))
    .sort();
  assert.ok(roomNames.length >= Math.max(additionalInspected, 2));
  const inspectOwners = roomNames.slice(0, additionalInspected).map((name) => `rooms/${name}`);
  const display = `/${owner}/data/displayName`;
  const description = `/${owner}/data/description/source/text`;
  const target = `/${owner}/data/exits/0/target`;
  results.additionalInspected = additionalInspected;
  const workloads = {
    roomDisplayName: [display],
    roomDescription: [description],
    projectTitle: ['/project/name'],
    roomExitTarget: [target],
    roomAndProject: [display, '/project/name'],
    undoInverse: [display],
  };
  for (const [label, pointers] of Object.entries(workloads)) {
    handle = binding.open(project);
    const inspected = accepted('inspect Room', binding.inspect(handle, owner));
    let revision = inspected.snapshot.workingRevision;
    for (const extra of inspectOwners)
      revision = accepted('inspect additional Room', binding.inspect(handle, extra)).snapshot
        .workingRevision;
    const times = [];
    for (let i = 0; i < 20; ++i) {
      const value =
        label === 'roomExitTarget' ? roomNames[i % 2] : `Dirty native addon ${label} ${i}`;
      const operations = pointers.map((pointer) => ({
        operation: 'replace',
        path: pointer,
        value,
      }));
      if (label === 'undoInverse') {
        const forward = accepted(
          'forward Patch',
          binding.patch(handle, revision, JSON.stringify(operations)),
        );
        revision = forward.snapshot.workingRevision;
      }
      const start = performance.now();
      const patched = accepted(
        'Patch',
        binding.patch(
          handle,
          revision,
          JSON.stringify(
            label === 'undoInverse'
              ? [{ operation: 'replace', path: display, value: 'Baseline undo value' }]
              : operations,
          ),
        ),
      );
      times.push(performance.now() - start);
      assert.equal(patched.snapshot.workingRevision, revision + 1);
      assert.equal(patched.snapshot.valid, true);
      revision = patched.snapshot.workingRevision;
    }
    results[label] = summarize(times);
    binding.close(handle);
    handle = undefined;
  }
  console.log(JSON.stringify(results));
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(temporary, { recursive: true, force: true });
}
