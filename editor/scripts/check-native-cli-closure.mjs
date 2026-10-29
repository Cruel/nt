import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertInstalledNativeCliBuild } from './native-production-qualification.mjs';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(editorRoot, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--with-node-tools'))
  throw new Error('Usage: check-native-cli-closure.mjs [--with-node-tools]');
const platform =
  process.env.NOVELTEA_CLI_TARGET === 'windows' || process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : 'linux';
const cli = path.join(
  root,
  'build/cli',
  platform,
  platform === 'windows' ? 'noveltea.exe' : 'noveltea',
);
await assertInstalledNativeCliBuild(cli);

// Check the actual installed binary, not merely the build configuration or
// a source-code grep. A JavaScript wrapper cannot masquerade as the C++ CLI.
const bytes = await readFile(cli);
const nativeMagic =
  (bytes[0] === 0x7f && bytes.subarray(1, 4).toString() === 'ELF') ||
  (bytes[0] === 0x4d && bytes[1] === 0x5a) ||
  ['feedfacf', 'cffaedfe'].includes(bytes.subarray(0, 4).toString('hex'));
assert.ok(nativeMagic, 'Installed CLI is not an ELF, PE, or Mach-O native executable.');
for (const symbol of [
  'scr_island_lre_opaque',
  'JS_RunGC',
  'JS_SetGCThreshold',
  'noveltea_tooling_scriptc_',
]) {
  assert.equal(
    bytes.includes(Buffer.from(symbol)),
    false,
    `Retired scripting runtime symbol: ${symbol}`,
  );
}

if (args.includes('--with-node-tools')) {
  const tools = path.join(editorRoot, 'dist-electron/tools');
  const violations = await verifyNativeProductionClosure([tools], {
    requireManifestRoots: [tools],
  });
  assert.deepEqual(
    violations,
    [],
    'Development Node forwarder contains retired Project authority.',
  );
}
console.log('Installed CLI closure verified: native executable and no scripting runtime linkage.');
