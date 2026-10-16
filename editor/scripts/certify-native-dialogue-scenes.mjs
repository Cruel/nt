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

for (const family of ['dialogues', 'scenes']) {
  let compared = 0;
  const root = path.join(project, 'records', family);
  for (const filename of (await readdir(root)).filter((name) => name.endsWith('.yaml'))) {
    const id = filename.slice(0, -5);
    const source = await readFile(path.join(root, filename), 'utf8');
    const expected = authoringRecordSchemas[family].parse(decodeSparseRecordYaml(family, source));
    const native = spawnSync(binary, ['--normalized', project, family, id], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, `Native '${family}/${id}' failed: ${native.stderr}`);
    assert.deepStrictEqual(
      JSON.parse(native.stdout),
      expected,
      `Normalized '${family}/${id}' differs`,
    );
    compared++;
  }
  console.log(`Native ${family} Zod differential passed: ${compared} records.`);
}
