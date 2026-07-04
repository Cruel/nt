import { create } from 'zustand';
import { useDraftDirtyStore, selectDraftDirtyByTabId } from './draft-dirty-store';
import { getTabDirtyState } from './dirty-state';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from './workbench-store';

export type CloseTabsReason = 'close' | 'close-all' | 'close-others' | 'close-right';

export interface PendingCloseTabs {
  groupId: string;
  tabIds: string[];
  reason: CloseTabsReason;
}

interface CloseGuardStoreState {
  pendingClose: PendingCloseTabs | null;
  requestCloseTabs: (groupId: string, tabIds: string[], reason: CloseTabsReason) => void;
  requestCloseTab: (groupId: string, tabId: string) => void;
  requestCloseOtherTabs: (groupId: string, tabId: string) => void;
  requestCloseTabsToRight: (groupId: string, tabId: string) => void;
  requestCloseAllTabsInGroup: (groupId: string) => void;
  confirmPendingClose: () => void;
  clearPendingClose: () => void;
}

function orderedRequestedTabIds(groupTabIds: string[], tabIds: string[]): string[] {
  const requested = new Set(tabIds);
  return groupTabIds.filter((tabId) => requested.has(tabId));
}

export const useCloseGuardStore = create<CloseGuardStoreState>()((set, get) => ({
  pendingClose: null,
  requestCloseTabs: (groupId, tabIds, reason) => {
    const workbench = useWorkbenchStore.getState();
    const group = workbench.groupsById[groupId];
    if (!group) return;
    const requestedTabIds = orderedRequestedTabIds(group.tabIds, tabIds).filter((tabId) => !!workbench.tabsById[tabId]);
    if (requestedTabIds.length === 0) return;
    const project = useProjectStore.getState();
    const draftDirtyByTabId = selectDraftDirtyByTabId(useDraftDirtyStore.getState());
    const hasDirtyTab = requestedTabIds.some((tabId) => {
      const tab = workbench.tabsById[tabId];
      return tab ? getTabDirtyState(tab, project.document, project.savedDocument, draftDirtyByTabId).dirty : false;
    });
    if (!hasDirtyTab) {
      workbench.closeTabs(groupId, requestedTabIds);
      return;
    }
    set({ pendingClose: { groupId, tabIds: requestedTabIds, reason } });
  },
  requestCloseTab: (groupId, tabId) => get().requestCloseTabs(groupId, [tabId], 'close'),
  requestCloseOtherTabs: (groupId, tabId) => {
    const group = useWorkbenchStore.getState().groupsById[groupId];
    if (!group || !group.tabIds.includes(tabId)) return;
    get().requestCloseTabs(groupId, group.tabIds.filter((candidateId) => candidateId !== tabId), 'close-others');
  },
  requestCloseTabsToRight: (groupId, tabId) => {
    const group = useWorkbenchStore.getState().groupsById[groupId];
    if (!group) return;
    const index = group.tabIds.indexOf(tabId);
    if (index < 0) return;
    get().requestCloseTabs(groupId, group.tabIds.slice(index + 1), 'close-right');
  },
  requestCloseAllTabsInGroup: (groupId) => {
    const group = useWorkbenchStore.getState().groupsById[groupId];
    if (!group) return;
    get().requestCloseTabs(groupId, group.tabIds, 'close-all');
  },
  confirmPendingClose: () => {
    const pendingClose = get().pendingClose;
    if (!pendingClose) return;
    useWorkbenchStore.getState().closeTabs(pendingClose.groupId, pendingClose.tabIds);
    set({ pendingClose: null });
  },
  clearPendingClose: () => set({ pendingClose: null }),
}));
