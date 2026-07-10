import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import { defaultEditorRegistry } from './default-editors';
import { resolveWorkbenchEditor } from './editor-registry';
import { selectOpenPersistentWorkbenchTabs, selectWorkbenchTabGroupId } from './persistent-editor-selectors';
import { WorkbenchGroupPreviewHostPoolBridge } from './workbench-group-services';
import { WorkbenchEditorPane } from './WorkbenchEditorPane';
import { useWorkbenchStore } from './workbench-store';
import type { WorkbenchTab } from './workbench-types';

interface PersistentEditorSlotRegistration {
  tabId: string;
  groupId: string;
  element: HTMLDivElement;
  generation: number;
}

interface PersistentEditorSlotRegistry {
  allocateGeneration: () => number;
  getSlot: (tabId: string) => PersistentEditorSlotRegistration | null;
  getVersion: () => number;
  isCurrent: (slot: PersistentEditorSlotRegistration) => boolean;
  registerSlot: (slot: PersistentEditorSlotRegistration) => () => void;
  subscribe: (listener: () => void) => () => void;
}

function createPersistentEditorSlotRegistry(): PersistentEditorSlotRegistry {
  const slotsByTabId = new Map<string, PersistentEditorSlotRegistration>();
  const listeners = new Set<() => void>();
  let nextGeneration = 1;
  let version = 0;

  const notify = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    allocateGeneration: () => nextGeneration++,
    getSlot: (tabId) => slotsByTabId.get(tabId) ?? null,
    getVersion: () => version,
    isCurrent: (slot) => slotsByTabId.get(slot.tabId) === slot,
    registerSlot: (slot) => {
      slotsByTabId.set(slot.tabId, slot);
      notify();
      return () => {
        if (slotsByTabId.get(slot.tabId) !== slot) return;
        slotsByTabId.delete(slot.tabId);
        notify();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface PersistentEditorHostContextValue {
  rootRef: RefObject<HTMLDivElement | null>;
  slots: PersistentEditorSlotRegistry;
  layout: PersistentEditorLayoutCoordinator;
}

type PersistentEditorLayoutInteraction = 'panel-resize' | 'tab-drag';

interface PersistentEditorLayoutCoordinator {
  getInteractionVersion: () => number;
  isInteractionActive: (interaction?: PersistentEditorLayoutInteraction) => boolean;
  notifyLayoutChanged: () => void;
  setInteractionActive: (interaction: PersistentEditorLayoutInteraction, active: boolean) => void;
  subscribeInteraction: (listener: () => void) => () => void;
  subscribeLayout: (listener: () => void) => () => void;
}

function createPersistentEditorLayoutCoordinator(): PersistentEditorLayoutCoordinator {
  const activeInteractions = new Set<PersistentEditorLayoutInteraction>();
  const interactionListeners = new Set<() => void>();
  const layoutListeners = new Set<() => void>();
  let interactionVersion = 0;

  const notifyLayoutChanged = () => {
    for (const listener of layoutListeners) listener();
  };

  return {
    getInteractionVersion: () => interactionVersion,
    isInteractionActive: (interaction) => interaction
      ? activeInteractions.has(interaction)
      : activeInteractions.size > 0,
    notifyLayoutChanged,
    setInteractionActive: (interaction, active) => {
      const changed = active
        ? !activeInteractions.has(interaction)
        : activeInteractions.has(interaction);
      if (!changed) return;
      if (active) activeInteractions.add(interaction);
      else activeInteractions.delete(interaction);
      interactionVersion += 1;
      for (const listener of interactionListeners) listener();
      notifyLayoutChanged();
    },
    subscribeInteraction: (listener) => {
      interactionListeners.add(listener);
      return () => interactionListeners.delete(listener);
    },
    subscribeLayout: (listener) => {
      layoutListeners.add(listener);
      return () => layoutListeners.delete(listener);
    },
  };
}

const PersistentEditorHostContext = createContext<PersistentEditorHostContextValue | null>(null);

export function PersistentEditorHostProvider({
  rootRef,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const slotsRef = useRef<PersistentEditorSlotRegistry | null>(null);
  const layoutRef = useRef<PersistentEditorLayoutCoordinator | null>(null);
  if (!slotsRef.current) slotsRef.current = createPersistentEditorSlotRegistry();
  if (!layoutRef.current) layoutRef.current = createPersistentEditorLayoutCoordinator();
  const value = useMemo(() => ({ rootRef, slots: slotsRef.current!, layout: layoutRef.current! }), [rootRef]);

  useEffect(() => {
    const layout = layoutRef.current!;
    const stopPanelResize = () => layout.setInteractionActive('panel-resize', false);
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('[data-workbench-resize-handle]')) return;
      layout.setInteractionActive('panel-resize', true);
    };
    const handleWindowResize = () => layout.notifyLayoutChanged();

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointerup', stopPanelResize, true);
    window.addEventListener('pointercancel', stopPanelResize, true);
    window.addEventListener('blur', stopPanelResize);
    window.addEventListener('resize', handleWindowResize, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointerup', stopPanelResize, true);
      window.removeEventListener('pointercancel', stopPanelResize, true);
      window.removeEventListener('blur', stopPanelResize);
      window.removeEventListener('resize', handleWindowResize);
      stopPanelResize();
    };
  }, []);

  return <PersistentEditorHostContext.Provider value={value}>{children}</PersistentEditorHostContext.Provider>;
}

export function useOptionalPersistentEditorLayoutCoordinator() {
  return useContext(PersistentEditorHostContext)?.layout ?? null;
}

const subscribeToNothing = () => () => undefined;
const getZeroVersion = () => 0;

export function usePersistentEditorLayoutInteractionActive() {
  const layout = useOptionalPersistentEditorLayoutCoordinator();
  useSyncExternalStore(
    layout?.subscribeInteraction ?? subscribeToNothing,
    layout?.getInteractionVersion ?? getZeroVersion,
    layout?.getInteractionVersion ?? getZeroVersion,
  );
  return layout?.isInteractionActive() ?? false;
}

export function PersistentEditorSlot({ tabId, groupId }: { tabId: string; groupId: string }) {
  const hostContext = useContext(PersistentEditorHostContext);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [generation] = useState(() => hostContext?.slots.allocateGeneration() ?? 0);

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!hostContext || !element) return undefined;
    return hostContext.slots.registerSlot({ tabId, groupId, element, generation });
  }, [generation, groupId, hostContext, tabId]);

  return (
    <div
      ref={elementRef}
      className="h-full min-h-0 w-full"
      data-workbench-persistent-editor-slot={tabId}
      data-workbench-group-id={groupId}
      data-workbench-slot-generation={generation}
    />
  );
}

interface PersistentEditorPlacement {
  groupId: string;
  slotGeneration: number;
  slotElement: HTMLDivElement;
  left: number;
  top: number;
  width: number;
  height: number;
}

function samePlacement(left: PersistentEditorPlacement | null, right: PersistentEditorPlacement | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.groupId === right.groupId
    && left.slotGeneration === right.slotGeneration
    && left.slotElement === right.slotElement
    && left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height;
}

function applyPlacementToElement(element: HTMLDivElement | null, placement: PersistentEditorPlacement | null) {
  if (!element) return;
  if (!placement) {
    element.style.visibility = 'hidden';
    element.style.pointerEvents = 'none';
    element.style.left = '0px';
    element.style.top = '0px';
    element.style.width = '0px';
    element.style.height = '0px';
    return;
  }
  element.style.visibility = '';
  element.style.left = `${placement.left}px`;
  element.style.top = `${placement.top}px`;
  element.style.width = `${placement.width}px`;
  element.style.height = `${placement.height}px`;
}

function PersistentEditorHost({ tab }: { tab: WorkbenchTab }) {
  const hostContext = useContext(PersistentEditorHostContext);
  if (!hostContext) throw new Error('PersistentEditorHost must be rendered within PersistentEditorHostProvider.');
  const { rootRef, slots, layout } = hostContext;
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const activateGroup = useWorkbenchStore((state) => state.activateGroup);
  const groupId = selectWorkbenchTabGroupId({ groupsById }, tab.id);
  const isActiveInGroup = groupId !== null && groupsById[groupId]?.activeTabId === tab.id;
  const slotVersion = useSyncExternalStore(slots.subscribe, slots.getVersion, slots.getVersion);
  useSyncExternalStore(layout.subscribeInteraction, layout.getInteractionVersion, layout.getInteractionVersion);
  const layoutInteractionActive = layout.isInteractionActive();
  const panelResizeActive = layout.isInteractionActive('panel-resize');
  const [placement, setPlacement] = useState<PersistentEditorPlacement | null>(null);
  const placementRef = useRef<PersistentEditorPlacement | null>(null);
  const paneElementRef = useRef<HTMLDivElement | null>(null);
  const scheduledMeasurementFrameRef = useRef(0);
  const resolved = resolveWorkbenchEditor(defaultEditorRegistry, tab);
  const hasIframeBackedPreview = resolved.policies.previewHostPolicy !== 'none';

  const measurePlacement = useCallback((commitState = true) => {
    const root = rootRef.current;
    const slot = slots.getSlot(tab.id);
    if (!root || !groupId || !isActiveInGroup || !slot || slot.groupId !== groupId || !slot.element.isConnected) {
      applyPlacementToElement(paneElementRef.current, null);
      if (commitState && placementRef.current) {
        placementRef.current = null;
        setPlacement(null);
      }
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const slotRect = slot.element.getBoundingClientRect();
    if (
      !slots.isCurrent(slot)
      || slot.groupId !== groupId
      || !slot.element.isConnected
      || slotRect.width <= 0
      || slotRect.height <= 0
    ) {
      applyPlacementToElement(paneElementRef.current, null);
      if (commitState && placementRef.current) {
        placementRef.current = null;
        setPlacement(null);
      }
      return;
    }
    const nextPlacement = {
      groupId,
      slotGeneration: slot.generation,
      slotElement: slot.element,
      left: slotRect.left - rootRect.left,
      top: slotRect.top - rootRect.top,
      width: slotRect.width,
      height: slotRect.height,
    };
    applyPlacementToElement(paneElementRef.current, nextPlacement);
    if (commitState && !samePlacement(placementRef.current, nextPlacement)) {
      placementRef.current = nextPlacement;
      setPlacement(nextPlacement);
    }
  }, [groupId, isActiveInGroup, rootRef, slots, tab.id]);

  const schedulePlacementMeasurement = useCallback(() => {
    if (scheduledMeasurementFrameRef.current) return;
    scheduledMeasurementFrameRef.current = window.requestAnimationFrame(() => {
      scheduledMeasurementFrameRef.current = 0;
      measurePlacement(!layout.isInteractionActive());
    });
  }, [layout, measurePlacement]);

  useLayoutEffect(() => {
    measurePlacement();
    const root = rootRef.current;
    const slot = slots.getSlot(tab.id);
    if (!root || !slot || slot.groupId !== groupId) return undefined;

    const resizeObserver = new ResizeObserver(() => {
      measurePlacement(!layout.isInteractionActive());
    });
    resizeObserver.observe(root);
    resizeObserver.observe(slot.element);
    return () => resizeObserver.disconnect();
  }, [groupId, layout, measurePlacement, rootRef, slotVersion, slots, tab.id]);

  useLayoutEffect(() => {
    const unsubscribe = layout.subscribeLayout(schedulePlacementMeasurement);
    return () => {
      unsubscribe();
      if (scheduledMeasurementFrameRef.current) {
        window.cancelAnimationFrame(scheduledMeasurementFrameRef.current);
        scheduledMeasurementFrameRef.current = 0;
      }
    };
  }, [layout, schedulePlacementMeasurement]);

  useLayoutEffect(() => {
    if (!panelResizeActive) {
      measurePlacement();
      return undefined;
    }
    let animationFrame = 0;
    const measureContinuously = () => {
      measurePlacement(false);
      animationFrame = window.requestAnimationFrame(measureContinuously);
    };
    animationFrame = window.requestAnimationFrame(measureContinuously);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [measurePlacement, panelResizeActive]);

  const currentSlot = slots.getSlot(tab.id);
  const isVisible = Boolean(
    isActiveInGroup
    && groupId
    && placement
    && currentSlot
    && currentSlot.groupId === groupId
    && currentSlot.generation === placement.slotGeneration
    && currentSlot.element === placement.slotElement
    && currentSlot.element.isConnected
    && placement.groupId === groupId,
  );
  const location = {
    tabId: tab.id,
    groupId: groupId ?? '',
    isActiveInGroup,
    isVisible,
  };

  const editorPane = (
    <WorkbenchEditorPane
      tab={tab}
      registration={resolved.registration}
      policies={resolved.policies}
      location={location}
      restoreMode="initial-mount"
      className="absolute overflow-hidden"
      elementRef={paneElementRef}
      onFocusCapture={() => {
        if (groupId) activateGroup(groupId);
      }}
      onPointerDownCapture={() => {
        if (groupId) activateGroup(groupId);
      }}
      style={placement ? {
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
        pointerEvents: isVisible && !(hasIframeBackedPreview && layoutInteractionActive) ? 'auto' : 'none',
      } : {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    />
  );

  if (resolved.policies.previewHostPolicy !== 'pooled-per-tab-group') return editorPane;

  return (
    <WorkbenchGroupPreviewHostPoolBridge groupId={groupId}>
      {editorPane}
    </WorkbenchGroupPreviewHostPoolBridge>
  );
}

export function PersistentEditorHostLayer() {
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const persistentTabs = useMemo(
    () => selectOpenPersistentWorkbenchTabs({ tabsById }, defaultEditorRegistry),
    [tabsById],
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
      data-workbench-persistent-editor-host-layer
    >
      {persistentTabs.map((tab) => <PersistentEditorHost key={tab.id} tab={tab} />)}
    </div>
  );
}
