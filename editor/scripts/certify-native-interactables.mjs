import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const binary = process.argv[2];
const projectRoot = process.argv[3];
if (!binary || !projectRoot) throw new Error('Expected native executable and Project root');

const [{ decodeSparseRecordYaml }, { authoringRecordSchemas }] = await Promise.all([
  import('../src/shared/project-workspace/sparse-record-yaml-source.ts'),
  import('../src/shared/project-schema/authoring-records.ts'),
]);
const native = spawnSync(binary, ['--normalized-records', projectRoot, 'interactables'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(native.status, 0, `Native corpus normalization failed: ${native.stderr}`);
const normalized = JSON.parse(native.stdout);

const sourceRoot = path.join(projectRoot, 'records', 'interactables');
let compared = 0;
for (const filename of (await readdir(sourceRoot)).filter((name) => name.endsWith('.yaml'))) {
  const id = filename.slice(0, -'.yaml'.length);
  const source = await readFile(path.join(sourceRoot, filename), 'utf8');
  const expected = authoringRecordSchemas.interactables.parse(
    decodeSparseRecordYaml('interactables', source),
  );
  const key = `interactables/${id}`;
  assert.ok(Object.hasOwn(normalized, key), `Native corpus is missing ${key}`);
  assert.deepStrictEqual(normalized[key], expected, `Normalized '${id}' differs from Zod`);
  compared++;
}

console.log(`Native Interactable/Zod differential passed: ${compared} definitions.`);
