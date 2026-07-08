import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import { useEnginePreview, type EnginePreviewController } from '@/hooks/use-engine-preview';
import type { PreviewMode } from '../../shared/preview-protocol';

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

function rectHostStyle(rect: PreviewHostRect): CSSProperties {
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    pointerEvents: 'auto',
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
}: {
  host: PreviewHostRecord;
  registerController: (hostId: string, controller: EnginePreviewController | null) => void;
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
  const style = rect && isVisible ? rectHostStyle(rect) : hiddenHostStyle();

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
    const controller = controllersRef.current.get(hostId);
    if (!controller) {
      return Promise.reject(new Error('Preview host is not ready.'));
    }
    const pending: PendingLeaseCommand = { cancelled: false };
    const leasePending = pendingByLeaseRef.current.get(leaseId) ?? new Set<PendingLeaseCommand>();
    leasePending.add(pending);
    pendingByLeaseRef.current.set(leaseId, leasePending);
    return Promise.resolve()
      .then(() => command(controller))
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

  useEffect(() => {
    setHosts((current) => current.map((host) => (
      host.lease && host.lease.ownerTabId !== activeTabId ? { ...host, lease: null } : host
    )));
  }, [activeTabId]);

  const value = useMemo<PreviewHostPoolContextValue>(() => ({
    activeTabId,
    layerRef,
    claimHost,
    releaseHost,
    updateHostRect,
  }), [activeTabId, claimHost, releaseHost, updateHostRect]);

  return (
    <PreviewHostPoolContext.Provider value={value}>
      {children}
      <div ref={layerRef} className="pointer-events-none absolute inset-0 z-10" data-preview-host-layer={groupId}>
        {hosts.map((host) => <PreviewHostSlot key={host.hostId} host={host} registerController={registerController} />)}
      </div>
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
  mode,
  children,
  className = 'relative min-h-0 flex-1 overflow-hidden bg-zinc-950',
  onLease,
}: {
  ownerTabId: string;
  paneId: string;
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

  useEffect(() => {
    if (!isActive) {
      if (leaseRef.current) {
        releaseHost(leaseRef.current.leaseId);
        leaseRef.current = null;
        onLeaseRef.current?.(null);
      }
      return;
    }
    const lease = claimHost({ ownerTabId, paneId, mode, persistence: 'derived' });
    leaseRef.current = lease;
    onLeaseRef.current?.(lease);
    measureAndUpdate();
    return () => {
      releaseHost(lease.leaseId);
      if (leaseRef.current?.leaseId === lease.leaseId) leaseRef.current = null;
      onLeaseRef.current?.(null);
    };
  }, [claimHost, isActive, measureAndUpdate, mode, ownerTabId, paneId, releaseHost]);

  useEffect(() => {
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
      data-preview-pane-active={isActive ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
