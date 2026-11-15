// Real Node-API ProjectSession patch/Save publication, using a disposable
// Feature Lab copy. Native work counters can be enabled with
// NOVELTEA_AUTHORING_PROFILE=1; the addon prints them to stderr, never IPC.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  // A one-owner session cannot expose the cost of reconstructing unrelated
  // inspected records. Reproduce a multi-tab editing session explicitly.
  const extraFlag = process.argv.find((argument) => argument.startsWith('--additional-inspected='));
  const requestedExtra = Number(extraFlag?.split('=')[1] ?? 0);
  assert.ok(Number.isInteger(requestedExtra) && requestedExtra >= 0 && requestedExtra <= 40);
  const candidates = (await readdir(path.join(project, 'records/rooms')))
    .filter((file) => file.endsWith('.yaml') && file !== 'properties-and-traits.yaml')
    .sort();
  assert.ok(candidates.length >= requestedExtra);
  for (const file of candidates.slice(0, requestedExtra)) {
    const other = `rooms/${file.slice(0, -'.yaml'.length)}`;
    const inspectedOther = accepted(`inspect ${other}`, binding.inspect(handle, other));
    assert.deepEqual(inspectedOther.affectedRecords, [other]);
    assert.deepEqual(Object.keys(inspectedOther.snapshot.recordSnapshots), [other]);
    revision = inspectedOther.snapshot.workingRevision;
  }
  const output = {
    coldOpenAndSnapshotMs: Number(coldOpenAndSnapshotMs.toFixed(2)),
    additionalInspected: requestedExtra,
  };
  const validateWorking = process.argv.includes('--validate-working');
  for (const [label, target, pointer, yaml] of [
    ['roomDisplayName', owner, `/${owner}/data/displayName`, `records/${owner}.yaml`],
    ['roomDescription', owner, `/${owner}/data/description/source/text`, `records/${owner}.yaml`],
    ['projectTitle', 'project', '/project/name', 'project.yaml'],
  ]) {
    const patchTimes = [],
      saveTimes = [],
      combinedTimes = [],
      staleTimes = [],
      validationTimes = [];
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

      if (validateWorking) {
        const validationStarted = performance.now();
        const validated = JSON.parse(binding.validateWorking(handle, revision));
        validationTimes.push(performance.now() - validationStarted);
        assert.equal(validated.workingRevision, revision);
        assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
      }

      const saveStarted = validateWorking ? performance.now() : afterPatch;
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
      saveTimes.push(afterSave - saveStarted);
      combinedTimes.push(afterSave - start);
    }
    output[label] = {
      patch: summary(patchTimes),
      save: summary(saveTimes),
      rejectedCAS: summary(staleTimes),
      combined: summary(combinedTimes),
    };
    if (validateWorking) output[label].validateWorking = summary(validationTimes);
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
  const savedRoom = path.join(project, `records/${owner}.yaml`);
  const patchOnlyTimes = [];
  const unchangedDisk = await readFile(savedRoom, 'utf8');
  let patchOnlyRevision = repaired.snapshot.workingRevision;
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    const updated = accepted(
      'in-memory-only patch',
      binding.patch(
        handle,
        patchOnlyRevision,
        JSON.stringify([
          {
            operation: 'replace',
            path: `/${owner}/data/displayName`,
            value: `Patch-only contributor ${i}`,
          },
        ]),
      ),
    );
    patchOnlyTimes.push(performance.now() - started);
    patchOnlyRevision = updated.snapshot.workingRevision;
    assert.equal(await readFile(savedRoom, 'utf8'), unchangedDisk);
  }
  output.inMemoryRoomPatchOnly = summary(patchOnlyTimes);
  const unchanged = accepted(
    'same-value working patch',
    binding.patch(
      handle,
      patchOnlyRevision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${owner}/data/displayName`,
          value: 'Patch-only contributor 19',
        },
      ]),
    ),
  );
  assert.equal(unchanged.snapshot.workingRevision, patchOnlyRevision);
  assert.deepEqual(unchanged.affectedRecords, []);
  output.unchangedPatch = 'passed';
  const committedPatchOnly = accepted(
    'Save after 20 in-memory-only patches',
    binding.saveOwners(handle, patchOnlyRevision, JSON.stringify([owner]), false, 'keep'),
  );
  assert.match(await readFile(savedRoom, 'utf8'), /Patch-only contributor 19/);
  output.batchedOwnWrite = 'passed';

  const changedType = accepted(
    'meaningful Room property-type change',
    binding.patch(
      handle,
      committedPatchOnly.snapshot.workingRevision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${owner}/localProperties/0/type`,
          value: 'number',
        },
      ]),
    ),
  );
  assert.equal(changedType.snapshot.valid, false);
  assert.deepEqual(
    changedType.snapshot.diagnostics,
    JSON.parse(binding.snapshot(handle)).diagnostics,
  );
  const repairedType = accepted(
    'restore Room property type',
    binding.patch(
      handle,
      changedType.snapshot.workingRevision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${owner}/localProperties/0/type`,
          value: 'string',
        },
      ]),
    ),
  );
  assert.equal(repairedType.snapshot.valid, true);
  assert.deepEqual(
    repairedType.snapshot.diagnostics,
    JSON.parse(binding.snapshot(handle)).diagnostics,
  );
  output.typedDependencyRepair = 'passed';

  const local = accepted(
    'local edit before overlapping physical change',
    binding.patch(
      handle,
      repairedType.snapshot.workingRevision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${owner}/data/displayName`,
          value: 'Unsaved conflicting Room name',
        },
      ]),
    ),
  );
  const physical = (await readFile(savedRoom, 'utf8')).replace(
    /^  displayName:.*$/m,
    '  displayName: External conflicting Room name',
  );
  assert.match(physical, /External conflicting Room name/);
  await writeFile(savedRoom, physical);
  const conflict = JSON.parse(
    binding.saveOwners(
      handle,
      local.snapshot.workingRevision,
      JSON.stringify([owner]),
      false,
      'keep',
    ),
  );
  assert.equal(conflict.accepted, false);
  assert.equal(await readFile(savedRoom, 'utf8'), physical);
  binding.close(handle);
  handle = binding.open(project);
  const recovered = accepted('reopen external physical revision', binding.inspect(handle, owner));
  assert.equal(
    recovered.snapshot.recordSnapshots[owner].normalized.data.displayName,
    'External conflicting Room name',
  );
  output.externalConflictAndReopen = 'passed';

  output.sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  output.addonSha256 = createHash('sha256')
    .update(await readFile(addon))
    .digest('hex');
  output.host = { platform: process.platform, arch: process.arch, node: process.version };
  console.log(JSON.stringify(output));
} finally {
  if (handle) binding.close(handle);
  await rm(temporary, { recursive: true, force: true });
}
