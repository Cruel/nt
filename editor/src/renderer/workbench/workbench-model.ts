import type { SerializedWorkbenchState } from '../../shared/project-schema/editor-project-state';
import type {
  MoveWorkbenchTabOptions,
  OpenWorkbenchTabOptions,
  SplitWorkbenchGroupOptions,
  WorkbenchGroup,
  WorkbenchIdFactory,
  WorkbenchLayoutNode,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';

export const PRIMARY_PREVIEW_TAB_ID = 'tab:primary-preview';
export const ROOT_GROUP_ID = 'group:root';

export function createPrimaryPreviewTab(): WorkbenchTab {
  return {
    id: PRIMARY_PREVIEW_TAB_ID,
    title: 'Preview',
    editorType: 'engine-preview',
    preview: true,
    resource: {
      kind: 'preview',
      stableId: 'preview:primary',
    },
  };
}

export function createInitialWorkbenchState(): WorkbenchState {
  return {
    layout: { kind: 'group', groupId: ROOT_GROUP_ID },
    groupsById: {
      [ROOT_GROUP_ID]: {
        id: ROOT_GROUP_ID,
        tabIds: [],
        activeTabId: null,
      },
    },
    tabsById: {},
    activeGroupId: ROOT_GROUP_ID,
    recentlyClosedTabs: [],
  };
}

function cloneState(state: WorkbenchState): WorkbenchState {
  return {
    layout: cloneLayoutNode(state.layout),
    groupsById: Object.fromEntries(
      Object.entries(state.groupsById).map(([id, group]) => [id, { ...group, tabIds: [...group.tabIds] }]),
    ),
    tabsById: Object.fromEntries(
      Object.entries(state.tabsById).map(([id, tab]) => [id, { ...tab, resource: tab.resource ? { ...tab.resource } : undefined }]),
    ),
    activeGroupId: state.activeGroupId,
    recentlyClosedTabs: state.recentlyClosedTabs.map((entry) => ({
      closedFromGroupId: entry.closedFromGroupId,
      tab: { ...entry.tab, resource: entry.tab.resource ? { ...entry.tab.resource } : undefined },
    })),
  };
}

function cloneLayoutNode(node: WorkbenchLayoutNode): WorkbenchLayoutNode {
  if (node.kind === 'group') return { ...node };
  return {
    ...node,
    children: node.children.map(cloneLayoutNode),
    sizes: node.sizes ? [...node.sizes] : undefined,
  };
}

function resourceKey(tab: WorkbenchTab): string | null {
  if (!tab.resource) return null;
  return `${tab.editorType}:${tab.resource.stableId}`;
}

function findTabByResource(state: WorkbenchState, tab: WorkbenchTab): string | null {
  const key = resourceKey(tab);
  if (!key) return null;
  for (const existing of Object.values(state.tabsById)) {
    if (resourceKey(existing) === key) return existing.id;
  }
  return null;
}

function findGroupContainingTab(state: WorkbenchState, tabId: string): string | null {
  for (const group of Object.values(state.groupsById)) {
    if (group.tabIds.includes(tabId)) return group.id;
  }
  return null;
}

function fallbackGroupId(state: WorkbenchState): string {
  if (state.groupsById[state.activeGroupId]) return state.activeGroupId;
  return Object.keys(state.groupsById)[0] ?? ROOT_GROUP_ID;
}

function normalizeGroupActiveTab(group: WorkbenchGroup): WorkbenchGroup {
  if (group.activeTabId && group.tabIds.includes(group.activeTabId)) return group;
  return {
    ...group,
    activeTabId: group.tabIds.at(-1) ?? null,
  };
}

function isProjectScopedUtilityEditorType(editorType: string): boolean {
  return ['asset-library', 'test-suite', 'variables', 'project-settings'].includes(editorType);
}

function isGlobalToolTab(tab: WorkbenchTab): boolean {
  if (tab.resource?.kind !== 'tool') return false;
  return !isProjectScopedUtilityEditorType(tab.editorType);
}

function normalizedProjectScopedResource(tab: WorkbenchTab): WorkbenchTab['resource'] | null {
  if (!tab.resource) return null;
  if (tab.resource.kind !== 'tool') return { ...tab.resource };
  if (!isProjectScopedUtilityEditorType(tab.editorType)) return null;
  return { ...tab.resource, kind: 'project' };
}

function replaceGroupNode(
  node: WorkbenchLayoutNode,
  groupId: string,
  replacement: WorkbenchLayoutNode,
): WorkbenchLayoutNode {
  if (node.kind === 'group') {
    return node.groupId === groupId ? replacement : node;
  }
  return {
    ...node,
    children: node.children.map((child) => replaceGroupNode(child, groupId, replacement)),
  };
}

function collectGroupIds(node: WorkbenchLayoutNode, ids = new Set<string>()): Set<string> {
  if (node.kind === 'group') {
    ids.add(node.groupId);
  } else {
    for (const child of node.children) collectGroupIds(child, ids);
  }
  return ids;
}

function pruneEmptySplits(node: WorkbenchLayoutNode): WorkbenchLayoutNode {
  if (node.kind === 'group') return node;
  const children = node.children.map(pruneEmptySplits);
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

function removeGroupFromLayout(node: WorkbenchLayoutNode, groupId: string): WorkbenchLayoutNode | null {
  if (node.kind === 'group') return node.groupId === groupId ? null : node;
  const children = node.children
    .map((child) => removeGroupFromLayout(child, groupId))
    .filter((child): child is WorkbenchLayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

function normalizeWorkbenchState(state: WorkbenchState): WorkbenchState {
  const next = cloneState(state);
  const layoutGroupIds = collectGroupIds(next.layout);
  for (const groupId of Object.keys(next.groupsById)) {
    if (!layoutGroupIds.has(groupId)) delete next.groupsById[groupId];
  }
  if (Object.keys(next.groupsById).length === 0) {
    return {
      layout: { kind: 'group', groupId: ROOT_GROUP_ID },
      groupsById: {
        [ROOT_GROUP_ID]: { id: ROOT_GROUP_ID, tabIds: [], activeTabId: null },
      },
      tabsById: {},
      activeGroupId: ROOT_GROUP_ID,
      recentlyClosedTabs: next.recentlyClosedTabs,
    };
  }

  for (const [groupId, group] of Object.entries(next.groupsById)) {
    next.groupsById[groupId] = normalizeGroupActiveTab(group);
  }

  const referencedTabs = new Set<string>();
  for (const group of Object.values(next.groupsById)) {
    for (const tabId of group.tabIds) referencedTabs.add(tabId);
  }
  for (const tabId of Object.keys(next.tabsById)) {
    if (!referencedTabs.has(tabId)) delete next.tabsById[tabId];
  }

  next.layout = pruneEmptySplits(next.layout);
  next.activeGroupId = fallbackGroupId(next);
  return next;
}

export function closeProjectWorkbenchTabs(state: WorkbenchState): WorkbenchState {
  const next = cloneState(state);
  const preservedTabs = Object.values(next.tabsById).filter(isGlobalToolTab);
  const activeTab = next.tabsById[next.groupsById[next.activeGroupId]?.activeTabId ?? ''];
  const preservedActiveTabId = activeTab && isGlobalToolTab(activeTab) ? activeTab.id : null;

  return normalizeWorkbenchState({
    layout: { kind: 'group', groupId: ROOT_GROUP_ID },
    groupsById: {
      [ROOT_GROUP_ID]: {
        id: ROOT_GROUP_ID,
        tabIds: preservedTabs.map((tab) => tab.id),
        activeTabId: preservedActiveTabId ?? preservedTabs.at(-1)?.id ?? null,
      },
    },
    tabsById: Object.fromEntries(preservedTabs.map((tab) => [tab.id, tab])),
    activeGroupId: ROOT_GROUP_ID,
    recentlyClosedTabs: next.recentlyClosedTabs.filter((entry) => isGlobalToolTab(entry.tab)),
  });
}

function cloneTabForProjectPersistence(tab: WorkbenchTab): WorkbenchTab | null {
  if (!tab.resource) return null;
  const resource = normalizedProjectScopedResource(tab);
  if (!resource) return null;
  return {
    id: tab.id,
    title: tab.title,
    editorType: tab.editorType,
    resource,
    pinned: tab.pinned || undefined,
    preview: tab.preview || undefined,
  };
}

function projectHasResource(project: unknown, tab: WorkbenchTab): boolean {
  const resource = tab.resource;
  if (!resource) return false;
  if (resource.kind === 'preview' || resource.kind === 'project') return true;
  if ((resource.kind === 'record' || resource.kind === 'raw') && resource.collection && resource.entityId) {
    if (typeof project !== 'object' || project === null || Array.isArray(project)) return false;
    const collection = (project as Record<string, unknown>)[resource.collection];
    return typeof collection === 'object'
      && collection !== null
      && !Array.isArray(collection)
      && Object.prototype.hasOwnProperty.call(collection, resource.entityId);
  }
  return false;
}

function filterLayoutToGroups(node: WorkbenchLayoutNode, groupIds: Set<string>): WorkbenchLayoutNode | null {
  if (node.kind === 'group') return groupIds.has(node.groupId) ? node : null;
  const children = node.children
    .map((child) => filterLayoutToGroups(child, groupIds))
    .filter((child): child is WorkbenchLayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: node.sizes?.slice(0, children.length) };
}

function tabResourceStableId(tab: WorkbenchTab): string | null {
  return tab.resource?.stableId ?? null;
}

export function serializeShellWorkbenchState(state: WorkbenchState): WorkbenchState {
  const next = normalizeWorkbenchState(state);
  return {
    layout: cloneLayoutNode(next.layout),
    groupsById: Object.fromEntries(
      Object.entries(next.groupsById).map(([groupId, group]) => [groupId, { ...group, tabIds: [...group.tabIds] }]),
    ),
    tabsById: Object.fromEntries(
      Object.entries(next.tabsById).map(([tabId, tab]) => [tabId, {
        id: tab.id,
        title: tab.title,
        editorType: tab.editorType,
        resource: tab.resource ? { ...tab.resource } : undefined,
        pinned: tab.pinned || undefined,
        preview: tab.preview || undefined,
      }]),
    ),
    activeGroupId: next.activeGroupId,
    recentlyClosedTabs: [],
  };
}

export function restoreShellWorkbenchState(
  serialized: WorkbenchState | null | undefined,
  project: unknown,
  projectWorkbench: WorkbenchState,
): WorkbenchState {
  if (!serialized) return projectWorkbench;
  const projectTabsByStableId = new Map(
    Object.values(projectWorkbench.tabsById)
      .map((tab) => [tabResourceStableId(tab), tab] as const)
      .filter((entry): entry is readonly [string, WorkbenchTab] => entry[0] !== null),
  );
  const tabEntries: Array<readonly [string, WorkbenchTab]> = [];
  for (const [tabId, tab] of Object.entries(serialized.tabsById)) {
    if (tab.resource?.kind === 'tool') {
      tabEntries.push([tabId, { ...tab, resource: { ...tab.resource } }]);
      continue;
    }
    const stableId = tabResourceStableId(tab);
    const canonical = stableId ? projectTabsByStableId.get(stableId) : undefined;
    if (canonical) {
      tabEntries.push([tabId, { ...canonical, id: tabId, resource: canonical.resource ? { ...canonical.resource } : undefined }]);
      continue;
    }
    if (projectHasResource(project, tab)) {
      tabEntries.push([tabId, { ...tab, resource: tab.resource ? { ...tab.resource } : undefined }]);
    }
  }
  const tabsById = Object.fromEntries(tabEntries);
  if (Object.keys(tabsById).length === 0) return projectWorkbench;
  const groupsById = Object.fromEntries(
    Object.entries(serialized.groupsById)
      .map(([groupId, group]) => {
        const tabIds = group.tabIds.filter((tabId) => !!tabsById[tabId]);
        return [groupId, { ...group, tabIds, activeTabId: group.activeTabId && tabIds.includes(group.activeTabId) ? group.activeTabId : tabIds.at(-1) ?? null }] as const;
      })
      .filter(([, group]) => group.tabIds.length > 0),
  );
  if (Object.keys(groupsById).length === 0) return projectWorkbench;

  const representedProjectStableIds = new Set(
    Object.values(tabsById)
      .map(tabResourceStableId)
      .filter((stableId): stableId is string => stableId !== null),
  );
  const targetGroupId = groupsById[serialized.activeGroupId] ? serialized.activeGroupId : Object.keys(groupsById)[0]!;
  const targetGroup = groupsById[targetGroupId]!;
  for (const projectTab of Object.values(projectWorkbench.tabsById)) {
    const stableId = tabResourceStableId(projectTab);
    if (!stableId || representedProjectStableIds.has(stableId)) continue;
    tabsById[projectTab.id] = { ...projectTab, resource: projectTab.resource ? { ...projectTab.resource } : undefined };
    targetGroup.tabIds.push(projectTab.id);
    representedProjectStableIds.add(stableId);
  }

  const layout = filterLayoutToGroups(serialized.layout, new Set(Object.keys(groupsById))) ?? { kind: 'group' as const, groupId: Object.keys(groupsById)[0]! };
  return normalizeWorkbenchState({
    layout,
    groupsById,
    tabsById,
    activeGroupId: groupsById[serialized.activeGroupId] ? serialized.activeGroupId : Object.keys(groupsById)[0]!,
    recentlyClosedTabs: [],
  });
}

export function serializeProjectWorkbenchState(state: WorkbenchState): SerializedWorkbenchState | null {
  const next = normalizeWorkbenchState(state);
  const tabsById = Object.fromEntries(
    Object.entries(next.tabsById)
      .map(([tabId, tab]) => [tabId, cloneTabForProjectPersistence(tab)] as const)
      .filter((entry): entry is readonly [string, WorkbenchTab] => entry[1] !== null),
  );
  if (Object.keys(tabsById).length === 0) return null;

  const groupsById = Object.fromEntries(
    Object.entries(next.groupsById)
      .map(([groupId, group]) => {
        const tabIds = group.tabIds.filter((tabId) => !!tabsById[tabId]);
        return [groupId, { ...group, tabIds, activeTabId: group.activeTabId && tabIds.includes(group.activeTabId) ? group.activeTabId : tabIds.at(-1) ?? null }] as const;
      })
      .filter(([, group]) => group.tabIds.length > 0),
  );
  if (Object.keys(groupsById).length === 0) return null;

  const layout = filterLayoutToGroups(next.layout, new Set(Object.keys(groupsById))) ?? { kind: 'group' as const, groupId: Object.keys(groupsById)[0]! };
  const activeGroupId = groupsById[next.activeGroupId] ? next.activeGroupId : Object.keys(groupsById)[0]!;
  return { layout, groupsById, tabsById, activeGroupId };
}

export function restoreProjectWorkbenchState(serialized: SerializedWorkbenchState | undefined, project: unknown): WorkbenchState {
  if (!serialized) return createInitialWorkbenchState();
  const tabsById = Object.fromEntries(
    Object.entries(serialized.tabsById)
      .filter(([, tab]) => projectHasResource(project, tab as WorkbenchTab))
      .map(([tabId, tab]) => [tabId, { ...tab, resource: tab.resource ? { ...tab.resource } : undefined }] as const),
  );
  if (Object.keys(tabsById).length === 0) return createInitialWorkbenchState();
  const groupsById = Object.fromEntries(
    Object.entries(serialized.groupsById)
      .map(([groupId, group]) => {
        const tabIds = group.tabIds.filter((tabId) => !!tabsById[tabId]);
        return [groupId, { ...group, tabIds, activeTabId: group.activeTabId && tabIds.includes(group.activeTabId) ? group.activeTabId : tabIds.at(-1) ?? null }] as const;
      })
      .filter(([, group]) => group.tabIds.length > 0),
  );
  if (Object.keys(groupsById).length === 0) return createInitialWorkbenchState();
  const layout = filterLayoutToGroups(serialized.layout as WorkbenchLayoutNode, new Set(Object.keys(groupsById))) ?? { kind: 'group' as const, groupId: Object.keys(groupsById)[0]! };
  return normalizeWorkbenchState({
    layout,
    groupsById,
    tabsById,
    activeGroupId: groupsById[serialized.activeGroupId] ? serialized.activeGroupId : Object.keys(groupsById)[0]!,
    recentlyClosedTabs: [],
  });
}

export function openWorkbenchTab(
  state: WorkbenchState,
  tab: WorkbenchTab,
  options: OpenWorkbenchTabOptions = {},
): WorkbenchState {
  const next = cloneState(state);
  const targetGroupId = options.groupId && next.groupsById[options.groupId] ? options.groupId : fallbackGroupId(next);
  const existingTabId = options.duplicate ? null : findTabByResource(next, tab);

  if (existingTabId) {
    const existingGroupId = findGroupContainingTab(next, existingTabId) ?? targetGroupId;
    if (tab.resource?.explorerNodeId) {
      next.tabsById[existingTabId] = {
        ...next.tabsById[existingTabId]!,
        resource: {
          ...next.tabsById[existingTabId]!.resource!,
          explorerNodeId: tab.resource.explorerNodeId,
        },
      };
    }
    next.activeGroupId = existingGroupId;
    next.groupsById[existingGroupId] = {
      ...next.groupsById[existingGroupId]!,
      activeTabId: existingTabId,
    };
    return normalizeWorkbenchState(next);
  }

  next.tabsById[tab.id] = { ...tab, resource: tab.resource ? { ...tab.resource } : undefined };
  const group = next.groupsById[targetGroupId]!;
  next.groupsById[targetGroupId] = {
    ...group,
    tabIds: group.tabIds.includes(tab.id) ? group.tabIds : [...group.tabIds, tab.id],
    activeTabId: options.activate === false ? group.activeTabId : tab.id,
  };
  if (options.activate !== false) next.activeGroupId = targetGroupId;
  return normalizeWorkbenchState(next);
}

export function activateWorkbenchTab(
  state: WorkbenchState,
  groupId: string,
  tabId: string,
): WorkbenchState {
  const next = cloneState(state);
  const group = next.groupsById[groupId];
  if (!group || !group.tabIds.includes(tabId)) return next;
  next.groupsById[groupId] = { ...group, activeTabId: tabId };
  next.activeGroupId = groupId;
  return normalizeWorkbenchState(next);
}

export function activateWorkbenchGroup(state: WorkbenchState, groupId: string): WorkbenchState {
  if (!state.groupsById[groupId] || state.activeGroupId === groupId) return state;
  const next = cloneState(state);
  next.activeGroupId = groupId;
  return normalizeWorkbenchState(next);
}

export function closeWorkbenchTab(
  state: WorkbenchState,
  groupId: string,
  tabId: string,
): WorkbenchState {
  const next = cloneState(state);
  const group = next.groupsById[groupId];
  const tab = next.tabsById[tabId];
  if (!group || !tab || !group.tabIds.includes(tabId)) return next;

  next.recentlyClosedTabs = [{ tab, closedFromGroupId: groupId }, ...next.recentlyClosedTabs].slice(0, 20);
  const tabIndex = group.tabIds.indexOf(tabId);
  const tabIds = group.tabIds.filter((id) => id !== tabId);
  const nextActiveTabId =
    group.activeTabId === tabId ? tabIds[Math.min(tabIndex, tabIds.length - 1)] ?? tabIds.at(-1) ?? null : group.activeTabId;
  next.groupsById[groupId] = { ...group, tabIds, activeTabId: nextActiveTabId };
  delete next.tabsById[tabId];

  if (tabIds.length === 0 && Object.keys(next.groupsById).length > 1) {
    delete next.groupsById[groupId];
    const pruned = removeGroupFromLayout(next.layout, groupId);
    if (pruned) next.layout = pruned;
  }

  return normalizeWorkbenchState(next);
}

export function splitWorkbenchGroup(
  state: WorkbenchState,
  options: SplitWorkbenchGroupOptions,
  createId: WorkbenchIdFactory,
): WorkbenchState {
  const next = cloneState(state);
  const sourceGroup = next.groupsById[options.sourceGroupId];
  if (!sourceGroup) return next;

  const newGroupId = createId('group');
  const splitId = createId('split');
  const tabToMove = options.tabId && sourceGroup.tabIds.includes(options.tabId) ? options.tabId : null;
  const clonedTabId = tabToMove && !options.moveTab ? createId('tab') : null;
  if (tabToMove && clonedTabId) {
    const sourceTab = next.tabsById[tabToMove];
    if (sourceTab) {
      next.tabsById[clonedTabId] = {
        ...sourceTab,
        id: clonedTabId,
        resource: sourceTab.resource ? { ...sourceTab.resource } : undefined,
      };
    }
  }
  const newGroupTabIds = tabToMove ? [options.moveTab ? tabToMove : clonedTabId ?? tabToMove] : [];
  const sourceTabIds = tabToMove && options.moveTab ? sourceGroup.tabIds.filter((id) => id !== tabToMove) : sourceGroup.tabIds;
  const newActiveTabId = newGroupTabIds[0] ?? null;

  next.groupsById[options.sourceGroupId] = normalizeGroupActiveTab({
    ...sourceGroup,
    tabIds: sourceTabIds,
    activeTabId: sourceGroup.activeTabId === tabToMove && options.moveTab ? sourceTabIds.at(-1) ?? null : sourceGroup.activeTabId,
  });
  next.groupsById[newGroupId] = {
    id: newGroupId,
    tabIds: newGroupTabIds,
    activeTabId: newActiveTabId,
  };
  next.layout = replaceGroupNode(next.layout, options.sourceGroupId, {
    kind: 'split',
    id: splitId,
    direction: options.direction,
    children: [
      { kind: 'group', groupId: options.sourceGroupId },
      { kind: 'group', groupId: newGroupId },
    ],
    sizes: [50, 50],
  });
  next.activeGroupId = newGroupId;
  return normalizeWorkbenchState(next);
}

export function moveWorkbenchTab(state: WorkbenchState, options: MoveWorkbenchTabOptions): WorkbenchState {
  const next = cloneState(state);
  const sourceGroup = next.groupsById[options.fromGroupId];
  const targetGroup = next.groupsById[options.toGroupId];
  if (!sourceGroup || !targetGroup || !sourceGroup.tabIds.includes(options.tabId)) return next;

  const sourceTabIds = sourceGroup.tabIds.filter((id) => id !== options.tabId);
  const targetTabIds = targetGroup.tabIds.filter((id) => id !== options.tabId);
  const insertAt = Math.max(0, Math.min(options.toIndex ?? targetTabIds.length, targetTabIds.length));
  targetTabIds.splice(insertAt, 0, options.tabId);

  next.groupsById[options.fromGroupId] = normalizeGroupActiveTab({
    ...sourceGroup,
    tabIds: sourceTabIds,
    activeTabId: sourceGroup.activeTabId === options.tabId ? sourceTabIds.at(-1) ?? null : sourceGroup.activeTabId,
  });
  next.groupsById[options.toGroupId] = {
    ...targetGroup,
    tabIds: targetTabIds,
    activeTabId: options.activate === false ? targetGroup.activeTabId : options.tabId,
  };
  if (options.activate !== false) next.activeGroupId = options.toGroupId;

  if (sourceTabIds.length === 0 && Object.keys(next.groupsById).length > 1) {
    delete next.groupsById[options.fromGroupId];
    const pruned = removeGroupFromLayout(next.layout, options.fromGroupId);
    if (pruned) next.layout = pruned;
  }

  return normalizeWorkbenchState(next);
}

export function setWorkbenchTabDirty(
  state: WorkbenchState,
  tabId: string,
  dirty: boolean,
): WorkbenchState {
  const next = cloneState(state);
  const tab = next.tabsById[tabId];
  if (!tab) return next;
  next.tabsById[tabId] = { ...tab, dirty };
  return next;
}

export function reopenLastClosedWorkbenchTab(state: WorkbenchState): WorkbenchState {
  const next = cloneState(state);
  const [entry, ...rest] = next.recentlyClosedTabs;
  if (!entry) return next;
  next.recentlyClosedTabs = rest;
  return openWorkbenchTab(next, entry.tab, {
    groupId: next.groupsById[entry.closedFromGroupId] ? entry.closedFromGroupId : next.activeGroupId,
    activate: true,
    duplicate: true,
  });
}

export function moveWorkbenchTabWithinGroup(
  state: WorkbenchState,
  groupId: string,
  tabId: string,
  toIndex: number,
): WorkbenchState {
  const next = cloneState(state);
  const group = next.groupsById[groupId];
  if (!group || !group.tabIds.includes(tabId)) return next;
  const tabIds = group.tabIds.filter((id) => id !== tabId);
  const insertAt = Math.max(0, Math.min(toIndex, tabIds.length));
  tabIds.splice(insertAt, 0, tabId);
  next.groupsById[groupId] = { ...group, tabIds, activeTabId: tabId };
  next.activeGroupId = groupId;
  return normalizeWorkbenchState(next);
}
