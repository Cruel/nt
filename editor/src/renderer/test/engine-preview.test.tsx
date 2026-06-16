import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnginePreview } from '@/components/engine-preview';
import { useWorkspaceStore } from '@/stores/workspace-store';

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
  it('replays editor position when ready', async () => {
    useWorkspaceStore.setState({ previewPosition: { x: 0.25, y: 0.75 } });
    const { editorPort } = await renderConnectedPreview();
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-demo-position',
      requestId: expect.any(String),
      position: { x: 0.25, y: 0.75 },
    });
  });

  it('movement control updates Zustand and sends a command', async () => {
    const user = userEvent.setup();
    const { editorPort } = await renderConnectedPreview();
    await user.click(screen.getByText('Right'));
    expect(useWorkspaceStore.getState().previewPosition.x).toBeCloseTo(0.55);
    expect(editorPort.sent).toContainEqual({
      version: 1,
      type: 'set-demo-position',
      requestId: expect.any(String),
      position: { x: 0.55, y: 0.5 },
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
