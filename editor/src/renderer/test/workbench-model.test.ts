import { describe, expect, it } from 'vitest';
import {
  activateWorkbenchGroup,
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
  ROOT_GROUP_ID,
  serializeProjectWorkbenchState,
  serializeShellWorkbenchState,
  splitWorkbenchGroup,
} from '@/workbench/workbench-model';
import type { WorkbenchTab } from '@/workbench/workbench-types';

function rawTab(id: string): WorkbenchTab {
  return {
    id: `tab:${id}`,
    title: id,
    editorType: 'raw-json',
    resource: {
      kind: 'record',
      stableId: `record:room:${id}`,
      collection: 'room',
      entityId: id,
    },
  };
}

function createTestId(prefix: string) {
  const createTestIdCounter = createTestId as typeof createTestId & { next?: number };
  createTestIdCounter.next = (createTestIdCounter.next ?? 0) + 1;
  return `${prefix}:${createTestIdCounter.next}`;
}

describe('workbench model', () => {
  it('creates an empty initial root group', () => {
    const state = createInitialWorkbenchState();
    expect(state.activeGroupId).toBe(ROOT_GROUP_ID);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBeNull();
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([]);
    expect(state.tabsById).toEqual({});
  });

  it('opens a record tab in the active group', () => {
    const state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toContain('tab:foyer');
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
  });

  it('deduplicates tabs by editor type and resource stable id', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, { ...rawTab('foyer'), id: 'tab:foyer-again' });
    expect(Object.keys(state.tabsById).filter((id) => id.includes('foyer'))).toEqual(['tab:foyer']);
  });

  it('updates an existing tab explorer placement when reopened from another explorer row', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, { ...rawTab('foyer'), resource: { ...rawTab('foyer').resource!, explorerNodeId: 'record:rooms:foyer' } });
    state = openWorkbenchTab(state, { ...rawTab('foyer'), id: 'tab:foyer-again', resource: { ...rawTab('foyer').resource!, explorerNodeId: 'record:rooms:foyer:all' } });
    expect(Object.keys(state.tabsById).filter((id) => id.includes('foyer'))).toEqual(['tab:foyer']);
    expect(state.tabsById['tab:foyer']?.resource?.explorerNodeId).toBe('record:rooms:foyer:all');
  });

  it('splits a group and can move the active tab into the new group', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal', tabId: 'tab:foyer', moveTab: true },
      createTestId,
    );
    const groupIds = Object.keys(state.groupsById);
    expect(groupIds).toHaveLength(2);
    const newGroupId = groupIds.find((id) => id !== ROOT_GROUP_ID)!;
    expect(state.groupsById[newGroupId]?.tabIds).toEqual(['tab:foyer']);
    expect(state.activeGroupId).toBe(newGroupId);
  });

  it('duplicates a tab instance when splitting without moving', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal', tabId: 'tab:foyer', moveTab: false },
      createTestId,
    );
    const newGroupId = Object.keys(state.groupsById).find((id) => id !== ROOT_GROUP_ID)!;
    const clonedTabId = state.groupsById[newGroupId]?.activeTabId;
    expect(clonedTabId).toBeTruthy();
    expect(clonedTabId).not.toBe('tab:foyer');
    expect(state.tabsById[clonedTabId!]?.resource?.stableId).toBe('record:room:foyer');

    state = closeWorkbenchTab(state, newGroupId, clonedTabId!);
    expect(state.tabsById['tab:foyer']).toBeTruthy();
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toContain('tab:foyer');
    expect(Object.keys(state.groupsById)).toEqual([ROOT_GROUP_ID]);
    expect(state.layout).toEqual({ kind: 'group', groupId: ROOT_GROUP_ID });
  });

  it('activates a group without changing that group active tab', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('left'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const rightGroupId = state.activeGroupId;
    state = openWorkbenchTab(state, rawTab('right'), { groupId: rightGroupId });
    state = activateWorkbenchTab(state, rightGroupId, 'tab:right');
    state = activateWorkbenchGroup(state, ROOT_GROUP_ID);

    expect(state.activeGroupId).toBe(ROOT_GROUP_ID);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:left');
    expect(state.groupsById[rightGroupId]?.activeTabId).toBe('tab:right');
  });

  it('moves a tab between groups', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const targetGroupId = Object.keys(state.groupsById).find((id) => id !== ROOT_GROUP_ID)!;
    state = moveWorkbenchTab({ ...state }, {
      tabId: 'tab:foyer',
      fromGroupId: ROOT_GROUP_ID,
      toGroupId: targetGroupId,
    });
    expect(state.groupsById[targetGroupId]?.tabIds).toContain('tab:foyer');
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds ?? []).not.toContain('tab:foyer');
  });

  it('reorders tabs within a group', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = moveWorkbenchTabWithinGroup(state, ROOT_GROUP_ID, 'tab:kitchen', 0);
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([
      'tab:kitchen',
      'tab:foyer',
    ]);
  });

  it('preserves project-independent tool tabs when closing project tabs', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });
    state = openWorkbenchTab(state, {
      id: 'tab:primary-preview',
      title: 'Preview',
      editorType: 'engine-preview',
      preview: true,
      resource: { kind: 'preview', stableId: 'preview:primary' },
    });

    state = closeProjectWorkbenchTabs(state);

    expect(Object.keys(state.tabsById)).toEqual(['tab:settings']);
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:settings']);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:settings');
  });

  it('serializes project-scoped utility tabs and closes them with project tabs', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, {
      id: 'tab:project-settings',
      title: 'Project Settings',
      editorType: 'project-settings',
      resource: { kind: 'project', stableId: 'project:settings' },
    });
    state = openWorkbenchTab(state, {
      id: 'tab:assets',
      title: 'Assets',
      editorType: 'asset-library',
      resource: { kind: 'project', stableId: 'assets', collection: 'assets' },
    });
    state = openWorkbenchTab(state, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });

    const serialized = serializeProjectWorkbenchState(state);
    expect(Object.keys(serialized?.tabsById ?? {})).toEqual(['tab:project-settings', 'tab:assets']);
    expect(restoreProjectWorkbenchState(serialized ?? undefined, {}).tabsById['tab:project-settings']).toBeTruthy();
    expect(restoreProjectWorkbenchState(serialized ?? undefined, {}).tabsById['tab:assets']).toBeTruthy();

    const closed = closeProjectWorkbenchTabs(state);
    expect(Object.keys(closed.tabsById)).toEqual(['tab:settings']);
  });

  it('treats stale project-scoped utility tabs with tool resources as project tabs', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, {
      id: 'tab:assets',
      title: 'Assets',
      editorType: 'asset-library',
      resource: { kind: 'tool', stableId: 'assets', collection: 'assets' },
    });
    state = openWorkbenchTab(state, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });

    const serialized = serializeProjectWorkbenchState(state);
    expect(serialized?.tabsById['tab:assets']?.resource?.kind).toBe('project');
    expect(closeProjectWorkbenchTabs(state).tabsById).toEqual({
      'tab:settings': expect.objectContaining({ editorType: 'settings' }),
    });
  });

  it('serializes only project-scoped tabs and restores valid references', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });

    const serialized = serializeProjectWorkbenchState(state);
    expect(Object.keys(serialized?.tabsById ?? {})).toEqual(['tab:foyer']);

    const restored = restoreProjectWorkbenchState(serialized ?? undefined, {
      room: {
        foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} },
      },
    });
    expect(restored.tabsById['tab:foyer']).toBeTruthy();

    const stale = restoreProjectWorkbenchState(serialized ?? undefined, { room: {} });
    expect(stale.tabsById).toEqual({});
    expect(stale.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([]);
  });

  it('merges tool-only local shell state with project-restored tabs', () => {
    let toolOnly = createInitialWorkbenchState();
    toolOnly = openWorkbenchTab(toolOnly, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });
    const shell = serializeShellWorkbenchState(toolOnly);
    const projectOnly = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    const restored = restoreShellWorkbenchState(shell, {
      room: {
        foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} },
      },
    }, projectOnly);

    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:settings', 'tab:foyer']);
    expect(restored.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:settings');
  });

  it('restores interleaved project and tool tabs from local shell state', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:settings');

    const shell = serializeShellWorkbenchState(state);
    const projectOnly = restoreProjectWorkbenchState(serializeProjectWorkbenchState(state) ?? undefined, {
      room: {
        foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} },
        kitchen: { id: 'kitchen', label: 'Kitchen', tags: [], data: {} },
      },
    });
    const restored = restoreShellWorkbenchState(shell, {
      room: {
        foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} },
        kitchen: { id: 'kitchen', label: 'Kitchen', tags: [], data: {} },
      },
    }, projectOnly);

    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer', 'tab:settings', 'tab:kitchen']);
    expect(restored.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:settings');
  });

  it('keeps active tab valid after closing and can reopen a closed tab', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:foyer');
    state = closeWorkbenchTab(state, ROOT_GROUP_ID, 'tab:foyer');
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBeNull();
    expect(state.recentlyClosedTabs[0]?.tab.id).toBe('tab:foyer');
    state = reopenLastClosedWorkbenchTab(state);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
  });
});
