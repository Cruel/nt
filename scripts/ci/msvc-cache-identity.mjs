// MSVC cl.exe loads separate compiler passes and support DLLs. A runner
// image's installation timestamps are not a compiler identity. Hash the
// selected toolchain's binaries once, while ccache independently checks
// the actual executable, headers, flags and source bytes on each request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function msvcCacheIdentity(compiler) {
  const executable = realpathSync(compiler);
  assert.equal(path.basename(executable).toLowerCase(), 'cl.exe');
  const directory = path.dirname(executable);
  const binaries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(exe|dll)$/i.test(entry.name))
    .map(entry => entry.name).sort();
  const names = binaries.map(name => name.toLowerCase());
  for (const required of ['cl.exe', 'c1.dll', 'c1xx.dll', 'c2.dll'])
    assert.ok(names.includes(required), `Incomplete MSVC compiler toolchain: ${required}`);
  assert.equal(new Set(names).size, names.length, 'Ambiguous MSVC binary name');
  const identity = createHash('sha256');
  identity.update('noveltea-msvc-toolchain-v1\0');
  for (const name of binaries) {
    const digest = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
    identity.update(name.toLowerCase() + '\0' + digest + '\0');
  }
  return identity.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: msvc-cache-identity.mjs <absolute cl.exe>');
  console.log(msvcCacheIdentity(process.argv[2]));
}
