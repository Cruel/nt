import { create } from 'zustand';
import {
  emptyEditorChaptersState,
  emptyEditorExplorerState,
  type EditorChaptersState,
  type EditorExplorerState,
} from '../../shared/project-schema/editor-project-state';
import { isAuthoringCollectionKey, type AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';

function unique(values: Iterable<string>) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validCollections(values: Iterable<string>) {
  return unique([...values].filter(isAuthoringCollectionKey)) as AuthoringCollectionKey[];
}

interface ProjectExplorerStore {
  expandedNodeIds: string[];
  hiddenCollectionKeys: AuthoringCollectionKey[];
  followActiveTab: boolean;
  organizeByChapter: boolean;
  groupUnassignedItems: boolean;
  showInfoOnHover: boolean;
  searchQuery: string;
  filterTags: string[];
  showTagFilter: boolean;
  exactMatch: boolean;
  activeNodeId: string | null;
  followExpandedNodeIds: string[];
  followSuppressedNodeIds: string[];
  chapters: EditorChaptersState;
  hydrate: (explorer?: Partial<EditorExplorerState> | null, chapters?: Partial<EditorChaptersState> | null) => void;
  serializeExplorer: () => EditorExplorerState;
  serializeChapters: () => EditorChaptersState;
  toggleExpanded: (nodeId: string) => void;
  setExpanded: (nodeId: string, expanded: boolean) => void;
  setHiddenCollectionKeys: (keys: AuthoringCollectionKey[]) => void;
  hideCollection: (collection: AuthoringCollectionKey) => void;
  unhideCollection: (collection: AuthoringCollectionKey) => void;
  setFollowActiveTab: (enabled: boolean) => void;
  setOrganizeByChapter: (enabled: boolean) => void;
  setGroupUnassignedItems: (enabled: boolean) => void;
  setShowInfoOnHover: (enabled: boolean) => void;
  setSearchQuery: (query: string) => void;
  setFilterTags: (tags: string[]) => void;
  setShowTagFilter: (visible: boolean) => void;
  setExactMatch: (enabled: boolean) => void;
  setActiveNodeId: (nodeId: string | null) => void;
  setFollowExpandedNodeIds: (nodeIds: string[]) => void;
  suppressFollowNodeId: (nodeId: string) => void;
  clearFollowSuppressedNodeIds: () => void;
  setChapters: (chapters: EditorChaptersState) => void;
}

export const useProjectExplorerStore = create<ProjectExplorerStore>()((set, get) => ({
  expandedNodeIds: [],
  hiddenCollectionKeys: [],
  followActiveTab: true,
  organizeByChapter: true,
  groupUnassignedItems: true,
  showInfoOnHover: true,
  searchQuery: '',
  filterTags: [],
  showTagFilter: false,
  exactMatch: false,
  activeNodeId: null,
  followExpandedNodeIds: [],
  followSuppressedNodeIds: [],
  chapters: emptyEditorChaptersState(),
  hydrate: (explorer, chapters) => {
    const defaults = emptyEditorExplorerState();
    const nextExplorer = { ...defaults, ...(explorer ?? {}) };
    const nextChapters = { ...emptyEditorChaptersState(), ...(chapters ?? {}) };
    set({
      expandedNodeIds: unique(nextExplorer.expandedNodeIds ?? []),
      hiddenCollectionKeys: validCollections(nextExplorer.hiddenCollectionKeys ?? []),
      followActiveTab: nextExplorer.followActiveTab ?? true,
      organizeByChapter: nextExplorer.organizeByChapter ?? true,
      groupUnassignedItems: nextExplorer.groupUnassignedItems ?? true,
      showInfoOnHover: nextExplorer.showInfoOnHover ?? true,
      searchQuery: nextExplorer.searchQuery ?? '',
      filterTags: unique(nextExplorer.filterTags ?? []),
      showTagFilter: nextExplorer.showTagFilter ?? false,
      exactMatch: nextExplorer.exactMatch ?? false,
      activeNodeId: null,
      followExpandedNodeIds: [],
      followSuppressedNodeIds: [],
      chapters: {
        records: nextChapters.records ?? {},
        assignments: Object.fromEntries(
          Object.entries(nextChapters.assignments ?? {}).map(([key, values]) => [key, unique(values)]),
        ),
      },
    });
  },
  serializeExplorer: () => {
    const state = get();
    return {
      expandedNodeIds: unique(state.expandedNodeIds),
      hiddenCollectionKeys: validCollections(state.hiddenCollectionKeys),
      followActiveTab: state.followActiveTab,
      organizeByChapter: state.organizeByChapter,
      groupUnassignedItems: state.groupUnassignedItems,
      showInfoOnHover: state.showInfoOnHover,
      searchQuery: state.searchQuery,
      filterTags: unique(state.filterTags),
      showTagFilter: state.showTagFilter,
      exactMatch: state.exactMatch,
    };
  },
  serializeChapters: () => {
    const chapters = get().chapters;
    return {
      records: chapters.records,
      assignments: Object.fromEntries(Object.entries(chapters.assignments).map(([key, values]) => [key, unique(values)])),
    };
  },
  toggleExpanded: (nodeId) => set((state) => {
    const expanded = new Set(state.expandedNodeIds);
    if (expanded.has(nodeId)) expanded.delete(nodeId);
    else expanded.add(nodeId);
    return { expandedNodeIds: unique(expanded) };
  }),
  setExpanded: (nodeId, expandedValue) => set((state) => {
    const expanded = new Set(state.expandedNodeIds);
    if (expandedValue) expanded.add(nodeId);
    else expanded.delete(nodeId);
    return { expandedNodeIds: unique(expanded) };
  }),
  setHiddenCollectionKeys: (keys) => set({ hiddenCollectionKeys: validCollections(keys) }),
  hideCollection: (collection) => set((state) => ({ hiddenCollectionKeys: validCollections([...state.hiddenCollectionKeys, collection]) })),
  unhideCollection: (collection) => set((state) => ({ hiddenCollectionKeys: validCollections(state.hiddenCollectionKeys.filter((key) => key !== collection)) })),
  setFollowActiveTab: (followActiveTab) => set({ followActiveTab }),
  setOrganizeByChapter: (organizeByChapter) => set({ organizeByChapter }),
  setGroupUnassignedItems: (groupUnassignedItems) => set({ groupUnassignedItems }),
  setShowInfoOnHover: (showInfoOnHover) => set({ showInfoOnHover }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setFilterTags: (filterTags) => set({ filterTags: unique(filterTags) }),
  setShowTagFilter: (showTagFilter) => set({ showTagFilter }),
  setExactMatch: (exactMatch) => set({ exactMatch }),
  setActiveNodeId: (activeNodeId) => set({ activeNodeId }),
  setFollowExpandedNodeIds: (nodeIds) => set({ followExpandedNodeIds: unique(nodeIds) }),
  suppressFollowNodeId: (nodeId) => set((state) => ({
    followExpandedNodeIds: unique(state.followExpandedNodeIds.filter((id) => id !== nodeId)),
    followSuppressedNodeIds: unique([...state.followSuppressedNodeIds, nodeId]),
  })),
  clearFollowSuppressedNodeIds: () => set({ followSuppressedNodeIds: [] }),
  setChapters: (chapters) => set({ chapters }),
}));

export function recordTargetKey(collection: string, entityId: string) {
  return `${collection}:${entityId}`;
}

export function parseRecordTargetKey(value: string): { collection: AuthoringCollectionKey; entityId: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const collection = value.slice(0, separator);
  const entityId = value.slice(separator + 1);
  if (!isAuthoringCollectionKey(collection) || !entityId) return null;
  return { collection, entityId };
}
