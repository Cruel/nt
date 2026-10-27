// Test/qualification teardown must let the native addon finish its current
// synchronous operation and close its Project authority before removing files.
// Worker.terminate() can interrupt native execution and leak Windows handles.
async function shutdownNativeWorker(worker) {
  if (worker.threadId === -1) return;
  await new Promise((resolve, reject) => {
    let completed = false;
    let failure = null;
    const finish = (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(watchdog);
      worker.off('exit', exited);
      worker.off('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const exited = (code) => {
      if (code !== 0) failure ??= new Error(`Native certification worker exited (${code}).`);
      finish(failure);
    };
    // Even if the worker reports an error, wait for actual exit before the
    // caller deletes the native Project's files.
    const failed = (error) => {
      failure = error;
    };
    const terminate = () => {
      void worker.terminate().then(
        () => finish(failure),
        () => finish(failure),
      );
    };
    // This is a deadlock watchdog, not a delay or a substitute for shutdown
    // acknowledgement. A hung worker makes certification fail explicitly.
    const watchdog = setTimeout(() => {
      // A hung worker is a failed certification. Terminate only on watchdog
      // expiry so it cannot keep the CI process alive after the failure.
      const stalled = new Error('Native certification worker did not exit after shutdown.');
      failure ??= stalled;
      terminate();
    }, 60_000);
    worker.on('exit', exited);
    worker.on('error', failed);
    try {
      worker.postMessage({ type: 'shutdown' });
    } catch (error) {
      failure = error;
      terminate();
    }
  });
}

module.exports = { shutdownNativeWorker };
