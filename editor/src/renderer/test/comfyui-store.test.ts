import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import type { ComfyUiStatus } from '../../shared/comfyui';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(window.noveltea.checkComfyUiConnection).mockReset();
  vi.mocked(window.noveltea.getComfyUiQueue).mockReset();
  usePreferencesStore.setState({
    comfyUiConfig: {
      enabled: false,
      serverUrl: 'http://127.0.0.1:8000',
      defaultWorkflowId: 'flux2-klein-text-to-image',
      defaultWorkflows: {
        'image.generate': 'flux2-klein-text-to-image',
        'image.edit': 'flux2-klein-image-edit',
      },
      requestTimeoutMs: 15000,
      connectionCheckIntervalMs: 10000,
    },
  });
  useComfyUiStore.getState().hydrateFromPreferences();
});

describe('useComfyUiStore', () => {
  it('does not report checking unless a connection check is in flight', () => {
    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });
    useComfyUiStore.getState().hydrateFromPreferences();

    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'unchecked',
      message: 'ComfyUI enabled; connection has not been checked yet.',
    });
    expect(window.noveltea.checkComfyUiConnection).not.toHaveBeenCalled();
  });

  it('keeps the disabled status when an older connection check returns after ComfyUI is disabled', async () => {
    const connection = deferred<ComfyUiStatus>();
    vi.mocked(window.noveltea.checkComfyUiConnection).mockReturnValueOnce(connection.promise);

    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });
    useComfyUiStore.getState().hydrateFromPreferences();
    const inFlight = useComfyUiStore.getState().checkConnection();

    usePreferencesStore.getState().setComfyUiConfig({ enabled: false });
    useComfyUiStore.getState().hydrateFromPreferences();
    connection.resolve({
      state: 'error',
      serverUrl: 'http://127.0.0.1:8000',
      checkedAt: 'now',
      message: 'ComfyUI connection refused',
      queueRemaining: null,
    });
    await inFlight;

    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'disabled',
      message: 'ComfyUI disabled',
    });
  });

  it('ignores stale queue refresh results after ComfyUI is disabled', async () => {
    const queue = deferred<Awaited<ReturnType<typeof window.noveltea.getComfyUiQueue>>>();
    vi.mocked(window.noveltea.getComfyUiQueue).mockReturnValueOnce(queue.promise);

    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });
    useComfyUiStore.getState().hydrateFromPreferences();
    const inFlight = useComfyUiStore.getState().refreshQueue();

    usePreferencesStore.getState().setComfyUiConfig({ enabled: false });
    useComfyUiStore.getState().hydrateFromPreferences();
    queue.resolve({
      promptId: null,
      workflowId: null,
      state: 'queued',
      queueRemaining: 3,
      currentNode: null,
      progressValue: null,
      progressMax: null,
      message: '3 queued/running',
    });
    await inFlight;

    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'disabled',
      message: 'ComfyUI disabled',
      queueRemaining: null,
    });
    expect(useComfyUiStore.getState().progress).toMatchObject({
      state: 'idle',
      queueRemaining: null,
    });
  });
});
