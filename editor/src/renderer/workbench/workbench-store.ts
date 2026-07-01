import { create } from 'zustand';
import {
  activateWorkbenchTab,
  closeProjectWorkbenchTabs,
  closeWorkbenchTab,
  createInitialWorkbenchState,
  moveWorkbenchTab,
  moveWorkbenchTabWithinGroup,
  openWorkbenchTab,
  reopenLastClosedWorkbenchTab,
  restoreProjectWorkbenchState,
  restoreShellWorkbenchState,
  serializeProjectWorkbenchState,
  serializeShellWorkbenchState,
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
  closeTab: (groupId: string, tabId: string) => void;
  splitGroup: (options: SplitWorkbenchGroupOptions) => void;
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
  closeProjectTabs: () => set((state) => toStoreState(closeProjectWorkbenchTabs(state))),
  replaceWorkbench: (state) => set(toStoreState(state)),
  restoreProjectWorkbench: (serialized, project) => {
    const restored = restoreProjectWorkbenchState(serialized, project);
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
