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

let count = 0;
for (const filename of (await readdir(path.join(root, 'records', 'tests'))).sort()) {
  if (!filename.endsWith('.yaml')) continue;
  const id = filename.slice(0, -'.yaml'.length);
  const source = await readFile(path.join(root, 'records', 'tests', filename), 'utf8');
  const expected = authoringRecordSchemas.tests.parse(decodeSparseRecordYaml('tests', source));
  const native = spawnSync(binary, ['--normalized-record', root, id], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, `Native Test ${id} failed: ${native.stderr}`);
  assert.deepStrictEqual(JSON.parse(native.stdout), expected, `Test ${id} normalization mismatch`);
  count++;
}
console.log(`Native Test Zod normalization differential passed: ${count} Feature Lab records.`);
