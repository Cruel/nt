import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { EnginePreviewHost } from '@/components/engine-preview-host';
import { useEnginePreview, type EnginePreviewController } from '@/hooks/use-engine-preview';
import {
  routePreviewWheelToScrollAncestors,
  type PreviewWheelMessage,
} from '@/preview/preview-wheel-routing';
import type { PreviewMode, PreviewToEditorMessage } from '../../shared/preview-protocol';
import type { PreviewWheelPolicy } from '../../shared/preview-wheel-routing';

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
  wheelPolicy?: PreviewWheelPolicy;
  initialRect?: PreviewHostRect;
}

export interface PreviewHostLease {
  leaseId: string;
  hostId: string;
  ownerTabId: string;
  paneId: string;
  mode: PreviewMode;
  wheelPolicy: PreviewWheelPolicy;
  reveal(): void;
  send<TResult>(
    command: (controller: EnginePreviewController) => Promise<TResult>,
  ): Promise<TResult>;
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
  wheelPolicy: PreviewWheelPolicy;
  visible: boolean;
  rect?: PreviewHostRect;
}

export interface PreviewHostPoolApi {
  activeTabId: string | null;
  layerRef: RefObject<HTMLDivElement | null>;
  claimHost: (request: PreviewHostClaimRequest) => PreviewHostLease;
  markHostReady: (hostId: string) => void;
  releaseHost: (leaseId: string) => void;
  revealHost: (leaseId: string) => void;
  updateHostRect: (leaseId: string, rect: PreviewHostRect | undefined) => void;
  registerPlaceholder: (leaseId: string, element: HTMLElement | null) => void;
}

const PreviewHostPoolContext = createContext<PreviewHostPoolApi | null>(null);

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
    width: 0,
    height: 0,
    overflow: 'hidden',
  };
}

function rectHostStyle(
  rect: PreviewHostRect,
  pointerEventsDisabled: boolean,
  visible: boolean,
): CSSProperties {
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    visibility: visible ? 'visible' : 'hidden',
    pointerEvents: visible && !pointerEventsDisabled ? 'auto' : 'none',
    overflow: 'hidden',
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

function applyMeasuredHostStyle(element: HTMLElement, rect: PreviewHostRect) {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function sameHostRect(left: PreviewHostRect | undefined, right: PreviewHostRect | undefined) {
  return Boolean(
    left &&
    right &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height,
  );
}

function isPreviewNotConnectedError(error: unknown) {
  return error instanceof Error && error.message === 'Engine preview is not connected.';
}

function PreviewHostSlot({
  host,
  registerController,
  markHostReady,
  registerHostElement,
  routeWheel,
  onActivateOwnerTab,
  pointerEventsDisabled,
}: {
  host: PreviewHostRecord;
  registerController: (hostId: string, controller: EnginePreviewController | null) => void;
  markHostReady: (hostId: string) => void;
  registerHostElement: (hostId: string, element: HTMLElement | null) => void;
  routeWheel: (hostId: string, message: PreviewWheelMessage) => void;
  onActivateOwnerTab?: (ownerTabId: string) => void;
  pointerEventsDisabled: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activateOwningTab = useCallback(() => {
    if (host.lease) onActivateOwnerTab?.(host.lease.ownerTabId);
  }, [host.lease, onActivateOwnerTab]);
  const handlePreviewMessage = useCallback(
    (message: PreviewToEditorMessage) => {
      if (message.type === 'preview-interacted') activateOwningTab();
      if (message.type === 'preview-wheel') routeWheel(host.hostId, message);
    },
    [activateOwningTab, host.hostId, routeWheel],
  );
  const handleHostWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const lease = host.lease;
      if (!lease || lease.wheelPolicy !== 'editor-scroll') return;
      event.preventDefault();
      routeWheel(host.hostId, {
        version: 1,
        type: 'preview-wheel',
        routeId: lease.leaseId,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode === 1 || event.deltaMode === 2 ? event.deltaMode : 0,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
    },
    [host.hostId, host.lease, routeWheel],
  );
  const controller = useEnginePreview({
    embedded: true,
    wheelPolicy: 'editor-scroll',
    onReady: () => markHostReady(host.hostId),
    onMessage: handlePreviewMessage,
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

  useEffect(() => {
    const leaseId = host.lease?.leaseId;
    const wheelPolicy = host.lease?.wheelPolicy;
    if (!leaseId || !wheelPolicy) return undefined;
    const setPreviewWheelRouting = controller.setPreviewWheelRouting;
    let cancelled = false;
    let retryTimer = 0;
    const startedAt = Date.now();
    const configure = () => {
      void setPreviewWheelRouting(wheelPolicy, leaseId).catch((error: unknown) => {
        if (!cancelled && isPreviewNotConnectedError(error) && Date.now() - startedAt <= 5000) {
          retryTimer = window.setTimeout(configure, 16);
        }
      });
    };
    configure();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [controller, host.lease?.leaseId, host.lease?.wheelPolicy]);

  const rect = host.lease?.rect;
  const isVisible = Boolean(host.lease?.visible && rect);
  const style =
    host.lease && rect ? rectHostStyle(rect, pointerEventsDisabled, isVisible) : hiddenHostStyle();

  useLayoutEffect(() => {
    const element = hostRef.current;
    registerHostElement(host.hostId, element);
    if (element && rect) applyMeasuredHostStyle(element, rect);
    return () => registerHostElement(host.hostId, null);
  }, [host.hostId, rect, registerHostElement]);

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
      ref={hostRef}
      className="bg-zinc-950"
      data-preview-host-id={host.hostId}
      data-preview-host-claimed={host.lease ? 'true' : undefined}
      data-preview-host-pane-id={host.lease?.paneId}
      data-preview-host-lease-id={host.lease?.leaseId}
      data-preview-host-visible={isVisible ? 'true' : undefined}
      data-preview-host-placement={rect ? 'measured-rect' : 'hidden'}
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
        onActivateContainingGroup={activateOwningTab}
        onConnecting={() => undefined}
        onError={() => undefined}
        onWheel={handleHostWheel}
      />
    </div>
  );
}

function scrollableAncestors(element: HTMLElement): EventTarget[] {
  const ancestors: EventTarget[] = [window];
  for (let current = element.parentElement; current; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
    if (/auto|scroll|overlay/i.test(overflow)) ancestors.push(current);
  }
  return ancestors;
}

export function PreviewHostPoolProvider({
  groupId,
  activeTabId,
  onActivateOwnerTab,
  pointerEventsDisabled = false,
  children,
}: {
  groupId: string;
  activeTabId: string | null;
  onActivateOwnerTab?: (ownerTabId: string) => void;
  pointerEventsDisabled?: boolean;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const controllersRef = useRef(new Map<string, EnginePreviewController>());
  const readyHostIdsRef = useRef(new Set<string>());
  const hostElementsRef = useRef(new Map<string, HTMLElement>());
  const placeholdersByLeaseRef = useRef(new Map<string, HTMLElement>());
  const pendingByLeaseRef = useRef(new Map<string, Set<PendingLeaseCommand>>());
  const reservedHostIdsRef = useRef(new Set<string>());
  const [hosts, setHosts] = useState<PreviewHostRecord[]>([]);
  const [resizePointerEventsDisabled, setResizePointerEventsDisabled] = useState(false);
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const registerController = useCallback(
    (hostId: string, controller: EnginePreviewController | null) => {
      if (controller) controllersRef.current.set(hostId, controller);
      else controllersRef.current.delete(hostId);
    },
    [],
  );

  const markHostReady = useCallback((hostId: string) => {
    readyHostIdsRef.current.add(hostId);
  }, []);

  const registerHostElement = useCallback((hostId: string, element: HTMLElement | null) => {
    if (element) hostElementsRef.current.set(hostId, element);
    else hostElementsRef.current.delete(hostId);
  }, []);

  const registerPlaceholder = useCallback((leaseId: string, element: HTMLElement | null) => {
    if (element) {
      placeholdersByLeaseRef.current.set(leaseId, element);
    } else {
      placeholdersByLeaseRef.current.delete(leaseId);
    }
  }, []);

  const isCurrentLease = useCallback((leaseId: string, hostId: string) => {
    return hostsRef.current.some(
      (host) => host.hostId === hostId && host.lease?.leaseId === leaseId,
    );
  }, []);

  const releaseHost = useCallback((leaseId: string) => {
    const pending = pendingByLeaseRef.current.get(leaseId);
    if (pending) {
      for (const command of pending) command.cancelled = true;
      pendingByLeaseRef.current.delete(leaseId);
    }
    placeholdersByLeaseRef.current.delete(leaseId);
    setHosts((current) =>
      current.map((host) => (host.lease?.leaseId === leaseId ? { ...host, lease: null } : host)),
    );
  }, []);

  const routeWheel = useCallback(
    (hostId: string, message: PreviewWheelMessage) => {
      const host = hostsRef.current.find((candidate) => candidate.hostId === hostId);
      const lease = host?.lease;
      if (
        !lease ||
        lease.leaseId !== message.routeId ||
        lease.ownerTabId !== activeTabId ||
        lease.wheelPolicy !== 'editor-scroll' ||
        !lease.visible ||
        message.ctrlKey ||
        message.metaKey
      ) {
        return;
      }
      const placeholder = placeholdersByLeaseRef.current.get(lease.leaseId);
      if (!placeholder?.isConnected) return;
      routePreviewWheelToScrollAncestors(placeholder, message);
    },
    [activeTabId],
  );

  const updateHostRect = useCallback((leaseId: string, rect: PreviewHostRect | undefined) => {
    const hostForLease = hostsRef.current.find((host) => host.lease?.leaseId === leaseId);
    if (
      hostForLease?.lease &&
      ((!rect && !hostForLease.lease.rect) || sameHostRect(hostForLease.lease.rect, rect))
    ) {
      return;
    }
    if (hostForLease && rect) {
      const element = hostElementsRef.current.get(hostForLease.hostId);
      if (element) applyMeasuredHostStyle(element, rect);
    }
    setHosts((current) =>
      current.map((host) => {
        if (host.lease?.leaseId !== leaseId) return host;
        if (rect && sameHostRect(host.lease.rect, rect)) return host;
        return { ...host, lease: { ...host.lease, rect } };
      }),
    );
  }, []);

  const revealHost = useCallback((leaseId: string) => {
    setHosts((current) =>
      current.map((host) => {
        if (host.lease?.leaseId !== leaseId || host.lease.visible) return host;
        return { ...host, lease: { ...host.lease, visible: true } };
      }),
    );
  }, []);

  const sendForLease = useCallback(
    <TResult,>(
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

      const startedAt = Date.now();
      const waitForController = () =>
        new Promise<EnginePreviewController>((resolve, reject) => {
          const startedAt = Date.now();
          const tick = () => {
            if (pending.cancelled || !isCurrentLease(leaseId, hostId)) {
              reject(
                new Error('Preview host command was cancelled because the lease was released.'),
              );
              return;
            }
            const controller = controllersRef.current.get(hostId);
            if (controller && readyHostIdsRef.current.has(hostId)) {
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

      const runWhenConnected = (): Promise<TResult> => {
        if (pending.cancelled || !isCurrentLease(leaseId, hostId)) {
          return Promise.reject(
            new Error('Preview host command was cancelled because the lease was released.'),
          );
        }
        return Promise.resolve()
          .then(waitForController)
          .then((controller) => command(controller))
          .then((result) => {
            if (pending.cancelled || !isCurrentLease(leaseId, hostId)) {
              throw new Error('Preview host command was cancelled because the lease was released.');
            }
            return result;
          })
          .catch((error: unknown) => {
            if (
              isPreviewNotConnectedError(error) &&
              !pending.cancelled &&
              isCurrentLease(leaseId, hostId) &&
              Date.now() - startedAt <= 5000
            ) {
              return new Promise<TResult>((resolve, reject) => {
                window.setTimeout(() => {
                  runWhenConnected().then(resolve, reject);
                }, 16);
              });
            }
            throw error;
          });
      };

      return runWhenConnected().finally(() => {
        leasePending.delete(pending);
        if (leasePending.size === 0) pendingByLeaseRef.current.delete(leaseId);
      });
    },
    [isCurrentLease],
  );

  const claimHost = useCallback(
    (request: PreviewHostClaimRequest): PreviewHostLease => {
      const leaseId = nextPreviewLeaseId();
      const currentHost =
        hostsRef.current.find((host) => host.lease?.paneId === request.paneId) ??
        hostsRef.current.find(
          (host) => !host.lease && !reservedHostIdsRef.current.has(host.hostId),
        );
      const claimedHostId =
        currentHost?.hostId ??
        nextPreviewHostId(groupId, hostsRef.current.length + reservedHostIdsRef.current.size);
      reservedHostIdsRef.current.add(claimedHostId);
      setHosts((current) => {
        if (current.some((host) => host.hostId === claimedHostId)) {
          return current.map((host) =>
            host.hostId === claimedHostId
              ? {
                  ...host,
                  lease: {
                    leaseId,
                    ownerTabId: request.ownerTabId,
                    paneId: request.paneId,
                    mode: request.mode,
                    wheelPolicy: request.wheelPolicy ?? 'editor-scroll',
                    visible: false,
                    rect: request.initialRect,
                  },
                }
              : host,
          );
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
              wheelPolicy: request.wheelPolicy ?? 'editor-scroll',
              visible: false,
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
        wheelPolicy: request.wheelPolicy ?? 'editor-scroll',
        reveal: () => revealHost(leaseId),
        send: (command) => sendForLease(leaseId, claimedHostId, command),
      };
    },
    [groupId, revealHost, sendForLease],
  );

  useEffect(() => {
    for (const hostId of [...reservedHostIdsRef.current]) {
      if (hosts.some((host) => host.hostId === hostId)) reservedHostIdsRef.current.delete(hostId);
    }
  }, [hosts]);

  useLayoutEffect(() => {
    setHosts((current) =>
      current.map((host) =>
        host.lease && host.lease.ownerTabId !== activeTabId ? { ...host, lease: null } : host,
      ),
    );
  }, [activeTabId]);

  useEffect(() => {
    const startsResizeDrag = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;

      const handle =
        target.closest('[role="separator"]') ?? target.closest('[data-panel-resize-handle-id]');
      if (handle) return true;

      const classed = target.closest('.cursor-col-resize') ?? target.closest('.cursor-row-resize');
      return Boolean(classed);
    };

    const stopResizeDrag = () => setResizePointerEventsDisabled(false);

    const onPointerDown = (event: PointerEvent) => {
      if (!startsResizeDrag(event.target)) return;

      setResizePointerEventsDisabled(true);
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

  const value = useMemo<PreviewHostPoolApi>(
    () => ({
      activeTabId,
      layerRef,
      claimHost,
      markHostReady,
      releaseHost,
      revealHost,
      updateHostRect,
      registerPlaceholder,
    }),
    [
      activeTabId,
      claimHost,
      markHostReady,
      registerPlaceholder,
      releaseHost,
      revealHost,
      updateHostRect,
    ],
  );

  return (
    <PreviewHostPoolContext.Provider value={value}>
      {children}
      <div
        ref={layerRef}
        className="pointer-events-none absolute inset-0 z-10"
        data-preview-host-layer={groupId}
      >
        {hosts.map((host) => (
          <PreviewHostSlot
            key={host.hostId}
            host={host}
            registerController={registerController}
            markHostReady={markHostReady}
            registerHostElement={registerHostElement}
            routeWheel={routeWheel}
            onActivateOwnerTab={onActivateOwnerTab}
            pointerEventsDisabled={pointerEventsDisabled || resizePointerEventsDisabled}
          />
        ))}
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

export function useOptionalPreviewHostPool() {
  return useContext(PreviewHostPoolContext);
}

export function PreviewHostPoolBridge({
  pool,
  children,
}: {
  pool: PreviewHostPoolApi | null;
  children: ReactNode;
}) {
  return <PreviewHostPoolContext.Provider value={pool}>{children}</PreviewHostPoolContext.Provider>;
}

export function PreviewPane({
  ownerTabId,
  paneId,
  policy = 'pooled-per-tab-group',
  persistence = 'derived',
  wheelPolicy = 'editor-scroll',
  mode,
  children,
  className = 'relative min-h-0 flex-1 overflow-hidden bg-zinc-950',
  onLease,
}: {
  ownerTabId: string;
  paneId: string;
  policy?: PreviewPanePolicy;
  persistence?: PooledPreviewPersistence;
  wheelPolicy?: PreviewWheelPolicy;
  mode: PreviewMode;
  children?: ReactNode;
  className?: string;
  onLease?: (lease: PreviewHostLease | null) => void;
}) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const scheduledMeasurementFrameRef = useRef(0);
  const leaseBindingRef = useRef<{ lease: PreviewHostLease; pool: PreviewHostPoolApi } | null>(
    null,
  );
  const onLeaseRef = useRef(onLease);
  const pool = useOptionalPreviewHostPool();
  const isActive = pool?.activeTabId === ownerTabId;
  onLeaseRef.current = onLease;

  const measureAndUpdate = useCallback(() => {
    const binding = leaseBindingRef.current;
    const placeholder = placeholderRef.current;
    const layer = binding?.pool.layerRef.current;
    if (!binding || !placeholder || !layer) return;
    binding.pool.updateHostRect(binding.lease.leaseId, measureRect(placeholder, layer));
  }, []);

  const scheduleMeasureAndUpdate = useCallback(() => {
    if (scheduledMeasurementFrameRef.current) return;
    scheduledMeasurementFrameRef.current = window.requestAnimationFrame(() => {
      scheduledMeasurementFrameRef.current = 0;
      measureAndUpdate();
    });
  }, [measureAndUpdate]);

  useEffect(
    () => () => {
      if (scheduledMeasurementFrameRef.current) {
        window.cancelAnimationFrame(scheduledMeasurementFrameRef.current);
      }
    },
    [],
  );

  const releaseBinding = useCallback(
    (binding: { lease: PreviewHostLease; pool: PreviewHostPoolApi }) => {
      binding.pool.releaseHost(binding.lease.leaseId);
      binding.pool.registerPlaceholder(binding.lease.leaseId, null);
      if (leaseBindingRef.current === binding) leaseBindingRef.current = null;
      onLeaseRef.current?.(null);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!pool || !isActive) return undefined;
    const placeholder = placeholderRef.current;
    const layer = pool.layerRef.current;
    const initialRect = placeholder && layer ? measureRect(placeholder, layer) : undefined;
    const lease = pool.claimHost({
      ownerTabId,
      paneId,
      mode,
      persistence,
      wheelPolicy,
      initialRect,
    });
    const binding = { lease, pool };
    leaseBindingRef.current = binding;
    if (placeholder) pool.registerPlaceholder(lease.leaseId, placeholder);
    onLeaseRef.current?.(lease);
    measureAndUpdate();
    return () => releaseBinding(binding);
  }, [
    isActive,
    measureAndUpdate,
    mode,
    ownerTabId,
    paneId,
    persistence,
    pool,
    releaseBinding,
    wheelPolicy,
  ]);

  useLayoutEffect(() => {
    if (!pool || !isActive) return undefined;
    const placeholder = placeholderRef.current;
    if (!placeholder) return undefined;
    measureAndUpdate();
    const ResizeObserverCtor = window.ResizeObserver;
    if (!ResizeObserverCtor) {
      window.addEventListener('resize', scheduleMeasureAndUpdate);
      return () => window.removeEventListener('resize', scheduleMeasureAndUpdate);
    }
    const observer = new ResizeObserverCtor(scheduleMeasureAndUpdate);
    observer.observe(placeholder);
    for (let current = placeholder.parentElement; current; current = current.parentElement) {
      observer.observe(current);
      if (current === pool.layerRef.current?.parentElement) break;
    }
    if (pool.layerRef.current) observer.observe(pool.layerRef.current);
    return () => observer.disconnect();
  }, [isActive, measureAndUpdate, pool, scheduleMeasureAndUpdate]);

  useLayoutEffect(() => {
    if (!pool || !isActive) return undefined;
    const placeholder = placeholderRef.current;
    if (!placeholder) return undefined;

    const targets = scrollableAncestors(placeholder);
    for (const target of targets) {
      target.addEventListener('scroll', scheduleMeasureAndUpdate, { passive: true });
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleMeasureAndUpdate();
    };
    window.addEventListener('resize', scheduleMeasureAndUpdate, { passive: true });
    window.addEventListener('pageshow', scheduleMeasureAndUpdate, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    scheduleMeasureAndUpdate();

    return () => {
      for (const target of targets) {
        target.removeEventListener('scroll', scheduleMeasureAndUpdate);
      }
      window.removeEventListener('resize', scheduleMeasureAndUpdate);
      window.removeEventListener('pageshow', scheduleMeasureAndUpdate);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isActive, pool, scheduleMeasureAndUpdate]);

  return (
    <div
      ref={placeholderRef}
      className={className}
      data-preview-pane-id={paneId}
      data-preview-pane-owner-tab-id={ownerTabId}
      data-preview-pane-policy={policy}
      data-preview-pane-persistence={persistence}
      data-preview-pane-mode={mode}
      data-preview-pane-wheel-policy={wheelPolicy}
      data-preview-pane-active={isActive ? 'true' : undefined}
      data-preview-pane-pool-available={pool ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
