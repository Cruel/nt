// Real Node-API ProjectSession patch/Save publication, using a disposable
// Feature Lab copy. Native work counters can be enabled with
// NOVELTEA_AUTHORING_PROFILE=1; the addon prints them to stderr, never IPC.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'noveltea-addon-publication-'));
const project = path.join(temporary, 'feature-lab');
let handle;

function accepted(label, text) {
  const value = JSON.parse(text);
  assert.equal(value.accepted, true, `${label}: ${value.error}`);
  return value;
}

function summary(values) {
  const warm = values.slice(1).sort((a, b) => a - b);
  assert.equal(warm.length, 19);
  return {
    count: warm.length,
    medianMs: Number(warm[9].toFixed(2)),
    p95Ms: Number(warm[17].toFixed(2)),
    maxMs: Number(warm[18].toFixed(2)),
  };
}

try {
  await cp(path.join(root, 'tests/projects/feature-lab'), project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  const openedAt = performance.now();
  handle = binding.open(project);
  const initial = JSON.parse(binding.snapshot(handle));
  const coldOpenAndSnapshotMs = performance.now() - openedAt;
  assert.equal(initial.valid, true, JSON.stringify(initial.diagnostics));

  const owner = 'rooms/properties-and-traits';
  const inspected = accepted('inspect Room', binding.inspect(handle, owner));
  assert.deepEqual(inspected.affectedRecords, [owner]);
  assert.deepEqual(Object.keys(inspected.snapshot.recordSnapshots), [owner]);
  let revision = inspected.snapshot.workingRevision;
  if (!process.argv.includes('--single-record')) {
    const traits = accepted('inspect Traits', binding.inspect(handle, 'traits'));
    assert.deepEqual(traits.affectedRecords, ['traits']);
    assert.deepEqual(Object.keys(traits.snapshot.recordSnapshots), ['traits']);
    revision = traits.snapshot.workingRevision;
  }
  const output = { coldOpenAndSnapshotMs: Number(coldOpenAndSnapshotMs.toFixed(2)) };
  for (const [label, target, pointer, yaml] of [
    ['roomDisplayName', owner, `/${owner}/data/displayName`, `records/${owner}.yaml`],
    ['roomDescription', owner, `/${owner}/data/description/source/text`, `records/${owner}.yaml`],
    ['projectTitle', 'project', '/project/name', 'project.yaml'],
  ]) {
    const patchTimes = [],
      saveTimes = [],
      combinedTimes = [],
      staleTimes = [];
    for (let i = 0; i < 20; i++) {
      const value = `Addon publication ${label} ${i}`;
      const beforeDisk = await readFile(path.join(project, yaml), 'utf8');
      const start = performance.now();
      const patched = accepted(
        'patch',
        binding.patch(
          handle,
          revision,
          JSON.stringify([{ operation: 'replace', path: pointer, value }]),
        ),
      );
      const afterPatch = performance.now();
      assert.equal(patched.snapshot.workingRevision, revision + 1);
      revision = patched.snapshot.workingRevision;
      assert.deepEqual(patched.affectedRecords, [target]);
      assert.deepEqual(
        Object.keys(patched.snapshot.recordSnapshots),
        target === 'project' ? [] : [target],
      );
      assert.equal(await readFile(path.join(project, yaml), 'utf8'), beforeDisk);

      const saved = accepted(
        'scoped Save',
        binding.saveOwners(
          handle,
          patched.snapshot.workingRevision,
          JSON.stringify([target]),
          false,
          'keep',
        ),
      );
      const afterSave = performance.now();
      assert.equal(saved.snapshot.workingRevision, patched.snapshot.workingRevision + 1);
      revision = saved.snapshot.workingRevision;
      assert.equal(saved.snapshot.dirty, false);
      assert.match(await readFile(path.join(project, yaml), 'utf8'), new RegExp(value));

      const staleAt = performance.now();
      const rejected = JSON.parse(
        binding.patch(
          handle,
          revision - 1,
          JSON.stringify([{ operation: 'replace', path: pointer, value: 'stale' }]),
        ),
      );
      staleTimes.push(performance.now() - staleAt);
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.snapshot.workingRevision, revision);
      assert.deepEqual(rejected.affectedRecords, []);

      if (i === 19) {
        // Full snapshot is a distinct explicit query. Its Project fields must
        // agree with both the saved result and the stale-CAS failure result.
        const full = JSON.parse(binding.snapshot(handle));
        for (const [key, value] of Object.entries(rejected.snapshot)) {
          if (key !== 'recordSnapshots') {
            assert.deepEqual(full[key], value, `cold/failed ${label}/${key}`);
            assert.deepEqual(saved.snapshot[key], value, `saved/failed ${label}/${key}`);
          }
        }
        if (target !== 'project') {
          assert.deepEqual(
            full.recordSnapshots[target],
            saved.snapshot.recordSnapshots[target],
            `cold/affected ${label}`,
          );
        }
      }

      patchTimes.push(afterPatch - start);
      saveTimes.push(afterSave - afterPatch);
      combinedTimes.push(afterSave - start);
    }
    output[label] = {
      patch: summary(patchTimes),
      save: summary(saveTimes),
      rejectedCAS: summary(staleTimes),
      combined: summary(combinedTimes),
    };
  }
  const beforeInvalid = JSON.parse(binding.snapshot(handle));
  const description = beforeInvalid.recordSnapshots[owner].source.data.description;
  const invalid = accepted(
    'invalid working Message',
    binding.patch(
      handle,
      revision,
      JSON.stringify([
        { operation: 'replace', path: `/${owner}/data/description`, value: 'invalid-message' },
      ]),
    ),
  );
  assert.equal(invalid.snapshot.valid, false);
  assert.ok(invalid.snapshot.diagnostics.length);
  const coldInvalid = JSON.parse(binding.snapshot(handle));
  assert.deepEqual(invalid.snapshot.diagnostics, coldInvalid.diagnostics);
  assert.deepEqual(invalid.snapshot.recordSnapshots[owner], coldInvalid.recordSnapshots[owner]);
  const failedSave = JSON.parse(
    binding.saveOwners(
      handle,
      invalid.snapshot.workingRevision,
      JSON.stringify([owner]),
      false,
      'keep',
    ),
  );
  assert.equal(failedSave.accepted, false);
  for (const [key, value] of Object.entries(invalid.snapshot))
    if (key !== 'recordSnapshots') assert.deepEqual(failedSave.snapshot[key], value);
  const repaired = accepted(
    'repair working Message',
    binding.patch(
      handle,
      invalid.snapshot.workingRevision,
      JSON.stringify([
        { operation: 'replace', path: `/${owner}/data/description`, value: description },
      ]),
    ),
  );
  assert.equal(repaired.snapshot.valid, true);
  const coldRepaired = JSON.parse(binding.snapshot(handle));
  assert.deepEqual(repaired.snapshot.diagnostics, coldRepaired.diagnostics);
  assert.deepEqual(repaired.snapshot.recordSnapshots[owner], coldRepaired.recordSnapshots[owner]);
  output.invalidRepair = 'passed';
  const validation = JSON.parse(binding.validateWorking(handle, repaired.snapshot.workingRevision));
  assert.equal(validation.workingRevision, repaired.snapshot.workingRevision);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.equal('projectSnapshotAssemblies' in (validation.work ?? {}), false);
  assert.equal('addonResultJsonConversions' in (validation.work ?? {}), false);
  output.validationDto = 'passed';
  output.addonSha256 = createHash('sha256')
    .update(await readFile(addon))
    .digest('hex');
  output.host = { platform: process.platform, arch: process.arch, node: process.version };
  console.log(JSON.stringify(output));
} finally {
  if (handle) binding.close(handle);
  await rm(temporary, { recursive: true, force: true });
}
