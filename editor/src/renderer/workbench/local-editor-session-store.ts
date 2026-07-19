import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkbenchState } from './workbench-types';

export interface LocalEditorShellSession {
  projectFilePath: string | null;
  shellWorkbench: WorkbenchState;
}

interface LocalEditorSessionState {
  shellSession: LocalEditorShellSession | null;
  saveShellWorkbench: (projectFilePath: string | null, workbench: WorkbenchState) => void;
  clearShellWorkbench: () => void;
}

function cloneWorkbenchState(state: WorkbenchState): WorkbenchState {
  return {
    layout: JSON.parse(JSON.stringify(state.layout)) as WorkbenchState['layout'],
    groupsById: Object.fromEntries(
      Object.entries(state.groupsById).map(([groupId, group]) => [
        groupId,
        { ...group, tabIds: [...group.tabIds] },
      ]),
    ),
    tabsById: Object.fromEntries(
      Object.entries(state.tabsById).map(([tabId, tab]) => [
        tabId,
        {
          id: tab.id,
          title: tab.title,
          editorType: tab.editorType,
          resource: tab.resource ? { ...tab.resource } : undefined,
          pinned: tab.pinned || undefined,
          preview: tab.preview || undefined,
        },
      ]),
    ),
    activeGroupId: state.activeGroupId,
    recentlyClosedTabs: [],
  };
}

export const useLocalEditorSessionStore = create<LocalEditorSessionState>()(
  persist(
    (set) => ({
      shellSession: null,
      saveShellWorkbench: (projectFilePath, workbench) =>
        set({
          shellSession: { projectFilePath, shellWorkbench: cloneWorkbenchState(workbench) },
        }),
      clearShellWorkbench: () => set({ shellSession: null }),
    }),
    {
      name: 'noveltea-editor-session',
      migrate: (persisted) => {
        if (typeof persisted !== 'object' || persisted === null) return persisted;
        const record = persisted as Record<string, unknown>;
        if (record.shellSession) return record;
        if (record.shellWorkbench) {
          return {
            ...record,
            shellSession: {
              projectFilePath: null,
              shellWorkbench: record.shellWorkbench,
            },
            shellWorkbench: undefined,
          };
        }
        return record;
      },
      version: 2,
    },
  ),
);
