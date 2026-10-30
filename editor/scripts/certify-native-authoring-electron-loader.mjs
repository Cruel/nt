import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(editorRoot, 'package.json'));
const success = /Electron \S+ native worker open\/delta\/patch\/stale-revision passed\./;

export function verifyElectronWorkerResult(result) {
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `Electron native worker exited abnormally: ${JSON.stringify({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    })}`,
  );
  assert.match(
    result.stdout,
    success,
    `Electron native worker did not report completion: ${result.stdout}\n${result.stderr}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    3,
    'Usage: certify-native-authoring-electron-loader.mjs <addon>',
  );
  const result = spawnSync(
    require('electron'),
    [
      path.join(editorRoot, 'scripts/certify-native-authoring-electron-worker.cjs'),
      path.resolve(process.argv[2]),
    ],
    {
      cwd: editorRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  verifyElectronWorkerResult(result);
  console.log(result.stdout.trim());
}
