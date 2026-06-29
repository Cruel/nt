import { create } from 'zustand';
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  createInitialWorkbenchState,
  moveWorkbenchTab,
  moveWorkbenchTabWithinGroup,
  openWorkbenchTab,
  reopenLastClosedWorkbenchTab,
  setWorkbenchTabDirty,
  splitWorkbenchGroup,
} from './workbench-model';
import type {
  MoveWorkbenchTabOptions,
  OpenWorkbenchTabOptions,
  SplitWorkbenchGroupOptions,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';

interface WorkbenchStore extends WorkbenchState {
  openTab: (tab: WorkbenchTab, options?: OpenWorkbenchTabOptions) => void;
  activateTab: (groupId: string, tabId: string) => void;
  closeTab: (groupId: string, tabId: string) => void;
  splitGroup: (options: SplitWorkbenchGroupOptions) => void;
  moveTab: (options: MoveWorkbenchTabOptions) => void;
  moveTabWithinGroup: (groupId: string, tabId: string, toIndex: number) => void;
  setTabDirty: (tabId: string, dirty: boolean) => void;
  reopenLastClosedTab: () => void;
  resetWorkbench: () => void;
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

export const useWorkbenchStore = create<WorkbenchStore>()((set) => ({
  ...createInitialWorkbenchState(),
  openTab: (tab, options) => set((state) => toStoreState(openWorkbenchTab(state, tab, options))),
  activateTab: (groupId, tabId) => set((state) => toStoreState(activateWorkbenchTab(state, groupId, tabId))),
  closeTab: (groupId, tabId) => set((state) => toStoreState(closeWorkbenchTab(state, groupId, tabId))),
  splitGroup: (options) => set((state) => toStoreState(splitWorkbenchGroup(state, options, createId))),
  moveTab: (options) => set((state) => toStoreState(moveWorkbenchTab(state, options))),
  moveTabWithinGroup: (groupId, tabId, toIndex) => set((state) => toStoreState(moveWorkbenchTabWithinGroup(state, groupId, tabId, toIndex))),
  setTabDirty: (tabId, dirty) => set((state) => toStoreState(setWorkbenchTabDirty(state, tabId, dirty))),
  reopenLastClosedTab: () => set((state) => toStoreState(reopenLastClosedWorkbenchTab(state))),
  resetWorkbench: () => {
    nextId = 1;
    set(toStoreState(createInitialWorkbenchState()));
  },
}));
