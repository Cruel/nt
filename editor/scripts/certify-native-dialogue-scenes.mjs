import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [binary, project] = process.argv.slice(2);
assert.ok(binary && project, 'Expected native certification binary and Feature Lab root');
const [{ decodeSparseRecordYaml }, { authoringRecordSchemas }] = await Promise.all([
  import('../src/shared/project-workspace/sparse-record-yaml-source.ts'),
  import('../src/shared/project-schema/authoring-records.ts'),
]);
const native = spawnSync(binary, ['--normalized-records', project, 'dialogues', 'scenes'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(native.status, 0, `Native corpus normalization failed: ${native.stderr}`);
const normalized = JSON.parse(native.stdout);

for (const family of ['dialogues', 'scenes']) {
  let compared = 0;
  const root = path.join(project, 'records', family);
  for (const filename of (await readdir(root)).filter((name) => name.endsWith('.yaml'))) {
    const id = filename.slice(0, -5);
    const source = await readFile(path.join(root, filename), 'utf8');
    const expected = authoringRecordSchemas[family].parse(decodeSparseRecordYaml(family, source));
    const key = `${family}/${id}`;
    assert.ok(Object.hasOwn(normalized, key), `Native corpus is missing ${key}`);
    assert.deepStrictEqual(normalized[key], expected, `Normalized '${family}/${id}' differs`);
    compared++;
  }
  console.log(`Native ${family} Zod differential passed: ${compared} records.`);
}
