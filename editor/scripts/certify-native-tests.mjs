import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const binary = process.argv[2];
const root = process.argv[3];
if (!binary || !root) throw new Error('Expected native executable and Project root');

const [{ decodeSparseRecordYaml }, { authoringRecordSchemas }] = await Promise.all([
  import('../src/shared/project-workspace/sparse-record-yaml-source.ts'),
  import('../src/shared/project-schema/authoring-records.ts'),
]);
const native = spawnSync(binary, ['--normalized-records', root, 'tests'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(native.status, 0, `Native corpus normalization failed: ${native.stderr}`);
const normalized = JSON.parse(native.stdout);

let count = 0;
for (const filename of (await readdir(path.join(root, 'records', 'tests'))).sort()) {
  if (!filename.endsWith('.yaml')) continue;
  const id = filename.slice(0, -'.yaml'.length);
  const source = await readFile(path.join(root, 'records', 'tests', filename), 'utf8');
  const expected = authoringRecordSchemas.tests.parse(decodeSparseRecordYaml('tests', source));
  const key = `tests/${id}`;
  assert.ok(Object.hasOwn(normalized, key), `Native corpus is missing ${key}`);
  assert.deepStrictEqual(normalized[key], expected, `Test ${id} normalization mismatch`);
  count++;
}
console.log(`Native Test Zod normalization differential passed: ${count} Feature Lab records.`);
