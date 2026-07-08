import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnginePreview } from '@/components/engine-preview';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';

class FakePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  sent: unknown[] = [];
  peer: FakePort | null = null;
  postMessage(message: unknown) {
    this.sent.push(message);
    this.peer?.onmessage?.({ data: message } as MessageEvent);
  }
  start() {}
  close() {
    this.closed = true;
  }
}

const ports: FakePort[] = [];

beforeEach(() => {
  ports.length = 0;
  vi.stubGlobal('MessageChannel', class {
    port1 = new FakePort();
    port2 = new FakePort();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
      ports.push(this.port1, this.port2);
    }
  });
  usePreviewManagerStore.getState().resetPreviewManager();
  useWorkbenchStore.getState().resetWorkbench();
    useWorkspaceStore.setState({
      previewPosition: { x: 0.5, y: 0.5 },
      previewRunning: true,
    previewConnectionState: 'disconnected',
    selectedRuntimeObjectId: null,
      lastPreviewEvent: null,
      statusMessage: 'Preview disconnected',
    });
    usePreferencesStore.setState({ showPreviewFpsCounter: false });
  vi.mocked(window.noveltea.getEnginePreviewSession).mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  });
  vi.mocked(window.noveltea.reloadEnginePreview).mockResolvedValue({
    url: 'http://127.0.0.1:5001/?sessionToken=test-token-2',
    origin: 'http://127.0.0.1:5001',
    sessionToken: 'test-token-2',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderConnectedPreview() {
  render(<EnginePreview />);
  const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
  await waitFor(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'http://127.0.0.1:5000',
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
    }));
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });
  const editorPort = ports.at(-2)!;
  const previewPort = ports.at(-1)!;
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'ready', capabilities: [] });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { iframe, editorPort, previewPort };
}

function latestRequest(editorPort: FakePort, type: string) {
  return [...editorPort.sent].reverse().find((message) => (message as { type?: string }).type === type) as { requestId: string } | undefined;
}

async function resolveLatest(editorPort: FakePort, previewPort: FakePort, type: string) {
  const request = latestRequest(editorPort, type);
  expect(request).toBeDefined();
  await act(async () => {
    previewPort.postMessage({ version: 1, type: 'command-result', requestId: request!.requestId, ok: true });
  });
}

describe('EnginePreview', () => {
  it('renders the lower-level iframe host without preview-manager wrapper state', () => {
    const iframeRef = { current: null };
    render(
      <EnginePreviewHost
        iframeRef={iframeRef}
        iframeKey={0}
        iframeSrc="http://localhost:4173/widget.html"
        embedded={true}
        connectionState="loading"
        className="absolute inset-0"
        iframeClassName="size-full border-0"
        showConnectionOverlay={false}
        onActivateContainingGroup={() => undefined}
        onConnecting={() => undefined}
        onError={() => undefined}
      />,
    );

    expect(screen.getByTitle('NovelTea engine preview')).toHaveAttribute('src', 'http://localhost:4173/widget.html');
    expect(screen.queryByText('loading')).not.toBeInTheDocument();
    expect(usePreviewManagerStore.getState().sessionsById).toEqual({});
  });

  it('loads a preview session into an iframe src', async () => {
    render(<EnginePreview />);
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    expect(iframe.src).toBe('http://127.0.0.1:5000/?sessionToken=test-token');
    expect(window.noveltea.getEnginePreviewSession).toHaveBeenCalledTimes(1);
  });

  it('activates the containing workbench group when the preview iframe receives click focus or child interaction', async () => {
    useWorkbenchStore.setState({
      layout: { kind: 'split', id: 'split', direction: 'horizontal', children: [{ kind: 'group', groupId: 'left' }, { kind: 'group', groupId: 'right' }], sizesByChild: { 'group:left': 50, 'group:right': 50 } },
      groupsById: {
        left: { id: 'left', tabIds: ['tab:left'], activeTabId: 'tab:left' },
        right: { id: 'right', tabIds: ['tab:right'], activeTabId: 'tab:right' },
      },
      tabsById: {
        'tab:left': { id: 'tab:left', title: 'Left', editorType: 'raw-json', resource: { kind: 'raw', stableId: 'left' } },
        'tab:right': { id: 'tab:right', title: 'Right', editorType: 'engine-preview', resource: { kind: 'preview', stableId: 'preview:right' } },
      },
      activeGroupId: 'left',
      recentlyClosedTabs: [],
    });
    render(<div data-workbench-group-id="right"><EnginePreview /></div>);
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    act(() => iframe.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    await waitFor(() => expect(useWorkbenchStore.getState().activeGroupId).toBe('right'));
    useWorkbenchStore.setState({ activeGroupId: 'left' });
    act(() => iframe.focus());
    await waitFor(() => expect(useWorkbenchStore.getState().activeGroupId).toBe('right'));
    useWorkbenchStore.setState({ activeGroupId: 'left' });
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      ports[1]?.postMessage({ version: 1, type: 'ready', capabilities: [] });
      ports[1]?.postMessage({ version: 1, type: 'preview-interacted', interaction: 'pointer' });
    });
    await waitFor(() => expect(useWorkbenchStore.getState().activeGroupId).toBe('right'));
  });

  it('replays editor position when ready', async () => {
    useWorkspaceStore.setState({ previewPosition: { x: 0.25, y: 0.75 } });
    const { editorPort } = await renderConnectedPreview();
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-demo-position',
      requestId: expect.any(String),
      position: { x: 0.25, y: 0.75 },
    });
    expect(usePreviewManagerStore.getState().sessionsById[PRIMARY_PREVIEW_SESSION_ID]).toMatchObject({
      kind: 'primary-runtime',
      status: 'ready',
    });
  });

  it('updates capabilities from ready and capabilities messages', async () => {
    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'capabilities', capabilities: ['runtime-debug', 'snapshots'] });
    });
    expect(usePreviewManagerStore.getState().sessionsById[PRIMARY_PREVIEW_SESSION_ID]).toMatchObject({
      status: 'ready',
      capabilities: ['runtime-debug', 'snapshots'],
    });
  });

  it('resolves command request and response messages for controls', async () => {
    const user = userEvent.setup();
    render(
      <EnginePreview
        renderControls={({ controller }) => (
          <button type="button" onClick={() => void controller.requestState().then(() => useWorkspaceStore.getState().setStatusMessage('request resolved'))}>
            Request state
          </button>
        )}
      />,
    );
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      ports.at(-1)?.postMessage({ version: 1, type: 'ready', capabilities: [] });
    });
    await user.click(screen.getByText('Request state'));
    const editorPort = ports.at(-2)!;
    const request = editorPort.sent.find((message) => (message as { type?: string }).type === 'request-state') as { requestId: string } | undefined;
    expect(request).toBeDefined();
    await act(async () => {
      ports.at(-1)?.postMessage({ version: 1, type: 'command-result', requestId: request!.requestId, ok: true });
    });
    await waitFor(() => expect(useWorkspaceStore.getState().statusMessage).toBe('request resolved'));
  });

  it('records timed out command requests as transport errors', async () => {
    render(
      <EnginePreview
        renderControls={({ controller, sendRuntimeCommand }) => (
          <button type="button" onClick={() => sendRuntimeCommand(controller.requestState(), 'Requested state')}>
            Request state
          </button>
        )}
      />,
    );
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      ports.at(-1)?.postMessage({ version: 1, type: 'ready', capabilities: [] });
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByText('Request state'));
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(useWorkspaceStore.getState().statusMessage).toBe('Preview command timed out: request-state'));
  });

  it('reloads the iframe session and closes the previous transport port', async () => {
    const user = userEvent.setup();
    render(
      <EnginePreview
        renderControls={({ reload }) => (
          <button type="button" onClick={reload}>
            Reload preview
          </button>
        )}
      />,
    );
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      ports.at(-1)?.postMessage({ version: 1, type: 'ready', capabilities: [] });
    });
    const editorPort = ports.at(-2)!;
    await user.click(await screen.findByText('Reload preview'));
    await waitFor(() => expect(window.noveltea.reloadEnginePreview).toHaveBeenCalled());
    expect(editorPort.closed).toBe(true);
    await waitFor(() => expect((screen.getByTitle('NovelTea engine preview') as HTMLIFrameElement).src).toBe('http://127.0.0.1:5001/?sessionToken=test-token-2'));
  });

  it('minimal embedded previews load preview documents with embedded iframe params', async () => {
    const previewDocument = {
      kind: 'room-preview' as const,
      recordId: 'foyer',
      revision: 'rev-1',
      data: { label: 'Foyer' },
    };
    render(<EnginePreview chrome="minimal" previewMode="room" previewDocument={previewDocument} />);
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    expect(iframe.src).toContain('sessionToken=test-token');
    expect(iframe.src).toContain('demo=none');
    expect(iframe.src).toContain('noImgui=1');
    expect(iframe.src).toContain('maxDpr=1');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      ports.at(-1)?.postMessage({ version: 1, type: 'ready', capabilities: [] });
    });
    const editorPort = ports.at(-2)!;
    await waitFor(() => expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-mode',
      requestId: expect.any(String),
      mode: 'room',
    }));
    const modeRequest = editorPort.sent.find((message) => (message as { type?: string }).type === 'set-preview-mode') as { requestId: string };
    await act(async () => {
      ports.at(-1)?.postMessage({ version: 1, type: 'command-result', requestId: modeRequest.requestId, ok: true });
    });
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'load-preview-document',
      requestId: expect.any(String),
      document: previewDocument,
    });
  });

  it('keeps ad-hoc runtime controls out of the generic preview chrome', async () => {
    await renderConnectedPreview();
    expect(screen.queryByLabelText('Start runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('Continue')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cap')).not.toBeInTheDocument();
  });

  it('sends engine FPS settings from editor preferences', async () => {
    usePreferencesStore.setState({ showPreviewFpsCounter: true });
    const { editorPort } = await renderConnectedPreview();
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-engine-settings',
      requestId: expect.any(String),
      settings: { showFpsCounter: true, fpsCap: 0 },
    });
  });

  it('sends preview activity and requests a safe refresh when a dedicated preview becomes visible', async () => {
    const view = render(
      <div data-workbench-editor-pane="tab:preview" data-hidden="true" aria-hidden="true">
        <EnginePreview previewActivityRefreshOnVisible="preview-state" />
      </div>,
    );
    const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
    await waitFor(() => {
      window.dispatchEvent(new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://127.0.0.1:5000',
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
      }));
      expect(ports.length).toBeGreaterThanOrEqual(2);
    });
    const editorPort = ports.at(-2)!;
    const previewPort = ports.at(-1)!;
    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'ready', capabilities: [] });
    });
    await waitFor(() => expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-activity',
      requestId: expect.any(String),
      active: false,
      visible: false,
    }));

    view.rerender(
      <div data-workbench-editor-pane="tab:preview">
        <EnginePreview previewActivityRefreshOnVisible="preview-state" />
      </div>,
    );

    await waitFor(() => expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-preview-activity',
      requestId: expect.any(String),
      active: true,
      visible: true,
    }));
    await resolveLatest(editorPort, previewPort, 'set-preview-activity');
    await waitFor(() => expect(latestRequest(editorPort, 'request-preview-state')).toBeDefined());
    expect(editorPort.sent.filter((message) => ['runtime-stop', 'runtime-reset', 'stop'].includes(String((message as { type?: string }).type)))).toEqual([]);
  });

  it('object-clicked updates selected runtime object and status', async () => {
    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'object-clicked',
        objectId: 'demo-triangle',
        position: { x: 0.5, y: 0.5 },
        pointerPosition: { x: 0.4, y: 0.6 },
      });
    });
    expect(useWorkspaceStore.getState().selectedRuntimeObjectId).toBe('demo-triangle');
    expect(useWorkspaceStore.getState().statusMessage).toBe('Selected demo-triangle from engine preview');
  });

  it('runtime errors are recorded as preview diagnostics', async () => {
    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({ version: 1, type: 'runtime-error', message: 'preview failed' });
    });
    const diagnostics = usePreviewManagerStore.getState().diagnosticOrder.map((id) => usePreviewManagerStore.getState().diagnosticsById[id]);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', source: 'runtime', message: 'preview failed' });
  });

  it('preview diagnostics are recorded from preview messages', async () => {
    const { previewPort } = await renderConnectedPreview();
    await act(async () => {
      previewPort.postMessage({
        version: 1,
        type: 'preview-diagnostic',
        diagnostic: { severity: 'warning', message: 'layout fallback used', path: 'rooms.foyer' },
      });
    });
    const diagnostics = usePreviewManagerStore.getState().diagnosticOrder.map((id) => usePreviewManagerStore.getState().diagnosticsById[id]);
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', source: 'runtime', message: 'layout fallback used', path: 'rooms.foyer' });
  });

  it('missing preview build displays the build instruction', async () => {
    vi.mocked(window.noveltea.getEnginePreviewSession).mockRejectedValueOnce(new Error('missing'));
    render(<EnginePreview />);
    expect(await screen.findByText('Engine preview build not found')).toBeInTheDocument();
    expect(screen.getByText('pnpm engine:preview:build')).toBeInTheDocument();
  });
});
