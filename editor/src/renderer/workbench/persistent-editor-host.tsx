import {
  createContext,
  useCallback,
  useContext,
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
  if (!slotsRef.current) slotsRef.current = createPersistentEditorSlotRegistry();
  const value = useMemo(() => ({ rootRef, slots: slotsRef.current! }), [rootRef]);
  return <PersistentEditorHostContext.Provider value={value}>{children}</PersistentEditorHostContext.Provider>;
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

function PersistentEditorHost({ tab }: { tab: WorkbenchTab }) {
  const hostContext = useContext(PersistentEditorHostContext);
  if (!hostContext) throw new Error('PersistentEditorHost must be rendered within PersistentEditorHostProvider.');
  const { rootRef, slots } = hostContext;
  const groupsById = useWorkbenchStore((state) => state.groupsById);
  const activateGroup = useWorkbenchStore((state) => state.activateGroup);
  const groupId = selectWorkbenchTabGroupId({ groupsById }, tab.id);
  const isActiveInGroup = groupId !== null && groupsById[groupId]?.activeTabId === tab.id;
  const slotVersion = useSyncExternalStore(slots.subscribe, slots.getVersion, slots.getVersion);
  const [placement, setPlacement] = useState<PersistentEditorPlacement | null>(null);
  const resolved = resolveWorkbenchEditor(defaultEditorRegistry, tab);

  const measurePlacement = useCallback(() => {
    const root = rootRef.current;
    const slot = slots.getSlot(tab.id);
    if (!root || !groupId || !isActiveInGroup || !slot || slot.groupId !== groupId || !slot.element.isConnected) {
      setPlacement(null);
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
      setPlacement(null);
      return;
    }
    setPlacement({
      groupId,
      slotGeneration: slot.generation,
      slotElement: slot.element,
      left: slotRect.left - rootRect.left,
      top: slotRect.top - rootRect.top,
      width: slotRect.width,
      height: slotRect.height,
    });
  }, [groupId, isActiveInGroup, rootRef, slots, tab.id]);

  useLayoutEffect(() => {
    measurePlacement();
    const root = rootRef.current;
    const slot = slots.getSlot(tab.id);
    if (!root || !slot || slot.groupId !== groupId) return undefined;

    const resizeObserver = new ResizeObserver(measurePlacement);
    resizeObserver.observe(root);
    resizeObserver.observe(slot.element);
    return () => resizeObserver.disconnect();
  }, [groupId, measurePlacement, rootRef, slotVersion, slots, tab.id]);

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

  return (
    <WorkbenchEditorPane
      tab={tab}
      registration={resolved.registration}
      policies={resolved.policies}
      location={location}
      restoreMode="initial-mount"
      className="absolute overflow-hidden"
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
        pointerEvents: isVisible ? 'auto' : 'none',
      } : {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        pointerEvents: 'none',
      }}
    />
  );
}

export function PersistentEditorHostLayer() {
  const tabsById = useWorkbenchStore((state) => state.tabsById);
  const persistentTabs = useMemo(
    () => selectOpenPersistentWorkbenchTabs({ tabsById }, defaultEditorRegistry),
    [tabsById],
  );

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-workbench-persistent-editor-host-layer>
      {persistentTabs.map((tab) => <PersistentEditorHost key={tab.id} tab={tab} />)}
    </div>
  );
}
