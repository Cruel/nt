import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AssetProfilerPollingController } from '@/asset-profiler/asset-profiler-controller';
import { useAssetProfilerStore } from '@/asset-profiler/asset-profiler-store';
import {
  assetProfilerDeltaPayload,
  assetProfilerEntry,
  assetProfilerFullPayload,
} from './fixtures/asset-profiler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  useAssetProfilerStore.getState().resetForEditorReload();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('asset profiler polling controller', () => {
  it('uses an immediate full request, exact visible and hidden cadence, and bigint delta cursors', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(assetProfilerFullPayload({ latestSequence: '9007199254740993' }))
      .mockResolvedValueOnce(
        assetProfilerDeltaPayload({
          afterSequence: '9007199254740993',
          latestSequence: '9007199254740994',
        }),
      )
      .mockResolvedValueOnce(
        assetProfilerDeltaPayload({
          afterSequence: '9007199254740994',
          latestSequence: '9007199254740995',
        }),
      );
    const controller = new AssetProfilerPollingController();
    controller.setPanelVisible(true);
    controller.setTransport({ key: 'preview-1', request, connected: true, supported: true });
    await flushPromises();

    expect(request).toHaveBeenNthCalledWith(1, undefined);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(request).toHaveBeenNthCalledWith(2, {
      sessionId: 1n,
      afterSequence: 9_007_199_254_740_993n,
    });

    controller.setPanelVisible(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(request).toHaveBeenNthCalledWith(3, {
      sessionId: 1n,
      afterSequence: 9_007_199_254_740_994n,
    });
    controller.dispose();
  });

  it('keeps one request in flight and rejects stale data after project replacement', async () => {
    const first = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const replacement = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(replacement.promise);
    const controller = new AssetProfilerPollingController();
    controller.setTransport({ key: 'preview-1', request, connected: true, supported: true });
    expect(request).toHaveBeenCalledTimes(1);

    controller.notifyProjectReplaced();
    expect(request).toHaveBeenCalledTimes(1);
    first.resolve(assetProfilerFullPayload({ sessionId: '1', latestSequence: '8' }));
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(undefined);
    expect(useAssetProfilerStore.getState().payload).toBeNull();

    replacement.resolve(assetProfilerFullPayload({ sessionId: '2', latestSequence: '1' }));
    await flushPromises();
    expect(useAssetProfilerStore.getState().payload?.sessionId).toBe(2n);
    controller.dispose();
  });

  it('queues an immediate full request for a replacement preview transport', async () => {
    const oldResponse = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const newResponse = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const oldRequest = vi.fn().mockReturnValue(oldResponse.promise);
    const newRequest = vi.fn().mockReturnValue(newResponse.promise);
    const controller = new AssetProfilerPollingController();
    controller.setTransport({
      key: 'preview-old',
      request: oldRequest,
      connected: true,
      supported: true,
    });

    controller.setTransport({
      key: 'preview-new',
      request: newRequest,
      connected: true,
      supported: true,
    });
    expect(newRequest).not.toHaveBeenCalled();

    oldResponse.resolve(assetProfilerFullPayload({ sessionId: '1' }));
    await flushPromises();
    expect(newRequest).toHaveBeenCalledOnce();
    expect(newRequest).toHaveBeenCalledWith(undefined);
    expect(useAssetProfilerStore.getState().payload).toBeNull();

    newResponse.resolve(assetProfilerFullPayload({ sessionId: '2' }));
    await flushPromises();
    expect(useAssetProfilerStore.getState().payload?.sessionId).toBe(2n);
    controller.dispose();
  });

  it('installs history-gap replacement data and immediately requests a full snapshot', async () => {
    const finalFull = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const replacementEntry = assetProfilerEntry('project:/gap-window.png');
    const request = vi
      .fn()
      .mockResolvedValueOnce(assetProfilerFullPayload())
      .mockResolvedValueOnce(
        assetProfilerDeltaPayload({
          afterSequence: '1',
          latestSequence: '8',
          replacementInventory: [replacementEntry],
          historyGap: true,
        }),
      )
      .mockReturnValueOnce(finalFull.promise);
    const controller = new AssetProfilerPollingController();
    controller.setTransport({ key: 'preview-1', request, connected: true, supported: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1000);
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith(undefined);
    expect(
      [...useAssetProfilerStore.getState().assetsByKey.values()][0]?.cacheKey.stableIdentity,
    ).toBe('project:/gap-window.png');
    expect(useAssetProfilerStore.getState().historyGapNotice).toBe(true);

    finalFull.resolve(assetProfilerFullPayload({ latestSequence: '9' }));
    await flushPromises();
    expect(useAssetProfilerStore.getState().historyGapNotice).toBe(true);
    controller.dispose();
  });

  it('retries a profiler-session mismatch once as an immediate full request', async () => {
    const full = deferred<ReturnType<typeof assetProfilerFullPayload>>();
    const mismatch = Object.assign(new Error('session mismatch'), {
      code: 'assets.editor_profiler_session_mismatch',
    });
    const request = vi.fn().mockRejectedValueOnce(mismatch).mockReturnValueOnce(full.promise);
    const controller = new AssetProfilerPollingController();
    controller.setTransport({ key: 'preview-1', request, connected: true, supported: true });
    await flushPromises();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, undefined);
    expect(request).toHaveBeenNthCalledWith(2, undefined);
    full.resolve(assetProfilerFullPayload());
    await flushPromises();
    controller.dispose();
  });

  it('stops polling after malformed or unsupported protocol data until preview recreation', async () => {
    const protocolError = Object.assign(new Error('unsupported schema'), {
      code: 'asset-profiler.unsupported-schema',
    });
    const request = vi.fn().mockRejectedValue(protocolError);
    const controller = new AssetProfilerPollingController();
    controller.setTransport({ key: 'preview-1', request, connected: true, supported: true });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(request).toHaveBeenCalledTimes(1);
    expect(useAssetProfilerStore.getState()).toMatchObject({
      status: 'error',
      error: 'unsupported schema',
    });

    controller.setTransport({ key: 'preview-2', request, connected: true, supported: true });
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
