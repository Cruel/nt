// #520: the editor's real Electron addon and the installed native CLI must
// share clean disk evidence without sharing resident/dirty Project authority.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { editorRoot } from './editor-distribution-lib.mjs';

if (!process.env.NOVELTEA_AUTHORING_NODE_ADDON)
  throw new Error('NOVELTEA_AUTHORING_NODE_ADDON is required; no mock addon fallback.');
if (!process.argv[2]) throw new Error('Pass the installed NovelTea CLI executable path.');

const require = createRequire(path.join(editorRoot, 'package.json'));
const electron = require('electron');
const run = spawnSync(
  electron,
  [
    path.join(editorRoot, 'scripts/certify-native-authoring-cross-system-worker.cjs'),
    path.resolve(process.env.NOVELTEA_AUTHORING_NODE_ADDON),
    path.resolve(process.argv[2]),
  ],
  {
    cwd: editorRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 480_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
if (run.error || run.status !== 0)
  throw new Error(
    `Cross-system native certification failed (${run.status}):\n${run.stderr}\n${run.stdout}`,
    {
      cause: run.error,
    },
  );
console.log(run.stdout.trim());
