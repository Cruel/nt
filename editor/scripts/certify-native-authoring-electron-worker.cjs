const assert = require('node:assert/strict');
const { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { shutdownNativeWorker } = require('./native-worker-certification-shutdown.cjs');

async function main() {
  const addon = path.resolve(process.argv[2]);
  const workerScript = path.resolve('dist-electron/authoring-worker/native-authoring-worker.cjs');
  const fixture = path.resolve('../tests/projects/feature-lab');
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-electron-native-'));
  let worker;
  try {
    for (const file of [
      'project.yaml',
      'traits.yaml',
      'editor.yaml',
      'i18n/project.yaml',
      'i18n/messages.yaml',
      'i18n/usage-notes.yaml',
      'i18n/tracking.yaml',
      'i18n/orphans.yaml',
      'records/rooms/room-lifecycle-roundtrip.yaml',
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await copyFile(path.join(fixture, file), path.join(root, file));
    }
    await mkdir(path.join(root, 'i18n/locales'), { recursive: true });
    await mkdir(path.join(root, 'i18n/assets'), { recursive: true });
    const messages = [];
    worker = new Worker(workerScript, {
      workerData: {
        addonPath: addon,
        root,
        sessionId: 'electron-host',
        generation: 1,
        pollIntervalMs: 100,
      },
    });
    worker.on('message', (message) => messages.push(message));
    const next = (predicate) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for native event: ${JSON.stringify(messages)}`));
        }, 15000);
        const receive = (message) => {
          if (message.type === 'failure') {
            cleanup();
            reject(new Error(message.error));
          } else if (predicate(message)) {
            cleanup();
            resolve(message);
          }
        };
        const died = (error) => {
          cleanup();
          reject(error);
        };
        const exited = (code) => died(new Error(`Worker exited before response: ${code}`));
        const cleanup = () => {
          clearTimeout(timeout);
          worker.off('message', receive);
          worker.off('error', died);
          worker.off('exit', exited);
        };
        worker.on('message', receive);
        worker.on('error', died);
        worker.on('exit', exited);
        for (const message of messages) receive(message);
      });
    const initial = await next((event) => event.type === 'snapshot');
    assert.equal(initial.snapshot.workingRevision, 0);
    assert.ok(initial.snapshot.inventory.includes('records/rooms/room-lifecycle-roundtrip.yaml'));
    const room = path.join(root, 'records/rooms/room-lifecycle-roundtrip.yaml');
    await writeFile(room, (await readFile(room, 'utf8')) + '\n# external change\n');
    const delta = await next(
      (event) =>
        event.type === 'delta' &&
        event.changedSourcePaths.includes('records/rooms/room-lifecycle-roundtrip.yaml'),
    );
    assert.match(
      delta.observation.revisions['records/rooms/room-lifecycle-roundtrip.yaml'],
      /^sha256:[0-9a-f]{64}$/,
    );
    worker.postMessage({
      operation: 'patch',
      requestId: 1,
      expectedRevision: 0,
      patches: [{ operation: 'replace', path: '/project/name', value: 'Electron worker edit' }],
    });
    const patch = await next((event) => event.type === 'response' && event.requestId === 1);
    assert.equal(patch.result.accepted, true);
    assert.equal(patch.result.snapshot.workingRevision, 1);
    worker.postMessage({
      operation: 'patch',
      requestId: 2,
      expectedRevision: 0,
      patches: [{ operation: 'replace', path: '/project/name', value: 'stale' }],
    });
    const stale = await next((event) => event.type === 'response' && event.requestId === 2);
    assert.equal(stale.result.accepted, false);
    assert.equal(stale.result.snapshot.workingRevision, 1);
    console.log(
      `Electron ${process.versions.electron} native worker open/delta/patch/stale-revision passed.`,
    );
  } finally {
    if (worker) await shutdownNativeWorker(worker);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
