import { describe, expect, it } from 'vitest';
import {
  activateWorkbenchTab,
  closeWorkbenchTab,
  createInitialWorkbenchState,
  moveWorkbenchTab,
  moveWorkbenchTabWithinGroup,
  openWorkbenchTab,
  PRIMARY_PREVIEW_TAB_ID,
  reopenLastClosedWorkbenchTab,
  ROOT_GROUP_ID,
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
  it('creates an initial primary preview tab', () => {
    const state = createInitialWorkbenchState();
    expect(state.activeGroupId).toBe(ROOT_GROUP_ID);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe(PRIMARY_PREVIEW_TAB_ID);
    expect(state.tabsById[PRIMARY_PREVIEW_TAB_ID]?.editorType).toBe('engine-preview');
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
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).not.toContain('tab:foyer');
  });

  it('reorders tabs within a group', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = moveWorkbenchTabWithinGroup(state, ROOT_GROUP_ID, 'tab:kitchen', 1);
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([
      PRIMARY_PREVIEW_TAB_ID,
      'tab:kitchen',
      'tab:foyer',
    ]);
  });

  it('keeps active tab valid after closing and can reopen a closed tab', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:foyer');
    state = closeWorkbenchTab(state, ROOT_GROUP_ID, 'tab:foyer');
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe(PRIMARY_PREVIEW_TAB_ID);
    expect(state.recentlyClosedTabs[0]?.tab.id).toBe('tab:foyer');
    state = reopenLastClosedWorkbenchTab(state);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
  });
});
