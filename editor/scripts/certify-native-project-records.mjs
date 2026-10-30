import './native-schema/register-typescript.mjs';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [binary, root] = process.argv.slice(2);
assert.ok(binary && root, 'Expected native certification binary and Project root.');

const [{ decodeSparseRecordYaml }, { authoringRecordSchemas }] = await Promise.all([
  import('../src/shared/project-workspace/sparse-record-yaml-source.ts'),
  import('../src/shared/project-schema/authoring-records.ts'),
]);

// Independent Zod/YAML normalization is the compiler input contract. These are
// all sparse record families; Variable and Layout use distinct source codecs.
const families = [
  'archetypes',
  'scripts',
  'assets',
  'animations',
  'materials',
  'rooms',
  'maps',
  'characters',
  'interactables',
  'verbs',
  'interactions',
  'dialogues',
  'scenes',
  'tests',
];
let compared = 0;
// Run the complete native normalization in one process, rather than spawning a
// fresh sanitizer-instrumented C++ executable for each record. The assertions
// below remain per-record and still use the independent TypeScript/Zod codec.
const native = spawnSync(binary, ['--normalized-records', root], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
assert.equal(native.status, 0, `Native corpus normalization failed: ${native.stderr}`);
const normalized = JSON.parse(native.stdout);
for (const family of families) {
  const files = await readdir(join(root, 'records', family)).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const file of files.sort((a, b) => a.localeCompare(b))) {
    if (!file.endsWith('.yaml')) continue;
    const id = file.slice(0, -5);
    const source = await readFile(join(root, 'records', family, file), 'utf8');
    const expected = authoringRecordSchemas[family].parse(decodeSparseRecordYaml(family, source));
    const key = `${family}/${id}`;
    assert.ok(Object.hasOwn(normalized, key), `Native corpus is missing ${key}`);
    assert.deepStrictEqual(
      normalized[key],
      expected,
      `Normalized ${family}/${id} differs from Zod`,
    );
    compared++;
  }
}
assert.ok(compared > 100, 'Feature Lab must exercise the actual Project record corpus.');
assert.equal(
  Object.keys(normalized).length,
  compared,
  'Native corpus contains unexpected records.',
);
console.log(`Native full-Project record normalization differential passed: ${compared} records.`);
