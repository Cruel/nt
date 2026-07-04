import { Settings } from 'lucide-react';
import type { ComponentType } from 'react';
import { authoringCollectionMetadata } from '../../shared/project-schema/authoring-collections';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { searchDocuments } from '../../shared/project-search/project-search';
import type { ProjectSearchDocument, ProjectSearchFieldKind, ProjectSearchMatch } from '../../shared/project-search/project-search-types';
import { visualForCollection } from './collection-visuals';

export type CommandPaletteItemKind = 'action' | 'record';
export type CommandPaletteFieldKind = 'title' | 'id' | 'tag' | 'collection' | 'action';

export interface CommandPaletteItem {
  id: string;
  kind: CommandPaletteItemKind;
  title: string;
  subtitle?: string;
  collection?: AuthoringCollectionKey;
  entityId?: string;
  action?: 'project-settings' | 'assets' | 'variables' | 'tests';
  tags: string[];
  collectionTerms: string[];
  actionTerms: string[];
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
}

export interface CommandPaletteMatch {
  fieldKind: CommandPaletteFieldKind;
  fieldLabel: string;
  value: string;
  indices: readonly (readonly [number, number])[];
}

export interface CommandPaletteSearchResult {
  item: CommandPaletteItem;
  score: number;
  matches: CommandPaletteMatch[];
}

function actionItem(item: Omit<CommandPaletteItem, 'kind' | 'tags' | 'collectionTerms' | 'actionTerms' | 'icon' | 'iconClassName'> & { search: string[] }): CommandPaletteItem {
  return {
    ...item,
    kind: 'action',
    tags: [],
    collectionTerms: [],
    actionTerms: [item.subtitle ?? '', ...item.search].filter(Boolean),
    icon: Settings,
    iconClassName: 'text-muted-foreground',
  };
}

const baseActions: CommandPaletteItem[] = [
  actionItem({ id: 'action:project-settings', title: 'Project Settings', subtitle: 'Open project settings', action: 'project-settings', search: ['settings', 'project settings', 'preferences'] }),
  actionItem({ id: 'action:assets', title: 'Assets', subtitle: 'Open asset browser', action: 'assets', search: ['assets', 'asset browser', 'images audio fonts'] }),
  actionItem({ id: 'action:variables', title: 'Variables', subtitle: 'Open variables editor', action: 'variables', search: ['variables', 'state flags'] }),
  actionItem({ id: 'action:tests', title: 'Tests', subtitle: 'Open playback tests', action: 'tests', search: ['tests', 'playback tests', 'smoke tests'] }),
];

export function buildCommandPaletteItems(project: AuthoringProject | null): CommandPaletteItem[] {
  const items = [...baseActions];
  if (!project) return items;
  for (const [collection, metadata] of Object.entries(authoringCollectionMetadata) as Array<[AuthoringCollectionKey, (typeof authoringCollectionMetadata)[AuthoringCollectionKey]]>) {
    const visual = visualForCollection(collection);
    for (const [entityId, record] of Object.entries(project[collection])) {
      const title = record.label || entityId;
      items.push({
        id: `record:${collection}:${entityId}`,
        kind: 'record',
        title,
        subtitle: metadata.label,
        collection,
        entityId,
        tags: record.tags ?? [],
        collectionTerms: [metadata.label, metadata.singularLabel],
        actionTerms: [],
        icon: visual.icon,
        iconClassName: visual.colorClassName,
      });
    }
  }
  return items;
}

function itemToSearchDocument(item: CommandPaletteItem): ProjectSearchDocument {
  const fields = [
    { kind: 'title' as const, label: 'Name', value: item.title, path: `/${item.id}/title`, weight: 4, defaultSearchable: true },
    ...(item.entityId ? [{ kind: 'id' as const, label: 'ID', value: item.entityId, path: `/${item.id}/id`, weight: 3.5, defaultSearchable: true }] : []),
    ...item.tags.map((tag, index) => ({ kind: 'tag' as const, label: 'Tag', value: tag, path: `/${item.id}/tags/${index}`, weight: 2.75, defaultSearchable: true })),
    ...item.actionTerms.map((term, index) => ({ kind: 'action' as const, label: 'Action', value: term, path: `/${item.id}/actionTerms/${index}`, weight: 2, defaultSearchable: true })),
    ...item.collectionTerms.map((term, index) => ({ kind: 'collection' as const, label: 'Collection', value: term, path: `/${item.id}/collectionTerms/${index}`, weight: 1, defaultSearchable: true })),
  ];
  return {
    id: item.id,
    kind: 'subdocument',
    collection: item.collection,
    entityId: item.entityId,
    label: item.title,
    sourcePath: `/${item.id}`,
    fields,
    facets: { collection: item.collection, tags: item.tags },
    references: [],
    assetAliasUsages: [],
  };
}

function commandFieldKind(fieldKind: ProjectSearchFieldKind): CommandPaletteFieldKind | null {
  if (fieldKind === 'title' || fieldKind === 'id' || fieldKind === 'tag' || fieldKind === 'collection' || fieldKind === 'action') return fieldKind;
  if (fieldKind === 'label') return 'title';
  return null;
}

function matchForProjectSearchMatch(match: ProjectSearchMatch): CommandPaletteMatch | null {
  const fieldKind = commandFieldKind(match.fieldKind);
  if (!fieldKind) return null;
  return {
    fieldKind,
    fieldLabel: match.fieldLabel,
    value: match.value,
    indices: (match.ranges ?? []).map((range) => [range.start, range.end - 1] as const),
  };
}


function matchPriority(match: CommandPaletteMatch): number {
  if (match.fieldKind === 'title') return 5;
  if (match.fieldKind === 'id') return 4;
  if (match.fieldKind === 'tag') return 3;
  if (match.fieldKind === 'action') return 2;
  return 1;
}

export function searchCommandPaletteItems(items: CommandPaletteItem[], query: string, limit = 12): CommandPaletteSearchResult[] {
  const text = query.trim();
  if (!text) return items.slice(0, limit).map((item) => ({ item, score: 0, matches: [] }));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return searchDocuments(items.map(itemToSearchDocument), { text, mode: 'fuzzy', threshold: 0.45, limit, sort: { kind: 'rank' } }).results.flatMap((result) => {
    const item = itemsById.get(result.document.id);
    if (!item) return [];
    const matches = result.matches.flatMap((match) => {
      const mapped = matchForProjectSearchMatch(match);
      return mapped ? [mapped] : [];
    }).sort((left, right) => matchPriority(right) - matchPriority(left));
    return [{ item, score: result.score, matches }];
  });
}
