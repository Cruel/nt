import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyElectronWorkerResult } from './certify-native-authoring-electron-loader.mjs';

const success = 'Electron 43.1.1 native worker open/delta/patch/stale-revision passed.\n';

void test('requires a completed worker witness, not only a zero exit status', () => {
  assert.doesNotThrow(() => verifyElectronWorkerResult({ status: 0, stdout: success, stderr: '' }));
  assert.throws(
    () => verifyElectronWorkerResult({ status: 0, stdout: '', stderr: '' }),
    /did not report completion/,
  );
});

void test('rejects Windows native crashes even when a harness step otherwise reports success', () => {
  assert.throws(
    () =>
      verifyElectronWorkerResult({
        status: 4294930435,
        signal: null,
        stdout: '',
        stderr: 'crashpad_client_win.cc:867 not connected',
      }),
    /exited abnormally/,
  );
  assert.throws(
    () => verifyElectronWorkerResult({ status: null, signal: 'SIGABRT', stdout: '', stderr: '' }),
    /exited abnormally/,
  );
});
