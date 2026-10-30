import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundledRoots = ['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((directory) =>
  path.join(editorRoot, 'dist-electron', directory),
);
const violations = await verifyNativeProductionClosure(
  bundledRoots,
  // Every emitted editor chunk must have a cryptographically bound manifest;
  // the installed CLI must not have a JS runtime bundle at all.
  { requireManifestRoots: bundledRoots },
);
if (violations.length) {
  for (const violation of violations) console.error(`[native-production-closure] ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    'Native production closure verified: no retired Project authority in emitted bundles.',
  );
}
