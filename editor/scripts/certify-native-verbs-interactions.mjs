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

let compared = 0;
for (const family of ['verbs', 'interactions']) {
  const sourceRoot = path.join(projectRoot, 'records', family);
  for (const filename of (await readdir(sourceRoot)).filter((name) => name.endsWith('.yaml'))) {
    const id = filename.slice(0, -'.yaml'.length);
    const source = await readFile(path.join(sourceRoot, filename), 'utf8');
    const expected = authoringRecordSchemas[family].parse(decodeSparseRecordYaml(family, source));
    const native = spawnSync(binary, ['--normalized-record', projectRoot, family, id], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, `Native ${family}/${id} failed: ${native.stderr}`);
    assert.deepStrictEqual(
      JSON.parse(native.stdout),
      expected,
      `Native normalized ${family}/${id} differs from Zod`,
    );
    compared++;
  }
}

console.log(`Native Verb/Interaction Zod differential passed: ${compared} records.`);
