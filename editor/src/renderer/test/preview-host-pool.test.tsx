import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { PreviewHostPoolProvider, PreviewPane, type PreviewHostLease } from '@/preview/preview-host-pool';

const previewControllerMocks = vi.hoisted(() => ({
  setPreviewActivity: vi.fn().mockResolvedValue(undefined),
  requestPreviewState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: () => ({
    iframeRef: { current: null },
    iframeKey: 0,
    iframeSrc: 'http://127.0.0.1:5000/?sessionToken=test-token',
    session: {
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    },
    loadSession: vi.fn().mockResolvedValue({
      url: 'http://127.0.0.1:5000/?sessionToken=test-token',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'test-token',
    }),
    setPreviewActivity: previewControllerMocks.setPreviewActivity,
    requestPreviewState: previewControllerMocks.requestPreviewState,
  }),
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({ iframeSrc }: { iframeSrc: string | null }) => (
    <iframe title="NovelTea engine preview" src={iframeSrc ?? undefined} />
  ),
}));

interface HarnessPane {
  ownerTabId: string;
  paneId: string;
  onLease?: (lease: PreviewHostLease | null) => void;
}

function Harness({
  activeTabId,
  panes,
}: {
  activeTabId: string | null;
  panes: HarnessPane[];
}) {
  return (
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <PreviewHostPoolProvider groupId="group:one" activeTabId={activeTabId}>
        {panes.map((pane) => (
          <PreviewPane
            key={`${pane.ownerTabId}:${pane.paneId}`}
            ownerTabId={pane.ownerTabId}
            paneId={pane.paneId}
            mode="room"
            className="h-48 w-64"
            onLease={pane.onLease}
          >
            <div>{pane.paneId}</div>
          </PreviewPane>
        ))}
      </PreviewHostPoolProvider>
    </div>
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

beforeEach(() => {
  previewControllerMocks.setPreviewActivity.mockClear();
  previewControllerMocks.requestPreviewState.mockClear();
  vi.mocked(window.noveltea.getEnginePreviewSession).mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  });
});

describe('PreviewHostPool', () => {
  it('lazily creates one host for the first active preview pane', async () => {
    const { container } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);

    await waitFor(() => expect(hostElements(container)).toHaveLength(1));

    const [host] = hostElements(container);
    expect(host).toHaveAttribute('data-preview-host-id', 'preview-host:group:one:1');
    expect(host).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(host).toHaveAttribute('data-preview-host-pane-id', 'main');
    expect(screen.getByTitle('NovelTea engine preview')).toBeInTheDocument();
  });

  it('creates additional hosts lazily for simultaneous pane ids', async () => {
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          { ownerTabId: 'tab:a', paneId: 'main' },
          { ownerTabId: 'tab:a', paneId: 'compare' },
        ]}
      />,
    );

    await waitFor(() => expect(hostElements(container)).toHaveLength(2));

    expect(hostElements(container).map((host) => host.dataset.previewHostId)).toEqual([
      'preview-host:group:one:1',
      'preview-host:group:one:2',
    ]);
  });

  it('releases inactive panes while keeping warm hosts for reuse', async () => {
    const { container, rerender } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    const firstHostId = hostElements(container)[0]?.dataset.previewHostId;

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() => expect(hostElements(container)[0]).not.toHaveAttribute('data-preview-host-claimed'));
    expect(hostElements(container)).toHaveLength(1);

    rerender(<Harness activeTabId="tab:b" panes={[{ ownerTabId: 'tab:b', paneId: 'main' }]} />);
    await waitFor(() => expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-claimed', 'true'));
    expect(hostElements(container)).toHaveLength(1);
    expect(hostElements(container)[0]?.dataset.previewHostId).toBe(firstHostId);
  });

  it('sends inactive activity when a pooled host is released', async () => {
    const { rerender } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() => expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true));

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);

    await waitFor(() => expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(false, false));
  });

  it('sends active activity and requests preview state when a warm pooled host becomes visible again', async () => {
    const { rerender } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() => expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true));

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() => expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(false, false));
    previewControllerMocks.setPreviewActivity.mockClear();
    previewControllerMocks.requestPreviewState.mockClear();

    rerender(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);

    await waitFor(() => expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true));
    await waitFor(() => expect(previewControllerMocks.requestPreviewState).toHaveBeenCalled());
  });

  it('rejects sends from stale leases after release', async () => {
    let lease: PreviewHostLease | null = null;
    const { rerender } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main', onLease: (next) => { lease = next; } }]} />);
    await waitFor(() => expect(lease).not.toBeNull());
    const staleLease = lease!;

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main', onLease: (next) => { lease = next; } }]} />);
    await waitFor(() => expect(lease).toBeNull());

    await expect(staleLease.send(async () => undefined)).rejects.toThrow('Preview host lease is no longer current.');
  });

  it('cancels pending commands when a lease is released', async () => {
    let lease: PreviewHostLease | null = null;
    let resolveCommand: ((value: string) => void) | null = null;
    const { rerender } = render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main', onLease: (next) => { lease = next; } }]} />);
    await waitFor(() => expect(lease).not.toBeNull());

    const pending = lease!.send(() => new Promise<string>((resolve) => {
      resolveCommand = resolve;
    }));
    const pendingExpectation = expect(pending).rejects.toThrow('Preview host command was cancelled because the lease was released.');

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main', onLease: (next) => { lease = next; } }]} />);
    await waitFor(() => expect(lease).toBeNull());

    await act(async () => {
      resolveCommand?.('done');
    });

    await pendingExpectation;
  });
});
