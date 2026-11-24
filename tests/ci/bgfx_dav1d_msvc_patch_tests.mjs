import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const patch = fileURLToPath(new URL('../../cmake/patch-bgfx-dav1d-msvc.cmake', import.meta.url));
const relative = 'bimg/3rdparty/dav1d/include/compat/msvc/stdatomic.h';
const old = '#if defined(__clang__) && __has_include_next(<stdatomic.h>)';

test('pinned dav1d MSVC preprocessor patch is scoped, repeatable and rejects source drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-dav1d-msvc-'));
  try {
    const header = path.join(root, relative);
    await mkdir(path.dirname(header), { recursive: true });
    await writeFile(header, `#ifndef MSCVER_STDATOMIC_H_
#define MSCVER_STDATOMIC_H_
${old}
#  include_next <stdatomic.h>
#else
#include <windows.h>
#endif
#endif
`);
    const run = () => spawnSync('cmake', ['-P', patch], { cwd: root, encoding: 'utf8' });
    assert.equal(run().status, 0);
    const once = await readFile(header, 'utf8');
    assert.match(once, /#if defined\(__clang__\)\n#  if __has_include_next\(<stdatomic\.h>\)/);
    assert.match(once, /#if defined\(NOVELTEA_DAV1D_USE_CLANG_STDATOMIC\)/);
    assert.match(once, /#else\n#include <windows\.h>/);
    assert.equal(run().status, 0);
    assert.equal(await readFile(header, 'utf8'), once);
    await writeFile(header, '#if changed_upstream\n');
    const drift = run();
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /dav1d header changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
