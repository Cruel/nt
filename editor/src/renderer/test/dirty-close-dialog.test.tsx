import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirtyCloseDialog } from '@/workbench/DirtyCloseDialog';
import { useCloseGuardStore } from '@/workbench/close-guard-store';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { ROOT_GROUP_ID } from '@/workbench/workbench-model';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import {
  clearWorkbenchTabStates,
  setWorkbenchTabState,
  useWorkbenchTabStateStore,
} from '@/workbench/workbench-tab-state';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { toJsonValue } from '@/project/json-value';
import {
  buildEditorProjectStateSnapshot,
  setLoadedEditorProjectState,
} from '@/workbench/project-editor-state';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';

const tab: WorkbenchTab = {
  id: 'tab:rooms:foyer',
  title: 'foyer',
  editorType: 'room-detail',
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
  editorType: 'room-detail',
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

function authoringProjectWithRooms(foyerLabel = 'Foyer', kitchenLabel = 'Kitchen') {
  const project = createAuthoringProject();
  project.rooms.foyer = {
    id: 'foyer',
    label: foyerLabel,
    data: defaultRoomData(foyerLabel),
  };
  project.rooms.kitchen = {
    id: 'kitchen',
    label: kitchenLabel,
    data: defaultRoomData(kitchenLabel),
  };
  return project;
}

beforeEach(() => {
  useWorkbenchStore.getState().resetWorkbench();
  useCloseGuardStore.getState().clearPendingClose();
  useDraftDirtyStore.getState().resetDraftDirty();
  useCommandStore.getState().resetCommandHistory();
  useProjectStore.getState().clearProject();
  clearWorkbenchTabStates();
  setLoadedEditorProjectState(emptyEditorProjectState('0'.repeat(64)));
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

    act(() =>
      useCloseGuardStore
        .getState()
        .requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'),
    );

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
    useProjectStore
      .getState()
      .replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    expect(await screen.findByText('Close foyer?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(useCloseGuardStore.getState().pendingClose).toBeNull();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
  });

  it('keeps tab state when a dirty close is cancelled', async () => {
    const user = userEvent.setup();
    useProjectStore.getState().loadProjectDocument({
      document: { rooms: { foyer: { id: 'foyer', label: 'Foyer' } } },
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore
      .getState()
      .replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    setWorkbenchTabState(tab.id, {
      schema: 'noveltea.editor.tab-state.test',
      schemaVersion: 1,
      payload: { scroll: { scrollTop: 33, scrollLeft: 4 } },
    });
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    expect(await screen.findByText('Close foyer?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));

    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeTruthy();
    expect(useWorkbenchTabStateStore.getState().tabStatesById[tab.id]).toMatchObject({
      schema: 'noveltea.editor.tab-state.test',
      payload: { scroll: { scrollTop: 33, scrollLeft: 4 } },
    });
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
    useProjectStore.getState().replaceDocumentFromCommand(
      {
        rooms: {
          foyer: { id: 'foyer', label: 'New Foyer' },
          kitchen: { id: 'kitchen', label: 'Kitchen' },
        },
      },
      0,
    );
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() =>
      useCloseGuardStore
        .getState()
        .requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'),
    );
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
    useProjectStore.getState().replaceDocumentFromCommand(
      {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'New Kitchen' },
        },
      },
      0,
    );
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseOtherTabs(ROOT_GROUP_ID, tab.id));
    expect(await screen.findByText('Close kitchen?')).toBeInTheDocument();

    await user.click(screen.getByText('Cancel'));
    expect(useWorkbenchStore.getState().groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([
      tab.id,
      kitchenTab.id,
    ]);
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
    useProjectStore.getState().replaceDocumentFromCommand(
      {
        rooms: {
          foyer: { id: 'foyer', label: 'Foyer' },
          kitchen: { id: 'kitchen', label: 'New Kitchen' },
        },
      },
      0,
    );
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTabsToRight(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText("Don't Save"));

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
    useProjectStore.getState().replaceDocumentFromCommand(
      {
        rooms: {
          foyer: { id: 'foyer', label: 'New Foyer' },
          kitchen: { id: 'kitchen', label: 'New Kitchen' },
        },
      },
      0,
    );
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() =>
      useCloseGuardStore
        .getState()
        .requestCloseTabs(ROOT_GROUP_ID, [tab.id, kitchenTab.id], 'close-all'),
    );
    await user.click(await screen.findByText("Don't Save"));

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
    const saved = authoringProjectWithRooms();
    const working = authoringProjectWithRooms('New Foyer', 'New Kitchen');
    useProjectStore.getState().loadProjectDocument({
      document: saved,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    openTestTabs();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseAllTabsInGroup(ROOT_GROUP_ID));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProjectContent).toHaveBeenCalledTimes(2);
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[0]).toBe(
      '/mock/project/game.json',
    );
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls.at(-1)?.[2]).toMatchObject({
      rooms: {
        foyer: { label: 'New Foyer' },
        kitchen: { label: 'New Kitchen' },
      },
    });
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
    useProjectStore
      .getState()
      .replaceDocumentFromCommand({ rooms: { foyer: { id: 'foyer', label: 'New Foyer' } } }, 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText("Don't Save"));

    expect(useProjectStore.getState().document).toEqual({
      rooms: { foyer: { id: 'foyer', label: 'Foyer' } },
    });
    expect(useCommandStore.getState().history.entries.at(-1)?.label).toBe(
      'Discard changes to foyer',
    );
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('saves dirty record changes before closing', async () => {
    const user = userEvent.setup();
    const saved = authoringProjectWithRooms();
    const working = authoringProjectWithRooms('New Foyer');
    useProjectStore.getState().loadProjectDocument({
      document: saved,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      rooms: { foyer: { label: 'New Foyer' } },
    });
    expect(useProjectStore.getState().savedDocument).toMatchObject({
      rooms: { foyer: { label: 'New Foyer' } },
    });
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('applies draft changes before saving and closing', async () => {
    const user = userEvent.setup();
    const project = authoringProjectWithRooms();
    useProjectStore.getState().loadProjectDocument({
      document: project,
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
          originSaveUnitId: 'record:rooms:foyer',
          persistencePolicy: 'manual-save',
        });
        return true;
      },
      discard: () => true,
    });
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Save'));

    expect(window.noveltea.saveProjectContent).toHaveBeenCalledOnce();
    expect(vi.mocked(window.noveltea.saveProjectContent).mock.calls[0]?.[2]).toMatchObject({
      rooms: { foyer: { label: 'Draft Foyer' } },
    });
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
  });

  it('returns to the editor when a draft cannot be applied', async () => {
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
      label: 'Invalid draft',
      apply: () => false,
      discard: () => true,
    });
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText('Save'));

    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(window.noveltea.saveProjectContent).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeDefined();
  });

  it('closes a duplicate dirty view without prompting until the final logical view closes', async () => {
    const user = userEvent.setup();
    const project = authoringProjectWithRooms();
    useProjectStore.getState().loadProjectDocument({
      document: project,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    const working = authoringProjectWithRooms('New Foyer');
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    const duplicateTab: WorkbenchTab = {
      ...tab,
      id: 'tab:rooms:foyer:duplicate',
      title: 'foyer duplicate',
    };
    useWorkbenchStore.getState().openTab(tab);
    useWorkbenchStore.getState().openTab(duplicateTab, { duplicate: true });
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));

    expect(useWorkbenchStore.getState().tabsById[tab.id]).toBeUndefined();
    expect(useWorkbenchStore.getState().tabsById[duplicateTab.id]).toBeDefined();
    expect(screen.queryByText('Close foyer?')).not.toBeInTheDocument();

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, duplicateTab.id));
    expect(await screen.findByText('Close foyer duplicate?')).toBeInTheDocument();
    await user.click(screen.getByText('Cancel'));
    expect(useWorkbenchStore.getState().tabsById[duplicateTab.id]).toBeDefined();
  });

  it("Don't Save removes the logical recovery overlay, including pending raw input", async () => {
    const user = userEvent.setup();
    const saved = authoringProjectWithRooms();
    const working = authoringProjectWithRooms('Dirty Foyer');
    useProjectStore.getState().loadProjectDocument({
      document: saved,
      projectPath: '/mock/project',
      projectFilePath: '/mock/project/game.json',
    });
    useProjectStore.getState().replaceDocumentFromCommand(toJsonValue(working), 0);
    setLoadedEditorProjectState({
      ...emptyEditorProjectState('0'.repeat(64)),
      recovery: {
        sequence: 1,
        saveUnitsById: {
          'record:rooms:foyer': {
            sequence: 1,
            patches: [{ op: 'replace', path: '/rooms/foyer/label', value: 'Dirty Foyer' }],
            affectedPaths: ['/rooms/foyer'],
            pendingRawInputByPath: {
              '/rooms/foyer/data/zoom': { value: 'invalid' },
            },
            atomicTransactionGroupIds: [],
          },
        },
      },
    });
    openTestTab();
    render(<DirtyCloseDialog />);

    act(() => useCloseGuardStore.getState().requestCloseTab(ROOT_GROUP_ID, tab.id));
    await user.click(await screen.findByText("Don't Save"));

    expect(useProjectStore.getState().document).toMatchObject({
      rooms: { foyer: { label: 'Foyer' } },
    });
    expect(buildEditorProjectStateSnapshot().recovery.saveUnitsById).not.toHaveProperty(
      'record:rooms:foyer',
    );
  });
});
