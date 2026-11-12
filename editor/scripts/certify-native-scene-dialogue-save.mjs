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
  const sceneIndex = (await readRecord('scenes', sceneFile)).data.events.findIndex(
    (event) => event.id === 'delay',
  );
  const dialogueIndex = (await readRecord('dialogues', dialogueFile)).data.blocks.findIndex(
    (block) => block.id === 'notice',
  );
  assert.ok(sceneIndex >= 0 && dialogueIndex >= 0, 'Feature Lab semantic IDs changed.');

  const modified = accepted(
    'Scene and Dialogue native fields',
    binding.patch(
      handle,
      original.workingRevision,
      JSON.stringify([
        { operation: 'replace', path: `/scenes/${sceneId}/data/displayName`, value: sceneLabel },
        {
          operation: 'replace',
          path: `/scenes/${sceneId}/data/events/${sceneIndex}/label`,
          value: 'Delayed-native event',
        },
        {
          operation: 'replace',
          path: `/dialogues/${dialogueId}/data/displayName`,
          value: dialogueLabel,
        },
        {
          operation: 'replace',
          path: `/dialogues/${dialogueId}/data/blocks/${dialogueIndex}/label`,
          value: 'Delayed-native block',
        },
      ]),
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
