// Exercise the real native ProjectSession and physical YAML Save owners for
// the Scene/Dialogue immediate-field editor migration. No renderer fake worker.
import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const addon = process.argv[2] ?? process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(addon, 'Pass NOVELTEA_AUTHORING_NODE_ADDON or the native Node addon path.');
const binding = createRequire(import.meta.url)(path.resolve(addon));
const { decodeSparseRecordYaml } =
  await import('../src/shared/project-workspace/sparse-record-yaml-source.ts');
const { nativeFieldJsonPatches } =
  await import('../src/renderer/commands/native-field-json-patches.ts');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-scene-dialogue-save-'));
const project = path.join(scratch, 'feature-lab');
const source = path.resolve('tests/projects/feature-lab');

const sceneId = 'background-clock-a';
const dialogueId = 'active-text';
const sceneFile = path.join(project, 'records', 'scenes', `${sceneId}.yaml`);
const dialogueFile = path.join(project, 'records', 'dialogues', `${dialogueId}.yaml`);
const sceneLabel = 'Scene-native-604';
const dialogueLabel = 'Dialogue-native-604';
let handle;

function accepted(label, result) {
  const parsed = JSON.parse(result);
  assert.equal(parsed.accepted, true, `${label}: ${parsed.error ?? 'Native rejected mutation'}`);
  return parsed;
}

async function readRecord(family, file) {
  return decodeSparseRecordYaml(family, await readFile(file, 'utf8'));
}

try {
  await cp(source, project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  handle = binding.open(project);
  const original = JSON.parse(binding.snapshot(handle));
  assert.equal(original.valid, true, JSON.stringify(original.diagnostics));
  const originalScene = await readFile(sceneFile, 'utf8');
  const originalDialogue = await readFile(dialogueFile, 'utf8');
  const prepared = accepted(
    'Prepare normalized native records',
    binding.prepareCompleteWorking(handle, original.workingRevision, ''),
  );
  const sceneData = prepared.completeProject.scenes[sceneId].data;
  const dialogueData = prepared.completeProject.dialogues[dialogueId].data;
  const sceneEvents = structuredClone(sceneData.events);
  const dialogueBlocks = structuredClone(dialogueData.blocks);
  const event = sceneEvents.find((item) => item.id === 'delay');
  const block = dialogueBlocks.find((item) => item.id === 'notice');
  assert.ok(event && block, 'Feature Lab semantic IDs changed.');
  event.label = 'Delayed-native event';
  block.label = 'Delayed-native block';

  // Exercise exactly the editor's dispatch-time command planner, not an
  // independently hand-written set of leaf patches. Normalized entire-array
  // replacements are valid native working edits but can fail physical YAML Save.
  const patches = [
    ...nativeFieldJsonPatches(
      sceneData.displayName,
      sceneLabel,
      `/scenes/${sceneId}/data/displayName`,
    ),
    ...nativeFieldJsonPatches(sceneData.events, sceneEvents, `/scenes/${sceneId}/data/events`),
    ...nativeFieldJsonPatches(
      dialogueData.displayName,
      dialogueLabel,
      `/dialogues/${dialogueId}/data/displayName`,
    ),
    ...nativeFieldJsonPatches(
      dialogueData.blocks,
      dialogueBlocks,
      `/dialogues/${dialogueId}/data/blocks`,
    ),
  ];
  assert.equal(patches.length, 4, 'Expected one native leaf edit per modified value.');
  assert.ok(
    patches.every(
      (patch) =>
        patch.path !== `/scenes/${sceneId}/data/events` &&
        patch.path !== `/dialogues/${dialogueId}/data/blocks`,
    ),
    'Must not replace normalized Scene or Dialogue arrays at the native boundary.',
  );

  const modified = accepted(
    'Scene and Dialogue native fields',
    binding.patch(
      handle,
      original.workingRevision,
      JSON.stringify(patches.map(({ op, ...patch }) => ({ operation: op, ...patch }))),
    ),
  );
  assert.equal(await readFile(sceneFile, 'utf8'), originalScene);
  assert.equal(await readFile(dialogueFile, 'utf8'), originalDialogue);

  const sceneSaved = accepted(
    'Scene scoped Save',
    binding.saveOwners(
      handle,
      modified.snapshot.workingRevision,
      JSON.stringify([`scenes/${sceneId}`]),
      false,
      'keep',
    ),
  );
  const scene = await readRecord('scenes', sceneFile);
  assert.equal(scene.data.displayName, sceneLabel);
  assert.equal(
    scene.data.events.find((event) => event.id === 'delay')?.label,
    'Delayed-native event',
  );
  assert.equal(await readFile(dialogueFile, 'utf8'), originalDialogue);

  const dialogueSaved = accepted(
    'Dialogue scoped Save',
    binding.saveOwners(
      handle,
      sceneSaved.snapshot.workingRevision,
      JSON.stringify([`dialogues/${dialogueId}`]),
      false,
      'keep',
    ),
  );
  const dialogue = await readRecord('dialogues', dialogueFile);
  assert.equal(dialogue.data.displayName, dialogueLabel);
  assert.equal(
    dialogue.data.blocks.find((block) => block.id === 'notice')?.label,
    'Delayed-native block',
  );
  assert.equal((await readRecord('scenes', sceneFile)).data.displayName, sceneLabel);
  assert.ok(dialogueSaved.snapshot.workingRevision >= sceneSaved.snapshot.workingRevision);

  console.log(
    'Native Scene/Dialogue field patch, owner-isolated Save and exact YAML readback passed.',
  );
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
