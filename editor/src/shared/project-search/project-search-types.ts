import type { AuthoringCollectionKey } from '../project-schema/authoring-collections';
import type { ReferenceTarget } from '../project-schema/authoring-project';
import type { AssetAliasUsage } from '../project-schema/authoring-asset-references';
import type { ReferenceUsage } from '../project-schema/authoring-references';

export type ProjectSearchDocumentKind = 'record' | 'project' | 'settings' | 'subdocument';

export type ProjectSearchFieldKind =
  | 'id'
  | 'label'
  | 'title'
  | 'tag'
  | 'type'
  | 'collection'
  | 'action'
  | 'alias'
  | 'description'
  | 'content'
  | 'script'
  | 'reference'
  | 'metadata';

export type ProjectSearchMatchMode =
  | 'token'
  | 'fuzzy'
  | 'extended'
  | 'regex'
  | 'facet'
  | 'reference';

export interface ProjectSearchField {
  kind: ProjectSearchFieldKind;
  label: string;
  value: string;
  path: string;
  weight?: number;
  defaultSearchable?: boolean;
}

export interface ProjectSearchFacets {
  collection?: AuthoringCollectionKey;
  assetType?: string;
  tags: string[];
}

export interface ProjectSearchDocument {
  id: string;
  kind: ProjectSearchDocumentKind;
  collection?: AuthoringCollectionKey;
  entityId?: string;
  label: string;
  sourcePath: string;
  fields: ProjectSearchField[];
  facets: ProjectSearchFacets;
  references: ReferenceUsage[];
  assetAliasUsages: AssetAliasUsage[];
}

export type ProjectSearchSort =
  | { kind: 'rank'; direction?: 'desc' }
  | { kind: 'label'; direction?: 'asc' | 'desc' }
  | { kind: 'id'; direction?: 'asc' | 'desc' }
  | { kind: 'collection'; direction?: 'asc' | 'desc' }
  | { kind: 'assetType'; direction?: 'asc' | 'desc' };

export interface ProjectSearchQuery {
  text?: string;
  mode?: 'token' | 'fuzzy' | 'extended' | 'regex';
  tokenMode?: 'all' | 'any';
  caseSensitive?: boolean;
  threshold?: number;
  includeFields?: ProjectSearchFieldKind[];
  excludeFields?: ProjectSearchFieldKind[];
  collections?: AuthoringCollectionKey[];
  documentIds?: string[];
  recordIds?: string[];
  assetTypes?: string[];
  tags?: string[];
  tagMode?: 'all' | 'any';
  referencesTo?: ReferenceTarget[];
  aliases?: string[];
  limit?: number;
  sort?: ProjectSearchSort;
}

export interface ProjectSearchMatch {
  fieldKind: ProjectSearchFieldKind;
  fieldLabel: string;
  path: string;
  value: string;
  terms: string[];
  ranges?: Array<{ start: number; end: number }>;
  score: number;
  mode: ProjectSearchMatchMode;
}

export interface ProjectSearchResult {
  document: ProjectSearchDocument;
  score: number;
  matches: ProjectSearchMatch[];
}

export interface ProjectSearchDiagnostic {
  severity: 'warning' | 'error';
  message: string;
}

export interface ProjectSearchResponse {
  results: ProjectSearchResult[];
  diagnostics: ProjectSearchDiagnostic[];
}
