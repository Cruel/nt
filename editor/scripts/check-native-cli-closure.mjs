import assert from 'node:assert/strict';
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

// The shared installed-build assertion checks both SHA-bound build provenance
// and the actual executable format/retired runtime symbols in every production
// and candidate acceptance entrypoint, not only in this auxiliary guard.

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
