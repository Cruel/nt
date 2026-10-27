import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { shutdownNativeWorker } = require(
  '../../editor/scripts/native-worker-certification-shutdown.cjs',
);

class WorkerDouble extends EventEmitter {
  threadId = 1;
  messages = [];
  forced = false;

  postMessage(value) {
    this.messages.push(value);
  }

  terminate() {
    this.forced = true;
    return Promise.resolve(1);
  }
}

test('certification teardown waits for cooperative native close before cleanup', async () => {
  const worker = new WorkerDouble();
  let finished = false;
  const teardown = shutdownNativeWorker(worker).then(() => {
    finished = true;
  });
  assert.deepEqual(worker.messages, [{ type: 'shutdown' }]);
  await Promise.resolve();
  assert.equal(finished, false, 'Shutdown must not resolve merely because it was requested.');
  assert.equal(worker.forced, false);
  worker.threadId = -1;
  worker.emit('exit', 0);
  await teardown;
  assert.equal(finished, true);
  assert.equal(worker.forced, false);
});

test('certification teardown rejects crashed native workers and skips those already exited', async () => {
  const crashed = new WorkerDouble();
  const teardown = shutdownNativeWorker(crashed);
  crashed.emit('error', new Error('native addon failed'));
  assert.equal(
    crashed.listenerCount('exit'),
    1,
    'A reported worker error must not release native source files before exit.',
  );
  crashed.threadId = -1;
  crashed.emit('exit', 1);
  await assert.rejects(teardown, /native addon failed/);
  await shutdownNativeWorker(crashed);
  assert.equal(crashed.messages.length, 1);
});
