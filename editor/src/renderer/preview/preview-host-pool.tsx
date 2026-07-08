import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import { useEnginePreview, type EnginePreviewController } from '@/hooks/use-engine-preview';
import type { PreviewMode } from '../../shared/preview-protocol';

export type PreviewPanePolicy = 'pooled-per-tab-group';
export type PooledPreviewPersistence = 'derived';

export interface PreviewHostRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PreviewHostClaimRequest {
  ownerTabId: string;
  paneId: string;
  mode: PreviewMode;
  persistence?: PooledPreviewPersistence;
  initialRect?: PreviewHostRect;
}

export interface PreviewHostLease {
  leaseId: string;
  hostId: string;
  ownerTabId: string;
  paneId: string;
  mode: PreviewMode;
  send<TResult>(command: (controller: EnginePreviewController) => Promise<TResult>): Promise<TResult>;
}

interface PendingLeaseCommand {
  cancelled: boolean;
}

interface PreviewHostRecord {
  hostId: string;
  lease: PreviewHostLeaseInfo | null;
}

interface PreviewHostLeaseInfo {
  leaseId: string;
  ownerTabId: string;
  paneId: string;
  mode: PreviewMode;
  rect?: PreviewHostRect;
}

interface PreviewHostPoolContextValue {
  activeTabId: string | null;
  layerRef: RefObject<HTMLDivElement | null>;
  claimHost: (request: PreviewHostClaimRequest) => PreviewHostLease;
  releaseHost: (leaseId: string) => void;
  updateHostRect: (leaseId: string, rect: PreviewHostRect | undefined) => void;
}

const PreviewHostPoolContext = createContext<PreviewHostPoolContextValue | null>(null);

function nextPreviewHostId(groupId: string, index: number) {
  return `preview-host:${groupId}:${index + 1}`;
}

function nextPreviewLeaseId() {
  return `preview-lease:${crypto.randomUUID()}`;
}

function hiddenHostStyle(): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    visibility: 'hidden',
    pointerEvents: 'none',
  };
}

function rectHostStyle(rect: PreviewHostRect, pointerEventsDisabled: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    pointerEvents: pointerEventsDisabled ? 'none' : 'auto',
  };
}

function measureRect(element: HTMLElement, layer: HTMLElement): PreviewHostRect {
  const elementRect = element.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  return {
    left: elementRect.left - layerRect.left,
    top: elementRect.top - layerRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

function PreviewHostSlot({
  host,
  registerController,
  pointerEventsDisabled,
}: {
  host: PreviewHostRecord;
  registerController: (hostId: string, controller: EnginePreviewController | null) => void;
  pointerEventsDisabled: boolean;
}) {
  const controller = useEnginePreview({
    embedded: true,
    onReady: () => undefined,
    onMessage: () => undefined,
    onError: () => undefined,
  });
  const { iframeRef, iframeKey, iframeSrc, loadSession } = controller;

  useEffect(() => {
    registerController(host.hostId, controller);
    return () => registerController(host.hostId, null);
  }, [controller, host.hostId, registerController]);

  useEffect(() => {
    void loadSession().catch(() => undefined);
  }, [loadSession]);

  const rect = host.lease?.rect;
  const isVisible = Boolean(rect && host.lease);
  const style = rect && isVisible ? rectHostStyle(rect, pointerEventsDisabled) : hiddenHostStyle();

  useEffect(() => {
    const sendActivity = async () => {
      try {
        await controller.setPreviewActivity(isVisible, isVisible);
        if (isVisible) await controller.requestPreviewState();
      } catch {
        // Activity is best-effort; preview content commands remain lease-scoped.
      }
    };
    void sendActivity();
  }, [controller, isVisible]);

  return (
    <div
      className="overflow-hidden bg-zinc-950"
      data-preview-host-id={host.hostId}
      data-preview-host-claimed={host.lease ? 'true' : undefined}
      data-preview-host-pane-id={host.lease?.paneId}
      data-preview-host-lease-id={host.lease?.leaseId}
      aria-hidden={isVisible ? undefined : true}
      style={style}
    >
      <EnginePreviewHost
        iframeRef={iframeRef}
        iframeKey={iframeKey}
        iframeSrc={iframeSrc}
        embedded={true}
        connectionState="loading"
        className="h-full w-full bg-zinc-950"
        iframeClassName="h-full w-full border-0"
        showConnectionOverlay={false}
        onActivateContainingGroup={() => undefined}
        onConnecting={() => undefined}
        onError={() => undefined}
      />
    </div>
  );
}

export function PreviewHostPoolProvider({
  groupId,
  activeTabId,
  children,
}: {
  groupId: string;
  activeTabId: string | null;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const controllersRef = useRef(new Map<string, EnginePreviewController>());
  const pendingByLeaseRef = useRef(new Map<string, Set<PendingLeaseCommand>>());
  const reservedHostIdsRef = useRef(new Set<string>());
  const [hosts, setHosts] = useState<PreviewHostRecord[]>([]);
  const [previewPointerEventsDisabled, setPreviewPointerEventsDisabled] = useState(false);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const registerController = useCallback((hostId: string, controller: EnginePreviewController | null) => {
    if (controller) controllersRef.current.set(hostId, controller);
    else controllersRef.current.delete(hostId);
  }, []);

  const isCurrentLease = useCallback((leaseId: string, hostId: string) => {
    return hostsRef.current.some((host) => host.hostId === hostId && host.lease?.leaseId === leaseId);
  }, []);

  const releaseHost = useCallback((leaseId: string) => {
    const pending = pendingByLeaseRef.current.get(leaseId);
    if (pending) {
      for (const command of pending) command.cancelled = true;
      pendingByLeaseRef.current.delete(leaseId);
    }
    setHosts((current) => current.map((host) => (
      host.lease?.leaseId === leaseId ? { ...host, lease: null } : host
    )));
  }, []);

  const updateHostRect = useCallback((leaseId: string, rect: PreviewHostRect | undefined) => {
    setHosts((current) => current.map((host) => {
      if (host.lease?.leaseId !== leaseId) return host;
      return { ...host, lease: { ...host.lease, rect } };
    }));
  }, []);

  const sendForLease = useCallback(<TResult,>(
    leaseId: string,
    hostId: string,
    command: (controller: EnginePreviewController) => Promise<TResult>,
  ) => {
    if (!isCurrentLease(leaseId, hostId)) {
      return Promise.reject(new Error('Preview host lease is no longer current.'));
    }
    const pending: PendingLeaseCommand = { cancelled: false };
    const leasePending = pendingByLeaseRef.current.get(leaseId) ?? new Set<PendingLeaseCommand>();
    leasePending.add(pending);
    pendingByLeaseRef.current.set(leaseId, leasePending);

    const waitForController = () => new Promise<EnginePreviewController>((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (pending.cancelled || !isCurrentLease(leaseId, hostId)) {
          reject(new Error('Preview host command was cancelled because the lease was released.'));
          return;
        }
        const controller = controllersRef.current.get(hostId);
        if (controller) {
          resolve(controller);
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error('Preview host is not ready.'));
          return;
        }
        window.setTimeout(tick, 0);
      };
      tick();
    });

    return Promise.resolve()
      .then(waitForController)
      .then((controller) => command(controller))
      .then((result) => {
        if (pending.cancelled || !isCurrentLease(leaseId, hostId)) {
          throw new Error('Preview host command was cancelled because the lease was released.');
        }
        return result;
      })
      .finally(() => {
        leasePending.delete(pending);
        if (leasePending.size === 0) pendingByLeaseRef.current.delete(leaseId);
      });
  }, [isCurrentLease]);

  const claimHost = useCallback((request: PreviewHostClaimRequest): PreviewHostLease => {
    const leaseId = nextPreviewLeaseId();
    const currentHost = hostsRef.current.find((host) => host.lease?.paneId === request.paneId)
      ?? hostsRef.current.find((host) => !host.lease && !reservedHostIdsRef.current.has(host.hostId));
    const claimedHostId = currentHost?.hostId
      ?? nextPreviewHostId(groupId, hostsRef.current.length + reservedHostIdsRef.current.size);
    reservedHostIdsRef.current.add(claimedHostId);
    setHosts((current) => {
      if (current.some((host) => host.hostId === claimedHostId)) {
        return current.map((host) => host.hostId === claimedHostId
          ? {
              ...host,
              lease: {
                leaseId,
                ownerTabId: request.ownerTabId,
                paneId: request.paneId,
                mode: request.mode,
                rect: request.initialRect,
              },
            }
          : host);
      }
      return [
        ...current,
        {
          hostId: claimedHostId,
          lease: {
            leaseId,
            ownerTabId: request.ownerTabId,
            paneId: request.paneId,
            mode: request.mode,
            rect: request.initialRect,
          },
        },
      ];
    });
    return {
      leaseId,
      hostId: claimedHostId,
      ownerTabId: request.ownerTabId,
      paneId: request.paneId,
      mode: request.mode,
      send: (command) => sendForLease(leaseId, claimedHostId, command),
    };
  }, [groupId, sendForLease]);

  useEffect(() => {
    for (const hostId of [...reservedHostIdsRef.current]) {
      if (hosts.some((host) => host.hostId === hostId)) reservedHostIdsRef.current.delete(hostId);
    }
  }, [hosts]);

  useLayoutEffect(() => {
    setHosts((current) => current.map((host) => (
      host.lease && host.lease.ownerTabId !== activeTabId ? { ...host, lease: null } : host
    )));
  }, [activeTabId]);

  useEffect(() => {
    const startsResizeDrag = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;

      const handle = target.closest('[role="separator"]') ?? target.closest('[data-panel-resize-handle-id]');
      if (handle) return true;

      const classed = target.closest('.cursor-col-resize') ?? target.closest('.cursor-row-resize');
      return Boolean(classed);
    };

    const stopResizeDrag = () => setPreviewPointerEventsDisabled(false);

    const onPointerDown = (event: PointerEvent) => {
      if (!startsResizeDrag(event.target)) return;

      setPreviewPointerEventsDisabled(true);
      window.addEventListener('pointerup', stopResizeDrag, { once: true });
      window.addEventListener('pointercancel', stopResizeDrag, { once: true });
      window.addEventListener('blur', stopResizeDrag, { once: true });
    };

    window.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', stopResizeDrag);
      window.removeEventListener('pointercancel', stopResizeDrag);
      window.removeEventListener('blur', stopResizeDrag);
    };
  }, []);

  const value = useMemo<PreviewHostPoolContextValue>(() => ({
    activeTabId,
    layerRef,
    claimHost,
    releaseHost,
    updateHostRect,
  }), [activeTabId, claimHost, releaseHost, updateHostRect]);

  return (
    <PreviewHostPoolContext.Provider value={value}>
      <div ref={layerRef} className="pointer-events-none absolute inset-0 z-10" data-preview-host-layer={groupId}>
        {hosts.map((host) => (
          <PreviewHostSlot
            key={host.hostId}
            host={host}
            registerController={registerController}
            pointerEventsDisabled={previewPointerEventsDisabled}
          />
        ))}
      </div>
      {children}
    </PreviewHostPoolContext.Provider>
  );
}

export function usePreviewHostPool() {
  const context = useContext(PreviewHostPoolContext);
  if (!context) {
    throw new Error('Preview host pool context is not available.');
  }
  return context;
}

export function PreviewPane({
  ownerTabId,
  paneId,
  policy = 'pooled-per-tab-group',
  persistence = 'derived',
  mode,
  children,
  className = 'relative min-h-0 flex-1 overflow-hidden bg-zinc-950',
  onLease,
}: {
  ownerTabId: string;
  paneId: string;
  policy?: PreviewPanePolicy;
  persistence?: PooledPreviewPersistence;
  mode: PreviewMode;
  children?: ReactNode;
  className?: string;
  onLease?: (lease: PreviewHostLease | null) => void;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const leaseRef = useRef<PreviewHostLease | null>(null);
  const onLeaseRef = useRef(onLease);
  const { activeTabId, layerRef, claimHost, releaseHost, updateHostRect } = usePreviewHostPool();
  const isActive = activeTabId === ownerTabId;
  onLeaseRef.current = onLease;

  const measureAndUpdate = useCallback(() => {
    const lease = leaseRef.current;
    const placeholder = placeholderRef.current;
    const layer = layerRef.current;
    if (!lease || !placeholder || !layer) return;
    updateHostRect(lease.leaseId, measureRect(placeholder, layer));
  }, [layerRef, updateHostRect]);

  useLayoutEffect(() => {
    if (!isActive) {
      if (leaseRef.current) {
        releaseHost(leaseRef.current.leaseId);
        leaseRef.current = null;
        onLeaseRef.current?.(null);
      }
      return;
    }
    const placeholder = placeholderRef.current;
    const layer = layerRef.current;
    const initialRect = placeholder && layer ? measureRect(placeholder, layer) : undefined;
    const lease = claimHost({ ownerTabId, paneId, mode, persistence, initialRect });
    leaseRef.current = lease;
    onLeaseRef.current?.(lease);
    measureAndUpdate();
    return () => {
      releaseHost(lease.leaseId);
      if (leaseRef.current?.leaseId === lease.leaseId) leaseRef.current = null;
      onLeaseRef.current?.(null);
    };
  }, [claimHost, isActive, measureAndUpdate, mode, ownerTabId, paneId, persistence, releaseHost]);

  useLayoutEffect(() => {
    if (!isActive) return undefined;
    const placeholder = placeholderRef.current;
    if (!placeholder) return undefined;
    measureAndUpdate();
    const ResizeObserverCtor = window.ResizeObserver;
    if (!ResizeObserverCtor) {
      window.addEventListener('resize', measureAndUpdate);
      return () => window.removeEventListener('resize', measureAndUpdate);
    }
    const observer = new ResizeObserverCtor(measureAndUpdate);
    observer.observe(placeholder);
    if (layerRef.current) observer.observe(layerRef.current);
    return () => observer.disconnect();
  }, [isActive, layerRef, measureAndUpdate]);

  return (
    <div
      ref={placeholderRef}
      className={className}
      data-preview-pane-id={paneId}
      data-preview-pane-owner-tab-id={ownerTabId}
      data-preview-pane-policy={policy}
      data-preview-pane-persistence={persistence}
      data-preview-pane-mode={mode}
      data-preview-pane-active={isActive ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
