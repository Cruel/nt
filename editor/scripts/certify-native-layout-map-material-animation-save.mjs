// Real ProjectSession and physical source readback for the four #606 editor families.
import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const addon = process.argv[2] ?? process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(addon, 'Pass the native Node addon path.');
const binding = createRequire(import.meta.url)(path.resolve(addon));
const { defaultMapData } = await import('../src/shared/project-schema/authoring-maps.ts');
const { decodeSparseRecordYaml, encodeSparseRecordYaml } =
  await import('../src/shared/project-workspace/sparse-record-yaml-source.ts');
const { nativeFieldJsonPatches } =
  await import('../src/renderer/commands/native-field-json-patches.ts');

const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-606-native-save-'));
const project = path.join(scratch, 'feature-lab');
const source = path.resolve('tests/projects/feature-lab');
const layoutId = 'lab-pause';
const mapId = 'certification-map';
const materialId = 'lab-text';
const animationId = 'alpha-occupancy-loop';
const file = (collection, id) =>
  collection === 'layouts'
    ? path.join(project, 'records', collection, id, 'layout.yaml')
    : path.join(project, 'records', collection, `${id}.yaml`);
let handle;

function accepted(label, result) {
  const parsed = JSON.parse(result);
  assert.equal(parsed.accepted, true, `${label}: ${parsed.error ?? 'native rejection'}`);
  return parsed;
}

async function readRecord(collection, id) {
  return decodeSparseRecordYaml(collection, await readFile(file(collection, id), 'utf8'));
}

try {
  await cp(source, project, {
    recursive: true,
    filter: (name) => !name.split(path.sep).includes('.noveltea'),
  });
  await mkdir(path.dirname(file('maps', mapId)), { recursive: true });
  await writeFile(
    file('maps', mapId),
    encodeSparseRecordYaml('maps', {
      id: mapId,
      label: 'Certification Map',
      data: defaultMapData(),
    }),
  );
  handle = binding.open(project);
  const initial = JSON.parse(binding.snapshot(handle));
  assert.equal(initial.valid, true, JSON.stringify(initial.diagnostics));
  const initialMaterial = await readFile(file('materials', materialId), 'utf8');
  const initialAnimation = await readFile(file('animations', animationId), 'utf8');
  const prepared = accepted(
    'Prepare normalized native records',
    binding.prepareCompleteWorking(handle, initial.workingRevision, ''),
  );
  const native = prepared.completeProject;
  const mount = structuredClone(native.layouts[layoutId].data.mount);
  mount.defaultParent = 'certification-mount';
  const presentation = structuredClone(native.maps[mapId].data.presentation);
  presentation.initialMode = 'minimap';
  const parameters = structuredClone(native.materials[materialId].data.parameters);
  parameters.u_amount.value = 0.4;
  const frames = structuredClone(native.animations[animationId].data.motions[0].frames);
  frames[0].durationMs = 1200;
  const changes = [
    ['layouts', layoutId, 'mount', native.layouts[layoutId].data.mount, mount],
    ['maps', mapId, 'presentation', native.maps[mapId].data.presentation, presentation],
    [
      'materials',
      materialId,
      'parameters',
      native.materials[materialId].data.parameters,
      parameters,
    ],
    [
      'animations',
      animationId,
      'motions',
      native.animations[animationId].data.motions,
      [{ ...native.animations[animationId].data.motions[0], frames }],
    ],
  ];
  let revision = initial.workingRevision;
  for (const [family, id, field, before, after] of changes) {
    const patches = nativeFieldJsonPatches(before, after, `/${family}/${id}/data/${field}`);
    assert.equal(patches.length, 1, `${family}: expected one native leaf edit.`);
    const modified = accepted(
      `${family} native field`,
      binding.patch(
        handle,
        revision,
        JSON.stringify(patches.map(({ op, ...patch }) => ({ operation: op, ...patch }))),
      ),
    );
    revision = modified.snapshot.workingRevision;
  }
  assert.equal(await readFile(file('materials', materialId), 'utf8'), initialMaterial);
  assert.equal(await readFile(file('animations', animationId), 'utf8'), initialAnimation);
  for (const [family, id] of [
    ['layouts', layoutId],
    ['maps', mapId],
    ['materials', materialId],
    ['animations', animationId],
  ]) {
    const saved = accepted(
      `${family} owner Save`,
      binding.saveOwners(handle, revision, JSON.stringify([`${family}/${id}`]), false, 'keep'),
    );
    revision = saved.snapshot.workingRevision;
  }
  assert.equal(
    (await readRecord('layouts', layoutId)).data.mount.defaultParent,
    'certification-mount',
  );
  assert.equal((await readRecord('maps', mapId)).data.presentation.initialMode, 'minimap');
  assert.equal((await readRecord('materials', materialId)).data.parameters.u_amount.value, 0.4);
  assert.equal(
    (await readRecord('animations', animationId)).data.motions[0].frames[0].durationMs,
    1200,
  );
  binding.close(handle);
  handle = binding.open(project);
  const reopened = JSON.parse(binding.snapshot(handle));
  assert.equal(reopened.valid, true, JSON.stringify(reopened.diagnostics));
  console.log('Native #606 Layout/Map/Material/Animation physical Save and reopening passed.');
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
