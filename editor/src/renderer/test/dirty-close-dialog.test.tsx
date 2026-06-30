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

function openTestTab() {
  useWorkbenchStore.getState().openTab(tab);
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
