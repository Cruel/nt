import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const { materialDataSchema, resolveMaterialData, validateMaterialData } =
  await import('../src/shared/project-schema/authoring-materials.ts');

const [addonPath, projectRoot] = process.argv.slice(2);
assert.ok(addonPath && projectRoot, 'Expected addon and Feature Lab Project paths.');
const require = createRequire(import.meta.url);
const native = require(addonPath);
const handle = native.open(projectRoot);

const ids = ['engine2d-draw-contract', 'lab-inherited', 'lab-invert', 'lab-grade'];
const source = (id) =>
  YAML.parse(readFileSync(join(projectRoot, 'records', 'materials', `${id}.yaml`), 'utf8'));
const normalizedSource = (id) => {
  const record = source(id);
  const base = record.data.base;
  const authoredData = {
    ...record.data,
    base:
      base.kind === 'material'
        ? { kind: 'material', material: { $ref: { collection: 'materials', id: base.material } } }
        : base,
  };
  return { ...record, data: materialDataSchema.parse(authoredData) };
};
const project = {
  materials: Object.fromEntries(ids.map((id) => [id, normalizedSource(id)])),
  assets: {},
};

try {
  for (const id of ids) {
    const response = JSON.parse(native.inspect(handle, `materials/${id}`));
    assert.equal(response.accepted, true, `Cannot inspect ${id}`);
    assert.equal(response.snapshot.valid, true, `Native Material ${id} is invalid`);
    const effective = response.snapshot.recordSnapshots[`materials/${id}`].normalized;
    assert.deepEqual(
      effective.data,
      project.materials[id].data,
      `Zod normalization mismatch: ${id}`,
    );
    const ts = resolveMaterialData(project, id);
    assert.ok(ts.data, `TypeScript Material ${id} could not resolve`);
    assert.deepEqual(ts.diagnostics, [], `TypeScript Material ${id} has unexpected diagnostics`);
    const request = JSON.parse(native.materialCompilerRequest(handle, id));
    const compiled = request.programs[id];
    if (compiled) {
      assert.equal(compiled.vertexSource, ts.data.vertexSource);
      assert.equal(compiled.fragmentSource, ts.data.fragmentSource);
      assert.equal(compiled.varyingDefinition, ts.data.varyingDefinition);
      assert.equal(compiled.interfaceContract, ts.data.interfaceContract);
      assert.equal(compiled.interfaceFingerprint, ts.data.interfaceFingerprint);
    }
  }

  const edited = structuredClone(project.materials['lab-inherited']);
  edited.data.parameters = { u_strength: { type: 'vec3' } };
  project.materials['lab-inherited'] = edited;
  assert.ok(
    validateMaterialData(project, 'lab-inherited', edited).some((issue) =>
      issue.path.endsWith('/parameters/u_strength/type'),
    ),
    'TypeScript must reject inherited logical type reinterpretation.',
  );
  const revision = JSON.parse(native.snapshot(handle)).workingRevision;
  const changed = JSON.parse(
    native.patch(
      handle,
      revision,
      JSON.stringify([
        {
          operation: 'add',
          path: '/materials/lab-inherited/data/parameters/u_strength',
          value: { type: 'vec3' },
        },
      ]),
    ),
  );
  assert.equal(changed.accepted, true);
  assert.equal(changed.snapshot.valid, false);
  assert.ok(
    changed.snapshot.diagnostics.some((issue) =>
      issue.path.endsWith('/parameters/u_strength/type'),
    ),
    'Native must diagnose the same invalid inherited override path.',
  );
  console.log('Native/TypeScript Material differential certification passed.');
} finally {
  native.close(handle);
}
