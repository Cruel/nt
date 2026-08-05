import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PreviewHostPoolBridge,
  PreviewHostPoolProvider,
  PreviewPane,
  usePreviewHostPool,
  type PreviewHostLease,
  type PreviewHostPoolApi,
  type PreviewPanePolicy,
} from '@/preview/preview-host-pool';
import { usePreferencesStore } from '@/stores/preferences-store';
import type { PreviewToEditorMessage } from '../../shared/preview-protocol';
import type { PreviewWheelPolicy } from '../../shared/preview-wheel-routing';

const previewControllerMocks = vi.hoisted(() => ({
  setEngineSettings: vi.fn().mockResolvedValue(undefined),
  setPreviewActivity: vi.fn().mockResolvedValue(undefined),
  setPreviewWheelRouting: vi.fn().mockResolvedValue(undefined),
  requestPreviewState: vi.fn().mockResolvedValue(undefined),
  onMessages: [] as Array<(message: PreviewToEditorMessage) => void>,
  onReadies: [] as Array<() => void>,
  audioEnabledOptions: [] as Array<boolean | undefined>,
  autoReady: true,
}));

vi.mock('@/hooks/use-engine-preview', () => ({
  useEnginePreview: (options: {
    onMessage: (message: PreviewToEditorMessage) => void;
    onReady?: () => void;
    audioEnabled?: boolean;
  }) => {
    previewControllerMocks.audioEnabledOptions.push(options.audioEnabled);
    previewControllerMocks.onMessages.push(options.onMessage);
    if (options.onReady) {
      const emitReady = () => {
        options.onReady?.();
        options.onMessage({
          version: 1,
          type: 'ready',
          capabilities: [],
          hostGeneration: 1,
          transportGeneration: 1,
          activeShaderVariant: 'glsl-120',
        });
      };
      previewControllerMocks.onReadies.push(emitReady);
      if (previewControllerMocks.autoReady) queueMicrotask(emitReady);
    }
    return {
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
      setEngineSettings: previewControllerMocks.setEngineSettings,
      setPreviewActivity: previewControllerMocks.setPreviewActivity,
      setPreviewWheelRouting: previewControllerMocks.setPreviewWheelRouting,
      requestPreviewState: previewControllerMocks.requestPreviewState,
    };
  },
}));

vi.mock('@/components/engine-preview-host', () => ({
  EnginePreviewHost: ({
    iframeSrc,
    onActivateContainingGroup,
  }: {
    iframeSrc: string | null;
    onActivateContainingGroup: () => void;
  }) => (
    <iframe
      title="NovelTea engine preview"
      src={iframeSrc ?? undefined}
      onPointerDown={onActivateContainingGroup}
      onFocus={onActivateContainingGroup}
    />
  ),
}));

interface HarnessPane {
  ownerTabId: string;
  paneId: string;
  revealOnLease?: boolean;
  policy?: PreviewPanePolicy;
  wheelPolicy?: PreviewWheelPolicy;
  onLease?: (lease: PreviewHostLease | null) => void;
}

function Harness({
  activeTabId,
  panes,
  onActivateOwnerTab,
  pointerEventsDisabled,
  retainedOwnerTabIds,
}: {
  activeTabId: string | null;
  panes: HarnessPane[];
  onActivateOwnerTab?: (ownerTabId: string) => void;
  pointerEventsDisabled?: boolean;
  retainedOwnerTabIds?: readonly string[];
}) {
  return (
    <div
      data-workbench-group-id="group:one"
      style={{ position: 'relative', width: 800, height: 600, overflowY: 'auto' }}
    >
      <PreviewHostPoolProvider
        groupId="group:one"
        activeTabId={activeTabId}
        onActivateOwnerTab={onActivateOwnerTab}
        pointerEventsDisabled={pointerEventsDisabled}
        retainedOwnerTabIds={retainedOwnerTabIds}
      >
        {panes.map((pane) => (
          <PreviewPane
            key={`${pane.ownerTabId}:${pane.paneId}`}
            ownerTabId={pane.ownerTabId}
            paneId={pane.paneId}
            policy={pane.policy}
            mode="room"
            wheelPolicy={pane.wheelPolicy}
            className="h-48 w-64"
            onLease={(lease) => {
              if (lease && pane.revealOnLease) lease.reveal();
              pane.onLease?.(lease);
            }}
          >
            <div>{pane.paneId}</div>
          </PreviewPane>
        ))}
      </PreviewHostPoolProvider>
    </div>
  );
}

function PreviewHostPoolCapture({ onPool }: { onPool: (pool: PreviewHostPoolApi) => void }) {
  const pool = usePreviewHostPool();
  useLayoutEffect(() => onPool(pool), [onPool, pool]);
  return null;
}

function MountedProbe({ onMount, onUnmount }: { onMount: () => void; onUnmount: () => void }) {
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return <div data-testid="bridged-preview-probe" />;
}

function BridgeAvailabilityHarness({
  available,
  onLease,
  onProbeMount,
  onProbeUnmount,
}: {
  available: boolean;
  onLease: (lease: PreviewHostLease | null) => void;
  onProbeMount: () => void;
  onProbeUnmount: () => void;
}) {
  const [pool, setPool] = useState<PreviewHostPoolApi | null>(null);

  return (
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <PreviewHostPoolProvider groupId="group:bridge" activeTabId="tab:bridge">
        <PreviewHostPoolCapture onPool={setPool} />
      </PreviewHostPoolProvider>
      <PreviewHostPoolBridge pool={available ? pool : null}>
        <PreviewPane ownerTabId="tab:bridge" paneId="main" mode="room" onLease={onLease}>
          <MountedProbe onMount={onProbeMount} onUnmount={onProbeUnmount} />
        </PreviewPane>
      </PreviewHostPoolBridge>
    </div>
  );
}

function hostElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-host-id]')];
}

function testRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  usePreferencesStore.setState({
    showPreviewFpsCounter: false,
    previewFpsCap: 0,
    previewRmlUiRasterSnap: 'all',
  });
  previewControllerMocks.setPreviewActivity.mockClear();
  previewControllerMocks.setEngineSettings.mockClear();
  previewControllerMocks.setPreviewWheelRouting.mockClear();
  previewControllerMocks.requestPreviewState.mockClear();
  previewControllerMocks.onMessages = [];
  previewControllerMocks.onReadies = [];
  previewControllerMocks.audioEnabledOptions = [];
  previewControllerMocks.autoReady = true;
  vi.mocked(window.noveltea.getEnginePreviewSession).mockResolvedValue({
    url: 'http://127.0.0.1:5000/?sessionToken=test-token',
    origin: 'http://127.0.0.1:5000',
    sessionToken: 'test-token',
  });
});

describe('PreviewHostPool', () => {
  it('applies live editor preview rendering settings to pooled hosts', async () => {
    render(<Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);

    await waitFor(() =>
      expect(previewControllerMocks.setEngineSettings).toHaveBeenCalledWith({
        showFpsCounter: false,
        fpsCap: 0,
        rmluiRasterSnap: 'all',
      }),
    );

    act(() => {
      usePreferencesStore.getState().setPreviewFpsCap(1);
      usePreferencesStore.getState().setPreviewRmlUiRasterSnap('none');
    });

    await waitFor(() =>
      expect(previewControllerMocks.setEngineSettings).toHaveBeenLastCalledWith({
        showFpsCounter: false,
        fpsCap: 1,
        rmluiRasterSnap: 'none',
      }),
    );
  });

  it('does not allocate an orphan host when StrictMode replays the pane lease effect', async () => {
    const { container } = render(
      <StrictMode>
        <Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />
      </StrictMode>,
    );

    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(hostElements(container)[0]).toHaveAttribute(
      'data-preview-host-id',
      'preview-host:group:one:1',
    );
    expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(previewControllerMocks.audioEnabledOptions.length).toBeGreaterThan(0);
    expect(new Set(previewControllerMocks.audioEnabledOptions)).toEqual(new Set([false]));
  });

  it('lazily creates one host for the first active preview pane', async () => {
    const { container } = render(
      <Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />,
    );

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

  it('retains a dedicated iframe across tab switches and destroys it when the tab closes', async () => {
    const dedicatedPanes: HarnessPane[] = [
      {
        ownerTabId: 'tab:a',
        paneId: 'main',
        policy: 'dedicated-while-open',
        revealOnLease: true,
      },
      {
        ownerTabId: 'tab:b',
        paneId: 'main',
        policy: 'dedicated-while-open',
        revealOnLease: true,
      },
    ];
    const { container, rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={dedicatedPanes}
        retainedOwnerTabIds={['tab:a', 'tab:b']}
      />,
    );

    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    const hostA = hostElements(container)[0]!;
    const iframeA = hostA.querySelector('iframe');
    const layer = container.querySelector<HTMLElement>('[data-preview-host-layer="group:one"]')!;
    const paneA = container.querySelector<HTMLElement>('[data-preview-pane-owner-tab-id="tab:a"]')!;
    vi.spyOn(layer, 'getBoundingClientRect').mockImplementation(() => testRect(0, 0, 800, 600));
    vi.spyOn(paneA, 'getBoundingClientRect').mockImplementation(() => testRect(12, 20, 320, 180));
    fireEvent(window, new Event('resize'));
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    await waitFor(() => expect(hostA).toHaveStyle({ width: '320px', height: '180px' }));
    expect(hostA).toHaveAttribute('data-preview-host-policy', 'dedicated-while-open');
    expect(hostA).toHaveAttribute('data-preview-host-owner-tab-id', 'tab:a');

    rerender(
      <Harness
        activeTabId="tab:b"
        panes={dedicatedPanes}
        retainedOwnerTabIds={['tab:a', 'tab:b']}
      />,
    );

    await waitFor(() => expect(hostElements(container)).toHaveLength(2));
    expect(hostA).not.toHaveAttribute('data-preview-host-claimed');
    expect(hostA).toHaveAttribute('aria-hidden', 'true');
    expect(hostA).toHaveAttribute('data-preview-host-placement', 'retained-offscreen');
    expect(hostA).toHaveStyle({
      left: '-100000px',
      top: '-100000px',
      width: '320px',
      height: '180px',
      opacity: '0',
    });
    expect(hostA.querySelector('iframe')).toBe(iframeA);
    expect(
      hostElements(container).find((host) => host.dataset.previewHostOwnerTabId === 'tab:b'),
    ).toHaveAttribute('data-preview-host-claimed', 'true');
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(false, false),
    );

    rerender(
      <Harness
        activeTabId="tab:a"
        panes={dedicatedPanes}
        retainedOwnerTabIds={['tab:a', 'tab:b']}
      />,
    );
    await waitFor(() => expect(hostA).toHaveAttribute('data-preview-host-claimed', 'true'));
    expect(hostA.querySelector('iframe')).toBe(iframeA);

    rerender(
      <Harness activeTabId="tab:b" panes={[dedicatedPanes[1]!]} retainedOwnerTabIds={['tab:b']} />,
    );
    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    expect(container.contains(hostA)).toBe(false);
    expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-owner-tab-id', 'tab:b');
  });

  it('restores a retained dedicated host after StrictMode lease replay', async () => {
    const pane: HarnessPane = {
      ownerTabId: 'tab:a',
      paneId: 'main',
      policy: 'dedicated-while-open',
      onLease: (lease) => {
        if (!lease) return;
        lease.commitContent('focused:room-preview:room-a:revision-one');
        lease.reveal();
      },
    };
    const renderHarness = (activeTabId: string | null) => (
      <StrictMode>
        <Harness activeTabId={activeTabId} panes={[pane]} retainedOwnerTabIds={['tab:a']} />
      </StrictMode>
    );
    const { container, rerender } = render(renderHarness('tab:a'));

    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    const host = hostElements(container)[0]!;
    await waitFor(() => {
      expect(host).toHaveAttribute('data-preview-host-visible', 'true');
      expect(host).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });
      expect(host).not.toHaveAttribute('aria-hidden');
    });

    rerender(renderHarness(null));
    await waitFor(() => {
      expect(host).toHaveAttribute('data-preview-host-placement', 'retained-offscreen');
      expect(host).toHaveStyle({ opacity: '0', pointerEvents: 'none' });
      expect(host).toHaveAttribute('aria-hidden', 'true');
    });

    rerender(renderHarness('tab:a'));
    await waitFor(() => {
      expect(host).toHaveAttribute('data-preview-host-visible', 'true');
      expect(host).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });
      expect(host).not.toHaveAttribute('aria-hidden');
    });
  });

  it('releases inactive panes while keeping warm hosts for reuse', async () => {
    const { container, rerender } = render(
      <Harness activeTabId="tab:a" panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />,
    );
    await waitFor(() => expect(hostElements(container)).toHaveLength(1));
    const firstHostId = hostElements(container)[0]?.dataset.previewHostId;

    rerender(<Harness activeTabId={null} panes={[{ ownerTabId: 'tab:a', paneId: 'main' }]} />);
    await waitFor(() =>
      expect(hostElements(container)[0]).not.toHaveAttribute('data-preview-host-claimed'),
    );
    expect(hostElements(container)).toHaveLength(1);

    rerender(<Harness activeTabId="tab:b" panes={[{ ownerTabId: 'tab:b', paneId: 'main' }]} />);
    await waitFor(() =>
      expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-claimed', 'true'),
    );
    expect(hostElements(container)).toHaveLength(1);
    expect(hostElements(container)[0]?.dataset.previewHostId).toBe(firstHostId);
  });

  it('reuses one iframe host and resizes it for differently sized tab placeholders', async () => {
    const panes = [
      { ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true },
      { ownerTabId: 'tab:b', paneId: 'main', revealOnLease: true },
    ];
    const { container, rerender } = render(<Harness activeTabId="tab:a" panes={panes} />);
    await waitFor(() => expect(hostElements(container)).toHaveLength(1));

    const layer = container.querySelector<HTMLElement>('[data-preview-host-layer="group:one"]')!;
    const paneA = container.querySelector<HTMLElement>('[data-preview-pane-owner-tab-id="tab:a"]')!;
    const paneB = container.querySelector<HTMLElement>('[data-preview-pane-owner-tab-id="tab:b"]')!;
    vi.spyOn(layer, 'getBoundingClientRect').mockImplementation(() => testRect(0, 0, 800, 600));
    vi.spyOn(paneA, 'getBoundingClientRect').mockImplementation(() => testRect(12, 20, 320, 180));
    vi.spyOn(paneB, 'getBoundingClientRect').mockImplementation(() => testRect(48, 72, 500, 300));

    fireEvent(window, new Event('resize'));
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    const host = hostElements(container)[0]!;
    const iframe = screen.getByTitle('NovelTea engine preview');
    await waitFor(() =>
      expect(host).toHaveStyle({ left: '12px', top: '20px', width: '320px', height: '180px' }),
    );

    rerender(<Harness activeTabId="tab:b" panes={panes} />);

    await waitFor(() =>
      expect(host).toHaveStyle({ left: '48px', top: '72px', width: '500px', height: '300px' }),
    );
    expect(hostElements(container)).toEqual([host]);
    expect(screen.getByTitle('NovelTea engine preview')).toBe(iframe);
  });

  it('allocates focused apply sequences across successive leases of one pooled host', async () => {
    let leaseA: PreviewHostLease | null = null;
    let leaseB: PreviewHostLease | null = null;
    const panes = [
      {
        ownerTabId: 'tab:a',
        paneId: 'main',
        onLease: (lease: PreviewHostLease | null) => {
          if (lease) leaseA = lease;
        },
      },
      {
        ownerTabId: 'tab:b',
        paneId: 'main',
        onLease: (lease: PreviewHostLease | null) => {
          if (lease) leaseB = lease;
        },
      },
    ];
    const { container, rerender } = render(<Harness activeTabId="tab:a" panes={panes} />);
    await waitFor(() => expect(leaseA).not.toBeNull());
    expect(leaseA!.nextFocusedApplySequence()).toBe(1);
    const host = hostElements(container)[0];

    rerender(<Harness activeTabId="tab:b" panes={panes} />);
    await waitFor(() => expect(leaseB).not.toBeNull());

    expect(hostElements(container)[0]).toBe(host);
    expect(leaseB!.nextFocusedApplySequence()).toBe(2);
  });

  it('releases and reclaims a lease when a bridged pool is temporarily unavailable without remounting the pane', async () => {
    let lease: PreviewHostLease | null = null;
    const onProbeMount = vi.fn();
    const onProbeUnmount = vi.fn();
    const { container, rerender } = render(
      <BridgeAvailabilityHarness
        available={true}
        onLease={(nextLease) => {
          lease = nextLease;
        }}
        onProbeMount={onProbeMount}
        onProbeUnmount={onProbeUnmount}
      />,
    );

    await waitFor(() => expect(lease).not.toBeNull());
    const firstHost = hostElements(container)[0];
    expect(firstHost).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(onProbeMount).toHaveBeenCalledTimes(1);

    rerender(
      <BridgeAvailabilityHarness
        available={false}
        onLease={(nextLease) => {
          lease = nextLease;
        }}
        onProbeMount={onProbeMount}
        onProbeUnmount={onProbeUnmount}
      />,
    );

    await waitFor(() => expect(lease).toBeNull());
    await waitFor(() => expect(firstHost).not.toHaveAttribute('data-preview-host-claimed'));
    expect(screen.getByTestId('bridged-preview-probe')).toBeInTheDocument();
    expect(onProbeMount).toHaveBeenCalledTimes(1);
    expect(onProbeUnmount).not.toHaveBeenCalled();

    rerender(
      <BridgeAvailabilityHarness
        available={true}
        onLease={(nextLease) => {
          lease = nextLease;
        }}
        onProbeMount={onProbeMount}
        onProbeUnmount={onProbeUnmount}
      />,
    );

    await waitFor(() => expect(lease).not.toBeNull());
    expect(hostElements(container)).toHaveLength(1);
    expect(hostElements(container)[0]).toBe(firstHost);
    expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(onProbeMount).toHaveBeenCalledTimes(1);
    expect(onProbeUnmount).not.toHaveBeenCalled();
  });

  it('sends inactive activity when a pooled host is released', async () => {
    const { rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
      />,
    );
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );

    rerender(
      <Harness
        activeTabId={null}
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
      />,
    );

    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(false, false),
    );
  });

  it('sends active activity and requests preview state when a warm pooled host becomes visible again', async () => {
    const { rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
      />,
    );
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );

    rerender(
      <Harness
        activeTabId={null}
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
      />,
    );
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(false, false),
    );
    previewControllerMocks.setPreviewActivity.mockClear();
    previewControllerMocks.requestPreviewState.mockClear();

    rerender(
      <Harness
        activeTabId="tab:a"
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
      />,
    );

    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );
    await waitFor(() => expect(previewControllerMocks.requestPreviewState).toHaveBeenCalled());
  });

  it('keeps a newly claimed host invisible until its lease is revealed', async () => {
    let lease: PreviewHostLease | null = null;
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );

    await waitFor(() => expect(lease).not.toBeNull());
    const [host] = hostElements(container);
    expect(host).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(host).not.toHaveAttribute('data-preview-host-visible');
    await waitFor(() =>
      expect(host).toHaveStyle({ visibility: 'visible', opacity: '0', pointerEvents: 'none' }),
    );
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, false),
    );

    act(() => lease!.reveal());

    await waitFor(() => expect(host).toHaveStyle({ opacity: '1' }));
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );
    await waitFor(() => expect(previewControllerMocks.requestPreviewState).toHaveBeenCalled());
  });

  it('disables pooled iframe pointer events during an external workbench interaction without releasing the lease', async () => {
    const panes = [{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }];
    const { container, rerender } = render(
      <Harness activeTabId="tab:a" panes={panes} pointerEventsDisabled={false} />,
    );

    await waitFor(() => expect(hostElements(container)[0]).toHaveStyle({ pointerEvents: 'auto' }));
    const host = hostElements(container)[0];
    const leaseId = host.dataset.previewHostLeaseId;

    rerender(<Harness activeTabId="tab:a" panes={panes} pointerEventsDisabled={true} />);

    await waitFor(() => expect(host).toHaveStyle({ pointerEvents: 'none' }));
    expect(host).toHaveAttribute('data-preview-host-claimed', 'true');
    expect(host).toHaveAttribute('data-preview-host-lease-id', leaseId);

    rerender(<Harness activeTabId="tab:a" panes={panes} pointerEventsDisabled={false} />);

    await waitFor(() => expect(host).toHaveStyle({ pointerEvents: 'auto' }));
    expect(host).toHaveAttribute('data-preview-host-lease-id', leaseId);
  });

  it('disables preview iframe pointer events for the duration of a panel resize drag', async () => {
    const panes = [{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }];
    const { container } = render(<Harness activeTabId="tab:a" panes={panes} />);

    await waitFor(() => expect(hostElements(container)[0]).toHaveStyle({ pointerEvents: 'auto' }));
    const host = hostElements(container)[0];
    const leaseId = host.dataset.previewHostLeaseId;
    const separator = document.createElement('div');
    separator.setAttribute('role', 'separator');
    container.appendChild(separator);

    fireEvent.pointerDown(separator, { pointerId: 1 });

    await waitFor(() => expect(host).toHaveStyle({ pointerEvents: 'none' }));
    expect(host).toHaveAttribute('data-preview-host-lease-id', leaseId);

    fireEvent.pointerUp(window, { pointerId: 1 });

    await waitFor(() => expect(host).toHaveStyle({ pointerEvents: 'auto' }));
    expect(host).toHaveAttribute('data-preview-host-lease-id', leaseId);
  });

  it('refreshes a revealed host when its placeholder grows from zero to positive geometry', async () => {
    let lease: PreviewHostLease | null = null;
    let paneRect = testRect(0, 0, 0, 0);
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());

    const pane = container.querySelector<HTMLElement>('[data-preview-pane-id="main"]')!;
    const layer = container.querySelector<HTMLElement>('[data-preview-host-layer="group:one"]')!;
    vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() => paneRect);
    vi.spyOn(layer, 'getBoundingClientRect').mockImplementation(() => testRect(0, 0, 800, 600));

    previewControllerMocks.setPreviewActivity.mockClear();
    act(() => lease!.reveal());
    fireEvent(window, new Event('resize'));

    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );
    previewControllerMocks.setPreviewActivity.mockClear();
    previewControllerMocks.requestPreviewState.mockClear();

    paneRect = testRect(24, 32, 640, 360);
    fireEvent(window, new Event('resize'));

    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, false),
    );
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewActivity).toHaveBeenCalledWith(true, true),
    );
    await waitFor(() => expect(previewControllerMocks.requestPreviewState).toHaveBeenCalled());
    expect(hostElements(container)[0]).toHaveAttribute('data-preview-host-visible', 'true');
  });

  it('continuously tracks the active lease placeholder position and size', async () => {
    let lease: PreviewHostLease | null = null;
    let paneRect = testRect(10, 20, 256, 192);
    const { container, rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());

    const pane = container.querySelector<HTMLElement>('[data-preview-pane-id="main"]');
    const layer = container.querySelector<HTMLElement>('[data-preview-host-layer="group:one"]');
    expect(pane).not.toBeNull();
    expect(layer).not.toBeNull();
    vi.spyOn(pane!, 'getBoundingClientRect').mockImplementation(() => paneRect);
    vi.spyOn(layer!, 'getBoundingClientRect').mockImplementation(() => testRect(0, 0, 800, 600));

    fireEvent(window, new Event('resize'));
    act(() => lease!.reveal());
    await waitFor(() =>
      expect(hostElements(container)[0]).toHaveStyle({
        left: '10px',
        top: '20px',
        width: '256px',
        height: '192px',
      }),
    );

    paneRect = testRect(40, 64, 512, 288);
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    await waitFor(() =>
      expect(hostElements(container)[0]).toHaveStyle({
        left: '40px',
        top: '64px',
        width: '512px',
        height: '288px',
      }),
    );

    rerender(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );

    expect(hostElements(container)[0]).toHaveStyle({
      left: '40px',
      top: '64px',
      width: '512px',
      height: '288px',
    });
  });

  it('activates the owning tab when the pooled preview iframe is focused or clicked', async () => {
    const onActivateOwnerTab = vi.fn();
    render(
      <Harness
        activeTabId="tab:a"
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
        onActivateOwnerTab={onActivateOwnerTab}
      />,
    );

    const iframe = await screen.findByTitle('NovelTea engine preview');
    fireEvent.pointerDown(iframe);
    expect(onActivateOwnerTab).toHaveBeenCalledWith('tab:a');

    fireEvent.focus(iframe);
    expect(onActivateOwnerTab).toHaveBeenCalledWith('tab:a');
  });

  it('activates the owning tab from iframe preview-interacted messages', async () => {
    const onActivateOwnerTab = vi.fn();
    render(
      <Harness
        activeTabId="tab:a"
        panes={[{ ownerTabId: 'tab:a', paneId: 'main', revealOnLease: true }]}
        onActivateOwnerTab={onActivateOwnerTab}
      />,
    );

    await waitFor(() => expect(previewControllerMocks.onMessages.length).toBeGreaterThan(0));
    act(() => {
      previewControllerMocks.onMessages.at(-1)?.({
        version: 1,
        type: 'preview-interacted',
        interaction: 'pointer',
      });
    });

    expect(onActivateOwnerTab).toHaveBeenCalledWith('tab:a');
  });

  it('configures iframe wheel routing with the current lease and routes matching messages from the placeholder', async () => {
    let lease: PreviewHostLease | null = null;
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            revealOnLease: true,
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewWheelRouting).toHaveBeenCalledWith(
        'editor-scroll',
        lease!.leaseId,
      ),
    );

    const group = container.querySelector<HTMLElement>('[data-workbench-group-id="group:one"]')!;
    Object.defineProperty(group, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(group, 'scrollHeight', { value: 500, configurable: true });

    act(() => {
      previewControllerMocks.onMessages.at(-1)?.({
        version: 1,
        type: 'preview-wheel',
        routeId: lease!.leaseId,
        deltaX: 0,
        deltaY: 30,
        deltaMode: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    });
    expect(group.scrollTop).toBe(30);
  });

  it('ignores matching wheel messages for preview-input leases', async () => {
    let lease: PreviewHostLease | null = null;
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            revealOnLease: true,
            wheelPolicy: 'preview-input',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());
    await waitFor(() =>
      expect(previewControllerMocks.setPreviewWheelRouting).toHaveBeenCalledWith(
        'preview-input',
        lease!.leaseId,
      ),
    );

    const group = container.querySelector<HTMLElement>('[data-workbench-group-id="group:one"]')!;
    Object.defineProperty(group, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(group, 'scrollHeight', { value: 500, configurable: true });

    act(() => {
      previewControllerMocks.onMessages.at(-1)?.({
        version: 1,
        type: 'preview-wheel',
        routeId: lease!.leaseId,
        deltaX: 0,
        deltaY: 30,
        deltaMode: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    });
    expect(group.scrollTop).toBe(0);
  });

  it('ignores stale wheel route ids for editor-scroll leases', async () => {
    let lease: PreviewHostLease | null = null;
    const { container } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            revealOnLease: true,
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());

    const group = container.querySelector<HTMLElement>('[data-workbench-group-id="group:one"]')!;
    Object.defineProperty(group, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(group, 'scrollHeight', { value: 500, configurable: true });

    act(() => {
      previewControllerMocks.onMessages.at(-1)?.({
        version: 1,
        type: 'preview-wheel',
        routeId: 'preview-lease:stale',
        deltaX: 0,
        deltaY: 30,
        deltaMode: 0,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    });
    expect(group.scrollTop).toBe(0);
  });

  it('retries lease sends while the preview transport is still connecting', async () => {
    let lease: PreviewHostLease | null = null;
    render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());

    let attempts = 0;
    await expect(
      lease!.send(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Engine preview is not connected.');
        return 'sent';
      }),
    ).resolves.toBe('sent');
    expect(attempts).toBe(2);
  });

  it('holds a first pooled lease command until the iframe reports ready', async () => {
    previewControllerMocks.autoReady = false;
    let lease: PreviewHostLease | null = null;
    render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());
    await waitFor(() => expect(previewControllerMocks.onReadies.length).toBeGreaterThan(0));

    const command = vi.fn().mockResolvedValue('loaded');
    const pending = lease!.send(command);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(command).not.toHaveBeenCalled();

    act(() => previewControllerMocks.onReadies.at(-1)!());
    await expect(pending).resolves.toBe('loaded');
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('rejects sends from stale leases after release', async () => {
    let lease: PreviewHostLease | null = null;
    const { rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());
    const staleLease = lease!;

    rerender(
      <Harness
        activeTabId={null}
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).toBeNull());

    await expect(staleLease.send(async () => undefined)).rejects.toThrow(
      'Preview host lease is no longer current.',
    );
  });

  it('cancels pending commands when a lease is released', async () => {
    let lease: PreviewHostLease | null = null;
    const { rerender } = render(
      <Harness
        activeTabId="tab:a"
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).not.toBeNull());

    const pending = lease!.send(
      () =>
        new Promise<string>(() => {
          // The underlying preview command is intentionally stuck. Lease cancellation must
          // settle the editor-side command without waiting for the transport promise.
        }),
    );
    const pendingExpectation = expect(pending).rejects.toThrow(
      'Preview host command was cancelled because the lease was released.',
    );

    rerender(
      <Harness
        activeTabId={null}
        panes={[
          {
            ownerTabId: 'tab:a',
            paneId: 'main',
            onLease: (next) => {
              lease = next;
            },
          },
        ]}
      />,
    );
    await waitFor(() => expect(lease).toBeNull());

    await pendingExpectation;
  });
});
