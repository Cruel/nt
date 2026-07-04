import { create } from 'zustand';
import {
  activateWorkbenchGroup,
  activateWorkbenchTab,
  closeAllWorkbenchTabsInGroup,
  closeOtherWorkbenchTabs,
  closeProjectWorkbenchTabs,
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
  MoveWorkbenchTabOptions,
  OpenWorkbenchTabOptions,
  SplitWorkbenchGroupOptions,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';
import type { SerializedWorkbenchState } from '../../shared/project-schema/editor-project-state';

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

export const useWorkbenchStore = create<WorkbenchStore>()((set, get) => ({
  ...createInitialWorkbenchState(),
  openTab: (tab, options) => set((state) => toStoreState(openWorkbenchTab(state, tab, options))),
  activateTab: (groupId, tabId) => set((state) => toStoreState(activateWorkbenchTab(state, groupId, tabId))),
  activateGroup: (groupId) => set((state) => toStoreState(activateWorkbenchGroup(state, groupId))),
  closeTab: (groupId, tabId) => set((state) => toStoreState(closeWorkbenchTab(state, groupId, tabId))),
  closeTabs: (groupId, tabIds) => set((state) => toStoreState(closeWorkbenchTabs(state, groupId, tabIds))),
  closeOtherTabs: (groupId, tabId) => set((state) => toStoreState(closeOtherWorkbenchTabs(state, groupId, tabId))),
  closeTabsToRight: (groupId, tabId) => set((state) => toStoreState(closeWorkbenchTabsToRight(state, groupId, tabId))),
  closeAllTabsInGroup: (groupId) => set((state) => toStoreState(closeAllWorkbenchTabsInGroup(state, groupId))),
  splitGroup: (options) => set((state) => toStoreState(splitWorkbenchGroup(state, options, createId))),
  setSplitSizesByChild: (splitId, sizesByChild) => set((state) => toStoreState(setWorkbenchSplitSizesByChild(state, splitId, sizesByChild))),
  moveTab: (options) => set((state) => toStoreState(moveWorkbenchTab(state, options))),
  moveTabWithinGroup: (groupId, tabId, toIndex) => set((state) => toStoreState(moveWorkbenchTabWithinGroup(state, groupId, tabId, toIndex))),
  setTabDirty: (tabId, dirty) => set((state) => toStoreState(setWorkbenchTabDirty(state, tabId, dirty))),
  reopenLastClosedTab: () => set((state) => toStoreState(reopenLastClosedWorkbenchTab(state))),
  resetWorkbench: () => {
    nextId = 1;
    set(toStoreState(createInitialWorkbenchState()));
  },
  closeProjectTabs: () => set((state) => toStoreState(closeProjectWorkbenchTabs(state))),
  replaceWorkbench: (state) => set(toStoreState(state)),
  restoreProjectWorkbench: (serialized, project) => {
    const restored = restoreProjectWorkbenchStatePreservingGlobalTabs(serialized, project, get());
    set(toStoreState(restored));
    return restored;
  },
  restoreShellWorkbench: (serialized, project, projectWorkbench) => {
    const restored = restoreShellWorkbenchState(serialized, project, projectWorkbench);
    set(toStoreState(restored));
    return restored;
  },
  serializeProjectWorkbench: () => serializeProjectWorkbenchState(get()),
  serializeShellWorkbench: () => serializeShellWorkbenchState(get()),
}));
