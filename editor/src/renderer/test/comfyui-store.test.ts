import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import type { ComfyUiStatus } from '../../shared/comfyui';

function enabledProject() {
  const project = createAuthoringProject();
  project.settings.comfyui = {
    ...projectSettingsFromProject(project).comfyui,
    enabled: true,
    serverUrl: 'http://127.0.0.1:8000',
  };
  return project;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(window.noveltea.checkComfyUiConnection).mockReset();
  vi.mocked(window.noveltea.getComfyUiQueue).mockReset();
  useComfyUiStore.getState().hydrateFromProject(null);
});

describe('useComfyUiStore', () => {
  it('keeps the disabled status when an older connection check returns after ComfyUI is disabled', async () => {
    const connection = deferred<ComfyUiStatus>();
    vi.mocked(window.noveltea.checkComfyUiConnection).mockReturnValueOnce(connection.promise);

    useComfyUiStore.getState().hydrateFromProject(enabledProject());
    const inFlight = useComfyUiStore.getState().checkConnection();

    useComfyUiStore.getState().hydrateFromProject(null);
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

    useComfyUiStore.getState().hydrateFromProject(enabledProject());
    const inFlight = useComfyUiStore.getState().refreshQueue();

    useComfyUiStore.getState().hydrateFromProject(null);
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
