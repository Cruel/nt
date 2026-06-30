import { create } from 'zustand';
import { useDraftDirtyStore, selectDraftDirtyByTabId } from './draft-dirty-store';
import { getTabDirtyState } from './dirty-state';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from './workbench-store';

export interface PendingTabCloseRequest {
  groupId: string;
  tabId: string;
}

interface CloseGuardStoreState {
  pendingClose: PendingTabCloseRequest | null;
  requestCloseTab: (groupId: string, tabId: string) => void;
  clearPendingClose: () => void;
}

export const useCloseGuardStore = create<CloseGuardStoreState>()((set) => ({
  pendingClose: null,
  requestCloseTab: (groupId, tabId) => {
    const workbench = useWorkbenchStore.getState();
    const tab = workbench.tabsById[tabId];
    if (!tab) return;
    const project = useProjectStore.getState();
    const draftDirtyByTabId = selectDraftDirtyByTabId(useDraftDirtyStore.getState());
    const dirty = getTabDirtyState(tab, project.document, project.savedDocument, draftDirtyByTabId);
    if (!dirty.dirty) {
      workbench.closeTab(groupId, tabId);
      return;
    }
    set({ pendingClose: { groupId, tabId } });
  },
  clearPendingClose: () => set({ pendingClose: null }),
}));
