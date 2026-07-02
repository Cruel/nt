import {
  authoringCollectionKeys,
  authoringCollectionMetadata,
  type AuthoringCollectionKey,
} from '../../shared/project-schema/authoring-collections';
import type { AuthoringProject, AuthoringRecordBase } from '../../shared/project-schema/authoring-project';
import type { WorkbenchTab } from '@/workbench/workbench-types';
import type { EditorChaptersState, EditorExplorerState } from '../../shared/project-schema/editor-project-state';
import { recordTargetKey } from './project-explorer-store';

export const collectiveCollections = ['assets', 'tests', 'variables'] as const satisfies readonly AuthoringCollectionKey[];
export type CollectiveCollectionKey = (typeof collectiveCollections)[number];
export const collectiveCollectionSet = new Set<AuthoringCollectionKey>(collectiveCollections);

export type ProjectExplorerNodeKind =
  | 'collection'
  | 'collective-collection'
  | 'chapter-folder'
  | 'all-folder'
  | 'unassigned-folder'
  | 'record'
  | 'hidden-root';

export interface ProjectExplorerNode {
  id: string;
  label: string;
  kind: ProjectExplorerNodeKind;
  collection?: AuthoringCollectionKey;
  entityId?: string;
  chapterId?: string;
  dimmed?: boolean;
  expandable: boolean;
  children?: ProjectExplorerNode[];
  count?: number;
}

export interface BuildProjectExplorerTreeOptions {
  explorer: EditorExplorerState;
  chapters: EditorChaptersState;
}

function compareLabels(left: { label: string; id?: string }, right: { label: string; id?: string }) {
  const byLabel = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
  if (byLabel !== 0) return byLabel;
  return (left.id ?? '').localeCompare(right.id ?? '');
}

function sortedCollections(collections: AuthoringCollectionKey[]) {
  return [...collections].sort((left, right) => compareLabels(authoringCollectionMetadata[left], authoringCollectionMetadata[right]));
}

function sortedRecords(records: Record<string, AuthoringRecordBase>) {
  return Object.entries(records)
    .map(([id, record]) => ({ id, record, label: record.label || id }))
    .sort(compareLabels);
}

function sortedChapterEntries(chapters: EditorChaptersState) {
  return Object.entries(chapters.records)
    .map(([id, chapter]) => ({ id, chapter, label: chapter.label || id }))
    .sort(compareLabels);
}

function isAssignedTo(chapters: EditorChaptersState, collection: AuthoringCollectionKey, entityId: string, chapterId: string) {
  return (chapters.assignments[recordTargetKey(collection, entityId)] ?? []).includes(chapterId);
}

function assignmentCount(chapters: EditorChaptersState, collection: AuthoringCollectionKey, entityId: string) {
  return chapters.assignments[recordTargetKey(collection, entityId)]?.length ?? 0;
}

function recordNode(collection: AuthoringCollectionKey, entityId: string, record: AuthoringRecordBase, placement = ''): ProjectExplorerNode {
  return {
    id: placement ? `record:${collection}:${entityId}:${placement}` : `record:${collection}:${entityId}`,
    label: record.label || entityId,
    kind: 'record',
    collection,
    entityId,
    expandable: false,
  };
}

function buildCollectionChildren(
  project: AuthoringProject,
  collection: AuthoringCollectionKey,
  explorer: EditorExplorerState,
  chapters: EditorChaptersState,
  dimmed: boolean,
): ProjectExplorerNode[] {
  const records = sortedRecords(project[collection]);
  if (collectiveCollectionSet.has(collection)) return [];
  if (!explorer.organizeByChapter) {
    return records.map(({ id, record }) => ({ ...recordNode(collection, id, record), dimmed }));
  }

  const children: ProjectExplorerNode[] = [];
  const usedChapterIds = new Set<string>();
  for (const chapter of sortedChapterEntries(chapters)) {
    const chapterRecords = records.filter(({ id }) => isAssignedTo(chapters, collection, id, chapter.id));
    if (chapterRecords.length === 0) continue;
    usedChapterIds.add(chapter.id);
    children.push({
      id: `chapter:${collection}:${chapter.id}`,
      label: chapter.label,
      kind: 'chapter-folder',
      collection,
      chapterId: chapter.id,
      dimmed,
      expandable: true,
      count: chapterRecords.length,
      children: chapterRecords.map(({ id, record }) => ({ ...recordNode(collection, id, record, `chapter:${chapter.id}`), dimmed })),
    });
  }

  const hasAnyAssignedRecord = records.some(({ id }) => assignmentCount(chapters, collection, id) > 0);
  if (explorer.groupUnassignedItems && hasAnyAssignedRecord) {
    const unassigned = records.filter(({ id }) => assignmentCount(chapters, collection, id) === 0);
    children.push({
      id: `all:${collection}`,
      label: 'All',
      kind: 'all-folder',
      collection,
      dimmed,
      expandable: true,
      count: records.length,
      children: records.map(({ id, record }) => ({ ...recordNode(collection, id, record, 'all'), dimmed })),
    });
    children.push({
      id: `unassigned:${collection}`,
      label: 'Unassigned',
      kind: 'unassigned-folder',
      collection,
      dimmed,
      expandable: true,
      count: unassigned.length,
      children: unassigned.map(({ id, record }) => ({ ...recordNode(collection, id, record, 'unassigned'), dimmed })),
    });
    return children;
  }

  const chapteredIds = new Set<string>();
  if (explorer.groupUnassignedItems) {
    for (const chapterId of usedChapterIds) {
      for (const { id } of records) if (isAssignedTo(chapters, collection, id, chapterId)) chapteredIds.add(id);
    }
  }
  const directRecords = explorer.groupUnassignedItems ? records.filter(({ id }) => !chapteredIds.has(id)) : records;
  children.push(...directRecords.map(({ id, record }) => ({ ...recordNode(collection, id, record), dimmed })));
  return children;
}

function collectionNode(project: AuthoringProject, collection: AuthoringCollectionKey, options: BuildProjectExplorerTreeOptions, dimmed = false): ProjectExplorerNode {
  const metadata = authoringCollectionMetadata[collection];
  const collective = collectiveCollectionSet.has(collection);
  const children = buildCollectionChildren(project, collection, options.explorer, options.chapters, dimmed);
  return {
    id: `${dimmed ? 'hidden:' : ''}collection:${collection}`,
    label: metadata.label,
    kind: collective ? 'collective-collection' : 'collection',
    collection,
    dimmed,
    expandable: !collective,
    count: Object.keys(project[collection]).length,
    children,
  };
}

export function buildProjectExplorerTree(project: AuthoringProject, options: BuildProjectExplorerTreeOptions): ProjectExplorerNode[] {
  const hidden = new Set(options.explorer.hiddenCollectionKeys);
  const visibleCollections = sortedCollections(authoringCollectionKeys.filter((collection) => !hidden.has(collection)));
  const hiddenCollections = sortedCollections(authoringCollectionKeys.filter((collection) => hidden.has(collection)));
  const nodes = visibleCollections.map((collection) => collectionNode(project, collection, options));
  if (hiddenCollections.length > 0) {
    nodes.push({
      id: 'hidden-root',
      label: 'Hidden',
      kind: 'hidden-root',
      dimmed: true,
      expandable: true,
      count: hiddenCollections.length,
      children: hiddenCollections.map((collection) => collectionNode(project, collection, options, true)),
    });
  }
  return nodes;
}

export function nodeHasVisibleChildren(node: ProjectExplorerNode) {
  return !!node.children?.length;
}

export interface ProjectExplorerNodePlacement {
  node: ProjectExplorerNode;
  ancestorIds: string[];
}

function walkTree(nodes: ProjectExplorerNode[], visit: (node: ProjectExplorerNode, ancestorIds: string[]) => boolean | void, ancestorIds: string[] = []): boolean {
  for (const node of nodes) {
    if (visit(node, ancestorIds) === true) return true;
    if (node.children?.length && walkTree(node.children, visit, [...ancestorIds, node.id])) return true;
  }
  return false;
}

export function findProjectExplorerNodeById(nodes: ProjectExplorerNode[], nodeId: string): ProjectExplorerNodePlacement | null {
  let result: ProjectExplorerNodePlacement | null = null;
  walkTree(nodes, (node, ancestorIds) => {
    if (node.id !== nodeId) return false;
    result = { node, ancestorIds };
    return true;
  });
  return result;
}

export function findProjectExplorerPlacementForTab(nodes: ProjectExplorerNode[], tab: WorkbenchTab | null | undefined): ProjectExplorerNodePlacement | null {
  if (!tab?.resource) return null;
  if (tab.resource.explorerNodeId) {
    const exact = findProjectExplorerNodeById(nodes, tab.resource.explorerNodeId);
    if (exact) return exact;
  }
  let result: ProjectExplorerNodePlacement | null = null;
  walkTree(nodes, (node, ancestorIds) => {
    if (tab.resource?.collection && tab.resource.entityId) {
      if (node.kind === 'record' && node.collection === tab.resource.collection && node.entityId === tab.resource.entityId) {
        result = { node, ancestorIds };
        return true;
      }
      return false;
    }
    if (tab.resource?.collection && !tab.resource.entityId) {
      if (node.kind === 'collective-collection' && node.collection === tab.resource.collection) {
        result = { node, ancestorIds };
        return true;
      }
      return false;
    }
    if (tab.resource?.kind === 'project' && tab.resource.stableId === 'project:settings') return false;
    return false;
  });
  return result;
}
