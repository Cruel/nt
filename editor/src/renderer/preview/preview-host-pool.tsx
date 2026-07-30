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
import { usePreferencesStore } from '@/stores/preferences-store';
import {
  routePreviewWheelToScrollAncestors,
  type PreviewWheelMessage,
} from '@/preview/preview-wheel-routing';
import type { PreviewMode, PreviewToEditorMessage } from '../../shared/preview-protocol';
import type { ShaderVariant } from '../../shared/shader-variants';
import type { PreviewWheelPolicy } from '../../shared/preview-wheel-routing';

export type PreviewPanePolicy = 'pooled-per-tab-group' | 'dedicated-while-open';
export type PreviewPanePersistence = 'derived';

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
  policy?: PreviewPanePolicy;
  persistence?: PreviewPanePersistence;
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
  hostGeneration: number;
  nativeHostGeneration(): number | null;
  transportGeneration(): number | null;
  activeShaderVariant(): ShaderVariant | null;
  committedContentKey(): string | null;
  commitContent(key: string): void;
  nextFocusedApplySequence(): number;
  subscribeReady(listener: () => void): () => void;
  reveal(): void;
  send<TResult>(
    command: (controller: EnginePreviewController) => Promise<TResult>,
  ): Promise<TResult>;
}

interface PendingLeaseCommand {
  cancelled: boolean;
  cancel(): void;
}

interface PreviewHostRetention {
  ownerTabId: string;
  paneId: string;
}

interface PreviewHostRecord {
  hostId: string;
  poolKey: string | null;
  retention: PreviewHostRetention | null;
  retainedRect?: PreviewHostRect;
  committedContentKey: string | null;
  lease: PreviewHostLeaseInfo | null;
}

interface PreviewHostLeaseInfo {
  leaseId: string;
  groupId: string;
  ownerTabId: string;
  paneId: string;
  mode: PreviewMode;
  wheelPolicy: PreviewWheelPolicy;
  hostGeneration: number;
  policy: PreviewPanePolicy;
  visible: boolean;
  rect?: PreviewHostRect;
}

export interface PreviewHostPoolApi {
  activeTabId: string | null;
  layerRef: RefObject<HTMLDivElement | null>;
  claimHost: (request: PreviewHostClaimRequest) => PreviewHostLease;
  markHostReady: (
    hostId: string,
    ready: Extract<PreviewToEditorMessage, { type: 'ready' }>,
  ) => void;
  releaseHost: (leaseId: string) => void;
  revealHost: (leaseId: string) => void;
  updateHostRect: (leaseId: string, rect: PreviewHostRect | undefined) => void;
  registerPlaceholder: (leaseId: string, element: HTMLElement | null) => void;
}

const PreviewHostPoolContext = createContext<PreviewHostPoolApi | null>(null);

interface PreviewHostGroupRegistration {
  owner: object;
  activeTabId: string | null;
}

interface PreviewHostManagerApi {
  layerRef: RefObject<HTMLDivElement | null>;
  claimHost: (groupId: string, request: PreviewHostClaimRequest) => PreviewHostLease;
  markHostReady: PreviewHostPoolApi['markHostReady'];
  releaseHost: PreviewHostPoolApi['releaseHost'];
  revealHost: PreviewHostPoolApi['revealHost'];
  updateHostRect: PreviewHostPoolApi['updateHostRect'];
  registerPlaceholder: PreviewHostPoolApi['registerPlaceholder'];
  registerGroup: (groupId: string, owner: object, activeTabId: string | null) => void;
  unregisterGroup: (groupId: string, owner: object) => void;
}

const PreviewHostManagerContext = createContext<PreviewHostManagerApi | null>(null);

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

function retainedHostStyle(rect: PreviewHostRect): CSSProperties {
  return {
    position: 'absolute',
    left: -100000,
    top: -100000,
    width: rect.width,
    height: rect.height,
    visibility: 'visible',
    opacity: 0,
    pointerEvents: 'none',
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
    // Do not use `visibility: hidden` for a claimed Web preview host. Chromium suspends
    // requestAnimationFrame for a hidden iframe, which prevents native owner-thread asset
    // finalization from advancing while the focused candidate is preparing. Keep the iframe
    // browser-visible but visually transparent until the candidate commits.
    visibility: 'visible',
    opacity: visible ? 1 : 0,
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

function concealHostElement(element: HTMLElement) {
  element.style.opacity = '0';
  element.style.pointerEvents = 'none';
  element.setAttribute('aria-hidden', 'true');
}

function revealHostElement(
  element: HTMLElement,
  rect: PreviewHostRect,
  pointerEventsDisabled: boolean,
) {
  applyMeasuredHostStyle(element, rect);
  element.style.visibility = 'visible';
  element.style.opacity = '1';
  element.style.pointerEvents = pointerEventsDisabled ? 'none' : 'auto';
  element.style.overflow = 'hidden';
  element.removeAttribute('aria-hidden');
}

function sameHostRect(left: PreviewHostRect | undefined, right: PreviewHostRect | undefined) {
  const epsilon = 0.25;
  return Boolean(
    left &&
    right &&
    Math.abs(left.left - right.left) <= epsilon &&
    Math.abs(left.top - right.top) <= epsilon &&
    Math.abs(left.width - right.width) <= epsilon &&
    Math.abs(left.height - right.height) <= epsilon,
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
  markHostReady: (
    hostId: string,
    ready: Extract<PreviewToEditorMessage, { type: 'ready' }>,
  ) => void;
  registerHostElement: (hostId: string, element: HTMLElement | null) => void;
  routeWheel: (hostId: string, message: PreviewWheelMessage) => void;
  onActivateOwnerTab?: (groupId: string, ownerTabId: string) => void;
  pointerEventsDisabled: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<EnginePreviewController | null>(null);
  const readyRef = useRef(false);
  const previousMeasuredRectRef = useRef<{ leaseId: string | null; renderable: boolean }>({
    leaseId: null,
    renderable: false,
  });
  const showPreviewFpsCounter = usePreferencesStore((state) => state.showPreviewFpsCounter);
  const previewFpsCap = usePreferencesStore((state) => state.previewFpsCap);
  const previewSettingsRef = useRef({
    showFpsCounter: showPreviewFpsCounter,
    fpsCap: previewFpsCap,
  });
  previewSettingsRef.current = { showFpsCounter: showPreviewFpsCounter, fpsCap: previewFpsCap };
  const activateOwningTab = useCallback(() => {
    if (host.lease) onActivateOwnerTab?.(host.lease.groupId, host.lease.ownerTabId);
  }, [host.lease, onActivateOwnerTab]);
  const handlePreviewMessage = useCallback(
    (message: PreviewToEditorMessage) => {
      if (message.type === 'ready') {
        markHostReady(host.hostId, message);
        readyRef.current = true;
        void controllerRef.current
          ?.setEngineSettings(previewSettingsRef.current)
          .catch(() => undefined);
      }
      if (message.type === 'preview-interacted') activateOwningTab();
      if (message.type === 'preview-wheel') routeWheel(host.hostId, message);
    },
    [activateOwningTab, host.hostId, markHostReady, routeWheel],
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
    audioEnabled: false,
    wheelPolicy: 'editor-scroll',
    onReady: () => undefined,
    onMessage: handlePreviewMessage,
    onError: () => undefined,
  });
  controllerRef.current = controller;
  const { iframeRef, iframeKey, iframeSrc, loadSession } = controller;

  useEffect(() => {
    registerController(host.hostId, controller);
    return () => registerController(host.hostId, null);
  }, [controller, host.hostId, registerController]);

  useEffect(() => {
    void loadSession().catch(() => undefined);
  }, [loadSession]);

  useEffect(() => {
    if (!readyRef.current) return;
    void controller.setEngineSettings(previewSettingsRef.current).catch(() => undefined);
  }, [controller, previewFpsCap, showPreviewFpsCounter]);

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
  const isActive = Boolean(host.lease && rect);
  const isVisible = Boolean(host.lease?.visible && rect);
  const style =
    host.lease && rect
      ? rectHostStyle(rect, pointerEventsDisabled, isVisible)
      : host.retention && host.retainedRect
        ? retainedHostStyle(host.retainedRect)
        : hiddenHostStyle();

  useLayoutEffect(() => {
    const element = hostRef.current;
    registerHostElement(host.hostId, element);
    if (element && rect) applyMeasuredHostStyle(element, rect);
    return () => registerHostElement(host.hostId, null);
  }, [host.hostId, rect, registerHostElement]);

  useEffect(() => {
    const sendActivity = async () => {
      try {
        await controller.setPreviewActivity(isActive, isVisible);
        if (isVisible) await controller.requestPreviewState();
      } catch {
        // Activity is best-effort; preview content commands remain lease-scoped.
      }
    };
    void sendActivity();
  }, [controller, isActive, isVisible]);

  useEffect(() => {
    const leaseId = host.lease?.leaseId ?? null;
    const renderable = Boolean(rect && rect.width > 0.5 && rect.height > 0.5);
    const previous = previousMeasuredRectRef.current;
    previousMeasuredRectRef.current = { leaseId, renderable };
    if (
      !leaseId ||
      previous.leaseId !== leaseId ||
      previous.renderable ||
      !renderable ||
      !host.lease?.visible
    ) {
      return;
    }

    let cancelled = false;
    const refreshAfterGeometrySettles = async () => {
      await controller.setPreviewActivity(true, false);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      await controller.setPreviewActivity(true, true);
      await controller.requestPreviewState();
    };
    void refreshAfterGeometrySettles().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [controller, host.lease?.leaseId, host.lease?.visible, rect]);

  return (
    <div
      ref={hostRef}
      className="bg-zinc-950"
      data-preview-host-id={host.hostId}
      data-preview-host-claimed={host.lease ? 'true' : undefined}
      data-preview-host-pane-id={host.lease?.paneId ?? host.retention?.paneId}
      data-preview-host-owner-tab-id={host.lease?.ownerTabId ?? host.retention?.ownerTabId}
      data-preview-host-group-id={host.lease?.groupId}
      data-preview-host-pool-key={host.poolKey ?? undefined}
      data-preview-host-policy={
        host.lease?.policy ?? (host.retention ? 'dedicated-while-open' : 'pooled-per-tab-group')
      }
      data-preview-host-lease-id={host.lease?.leaseId}
      data-preview-host-visible={isVisible ? 'true' : undefined}
      data-preview-host-placement={
        rect
          ? 'measured-rect'
          : host.retention && host.retainedRect
            ? 'retained-offscreen'
            : 'hidden'
      }
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

export function PreviewHostManagerProvider({
  onActivateOwnerTab,
  pointerEventsDisabled = false,
  retainedOwnerTabIds,
  retainedPoolKeys,
  layerId = 'workbench',
  children,
}: {
  onActivateOwnerTab?: (groupId: string, ownerTabId: string) => void;
  pointerEventsDisabled?: boolean;
  retainedOwnerTabIds?: readonly string[];
  retainedPoolKeys?: readonly string[];
  layerId?: string;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const controllersRef = useRef(new Map<string, EnginePreviewController>());
  const readyHostIdsRef = useRef(new Set<string>());
  const readyInfoByHostIdRef = useRef(
    new Map<string, Extract<PreviewToEditorMessage, { type: 'ready' }>>(),
  );
  const readyListenersByHostIdRef = useRef(new Map<string, Set<() => void>>());
  const leaseGenerationByHostIdRef = useRef(new Map<string, number>());
  const focusedApplySequenceByHostIdRef = useRef(new Map<string, number>());
  const hostElementsRef = useRef(new Map<string, HTMLElement>());
  const placeholdersByLeaseRef = useRef(new Map<string, HTMLElement>());
  const pendingByLeaseRef = useRef(new Map<string, Set<PendingLeaseCommand>>());
  const [hosts, setHosts] = useState<PreviewHostRecord[]>([]);
  const [resizePointerEventsDisabled, setResizePointerEventsDisabled] = useState(false);
  const hostsRef = useRef<PreviewHostRecord[]>([]);
  const nextHostIndexRef = useRef(0);
  const groupRegistrationsRef = useRef(new Map<string, PreviewHostGroupRegistration>());
  const effectivePointerEventsDisabled = pointerEventsDisabled || resizePointerEventsDisabled;
  const pointerEventsDisabledRef = useRef(effectivePointerEventsDisabled);
  pointerEventsDisabledRef.current = effectivePointerEventsDisabled;

  const updateHosts = useCallback(
    (update: (current: PreviewHostRecord[]) => PreviewHostRecord[]) => {
      const current = hostsRef.current;
      const next = update(current);
      if (next === current) return;
      hostsRef.current = next;
      setHosts(next);
    },
    [],
  );

  const registerController = useCallback(
    (hostId: string, controller: EnginePreviewController | null) => {
      if (controller) {
        controllersRef.current.set(hostId, controller);
      } else {
        controllersRef.current.delete(hostId);
        queueMicrotask(() => {
          if (controllersRef.current.has(hostId)) return;
          readyHostIdsRef.current.delete(hostId);
          readyInfoByHostIdRef.current.delete(hostId);
          updateHosts((current) =>
            current.map((host) =>
              host.hostId === hostId && host.committedContentKey
                ? { ...host, committedContentKey: null }
                : host,
            ),
          );
        });
      }
    },
    [updateHosts],
  );

  const markHostReady = useCallback(
    (hostId: string, ready: Extract<PreviewToEditorMessage, { type: 'ready' }>) => {
      const previous = readyInfoByHostIdRef.current.get(hostId);
      const runtimeChanged = Boolean(
        previous &&
        (previous.hostGeneration !== ready.hostGeneration ||
          previous.transportGeneration !== ready.transportGeneration),
      );
      readyInfoByHostIdRef.current.set(hostId, ready);
      readyHostIdsRef.current.add(hostId);
      if (runtimeChanged) {
        updateHosts((current) =>
          current.map((host) =>
            host.hostId === hostId
              ? {
                  ...host,
                  committedContentKey: null,
                  lease: host.lease ? { ...host.lease, visible: false } : null,
                }
              : host,
          ),
        );
      }
      for (const listener of readyListenersByHostIdRef.current.get(hostId) ?? []) listener();
    },
    [updateHosts],
  );

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

  const cancelLeaseWork = useCallback((leaseId: string) => {
    const pending = pendingByLeaseRef.current.get(leaseId);
    if (pending) {
      for (const command of pending) command.cancel();
      pendingByLeaseRef.current.delete(leaseId);
    }
    placeholdersByLeaseRef.current.delete(leaseId);
  }, []);

  const releaseHost = useCallback(
    (leaseId: string) => {
      const host = hostsRef.current.find((candidate) => candidate.lease?.leaseId === leaseId);
      if (host?.lease?.policy === 'pooled-per-tab-group') {
        const element = hostElementsRef.current.get(host.hostId);
        if (element) concealHostElement(element);
      }
      cancelLeaseWork(leaseId);
      updateHosts((current) => {
        let changed = false;
        const next = current.map((candidate) => {
          if (candidate.lease?.leaseId !== leaseId) return candidate;
          changed = true;
          return {
            ...candidate,
            retainedRect: candidate.retention
              ? (candidate.lease.rect ?? candidate.retainedRect)
              : candidate.retainedRect,
            lease: null,
          };
        });
        return changed ? next : current;
      });
    },
    [cancelLeaseWork, updateHosts],
  );

  const routeWheel = useCallback((hostId: string, message: PreviewWheelMessage) => {
    const host = hostsRef.current.find((candidate) => candidate.hostId === hostId);
    const lease = host?.lease;
    if (
      !lease ||
      lease.leaseId !== message.routeId ||
      groupRegistrationsRef.current.get(lease.groupId)?.activeTabId !== lease.ownerTabId ||
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
  }, []);

  const updateHostRect = useCallback(
    (leaseId: string, rect: PreviewHostRect | undefined) => {
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
      updateHosts((current) => {
        let changed = false;
        const next = current.map((host) => {
          if (host.lease?.leaseId !== leaseId) return host;
          if (rect && sameHostRect(host.lease.rect, rect)) return host;
          changed = true;
          return {
            ...host,
            retainedRect: host.retention && rect ? rect : host.retainedRect,
            lease: { ...host.lease, rect },
          };
        });
        return changed ? next : current;
      });
    },
    [updateHosts],
  );

  const revealHost = useCallback(
    (leaseId: string) => {
      const host = hostsRef.current.find((candidate) => candidate.lease?.leaseId === leaseId);
      if (host?.lease?.rect) {
        const element = hostElementsRef.current.get(host.hostId);
        if (element) {
          revealHostElement(element, host.lease.rect, pointerEventsDisabledRef.current);
        }
      }
      updateHosts((current) => {
        let changed = false;
        const next = current.map((host) => {
          if (host.lease?.leaseId !== leaseId || host.lease.visible) return host;
          changed = true;
          return { ...host, lease: { ...host.lease, visible: true } };
        });
        return changed ? next : current;
      });
    },
    [updateHosts],
  );

  const sendForLease = useCallback(
    <TResult,>(
      leaseId: string,
      hostId: string,
      command: (controller: EnginePreviewController) => Promise<TResult>,
    ) => {
      if (!isCurrentLease(leaseId, hostId)) {
        return Promise.reject(new Error('Preview host lease is no longer current.'));
      }
      let rejectCancellation: ((error: Error) => void) | null = null;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const pending: PendingLeaseCommand = {
        cancelled: false,
        cancel() {
          if (pending.cancelled) return;
          pending.cancelled = true;
          rejectCancellation?.(
            new Error('Preview host command was cancelled because the lease was released.'),
          );
        },
      };
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

      return Promise.race([runWhenConnected(), cancellation]).finally(() => {
        leasePending.delete(pending);
        if (leasePending.size === 0) pendingByLeaseRef.current.delete(leaseId);
      });
    },
    [isCurrentLease],
  );

  const claimHost = useCallback(
    (groupId: string, request: PreviewHostClaimRequest): PreviewHostLease => {
      const leaseId = nextPreviewLeaseId();
      const policy = request.policy ?? 'pooled-per-tab-group';
      const retention =
        policy === 'dedicated-while-open'
          ? { ownerTabId: request.ownerTabId, paneId: request.paneId }
          : null;
      const currentHost = retention
        ? hostsRef.current.find(
            (host) =>
              host.retention?.ownerTabId === retention.ownerTabId &&
              host.retention.paneId === retention.paneId,
          )
        : (hostsRef.current.find(
            (host) =>
              host.poolKey === groupId && !host.retention && host.lease?.paneId === request.paneId,
          ) ??
          hostsRef.current.find(
            (host) => host.poolKey === groupId && !host.retention && !host.lease,
          ));
      const claimedHostId =
        currentHost?.hostId ?? nextPreviewHostId(layerId, nextHostIndexRef.current++);
      if (currentHost?.lease) {
        cancelLeaseWork(currentHost.lease.leaseId);
        if (currentHost.lease.policy === 'pooled-per-tab-group') {
          const element = hostElementsRef.current.get(currentHost.hostId);
          if (element) concealHostElement(element);
        }
      }
      const hostGeneration = (leaseGenerationByHostIdRef.current.get(claimedHostId) ?? 0) + 1;
      leaseGenerationByHostIdRef.current.set(claimedHostId, hostGeneration);
      const retainedContentKey = retention ? (currentHost?.committedContentKey ?? null) : null;
      const leaseInfo: PreviewHostLeaseInfo = {
        leaseId,
        groupId,
        ownerTabId: request.ownerTabId,
        paneId: request.paneId,
        mode: request.mode,
        wheelPolicy: request.wheelPolicy ?? 'editor-scroll',
        hostGeneration,
        policy,
        visible: retainedContentKey !== null,
        rect: request.initialRect,
      };
      updateHosts((current) => {
        if (current.some((host) => host.hostId === claimedHostId)) {
          return current.map((host) =>
            host.hostId === claimedHostId
              ? {
                  ...host,
                  poolKey: retention ? null : groupId,
                  retention: retention ?? host.retention,
                  retainedRect: request.initialRect ?? host.retainedRect,
                  committedContentKey: retainedContentKey,
                  lease: leaseInfo,
                }
              : host,
          );
        }
        return [
          ...current,
          {
            hostId: claimedHostId,
            poolKey: retention ? null : groupId,
            retention,
            retainedRect: request.initialRect,
            committedContentKey: null,
            lease: leaseInfo,
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
        hostGeneration,
        nativeHostGeneration: () =>
          readyInfoByHostIdRef.current.get(claimedHostId)?.hostGeneration ?? null,
        transportGeneration: () =>
          readyInfoByHostIdRef.current.get(claimedHostId)?.transportGeneration ?? null,
        activeShaderVariant: () =>
          readyInfoByHostIdRef.current.get(claimedHostId)?.activeShaderVariant ?? null,
        committedContentKey: () =>
          hostsRef.current.find((host) => host.hostId === claimedHostId)?.committedContentKey ??
          null,
        commitContent: (key) => {
          if (!isCurrentLease(leaseId, claimedHostId)) return;
          updateHosts((current) =>
            current.map((host) =>
              host.hostId === claimedHostId ? { ...host, committedContentKey: key } : host,
            ),
          );
        },
        nextFocusedApplySequence: () => {
          const next = (focusedApplySequenceByHostIdRef.current.get(claimedHostId) ?? 0) + 1;
          focusedApplySequenceByHostIdRef.current.set(claimedHostId, next);
          return next;
        },
        subscribeReady: (listener) => {
          const listeners = readyListenersByHostIdRef.current.get(claimedHostId) ?? new Set();
          listeners.add(listener);
          readyListenersByHostIdRef.current.set(claimedHostId, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) readyListenersByHostIdRef.current.delete(claimedHostId);
          };
        },
        reveal: () => revealHost(leaseId),
        send: (command) => sendForLease(leaseId, claimedHostId, command),
      };
    },
    [cancelLeaseWork, isCurrentLease, layerId, revealHost, sendForLease, updateHosts],
  );

  useLayoutEffect(() => {
    if (!retainedOwnerTabIds && !retainedPoolKeys) return;
    const retainedOwners = retainedOwnerTabIds ? new Set(retainedOwnerTabIds) : null;
    const retainedPools = retainedPoolKeys ? new Set(retainedPoolKeys) : null;
    const removed = hostsRef.current.filter((host) => {
      if (host.retention) {
        return Boolean(retainedOwners && !retainedOwners.has(host.retention.ownerTabId));
      }
      return Boolean(host.poolKey && retainedPools && !retainedPools.has(host.poolKey));
    });
    if (removed.length === 0) return;

    for (const host of removed) {
      if (host.lease) cancelLeaseWork(host.lease.leaseId);
      readyHostIdsRef.current.delete(host.hostId);
      readyInfoByHostIdRef.current.delete(host.hostId);
      readyListenersByHostIdRef.current.delete(host.hostId);
      leaseGenerationByHostIdRef.current.delete(host.hostId);
      focusedApplySequenceByHostIdRef.current.delete(host.hostId);
      hostElementsRef.current.delete(host.hostId);
      controllersRef.current.delete(host.hostId);
    }
    const removedHostIds = new Set(removed.map((host) => host.hostId));
    updateHosts((current) => current.filter((host) => !removedHostIds.has(host.hostId)));
  }, [cancelLeaseWork, retainedOwnerTabIds, retainedPoolKeys, updateHosts]);

  const releaseGroupLeases = useCallback(
    (groupId: string, activeTabId: string | null) => {
      for (const host of hostsRef.current) {
        if (
          !host.lease ||
          host.lease.groupId !== groupId ||
          host.lease.ownerTabId === activeTabId
        ) {
          continue;
        }
        cancelLeaseWork(host.lease.leaseId);
        if (host.lease.policy === 'pooled-per-tab-group') {
          const element = hostElementsRef.current.get(host.hostId);
          if (element) concealHostElement(element);
        }
      }
      updateHosts((current) => {
        let changed = false;
        const next = current.map((host) => {
          if (
            !host.lease ||
            host.lease.groupId !== groupId ||
            host.lease.ownerTabId === activeTabId
          ) {
            return host;
          }
          changed = true;
          return {
            ...host,
            retainedRect: host.retention
              ? (host.lease.rect ?? host.retainedRect)
              : host.retainedRect,
            lease: null,
          };
        });
        return changed ? next : current;
      });
    },
    [cancelLeaseWork, updateHosts],
  );

  const registerGroup = useCallback(
    (groupId: string, owner: object, activeTabId: string | null) => {
      groupRegistrationsRef.current.set(groupId, { owner, activeTabId });
      releaseGroupLeases(groupId, activeTabId);
    },
    [releaseGroupLeases],
  );

  const unregisterGroup = useCallback(
    (groupId: string, owner: object) => {
      if (groupRegistrationsRef.current.get(groupId)?.owner !== owner) return;
      groupRegistrationsRef.current.delete(groupId);
      releaseGroupLeases(groupId, null);
    },
    [releaseGroupLeases],
  );

  useEffect(() => {
    const startsResizeDrag = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          '[data-separator], [role="separator"], .cursor-col-resize, .cursor-row-resize',
        ),
      );
    };

    const stopResizeDrag = () => setResizePointerEventsDisabled(false);
    const handlePointerDown = (event: PointerEvent) => {
      if (startsResizeDrag(event.target)) setResizePointerEventsDisabled(true);
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', stopResizeDrag, true);
    window.addEventListener('pointercancel', stopResizeDrag, true);
    window.addEventListener('blur', stopResizeDrag);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', stopResizeDrag, true);
      window.removeEventListener('pointercancel', stopResizeDrag, true);
      window.removeEventListener('blur', stopResizeDrag);
    };
  }, []);

  const value = useMemo<PreviewHostManagerApi>(
    () => ({
      layerRef,
      claimHost,
      markHostReady,
      releaseHost,
      revealHost,
      updateHostRect,
      registerPlaceholder,
      registerGroup,
      unregisterGroup,
    }),
    [
      claimHost,
      markHostReady,
      registerGroup,
      registerPlaceholder,
      releaseHost,
      revealHost,
      unregisterGroup,
      updateHostRect,
    ],
  );

  return (
    <PreviewHostManagerContext.Provider value={value}>
      {children}
      <div
        ref={layerRef}
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        data-preview-host-layer={layerId}
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
            pointerEventsDisabled={effectivePointerEventsDisabled}
          />
        ))}
      </div>
    </PreviewHostManagerContext.Provider>
  );
}

function PreviewHostPoolScope({
  manager,
  groupId,
  activeTabId,
  children,
}: {
  manager: PreviewHostManagerApi;
  groupId: string;
  activeTabId: string | null;
  children: ReactNode;
}) {
  const ownerRef = useRef<object | null>(null);
  if (!ownerRef.current) ownerRef.current = {};
  const owner = ownerRef.current;

  useLayoutEffect(() => {
    manager.registerGroup(groupId, owner, activeTabId);
  }, [activeTabId, groupId, manager, owner]);

  useLayoutEffect(
    () => () => {
      manager.unregisterGroup(groupId, owner);
    },
    [groupId, manager, owner],
  );

  const claimHost = useCallback(
    (request: PreviewHostClaimRequest) => manager.claimHost(groupId, request),
    [groupId, manager],
  );
  const value = useMemo<PreviewHostPoolApi>(
    () => ({
      activeTabId,
      layerRef: manager.layerRef,
      claimHost,
      markHostReady: manager.markHostReady,
      releaseHost: manager.releaseHost,
      revealHost: manager.revealHost,
      updateHostRect: manager.updateHostRect,
      registerPlaceholder: manager.registerPlaceholder,
    }),
    [activeTabId, claimHost, manager],
  );

  return (
    <PreviewHostPoolContext.Provider value={value}>{children}</PreviewHostPoolContext.Provider>
  );
}

export function PreviewHostPoolProvider({
  groupId,
  activeTabId,
  onActivateOwnerTab,
  pointerEventsDisabled = false,
  retainedOwnerTabIds,
  children,
}: {
  groupId: string;
  activeTabId: string | null;
  onActivateOwnerTab?: (ownerTabId: string) => void;
  pointerEventsDisabled?: boolean;
  retainedOwnerTabIds?: readonly string[];
  children: ReactNode;
}) {
  const manager = useContext(PreviewHostManagerContext);
  if (manager) {
    return (
      <PreviewHostPoolScope manager={manager} groupId={groupId} activeTabId={activeTabId}>
        {children}
      </PreviewHostPoolScope>
    );
  }

  return (
    <PreviewHostManagerProvider
      layerId={groupId}
      pointerEventsDisabled={pointerEventsDisabled}
      retainedOwnerTabIds={retainedOwnerTabIds}
      retainedPoolKeys={[groupId]}
      onActivateOwnerTab={(claimedGroupId, ownerTabId) => {
        if (claimedGroupId === groupId) onActivateOwnerTab?.(ownerTabId);
      }}
    >
      <PreviewHostManagerContext.Consumer>
        {(standaloneManager) =>
          standaloneManager ? (
            <PreviewHostPoolScope
              manager={standaloneManager}
              groupId={groupId}
              activeTabId={activeTabId}
            >
              {children}
            </PreviewHostPoolScope>
          ) : null
        }
      </PreviewHostManagerContext.Consumer>
    </PreviewHostManagerProvider>
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
  enabled = true,
  children,
  className = 'relative min-h-0 flex-1 overflow-hidden bg-zinc-950',
  onLease,
}: {
  ownerTabId: string;
  paneId: string;
  policy?: PreviewPanePolicy;
  persistence?: PreviewPanePersistence;
  wheelPolicy?: PreviewWheelPolicy;
  mode: PreviewMode;
  enabled?: boolean;
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
  const isActive = enabled && pool?.activeTabId === ownerTabId;
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
      policy,
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
    policy,
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

  useLayoutEffect(() => {
    if (!pool || !isActive) return undefined;

    let animationFrame = 0;
    const synchronizePlacement = () => {
      measureAndUpdate();
      animationFrame = window.requestAnimationFrame(synchronizePlacement);
    };
    animationFrame = window.requestAnimationFrame(synchronizePlacement);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isActive, measureAndUpdate, pool]);

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
      data-preview-pane-enabled={enabled ? 'true' : undefined}
      data-preview-pane-active={isActive ? 'true' : undefined}
      data-preview-pane-pool-available={pool ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
