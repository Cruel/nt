import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { editorRoot } from './editor-distribution-lib.mjs';

const require = createRequire(path.join(editorRoot, 'package.json'));
const electron = require('electron');
const addon = path.resolve(process.env.NOVELTEA_AUTHORING_NODE_ADDON ?? '');
if (!process.env.NOVELTEA_AUTHORING_NODE_ADDON) {
  throw new Error('NOVELTEA_AUTHORING_NODE_ADDON must identify the built host module.');
}
const result = spawnSync(
  electron,
  [path.join(editorRoot, 'scripts', 'certify-native-authoring-electron-worker.cjs'), addon],
  {
    cwd: editorRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
if (result.error || result.status !== 0) {
  throw new Error(
    `Electron native authoring worker certification failed (${result.status}):\n${result.stderr}\n${result.stdout}`,
    { cause: result.error },
  );
}
console.log(result.stdout.trim());
