import { Settings } from 'lucide-react';
import type { ComponentType } from 'react';
import type { TFunction } from 'i18next';
import { editorI18n } from '@/i18n';
import { authoringCollectionMetadata } from '../../shared/project-schema/authoring-collections';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { parseAssetData, type AssetData } from '../../shared/project-schema/authoring-assets';
import { searchDocuments } from '../../shared/project-search/project-search';
import type { ProjectSearchDocument, ProjectSearchFieldKind, ProjectSearchMatch } from '../../shared/project-search/project-search-types';
import { visualForCollection } from './collection-visuals';

export type CommandPaletteItemKind = 'action' | 'record';
export type CommandPaletteFieldKind = 'title' | 'id' | 'tag' | 'collection' | 'action';
export type SelectorItemKind = CommandPaletteItemKind;
export type SelectorFieldKind = CommandPaletteFieldKind;

export interface SelectorPreview {
  kind: 'image';
  label: string;
  sourcePath: string;
}

export interface SelectorItem {
  id: string;
  kind: SelectorItemKind;
  title: string;
  subtitle?: string;
  collection?: AuthoringCollectionKey;
  entityId?: string;
  assetKind?: AssetData['kind'];
  preview?: SelectorPreview;
  action?: 'settings' | 'new-project' | 'open-project' | 'project-settings' | 'assets' | 'variables' | 'tests';
  tags: string[];
  collectionTerms: string[];
  actionTerms: string[];
  icon?: ComponentType<{ className?: string }>;
  iconClassName?: string;
}

export type CommandPaletteItem = SelectorItem;

export interface SelectorMatch {
  fieldKind: SelectorFieldKind;
  fieldLabel: string;
  value: string;
  indices: readonly (readonly [number, number])[];
}

export type CommandPaletteMatch = SelectorMatch;

export interface SelectorSearchResult {
  item: SelectorItem;
  score: number;
  matches: SelectorMatch[];
}

export type CommandPaletteSearchResult = SelectorSearchResult;

export interface SelectorItemFilter {
  collections?: readonly AuthoringCollectionKey[];
  assetKinds?: readonly AssetData['kind'][];
  includeActions?: boolean;
}

function actionItem(item: Omit<SelectorItem, 'kind' | 'tags' | 'collectionTerms' | 'actionTerms' | 'icon' | 'iconClassName'> & { search: string[] }): SelectorItem {
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

const actionDefinitions = [
  { id: 'action:settings', action: 'settings', key: 'settings', projectOnly: false },
  { id: 'action:new-project', action: 'new-project', key: 'newProject', projectOnly: false },
  { id: 'action:open-project', action: 'open-project', key: 'openProject', projectOnly: false },
  { id: 'action:project-settings', action: 'project-settings', key: 'projectSettings', projectOnly: true },
  { id: 'action:assets', action: 'assets', key: 'assets', projectOnly: true },
  { id: 'action:variables', action: 'variables', key: 'variables', projectOnly: true },
  { id: 'action:tests', action: 'tests', key: 'tests', projectOnly: true },
] as const;

function translatedSearchTerms(t: TFunction, key: string): string[] {
  const value = t(key, { returnObjects: true });
  return Array.isArray(value) ? value.map(String) : [String(value)].filter(Boolean);
}

function baseActions(t: TFunction): SelectorItem[] {
  return actionDefinitions.filter((definition) => !definition.projectOnly).map((definition) => actionItem({
    id: definition.id,
    title: t(`workspace:commandPalette.actions.${definition.key}.title`),
    subtitle: t(`workspace:commandPalette.actions.${definition.key}.subtitle`),
    action: definition.action,
    search: translatedSearchTerms(t, `workspace:commandPalette.actions.${definition.key}.search`),
  }));
}

export function buildCommandPaletteItems(project: AuthoringProject | null, t: TFunction = editorI18n.t.bind(editorI18n)): SelectorItem[] {
  const items = [...baseActions(t)];
  if (!project) return items;
  items.push(...actionDefinitions.filter((definition) => definition.projectOnly).map((definition) => actionItem({
    id: definition.id,
    title: t(`workspace:commandPalette.actions.${definition.key}.title`),
    subtitle: t(`workspace:commandPalette.actions.${definition.key}.subtitle`),
    action: definition.action,
    search: translatedSearchTerms(t, `workspace:commandPalette.actions.${definition.key}.search`),
  })));
  for (const [collection, metadata] of Object.entries(authoringCollectionMetadata) as Array<[AuthoringCollectionKey, (typeof authoringCollectionMetadata)[AuthoringCollectionKey]]>) {
    const visual = visualForCollection(collection);
    for (const [entityId, record] of Object.entries(project[collection])) {
      const title = record.label || entityId;
      const assetData = collection === 'assets' ? parseAssetData(record.data) : null;
      items.push({
        id: `record:${collection}:${entityId}`,
        kind: 'record',
        title,
        subtitle: metadata.label,
        collection,
        entityId,
        assetKind: assetData?.kind,
        preview: assetData?.kind === 'image' ? { kind: 'image', label: title, sourcePath: assetData.source.path } : undefined,
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

export function filterSelectorItems(items: readonly SelectorItem[], filter: SelectorItemFilter = {}): SelectorItem[] {
  const collections = filter.collections ? new Set(filter.collections) : null;
  const assetKinds = filter.assetKinds ? new Set(filter.assetKinds) : null;
  const includeActions = filter.includeActions ?? true;
  return items.filter((item) => {
    if (item.kind === 'action') return includeActions && !collections && !assetKinds;
    if (collections && (!item.collection || !collections.has(item.collection))) return false;
    if (assetKinds && item.assetKind && !assetKinds.has(item.assetKind)) return false;
    if (assetKinds && !item.assetKind) return false;
    return true;
  });
}

function itemToSearchDocument(item: SelectorItem): ProjectSearchDocument {
  const fields = [
    { kind: 'title' as const, label: editorI18n.t('common:fields.name'), value: item.title, path: `/${item.id}/title`, weight: 4, defaultSearchable: true },
    ...(item.entityId ? [{ kind: 'id' as const, label: editorI18n.t('common:fields.id'), value: item.entityId, path: `/${item.id}/id`, weight: 3.5, defaultSearchable: true }] : []),
    ...item.tags.map((tag, index) => ({ kind: 'tag' as const, label: editorI18n.t('common:fields.tag'), value: tag, path: `/${item.id}/tags/${index}`, weight: 2.75, defaultSearchable: true })),
    ...item.actionTerms.map((term, index) => ({ kind: 'action' as const, label: editorI18n.t('common:fields.action'), value: term, path: `/${item.id}/actionTerms/${index}`, weight: 2, defaultSearchable: true })),
    ...item.collectionTerms.map((term, index) => ({ kind: 'collection' as const, label: editorI18n.t('common:fields.collection'), value: term, path: `/${item.id}/collectionTerms/${index}`, weight: 1, defaultSearchable: true })),
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

function matchForProjectSearchMatch(match: ProjectSearchMatch): SelectorMatch | null {
  const fieldKind = commandFieldKind(match.fieldKind);
  if (!fieldKind) return null;
  return {
    fieldKind,
    fieldLabel: match.fieldLabel,
    value: match.value,
    indices: (match.ranges ?? []).map((range) => [range.start, range.end - 1] as const),
  };
}


function matchPriority(match: SelectorMatch): number {
  if (match.fieldKind === 'title') return 5;
  if (match.fieldKind === 'id') return 4;
  if (match.fieldKind === 'tag') return 3;
  if (match.fieldKind === 'action') return 2;
  return 1;
}

export function searchSelectorItems(items: readonly SelectorItem[], query: string, limit = 12): SelectorSearchResult[] {
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

export function searchCommandPaletteItems(items: readonly SelectorItem[], query: string, limit = 12): SelectorSearchResult[] {
  return searchSelectorItems(items, query, limit);
}
