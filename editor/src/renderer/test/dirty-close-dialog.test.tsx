import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirtyCloseDialog } from '@/workbench/DirtyCloseDialog';
import { useCloseGuardStore } from '@/workbench/close-guard-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { ROOT_GROUP_ID } from '@/workbench/workbench-model';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import type { WorkbenchTab } from '@/workbench/workbench-types';

const tab: WorkbenchTab = {
  id: 'tab:rooms:foyer',
  title: 'foyer',
  editorType: 'raw-json',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:foyer',
    collection: 'rooms',
    entityId: 'foyer',
  },
};

const kitchenTab: WorkbenchTab = {
  id: 'tab:rooms:kitchen',
  title: 'kitchen',
  editorType: 'raw-json',
  resource: {
    kind: 'record',
    stableId: 'record:rooms:kitchen',
    collection: 'rooms',
    entityId: 'kitchen',
  },
};

function openTestTab() {
  useWorkbenchStore.getState().openTab(tab);
}

function openTestTabs() {
  useWorkbenchStore.getState().openTab(tab);
  useWorkbenchStore.getState().openTab(kitchenTab);
}

beforeEach(() => {
  useWorkbenchStore.getState().resetWorkbench();
  useCloseGuardStore.getState().clearPendingClose();
  useDraftDirtyStore.getState().resetDraftDirty();
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  vi.clearAllMocks();
});

describe('dirty tab close guard', () => {
  it('closes clean tabs immediately', () => {
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    openTestTab();

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));

    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('closes a clean batch immediately', () => {
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    openTestTabs();

    act(() => useCloseGuardStore.getState().requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'));

    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
    expect(useWorkbenchStore.getState().tabsById[kitchenTab.id]).toBeUndefined();
  });

  it('prompts before closing dirty record tabs and can cancel', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    expect(await screen.findByText('Close foyer?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
  });

  it('prompts once for a dirty batch and cancels atomically', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({
      rooms: {
        foyer: { id: 'foyer', label: 'New Foyer' },
        kitchen: { id: 'kitchen', label: 'Kitchen' },
      },
    }, 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'));
    expect(await screen.findByText('Close 2 tabs?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
    expect(useWorkbenchStore.getState().tabsById[kitchenTab.id]).toBeTruthy();
  });

  it('prompts once for close others when one of the other tabs is dirty', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({
      rooms: {
        foyer: { id: 'foyer', label: 'Foyer' },
        kitchen: { id: 'kitchen', label: 'New Kitchen' },
      },
    }, 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseOtherTabs(ROOT_GROUP_ID, tab.id));
    expect(await screen.findByText('Close kitchen?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([tab.id, kitchenTab.id]);
  });

  it('prompts once for close to the right and confirms the whole requested range', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({
      rooms: {
        foyer: { id: 'foyer', label: 'Foyer' },
        kitchen: { id: 'kitchen', label: 'New Kitchen' },
      },
    }, 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTabsToRight(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Discard'));

    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
    expect(useWorkbenchStore.getState().tabsById[kitchenTab.id]).toBeUndefined();
  });

  it('discards a dirty batch and closes every requested tab', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({
      rooms: {
        foyer: { id: 'foyer', label: 'New Foyer' },
        kitchen: { id: 'kitchen', label: 'New Kitchen' },
      },
    }, 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'));
    await user.click(await screen.findByText('Discard'));

    expect(useProjectStore.getState().document).toEqual({
      rooms: {
        foyer: { id: 'foyer', label: 'Foyer' },
        kitchen: { id: 'kitchen', label: 'Kitchen' },
      },
    });
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
    expect(useWorkbenchStore.getState().tabsById[kitchenTab.id]).toBeUndefined();
  });

  it('saves dirty batch changes before closing every requested tab', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({
      rooms: {
        foyer: { id: 'foyer', label: 'New Foyer' },
        kitchen: { id: 'kitchen', label: 'New Kitchen' },
      },
    }, 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseAllTabsInGroup(ROOT_GROUP_ID));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProject).toHaveBeenCalledWith(
      {
        rooms: {
          foyer: { id: 'foyer', label: 'New Foyer' },
          kitchen: { id: 'kitchen', label: 'New Kitchen' },
        },
      },
      '/mock/project/game.json',
    );
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
    expect(useWorkbenchStore.getState().tabsById[kitchenTab.id]).toBeUndefined();
  });

  it('discards dirty record changes through the command bus before closing', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Discard'));

    expect(useProjectStore.getState().document).toEqual({ rooms: { foyer: { id: 'foyer', label: 'Foyer' } } });
    expect(useCommandStore.getState().history.entries.at(-1)?.label).toBe('Discard changes to foyer');
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('saves dirty record changes before closing', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProject).toHaveBeenCalledWith(
      { rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } },
      '/mock/project/game.json',
    );
    expect(useProjectStore.getState().savedDocument).toEqual({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } });
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('applies draft changes before saving and closing', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    openTestTab();
    useDraftDirtyStore.getState().setDraftDirty(tab.id, {
      tabId: tab.id,
      dirty: true,
      label: 'Draft',
      apply: () => {
        useCommandStore.getState().executeCommand({
          type: 'project.replaceAtPath',
          label: 'Apply draft',
          payload: { path: '/rooms/foyer/label', value: 'Draft Foyer' },
        });
        return true;
      },
      discard: () => true,
    });
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProject).toHaveBeenCalledWith(
      { rooms: { foyer: { id: 'foyer', label: 'Draft Foyer' } } },
      '/mock/project/game.json',
    );
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });
});
