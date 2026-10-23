import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledRoots = ['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((directory) =>
  path.join(editorRoot, 'dist-electron', directory),
);
const scriptcRoot = path.join(editorRoot, 'dist-scriptc-island');
const violations = await verifyNativeProductionClosure(
  [...bundledRoots, scriptcRoot],
  // Vite emits cryptographically bound module inventories for both editor
  // and ScriptC-island chunks. Missing inventories cannot silently downgrade
  // a production bundle to weak, forgeable source annotations.
  { requireManifestRoots: [...bundledRoots, scriptcRoot] },
);
if (violations.length) {
  for (const violation of violations) console.error(`[native-production-closure] ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'Native production closure verified: no retired Project authority in emitted bundles.',
  );
}
