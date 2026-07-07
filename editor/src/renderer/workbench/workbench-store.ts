import { create } from 'zustand';
import {
  activateWorkbenchGroup,
  activateWorkbenchTab,
  closeAllWorkbenchTabsInGroup,
  closeOtherWorkbenchTabs,
  closeProjectWorkbenchTabs,
  dockWorkbenchTabToGroupEdge,
  closeWorkbenchTab,
  closeWorkbenchTabs,
  closeWorkbenchTabsToRight,
  createInitialWorkbenchState,
  moveWorkbenchTab,
  moveWorkbenchTabWithinGroup,
  openWorkbenchTab,
  reopenLastClosedWorkbenchTab,
  restoreProjectWorkbenchStatePreservingGlobalTabs,
  restoreShellWorkbenchState,
  serializeProjectWorkbenchState,
  serializeShellWorkbenchState,
  setWorkbenchSplitSizesByChild,
  setWorkbenchTabDirty,
  splitWorkbenchGroup,
} from './workbench-model';
import type {
  DockWorkbenchTabOptions,
  MoveWorkbenchTabOptions,
  OpenWorkbenchTabOptions,
  SplitWorkbenchGroupOptions,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';
import type { SerializedWorkbenchState } from '../../shared/project-schema/editor-project-state';
import {
  captureWorkbenchTabState,
  captureWorkbenchTabStates,
  clearWorkbenchTabStates,
  pruneWorkbenchTabStates,
  restoreWorkbenchTabState,
  setWorkbenchTabState,
} from './workbench-tab-state';

interface WorkbenchStore extends WorkbenchState {
  openTab: (tab: WorkbenchTab, options?: OpenWorkbenchTabOptions) => void;
  activateTab: (groupId: string, tabId: string) => void;
  activateGroup: (groupId: string) => void;
  closeTab: (groupId: string, tabId: string) => void;
  closeTabs: (groupId: string, tabIds: string[]) => void;
  closeOtherTabs: (groupId: string, tabId: string) => void;
  closeTabsToRight: (groupId: string, tabId: string) => void;
  closeAllTabsInGroup: (groupId: string) => void;
  splitGroup: (options: SplitWorkbenchGroupOptions) => void;
  setSplitSizesByChild: (splitId: string, sizesByChild: Record<string, number>) => void;
  dockTabToGroupEdge: (options: DockWorkbenchTabOptions) => void;
  moveTab: (options: MoveWorkbenchTabOptions) => void;
  moveTabWithinGroup: (groupId: string, tabId: string, toIndex: number) => void;
  setTabDirty: (tabId: string, dirty: boolean) => void;
  reopenLastClosedTab: () => void;
  resetWorkbench: () => void;
  closeProjectTabs: () => void;
  replaceWorkbench: (state: WorkbenchState) => void;
  restoreProjectWorkbench: (serialized: SerializedWorkbenchState | undefined, project: unknown) => WorkbenchState;
  restoreShellWorkbench: (serialized: WorkbenchState | null | undefined, project: unknown, projectWorkbench: WorkbenchState) => WorkbenchState;
  serializeProjectWorkbench: () => SerializedWorkbenchState | null;
  serializeShellWorkbench: () => WorkbenchState;
}

let nextId = 1;
function createId(prefix: string) {
  const id = `${prefix}:${nextId}`;
  nextId += 1;
  return id;
}

function toStoreState(state: WorkbenchState): WorkbenchState {
  return {
    layout: state.layout,
    groupsById: state.groupsById,
    tabsById: state.tabsById,
    activeGroupId: state.activeGroupId,
    recentlyClosedTabs: state.recentlyClosedTabs,
  };
}

function tabIdsInWorkbench(state: Pick<WorkbenchState, 'tabsById'>): string[] {
  return Object.keys(state.tabsById);
}

function tabIdsInGroup(state: WorkbenchState, groupId: string, tabIds?: string[]): string[] {
  const group = state.groupsById[groupId];
  if (!group) return [];
  const allowed = tabIds ? new Set(tabIds) : null;
  return group.tabIds.filter((tabId) => (!allowed || allowed.has(tabId)) && !!state.tabsById[tabId]);
}

function tabStateKeepIds(state: WorkbenchState): string[] {
  return [
    ...Object.keys(state.tabsById),
    ...state.recentlyClosedTabs.map((entry) => entry.tab.id),
  ];
}

function withClosedTabStates(state: WorkbenchState, captured: Record<string, ReturnType<typeof captureWorkbenchTabState>>): WorkbenchState {
  return {
    ...state,
    recentlyClosedTabs: state.recentlyClosedTabs.map((entry) => ({
      ...entry,
      tabState: entry.tabState ?? captured[entry.tab.id],
    })),
  };
}

function captureActiveGroupTab(state: WorkbenchState, groupId: string): void {
  const activeTabId = state.groupsById[groupId]?.activeTabId;
  if (activeTabId) captureWorkbenchTabState(activeTabId);
}

export const useWorkbenchStore = create<WorkbenchStore>()((set, get) => ({
  ...createInitialWorkbenchState(),
  openTab: (tab, options) => set((state) => {
    captureActiveGroupTab(state, options?.groupId ?? state.activeGroupId);
    const next = openWorkbenchTab(state, tab, options);
    if (options?.activate !== false) restoreWorkbenchTabState(next.groupsById[next.activeGroupId]?.activeTabId ?? tab.id);
    return toStoreState(next);
  }),
  activateTab: (groupId, tabId) => set((state) => {
    captureActiveGroupTab(state, groupId);
    const next = activateWorkbenchTab(state, groupId, tabId);
    restoreWorkbenchTabState(tabId);
    return toStoreState(next);
  }),
  activateGroup: (groupId) => set((state) => toStoreState(activateWorkbenchGroup(state, groupId))),
  closeTab: (groupId, tabId) => set((state) => {
    const captured = captureWorkbenchTabStates(tabIdsInGroup(state, groupId, [tabId]));
    const next = withClosedTabStates(closeWorkbenchTab(state, groupId, tabId), captured);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  closeTabs: (groupId, tabIds) => set((state) => {
    const captured = captureWorkbenchTabStates(tabIdsInGroup(state, groupId, tabIds));
    const next = withClosedTabStates(closeWorkbenchTabs(state, groupId, tabIds), captured);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  closeOtherTabs: (groupId, tabId) => set((state) => {
    const closing = tabIdsInGroup(state, groupId).filter((candidateId) => candidateId !== tabId);
    const captured = captureWorkbenchTabStates(closing);
    const next = withClosedTabStates(closeOtherWorkbenchTabs(state, groupId, tabId), captured);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  closeTabsToRight: (groupId, tabId) => set((state) => {
    const group = state.groupsById[groupId];
    const tabIndex = group?.tabIds.indexOf(tabId) ?? -1;
    const closing = group && tabIndex >= 0 ? group.tabIds.slice(tabIndex + 1) : [];
    const captured = captureWorkbenchTabStates(closing);
    const next = withClosedTabStates(closeWorkbenchTabsToRight(state, groupId, tabId), captured);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  closeAllTabsInGroup: (groupId) => set((state) => {
    const captured = captureWorkbenchTabStates(tabIdsInGroup(state, groupId));
    const next = withClosedTabStates(closeAllWorkbenchTabsInGroup(state, groupId), captured);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  splitGroup: (options) => set((state) => {
    captureActiveGroupTab(state, options.sourceGroupId);
    const next = splitWorkbenchGroup(state, options, createId);
    restoreWorkbenchTabState(next.groupsById[next.activeGroupId]?.activeTabId ?? '');
    return toStoreState(next);
  }),
  setSplitSizesByChild: (splitId, sizesByChild) => set((state) => toStoreState(setWorkbenchSplitSizesByChild(state, splitId, sizesByChild))),
  dockTabToGroupEdge: (options) => set((state) => {
    captureWorkbenchTabState(options.tabId);
    const next = dockWorkbenchTabToGroupEdge(state, options, createId);
    restoreWorkbenchTabState(options.tabId);
    return toStoreState(next);
  }),
  moveTab: (options) => set((state) => {
    captureWorkbenchTabState(options.tabId);
    const next = moveWorkbenchTab(state, options);
    if (options.activate !== false) restoreWorkbenchTabState(options.tabId);
    return toStoreState(next);
  }),
  moveTabWithinGroup: (groupId, tabId, toIndex) => set((state) => {
    captureWorkbenchTabState(tabId);
    const next = moveWorkbenchTabWithinGroup(state, groupId, tabId, toIndex);
    restoreWorkbenchTabState(tabId);
    return toStoreState(next);
  }),
  setTabDirty: (tabId, dirty) => set((state) => toStoreState(setWorkbenchTabDirty(state, tabId, dirty))),
  reopenLastClosedTab: () => set((state) => {
    const entry = state.recentlyClosedTabs[0];
    if (entry?.tabState) setWorkbenchTabState(entry.tab.id, entry.tabState);
    const next = reopenLastClosedWorkbenchTab(state);
    if (entry) restoreWorkbenchTabState(entry.tab.id);
    return toStoreState(next);
  }),
  resetWorkbench: () => {
    nextId = 1;
    clearWorkbenchTabStates();
    set(toStoreState(createInitialWorkbenchState()));
  },
  closeProjectTabs: () => set((state) => {
    captureWorkbenchTabStates(tabIdsInWorkbench(state));
    const next = closeProjectWorkbenchTabs(state);
    pruneWorkbenchTabStates(tabStateKeepIds(next));
    return toStoreState(next);
  }),
  replaceWorkbench: (state) => {
    pruneWorkbenchTabStates(tabStateKeepIds(state));
    set(toStoreState(state));
  },
  restoreProjectWorkbench: (serialized, project) => {
    const restored = restoreProjectWorkbenchStatePreservingGlobalTabs(serialized, project, get());
    pruneWorkbenchTabStates(tabStateKeepIds(restored));
    set(toStoreState(restored));
    return restored;
  },
  restoreShellWorkbench: (serialized, project, projectWorkbench) => {
    const restored = restoreShellWorkbenchState(serialized, project, projectWorkbench);
    pruneWorkbenchTabStates(tabStateKeepIds(restored));
    set(toStoreState(restored));
    return restored;
  },
  serializeProjectWorkbench: () => {
    captureWorkbenchTabStates(tabIdsInWorkbench(get()));
    return serializeProjectWorkbenchState(get());
  },
  serializeShellWorkbench: () => {
    captureWorkbenchTabStates(tabIdsInWorkbench(get()));
    return serializeShellWorkbenchState(get());
  },
}));
