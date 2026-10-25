import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-scriptc-island');
const withNodeTools = process.argv.slice(2).includes('--with-node-tools');
if (process.argv.slice(2).some((argument) => argument !== '--with-node-tools'))
  throw new Error('Usage: check-native-cli-closure.mjs [--with-node-tools]');
// Standalone builds can additionally check the Node-tool forwarding entrypoints.
const roots = withNodeTools ? [root, path.resolve(root, '../dist-electron/tools')] : [root];
const violations = await verifyNativeProductionClosure(roots, { requireManifestRoots: roots });
if (violations.length) {
  for (const item of violations) console.error(`[native-cli-closure] ${item}`);
  process.exitCode = 1;
} else {
  console.log(
    `Native CLI${withNodeTools ? ' and Node-tool' : ''} closure verified: no retired Project authority.`,
  );
}
