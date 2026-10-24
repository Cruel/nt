import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist-scriptc-native-island',
);
const violations = await verifyNativeProductionClosure([root], { requireManifestRoots: [root] });
if (violations.length) {
  for (const item of violations) console.error(`[native-cli-candidate-closure] ${item}`);
  process.exitCode = 1;
} else {
  console.log('Native CLI candidate closure verified: no retired Project authority.');
}
