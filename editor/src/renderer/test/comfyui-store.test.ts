import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { useComfyUiStore } from '@/comfyui/comfyui-store';
import { invalidateComfyUiWorkflowVerification } from '@/comfyui/comfyui-workflow-library-store';
import { useProjectStore } from '@/project/project-store';
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
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockReset();
  vi.mocked(window.noveltea.verifyComfyUiWorkflowLibrary).mockReset();
  vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
    ok: true,
    success: true,
    diagnostics: [],
    entries: [],
    activeWorkflows: [],
    overriddenEntries: [],
    summary: { sources: [], totalCount: 0, activeCount: 0, overriddenCount: 0, invalidCount: 0, verifiedCount: 0, failedVerificationCount: 0 },
  });
  vi.mocked(window.noveltea.verifyComfyUiWorkflowLibrary).mockResolvedValue({ ok: true, success: true, checkedAt: 'now', verified: [], failed: [], skipped: [], entries: [], diagnostics: [] });
  invalidateComfyUiWorkflowVerification();
  useProjectStore.getState().clearProject();
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
  it('syncs enabled preference changes into the runtime status store', () => {
    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'disabled',
      message: 'ComfyUI disabled',
    });

    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });

    expect(useComfyUiStore.getState().config).toMatchObject({ enabled: true });
    expect(useComfyUiStore.getState().status).toMatchObject({
      state: 'unchecked',
      message: 'ComfyUI enabled; connection has not been checked yet.',
    });
  });

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

  it('verifies discovered workflows once when ComfyUI becomes ready', async () => {
    useProjectStore.getState().loadProjectDocument({ document: {}, projectPath: '/mock/project', projectFilePath: '/mock/project/game.json' });
    vi.mocked(window.noveltea.checkComfyUiConnection).mockResolvedValue({
      state: 'ready',
      serverUrl: 'http://127.0.0.1:8000',
      checkedAt: 'now',
      message: 'ComfyUI ready',
      queueRemaining: 0,
    });
    vi.mocked(window.noveltea.listComfyUiWorkflowLibrary).mockResolvedValue({
      ok: true,
      success: true,
      diagnostics: [],
      entries: [{
        source: 'built-in',
        workflowKey: 'built-in:base.manifest.json',
        id: 'base',
        label: 'Base',
        role: 'image.generate',
        manifestFile: 'base.manifest.json',
        workflowFile: 'base.workflow.json',
        manifestPath: '/mock/base.manifest.json',
        workflowPath: '/mock/base.workflow.json',
        packageHash: 'sha256:one',
        active: true,
        overridden: false,
        offlineStatus: 'valid',
        onlineStatus: 'unverified',
        repairable: false,
        diagnostics: [],
        verificationDiagnostics: [],
        capabilities: { canCopyToEditor: true, canCopyToProject: true, canDelete: false, canRepair: false, canReveal: false },
      }],
      activeWorkflows: [],
      overriddenEntries: [],
      summary: { sources: [], totalCount: 1, activeCount: 1, overriddenCount: 0, invalidCount: 0, verifiedCount: 0, failedVerificationCount: 0 },
    });

    usePreferencesStore.getState().setComfyUiConfig({ enabled: true });
    await useComfyUiStore.getState().checkConnection();
    await waitFor(() => expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledTimes(1));
    expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledWith(expect.objectContaining({ projectFilePath: '/mock/project/game.json' }));

    await useComfyUiStore.getState().checkConnection();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledTimes(1);

    invalidateComfyUiWorkflowVerification();
    await useComfyUiStore.getState().checkConnection();
    await waitFor(() => expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledTimes(2));
  });
});
