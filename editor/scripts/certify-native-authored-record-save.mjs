/** Real C++ ProjectSession + physical sparse YAML Save/reopen acceptance for
 * #605 authored Test, Interaction and Verb field/semantic controls. */
import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const addon = process.argv[2] ?? process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(addon, 'Pass NOVELTEA_AUTHORING_NODE_ADDON or the native Node addon path.');
const binding = createRequire(import.meta.url)(path.resolve(addon));
const { nativeFieldJsonPatches } =
  await import('../src/renderer/commands/native-field-json-patches.ts');
const { decodeSparseRecordYaml } =
  await import('../src/shared/project-workspace/sparse-record-yaml-source.ts');
const { renameVerbSlot } = await import('../src/renderer/editors/verbs/verb-slot-rename.ts');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-authored-record-save-'));
const project = path.join(scratch, 'feature-lab');
const source = path.resolve('tests/projects/feature-lab');
const owners = [
  ['tests', 'interaction-rules-flow'],
  ['interactions', 'interaction-rules'],
  ['verbs', 'resolve-subject'],
];
const ownerFile = (collection, id) => path.join(project, 'records', collection, `${id}.yaml`);
let handle;

function accepted(label, raw) {
  const result = JSON.parse(raw);
  assert.equal(result.accepted, true, `${label}: ${result.error ?? 'Native rejected operation'}`);
  return result;
}

async function readRecord(collection, id) {
  return decodeSparseRecordYaml(collection, await readFile(ownerFile(collection, id), 'utf8'));
}

try {
  await cp(source, project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  // A separate unreferenced Verb proves the exact multi-field UI command can
  // Save without requiring unrelated Project records to be simultaneously
  // remapped. The original fixture is never modified.
  const isolatedVerbId = 'atomic-rename-605';
  const isolatedVerbFile = ownerFile('verbs', isolatedVerbId);
  await writeFile(
    isolatedVerbFile,
    (await readFile(ownerFile('verbs', 'resolve-subject'), 'utf8'))
      .replace(/^id: resolve-subject$/mu, `id: ${isolatedVerbId}`)
      .replace(/^label: Resolve Subject$/mu, 'label: Atomic Rename 605'),
  );
  handle = binding.open(project);
  const opened = JSON.parse(binding.snapshot(handle));
  assert.equal(opened.valid, true, JSON.stringify(opened.diagnostics));
  const prepared = accepted(
    'Prepare native normalized records',
    binding.prepareCompleteWorking(handle, opened.workingRevision, ''),
  );
  const [testId, interactionId, verbId] = owners.map(([, id]) => id);
  const test = prepared.completeProject.tests[testId].data;
  const interaction = prepared.completeProject.interactions[interactionId].data;
  const verb = prepared.completeProject.verbs[verbId].data;

  const originalFiles = await Promise.all(
    owners.map(([family, id]) => readFile(ownerFile(family, id), 'utf8')),
  );
  const steps = structuredClone(test.steps);
  steps[0].label = '605 Native First Step';
  const rules = structuredClone(interaction.rules);
  assert.ok(rules.length >= 2, 'Feature Lab Interaction rules changed.');
  rules[0].id = 'renamed-rule-605';
  rules[0].priority = 43;
  [rules[0], rules[1]] = [rules[1], rules[0]];
  const action = structuredClone(verb.actionText);
  action.source = { kind: 'inline', text: 'Inspect closely' };

  const patches = [
    ...nativeFieldJsonPatches(
      test.displayName,
      '605 Native Test',
      `/tests/${testId}/data/displayName`,
    ),
    ...nativeFieldJsonPatches(test.steps, steps, `/tests/${testId}/data/steps`),
    ...nativeFieldJsonPatches(
      interaction.rules,
      rules,
      `/interactions/${interactionId}/data/rules`,
    ),
    ...nativeFieldJsonPatches(verb.actionText, action, `/verbs/${verbId}/data/actionText`),
  ];
  assert.ok(patches.length > 4, 'Expected fine-grained patches for the rule reorder and rename.');
  assert.ok(
    patches.every(({ path }) => path !== `/interactions/${interactionId}/data/rules`),
    'The editor must not emit an entire normalized Interaction rules array.',
  );
  assert.ok(
    patches.some(({ path }) => path.endsWith('/rules/1/id')),
    'Rule reorder must resolve native leaf addresses at dispatch.',
  );
  const modified = accepted(
    'Authoring field edits',
    binding.patch(
      handle,
      opened.workingRevision,
      JSON.stringify(patches.map(({ op, ...patch }) => ({ operation: op, ...patch }))),
    ),
  );
  for (const [i, [family, id]] of owners.entries())
    assert.equal(
      await readFile(ownerFile(family, id), 'utf8'),
      originalFiles[i],
      'Native patch must never write physical YAML before Save.',
    );

  let revision = modified.snapshot.workingRevision;
  for (const [i, [family, id]] of owners.entries()) {
    const saved = accepted(
      `${family} owner Save`,
      binding.saveOwners(handle, revision, JSON.stringify([`${family}/${id}`]), false, 'keep'),
    );
    revision = saved.snapshot.workingRevision;
    const record = await readRecord(family, id);
    if (family === 'tests') {
      assert.equal(record.data.displayName, '605 Native Test');
      assert.equal(record.data.steps[0].label, '605 Native First Step');
    } else if (family === 'interactions') {
      assert.equal(record.data.rules[0].id, rules[0].id);
      assert.equal(record.data.rules[1].id, 'renamed-rule-605');
      assert.equal(record.data.rules[1].priority, 43);
    } else assert.equal(record.data.actionText.source.text, 'Inspect closely');
    for (let other = i + 1; other < owners.length; other++) {
      const [otherFamily, otherId] = owners[other];
      assert.equal(
        await readFile(ownerFile(otherFamily, otherId), 'utf8'),
        originalFiles[other],
        'Scoped Save must not write a different Record owner.',
      );
    }
  }

  binding.close(handle);
  handle = undefined;
  handle = binding.open(project);
  for (const [family, id] of owners) {
    const native = accepted(`${family} reopen`, binding.inspect(handle, `${family}/${id}`));
    const reopened = native.snapshot.recordSnapshots[`${family}/${id}`].normalized;
    if (family === 'tests') {
      assert.equal(reopened.data.displayName, '605 Native Test');
      assert.equal(reopened.data.steps[0].label, '605 Native First Step');
    } else if (family === 'interactions') {
      assert.equal(reopened.data.rules[0].id, rules[0].id);
      assert.equal(reopened.data.rules[1].id, 'renamed-rule-605');
      assert.equal(reopened.data.rules[1].priority, 43);
    } else assert.equal(reopened.data.actionText.source.text, 'Inspect closely');
  }
  const prior = JSON.parse(binding.snapshot(handle));
  const isolated = accepted(
    'Inspect isolated Verb',
    binding.inspect(handle, `verbs/${isolatedVerbId}`),
  ).snapshot.recordSnapshots[`verbs/${isolatedVerbId}`].normalized.data;
  const renamed = renameVerbSlot(isolated, 'subject', 'target');
  const coordinated = ['slots', 'bindingOrder', 'offers', 'completedCommandText'].flatMap((field) =>
    nativeFieldJsonPatches(
      isolated[field],
      renamed[field],
      `/verbs/${isolatedVerbId}/data/${field}`,
    ),
  );
  assert.ok(coordinated.length >= 4, 'Expected a coordinated multi-field slot reference remap.');
  const renamedPatch = accepted(
    'Atomic Verb rename',
    binding.patch(
      handle,
      prior.workingRevision,
      JSON.stringify(coordinated.map(({ op, ...patch }) => ({ operation: op, ...patch }))),
    ),
  );
  const renamedSave = accepted(
    'Atomic Verb physical Save',
    binding.saveOwners(
      handle,
      renamedPatch.snapshot.workingRevision,
      JSON.stringify([`verbs/${isolatedVerbId}`]),
      false,
      'keep',
    ),
  );
  assert.ok(renamedSave.snapshot.workingRevision >= renamedPatch.snapshot.workingRevision);
  const savedVerb = await readRecord('verbs', isolatedVerbId);
  assert.equal(savedVerb.data.slots[0].id, 'target');
  assert.deepEqual(savedVerb.data.bindingOrder, ['target']);
  assert.equal(savedVerb.data.offers[0].slotId, 'target');
  assert.match(savedVerb.data.completedCommandText.source.text, /\{target\}/u);
  binding.close(handle);
  handle = binding.open(project);
  const reopenedVerb = accepted(
    'Atomic Verb native reopen',
    binding.inspect(handle, `verbs/${isolatedVerbId}`),
  ).snapshot.recordSnapshots[`verbs/${isolatedVerbId}`].normalized.data;
  assert.equal(reopenedVerb.slots[0].id, 'target');
  assert.deepEqual(reopenedVerb.bindingOrder, ['target']);
  assert.equal(reopenedVerb.offers[0].slotId, 'target');
  console.log(
    'Native Test/Interaction/Verb fields, rule reorder, atomic Verb slot rename, scoped Save and YAML reopen readback passed.',
  );
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
