import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = await verifyNativeProductionClosure([
  ...['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((directory) =>
    path.join(editorRoot, 'dist-electron', directory),
  ),
  path.join(editorRoot, 'dist-scriptc-island'),
]);
if (violations.length) {
  for (const violation of violations) console.error(`[native-production-closure] ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'Native production closure verified: no retired Project authority in emitted bundles.',
  );
}
