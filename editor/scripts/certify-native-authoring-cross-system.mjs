// #520: the editor's real Electron addon and the installed native CLI must
// share clean disk evidence without sharing resident/dirty Project authority.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { editorRoot } from './editor-distribution-lib.mjs';
import { verifyNativeProductionClosure } from './native-production-closure.mjs';
import {
  assertProductionInputs,
  isolatedProductionEnvironment,
} from './native-production-qualification.mjs';

if (!process.env.NOVELTEA_AUTHORING_NODE_ADDON)
  throw new Error('NOVELTEA_AUTHORING_NODE_ADDON is required; no mock addon fallback.');
if (!process.argv[2]) throw new Error('Pass the installed NovelTea CLI executable path.');
const production = process.argv[3] === '--production';
if (process.argv.length > 4 || (process.argv[3] && !production))
  throw new Error(
    'Usage: certify-native-authoring-cross-system.mjs <installed-cli> [--production]',
  );
if (production) {
  await assertProductionInputs(path.resolve(process.argv[2]));
  const roots = [
    ...['main', 'preload', 'authoring-worker', 'tools', 'renderer'].map((name) =>
      path.join(editorRoot, 'dist-electron', name),
    ),
    path.join(editorRoot, 'dist-scriptc-island'),
  ];
  for (const root of roots) {
    if (
      !(
        await stat(path.join(root, 'native-production-provenance.json')).catch(() => null)
      )?.isFile()
    )
      throw new Error(`Missing emitted production module evidence: ${root}`);
  }
  const violations = await verifyNativeProductionClosure(roots);
  if (violations.length)
    throw new Error(`#521 retirement is incomplete:\n${violations.join('\n')}`);
}

const require = createRequire(path.join(editorRoot, 'package.json'));
const electron = require('electron');
const temporaryHome = production
  ? await mkdtemp(path.join(os.tmpdir(), 'noveltea-522-cross-system-home-'))
  : null;
if (temporaryHome)
  await mkdir(path.join(temporaryHome, 'runtime'), { mode: 0o700, recursive: true });
const run = spawnSync(
  electron,
  [
    path.join(editorRoot, 'scripts/certify-native-authoring-cross-system-worker.cjs'),
    path.resolve(process.env.NOVELTEA_AUTHORING_NODE_ADDON),
    path.resolve(process.argv[2]),
    ...(production ? ['--production'] : []),
  ],
  {
    cwd: editorRoot,
    env: {
      ...(temporaryHome ? isolatedProductionEnvironment(process.env, temporaryHome) : process.env),
      ELECTRON_RUN_AS_NODE: '1',
    },
    encoding: 'utf8',
    timeout: 480_000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
if (run.error || run.status !== 0)
  throw new Error(
    `Cross-system native certification failed (status=${run.status}, signal=${run.signal ?? 'none'}, error=${run.error?.message ?? 'none'}):\n${run.stderr}\n${run.stdout}`,
    {
      cause: run.error,
    },
  );
console.log(run.stdout.trim());
