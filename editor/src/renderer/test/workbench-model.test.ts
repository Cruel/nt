import { describe, expect, it } from 'vitest';
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
  dockWorkbenchTabToGroupEdge,
  moveWorkbenchTab,
  moveWorkbenchTabWithinGroup,
  openWorkbenchTab,
  reopenLastClosedWorkbenchTab,
  restoreProjectWorkbenchState,
  restoreProjectWorkbenchStatePreservingGlobalTabs,
  restoreShellWorkbenchState,
  ROOT_GROUP_ID,
  serializeProjectWorkbenchState,
  serializeShellWorkbenchState,
  setWorkbenchSplitSizesByChild,
  splitWorkbenchGroup,
} from '@/workbench/workbench-model';
import type { WorkbenchLayoutNode, WorkbenchTab } from '@/workbench/workbench-types';

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

function groupIdsInLayoutOrder(node: WorkbenchLayoutNode): string[] {
  return node.kind === 'group' ? [node.groupId] : node.children.flatMap(groupIdsInLayoutOrder);
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

  it('supports directional split placement before and after the source group', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal', placement: 'before' },
      createTestId,
    );
    const leftGroupId = state.activeGroupId;
    expect(groupIdsInLayoutOrder(state.layout)).toEqual([leftGroupId, ROOT_GROUP_ID]);

    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'vertical', placement: 'after' },
      createTestId,
    );
    const lowerGroupId = state.activeGroupId;
    expect(groupIdsInLayoutOrder(state.layout)).toEqual([leftGroupId, ROOT_GROUP_ID, lowerGroupId]);
  });

  it('docks a tab from its own group into a new edge split', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));

    state = dockWorkbenchTabToGroupEdge(
      state,
      { tabId: 'tab:kitchen', fromGroupId: ROOT_GROUP_ID, targetGroupId: ROOT_GROUP_ID, edge: 'left' },
      createTestId,
    );

    const groupOrder = groupIdsInLayoutOrder(state.layout);
    expect(groupOrder).toHaveLength(2);
    const dockGroupId = groupOrder[0];
    expect(dockGroupId).not.toBe(ROOT_GROUP_ID);
    expect(state.layout.kind).toBe('split');
    if (state.layout.kind === 'split') expect(state.layout.direction).toBe('horizontal');
    expect(state.groupsById[dockGroupId]?.tabIds).toEqual(['tab:kitchen']);
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
    expect(state.activeGroupId).toBe(dockGroupId);
  });

  it('docks a tab from another group against the target group edge', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal', placement: 'after' },
      createTestId,
    );
    const rightGroupId = state.activeGroupId;
    state = openWorkbenchTab(state, rawTab('kitchen'), { groupId: rightGroupId });

    state = dockWorkbenchTabToGroupEdge(
      state,
      { tabId: 'tab:foyer', fromGroupId: ROOT_GROUP_ID, targetGroupId: rightGroupId, edge: 'bottom' },
      createTestId,
    );

    const groupOrder = groupIdsInLayoutOrder(state.layout);
    const dockGroupId = groupOrder.at(-1)!;
    expect(dockGroupId).not.toBe(rightGroupId);
    expect(dockGroupId).not.toBe(ROOT_GROUP_ID);
    expect(state.groupsById[ROOT_GROUP_ID]).toBeUndefined();
    expect(state.groupsById[rightGroupId]?.tabIds).toEqual(['tab:kitchen']);
    expect(state.groupsById[dockGroupId]?.tabIds).toEqual(['tab:foyer']);
    expect(state.groupsById[dockGroupId]?.activeTabId).toBe('tab:foyer');
  });

  it('allocates collision-free group and split ids when splitting restored layouts', () => {
    const state = {
      layout: {
        kind: 'split' as const,
        id: 'split:5',
        direction: 'horizontal' as const,
        children: [
          { kind: 'group' as const, groupId: ROOT_GROUP_ID },
          { kind: 'group' as const, groupId: 'group:4' },
        ],
      },
      groupsById: {
        [ROOT_GROUP_ID]: {
          id: ROOT_GROUP_ID,
          tabIds: ['tab:root'],
          activeTabId: 'tab:root',
          activationHistory: ['tab:root'],
        },
        'group:4': {
          id: 'group:4',
          tabIds: ['tab:foyer'],
          activeTabId: 'tab:foyer',
          activationHistory: ['tab:foyer'],
        },
      },
      tabsById: {
        'tab:root': rawTab('root'),
        'tab:foyer': rawTab('foyer'),
      },
      activeGroupId: 'group:4',
      recentlyClosedTabs: [],
    };
    const idsByPrefix: Record<string, string[]> = {
      group: ['group:4', 'group:6'],
      split: ['split:5', 'split:7'],
      tab: ['tab:foyer', 'tab:foyer-clone'],
    };
    const createCollidingId = (prefix: string) => idsByPrefix[prefix]?.shift() ?? `${prefix}:fallback`;

    const split = splitWorkbenchGroup(
      state,
      { sourceGroupId: 'group:4', direction: 'vertical', tabId: 'tab:foyer', moveTab: false },
      createCollidingId,
    );
    const groupOrder = groupIdsInLayoutOrder(split.layout);
    expect(groupOrder).toContain('group:4');
    expect(groupOrder).toContain('group:6');
    expect(new Set(groupOrder).size).toBe(groupOrder.length);
    expect(Object.keys(split.groupsById)).toContain('group:6');
    expect(Object.keys(split.tabsById)).toContain('tab:foyer-clone');
    expect(split.layout.kind).toBe('split');
    if (split.layout.kind === 'split') {
      expect(split.layout.id).toBe('split:5');
      const nested = split.layout.children.find((child) => child.kind === 'split');
      expect(nested?.kind === 'split' ? nested.id : null).toBe('split:7');
    }
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

  it('prunes an emptied source group after moving its last tab to another group', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('foyer'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const targetGroupId = Object.keys(state.groupsById).find((id) => id !== ROOT_GROUP_ID)!;
    state = moveWorkbenchTab(state, {
      tabId: 'tab:foyer',
      fromGroupId: ROOT_GROUP_ID,
      toGroupId: targetGroupId,
    });

    expect(state.groupsById[ROOT_GROUP_ID]).toBeUndefined();
    expect(state.layout).toEqual({ kind: 'group', groupId: targetGroupId });
    expect(state.groupsById[targetGroupId]?.tabIds).toEqual(['tab:foyer']);
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
    state = openWorkbenchTab(state, {
      id: 'tab:comfyui-workflows',
      title: 'ComfyUI Workflows',
      editorType: 'comfyui-workflows',
      resource: { kind: 'tool', stableId: 'utility:comfyui-workflows' },
    });

    const serialized = serializeProjectWorkbenchState(state);
    expect(Object.keys(serialized?.tabsById ?? {})).toEqual(['tab:project-settings', 'tab:assets']);
    expect(restoreProjectWorkbenchState(serialized ?? undefined, {}).tabsById['tab:project-settings']).toBeTruthy();
    expect(restoreProjectWorkbenchState(serialized ?? undefined, {}).tabsById['tab:assets']).toBeTruthy();

    const closed = closeProjectWorkbenchTabs(state);
    expect(Object.keys(closed.tabsById)).toEqual(['tab:settings', 'tab:comfyui-workflows']);
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

  it('serializes and restores child-keyed split sizes', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('left'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const rightGroupId = state.activeGroupId;
    state = openWorkbenchTab(state, rawTab('right'), { groupId: rightGroupId });
    const split = state.layout.kind === 'split' ? state.layout : null;
    expect(split).toBeTruthy();
    state = setWorkbenchSplitSizesByChild(state, split!.id, {
      [`group:${ROOT_GROUP_ID}`]: 65,
      [`group:${rightGroupId}`]: 35,
    });

    const serialized = serializeProjectWorkbenchState(state);
    expect(serialized?.layout.kind).toBe('split');
    if (serialized?.layout.kind === 'split') {
      expect(serialized.layout.sizesByChild).toEqual({
        [`group:${ROOT_GROUP_ID}`]: 65,
        [`group:${rightGroupId}`]: 35,
      });
    }

    const restored = restoreProjectWorkbenchState(serialized ?? undefined, {
      room: {
        left: { id: 'left', label: 'Left', tags: [], data: {} },
        right: { id: 'right', label: 'Right', tags: [], data: {} },
      },
    });
    expect(restored.layout.kind).toBe('split');
    if (restored.layout.kind === 'split') {
      expect(restored.layout.sizesByChild).toEqual({
        [`group:${ROOT_GROUP_ID}`]: 65,
        [`group:${rightGroupId}`]: 35,
      });
    }
  });

  it('restores project layout while grafting existing global tabs into the first project group', () => {
    let current = createInitialWorkbenchState();
    current = openWorkbenchTab(current, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });
    current = splitWorkbenchGroup(
      current,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const extraToolGroupId = current.activeGroupId;
    current = openWorkbenchTab(current, {
      id: 'tab:about',
      title: 'About',
      editorType: 'about',
      resource: { kind: 'tool', stableId: 'utility:about' },
    }, { groupId: extraToolGroupId });

    let projectState = createInitialWorkbenchState();
    projectState = openWorkbenchTab(projectState, rawTab('foyer'));
    projectState = splitWorkbenchGroup(
      projectState,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const rightProjectGroupId = projectState.activeGroupId;
    projectState = openWorkbenchTab(projectState, rawTab('kitchen'), { groupId: rightProjectGroupId });
    const serialized = serializeProjectWorkbenchState(projectState);

    const restored = restoreProjectWorkbenchStatePreservingGlobalTabs(serialized ?? undefined, {
      room: {
        foyer: { id: 'foyer', label: 'Foyer', tags: [], data: {} },
        kitchen: { id: 'kitchen', label: 'Kitchen', tags: [], data: {} },
      },
    }, current);

    expect(restored.layout.kind).toBe('split');
    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer', 'tab:settings', 'tab:about']);
    expect(restored.groupsById[rightProjectGroupId]?.tabIds).toEqual(['tab:kitchen']);
    expect(restored.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
    expect(restored.activeGroupId).toBe(rightProjectGroupId);
  });

  it('keeps the current workbench when opening a project without saved tabs', () => {
    let current = createInitialWorkbenchState();
    current = openWorkbenchTab(current, {
      id: 'tab:settings',
      title: 'Settings',
      editorType: 'settings',
      resource: { kind: 'tool', stableId: 'utility:settings' },
    });

    const restored = restoreProjectWorkbenchStatePreservingGlobalTabs(undefined, {}, current);

    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:settings']);
    expect(restored.tabsById['tab:settings']).toBeTruthy();
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

    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer', 'tab:settings']);
    expect(restored.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
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

    expect(restored.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer', 'tab:kitchen', 'tab:settings']);
    expect(restored.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:kitchen');
  });



  it('returns to the previously active tab when closing the current tab', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('assets'));
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:assets');
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:kitchen');

    state = closeWorkbenchTab(state, ROOT_GROUP_ID, 'tab:kitchen');

    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:assets');
  });

  it('closes other tabs in the target group and activates the selected tab', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('assets'));
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));

    state = closeOtherWorkbenchTabs(state, ROOT_GROUP_ID, 'tab:foyer');

    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
    expect(Object.keys(state.tabsById)).toEqual(['tab:foyer']);
    expect(state.recentlyClosedTabs.map((entry) => entry.tab.id)).toEqual(['tab:kitchen', 'tab:assets']);
  });

  it('closes only tabs to the right of the selected tab', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('assets'));
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = openWorkbenchTab(state, rawTab('library'));

    state = closeWorkbenchTabsToRight(state, ROOT_GROUP_ID, 'tab:foyer');

    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:assets', 'tab:foyer']);
    expect(Object.keys(state.tabsById)).toEqual(['tab:assets', 'tab:foyer']);
    expect(state.recentlyClosedTabs.map((entry) => entry.tab.id)).toEqual(['tab:library', 'tab:kitchen']);
  });

  it('batch closes tabs deterministically and preserves active tab invariants', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('assets'));
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = openWorkbenchTab(state, rawTab('kitchen'));
    state = activateWorkbenchTab(state, ROOT_GROUP_ID, 'tab:foyer');

    state = closeWorkbenchTabs(state, ROOT_GROUP_ID, ['missing', 'tab:assets', 'tab:kitchen']);

    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:foyer']);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBe('tab:foyer');
    expect(state.recentlyClosedTabs.map((entry) => entry.tab.id)).toEqual(['tab:kitchen', 'tab:assets']);
  });

  it('closes all tabs in a secondary group and prunes the empty group after the batch', () => {
    let state = openWorkbenchTab(createInitialWorkbenchState(), rawTab('left'));
    state = splitWorkbenchGroup(
      state,
      { sourceGroupId: ROOT_GROUP_ID, direction: 'horizontal' },
      createTestId,
    );
    const rightGroupId = state.activeGroupId;
    state = openWorkbenchTab(state, rawTab('right-a'), { groupId: rightGroupId });
    state = openWorkbenchTab(state, rawTab('right-b'), { groupId: rightGroupId });

    state = closeAllWorkbenchTabsInGroup(state, rightGroupId);

    expect(state.groupsById[rightGroupId]).toBeUndefined();
    expect(state.layout).toEqual({ kind: 'group', groupId: ROOT_GROUP_ID });
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual(['tab:left']);
    expect(state.recentlyClosedTabs.map((entry) => entry.tab.id)).toEqual(['tab:right-b', 'tab:right-a']);
  });

  it('keeps the root group valid after closing all remaining tabs', () => {
    let state = createInitialWorkbenchState();
    state = openWorkbenchTab(state, rawTab('foyer'));
    state = closeAllWorkbenchTabsInGroup(state, ROOT_GROUP_ID);

    expect(state.layout).toEqual({ kind: 'group', groupId: ROOT_GROUP_ID });
    expect(state.groupsById[ROOT_GROUP_ID]?.tabIds).toEqual([]);
    expect(state.groupsById[ROOT_GROUP_ID]?.activeTabId).toBeNull();
    expect(state.tabsById).toEqual({});
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
