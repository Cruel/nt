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
        activationHistory: [],
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
      Object.entries(state.groupsById).map(([id, group]) => [id, { ...group, tabIds: [...group.tabIds], activationHistory: [...(group.activationHistory ?? [])] }]),
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
    sizesByChild: node.sizesByChild ? { ...node.sizesByChild } : undefined,
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

function activationHistoryFor(group: WorkbenchGroup, activeTabId = group.activeTabId): string[] {
  const filtered = (group.activationHistory ?? []).filter((id, index, list) => group.tabIds.includes(id) && list.indexOf(id) === index);
  if (activeTabId && group.tabIds.includes(activeTabId)) return [activeTabId, ...filtered.filter((id) => id !== activeTabId)];
  return filtered;
}

function activateGroupTab(group: WorkbenchGroup, tabId: string): WorkbenchGroup {
  return { ...group, activeTabId: tabId, activationHistory: activationHistoryFor(group, tabId) };
}

function normalizeGroupActiveTab(group: WorkbenchGroup): WorkbenchGroup {
  const activeTabId = group.activeTabId && group.tabIds.includes(group.activeTabId) ? group.activeTabId : group.tabIds.at(-1) ?? null;
  return {
    ...group,
    activeTabId,
    activationHistory: activationHistoryFor(group, activeTabId),
  };
}

function isProjectScopedUtilityEditorType(editorType: string): boolean {
  return ['asset-library', 'test-suite', 'variables', 'project-settings', 'project-chapters', 'project-tags', 'image-generation'].includes(editorType);
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

export function workbenchLayoutChildKey(child: WorkbenchLayoutNode): string {
  return child.kind === 'group' ? `group:${child.groupId}` : `split:${child.id}`;
}

function normalizeSplitSizesByChild(node: Extract<WorkbenchLayoutNode, { kind: 'split' }>, sizesByChild?: Record<string, number>): Record<string, number> {
  const fallback = 100 / node.children.length;
  const entries = node.children.map((child) => {
    const key = workbenchLayoutChildKey(child);
    const value = sizesByChild?.[key] ?? fallback;
    return [key, Number.isFinite(value) && value > 0 ? value : fallback] as const;
  });
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return Object.fromEntries(entries.map(([key]) => [key, fallback]));
  return Object.fromEntries(entries.map(([key, value]) => [key, (value / total) * 100]));
}

function findSplitNode(node: WorkbenchLayoutNode, splitId: string): Extract<WorkbenchLayoutNode, { kind: 'split' }> | null {
  if (node.kind === 'group') return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const match = findSplitNode(child, splitId);
    if (match) return match;
  }
  return null;
}

function replaceSplitSizesByChild(
  node: WorkbenchLayoutNode,
  splitId: string,
  sizesByChild: Record<string, number>,
): WorkbenchLayoutNode {
  if (node.kind === 'group') return node;
  if (node.id === splitId) return { ...node, sizesByChild: normalizeSplitSizesByChild(node, sizesByChild) };
  return { ...node, children: node.children.map((child) => replaceSplitSizesByChild(child, splitId, sizesByChild)) };
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

function collectSplitIds(node: WorkbenchLayoutNode, ids = new Set<string>()): Set<string> {
  if (node.kind === 'split') {
    ids.add(node.id);
    for (const child of node.children) collectSplitIds(child, ids);
  }
  return ids;
}

function collectUsedWorkbenchIds(state: WorkbenchState): Set<string> {
  const ids = new Set<string>();
  for (const groupId of Object.keys(state.groupsById)) ids.add(groupId);
  for (const tabId of Object.keys(state.tabsById)) ids.add(tabId);
  for (const splitId of collectSplitIds(state.layout)) ids.add(splitId);
  for (const entry of state.recentlyClosedTabs) ids.add(entry.tab.id);
  return ids;
}

function createUniqueWorkbenchId(
  state: WorkbenchState,
  prefix: string,
  createId: WorkbenchIdFactory,
  reservedIds: Set<string>,
): string {
  const usedIds = collectUsedWorkbenchIds(state);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = createId(prefix);
    if (!usedIds.has(id) && !reservedIds.has(id)) {
      reservedIds.add(id);
      return id;
    }
  }

  let next = 1;
  while (usedIds.has(`${prefix}:${next}`) || reservedIds.has(`${prefix}:${next}`)) next += 1;
  const id = `${prefix}:${next}`;
  reservedIds.add(id);
  return id;
}

function collectGroupIdsInLayoutOrder(node: WorkbenchLayoutNode, groupIds: string[] = []): string[] {
  if (node.kind === 'group') {
    groupIds.push(node.groupId);
  } else {
    for (const child of node.children) collectGroupIdsInLayoutOrder(child, groupIds);
  }
  return groupIds;
}

function firstGroupIdInLayout(state: WorkbenchState): string | null {
  return collectGroupIdsInLayoutOrder(state.layout).find((groupId) => !!state.groupsById[groupId]) ?? null;
}

function globalTabsInLayoutOrder(state: WorkbenchState): WorkbenchTab[] {
  const tabs: WorkbenchTab[] = [];
  const seen = new Set<string>();
  for (const groupId of collectGroupIdsInLayoutOrder(state.layout)) {
    const group = state.groupsById[groupId];
    if (!group) continue;
    for (const tabId of group.tabIds) {
      const tab = state.tabsById[tabId];
      if (!tab || seen.has(tab.id) || !isGlobalToolTab(tab)) continue;
      tabs.push(tab);
      seen.add(tab.id);
    }
  }
  for (const tab of Object.values(state.tabsById)) {
    if (seen.has(tab.id) || !isGlobalToolTab(tab)) continue;
    tabs.push(tab);
    seen.add(tab.id);
  }
  return tabs;
}

function graftGlobalTabsIntoFirstGroup(projectWorkbench: WorkbenchState, globalTabs: WorkbenchTab[]): WorkbenchState {
  if (globalTabs.length === 0) return projectWorkbench;
  const next = cloneState(projectWorkbench);
  const targetGroupId = firstGroupIdInLayout(next) ?? fallbackGroupId(next);
  const targetGroup = next.groupsById[targetGroupId];
  if (!targetGroup) return next;
  const tabIds = [...targetGroup.tabIds];
  for (const tab of globalTabs) {
    if (!isGlobalToolTab(tab)) continue;
    const duplicateTabId = findTabByResource(next, tab);
    if (duplicateTabId) {
      if (!tabIds.includes(duplicateTabId)) tabIds.push(duplicateTabId);
      continue;
    }
    if (next.tabsById[tab.id]) continue;
    next.tabsById[tab.id] = { ...tab, resource: tab.resource ? { ...tab.resource } : undefined };
    tabIds.push(tab.id);
  }
  next.groupsById[targetGroupId] = {
    ...targetGroup,
    tabIds,
    activeTabId: targetGroup.activeTabId ?? tabIds[0] ?? null,
  };
  next.recentlyClosedTabs = next.recentlyClosedTabs.filter((entry) => isGlobalToolTab(entry.tab));
  return normalizeWorkbenchState(next);
}

function pruneEmptySplits(node: WorkbenchLayoutNode): WorkbenchLayoutNode {
  if (node.kind === 'group') return node;
  const children = node.children.map(pruneEmptySplits);
  if (children.length === 1) return children[0]!;
  const nextNode = { ...node, children };
  return { ...nextNode, sizesByChild: normalizeSplitSizesByChild(nextNode, node.sizesByChild) };
}

function removeGroupFromLayout(node: WorkbenchLayoutNode, groupId: string): WorkbenchLayoutNode | null {
  if (node.kind === 'group') return node.groupId === groupId ? null : node;
  const children = node.children
    .map((child) => removeGroupFromLayout(child, groupId))
    .filter((child): child is WorkbenchLayoutNode => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  const nextNode = { ...node, children };
  return { ...nextNode, sizesByChild: normalizeSplitSizesByChild(nextNode, node.sizesByChild) };
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

export function setWorkbenchSplitSizesByChild(state: WorkbenchState, splitId: string, sizesByChild: Record<string, number>): WorkbenchState {
  const next = cloneState(state);
  const split = findSplitNode(next.layout, splitId);
  if (!split) return state;
  const normalized = normalizeSplitSizesByChild(split, sizesByChild);
  const current = normalizeSplitSizesByChild(split, split.sizesByChild);
  const keys = Object.keys(normalized);
  if (keys.every((key) => Math.abs((current[key] ?? 0) - (normalized[key] ?? 0)) < 0.01)) return state;
  next.layout = replaceSplitSizesByChild(next.layout, splitId, normalized);
  return normalizeWorkbenchState(next);
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
  const filteredNode = { ...node, children };
  return { ...filteredNode, sizesByChild: normalizeSplitSizesByChild(filteredNode, node.sizesByChild) };
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
  if (Object.keys(projectWorkbench.tabsById).length > 0) {
    return graftGlobalTabsIntoFirstGroup(projectWorkbench, globalTabsInLayoutOrder(serialized));
  }
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

export function restoreProjectWorkbenchStatePreservingGlobalTabs(
  serialized: SerializedWorkbenchState | undefined,
  project: unknown,
  currentState: WorkbenchState,
): WorkbenchState {
  const restored = restoreProjectWorkbenchState(serialized, project);
  if (Object.keys(restored.tabsById).length === 0) return normalizeWorkbenchState(currentState);
  return graftGlobalTabsIntoFirstGroup(restored, globalTabsInLayoutOrder(currentState));
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
    next.groupsById[existingGroupId] = activateGroupTab(next.groupsById[existingGroupId]!, existingTabId);
    return normalizeWorkbenchState(next);
  }

  next.tabsById[tab.id] = { ...tab, resource: tab.resource ? { ...tab.resource } : undefined };
  const group = next.groupsById[targetGroupId]!;
  const tabIds = group.tabIds.includes(tab.id) ? group.tabIds : [...group.tabIds, tab.id];
  const nextGroup = { ...group, tabIds };
  next.groupsById[targetGroupId] = options.activate === false ? normalizeGroupActiveTab(nextGroup) : activateGroupTab(nextGroup, tab.id);
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
  next.groupsById[groupId] = activateGroupTab(group, tabId);
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
  return closeWorkbenchTabs(state, groupId, [tabId]);
}

export function closeWorkbenchTabs(
  state: WorkbenchState,
  groupId: string,
  tabIds: string[],
): WorkbenchState {
  const next = cloneState(state);
  const group = next.groupsById[groupId];
  if (!group) return next;

  const closeSet = new Set(tabIds.filter((tabId) => group.tabIds.includes(tabId) && !!next.tabsById[tabId]));
  if (closeSet.size === 0) return next;

  const closedTabIds = group.tabIds.filter((tabId) => closeSet.has(tabId));
  const closedTabs = closedTabIds.flatMap((tabId) => {
    const tab = next.tabsById[tabId];
    return tab ? [{ tab, closedFromGroupId: groupId }] : [];
  });
  next.recentlyClosedTabs = [...closedTabs.reverse(), ...next.recentlyClosedTabs].slice(0, 20);

  const firstClosedIndex = group.tabIds.findIndex((tabId) => closeSet.has(tabId));
  const remainingTabIds = group.tabIds.filter((tabId) => !closeSet.has(tabId));
  const activationHistory = (group.activationHistory ?? []).filter((tabId) => !closeSet.has(tabId));
  const nextActiveTabId =
    group.activeTabId && !closeSet.has(group.activeTabId)
      ? group.activeTabId
      : activationHistory.find((tabId) => remainingTabIds.includes(tabId))
        ?? remainingTabIds[Math.min(Math.max(firstClosedIndex, 0), remainingTabIds.length - 1)]
        ?? remainingTabIds.at(-1)
        ?? null;

  next.groupsById[groupId] = normalizeGroupActiveTab({
    ...group,
    tabIds: remainingTabIds,
    activeTabId: nextActiveTabId,
    activationHistory,
  });
  for (const tabId of closedTabIds) delete next.tabsById[tabId];

  if (remainingTabIds.length === 0 && Object.keys(next.groupsById).length > 1) {
    delete next.groupsById[groupId];
    const pruned = removeGroupFromLayout(next.layout, groupId);
    if (pruned) next.layout = pruned;
  }

  return normalizeWorkbenchState(next);
}

export function closeOtherWorkbenchTabs(
  state: WorkbenchState,
  groupId: string,
  tabId: string,
): WorkbenchState {
  const group = state.groupsById[groupId];
  if (!group || !group.tabIds.includes(tabId)) return state;
  const next = closeWorkbenchTabs(state, groupId, group.tabIds.filter((candidateId) => candidateId !== tabId));
  return activateWorkbenchTab(next, groupId, tabId);
}

export function closeWorkbenchTabsToRight(
  state: WorkbenchState,
  groupId: string,
  tabId: string,
): WorkbenchState {
  const group = state.groupsById[groupId];
  if (!group) return state;
  const tabIndex = group.tabIds.indexOf(tabId);
  if (tabIndex < 0) return state;
  return closeWorkbenchTabs(state, groupId, group.tabIds.slice(tabIndex + 1));
}

export function closeAllWorkbenchTabsInGroup(
  state: WorkbenchState,
  groupId: string,
): WorkbenchState {
  const group = state.groupsById[groupId];
  if (!group) return state;
  return closeWorkbenchTabs(state, groupId, group.tabIds);
}

export function splitWorkbenchGroup(
  state: WorkbenchState,
  options: SplitWorkbenchGroupOptions,
  createId: WorkbenchIdFactory,
): WorkbenchState {
  const next = cloneState(state);
  const sourceGroup = next.groupsById[options.sourceGroupId];
  if (!sourceGroup) return next;

  const reservedIds = new Set<string>();
  const newGroupId = createUniqueWorkbenchId(next, 'group', createId, reservedIds);
  const splitId = createUniqueWorkbenchId(next, 'split', createId, reservedIds);
  const tabToMove = options.tabId && sourceGroup.tabIds.includes(options.tabId) ? options.tabId : null;
  const clonedTabId = tabToMove && !options.moveTab ? createUniqueWorkbenchId(next, 'tab', createId, reservedIds) : null;
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
  const sourceChild: WorkbenchLayoutNode = { kind: 'group', groupId: options.sourceGroupId };
  const newChild: WorkbenchLayoutNode = { kind: 'group', groupId: newGroupId };
  const splitChildren: WorkbenchLayoutNode[] = options.placement === 'before'
    ? [newChild, sourceChild]
    : [sourceChild, newChild];
  next.layout = replaceGroupNode(next.layout, options.sourceGroupId, {
    kind: 'split',
    id: splitId,
    direction: options.direction,
    children: splitChildren,
    sizesByChild: Object.fromEntries(splitChildren.map((child) => [workbenchLayoutChildKey(child), 50])),
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
  next.groupsById[groupId] = activateGroupTab({ ...group, tabIds }, tabId);
  next.activeGroupId = groupId;
  return normalizeWorkbenchState(next);
}
