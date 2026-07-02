import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnginePreview } from '@/components/engine-preview';
import { PRIMARY_PREVIEW_SESSION_ID } from '@/preview/preview-manager';
import { usePreviewManagerStore } from '@/preview/preview-manager-store';
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderConnectedPreview() {
  render(<EnginePreview />);
  const iframe = await screen.findByTitle('NovelTea engine preview') as HTMLIFrameElement;
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      origin: 'http://127.0.0.1:5000',
      data: { type: 'noveltea-preview-hello', version: 1, sessionToken: 'test-token' },
    }));
    ports[1]?.postMessage({ version: 1, type: 'ready', capabilities: [] });
  });
  await waitFor(() => expect(useWorkspaceStore.getState().previewConnectionState).toBe('ready'));
  return { iframe, editorPort: ports[0]!, previewPort: ports[1]! };
}

describe('EnginePreview', () => {
  it('activates the containing workbench group when the preview iframe receives click focus or child interaction', async () => {
    useWorkbenchStore.setState({
      layout: { kind: 'split', id: 'split', direction: 'horizontal', children: [{ kind: 'group', groupId: 'left' }, { kind: 'group', groupId: 'right' }], sizes: [50, 50] },
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

  it('demo coordinate input updates Zustand and sends a compatibility command', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    const input = screen.getByLabelText('Demo X') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '0.75');
    expect(useWorkspaceStore.getState().previewPosition.x).toBeCloseTo(0.75);
    expect(usePreviewManagerStore.getState().replay.primaryRuntime.position.x).toBeCloseTo(0.75);
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-demo-position',
      requestId: expect.any(String),
      position: { x: 0.75, y: 0.5 },
    });
  });

  it('runtime controls send runtime input commands', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByText('Continue'));
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'runtime-continue',
      requestId: expect.any(String),
    });
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

  it('reload cleanup closes the previous MessagePort', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByLabelText('Reload engine preview'));
    expect(editorPort.closed).toBe(true);
  });

  it('missing preview build displays the build instruction', async () => {
    vi.mocked(window.noveltea.getEnginePreviewSession).mockRejectedValueOnce(new Error('missing'));
    render(<EnginePreview />);
    expect(await screen.findByText('Engine preview build not found')).toBeInTheDocument();
    expect(screen.getByText('pnpm engine:preview:build')).toBeInTheDocument();
  });
});
