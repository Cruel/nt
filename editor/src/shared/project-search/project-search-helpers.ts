import type { AuthoringCollectionKey } from '../project-schema/authoring-collections';
import type { AuthoringProject, ReferenceTarget } from '../project-schema/authoring-project';
import { searchProject } from './project-search';
import type {
  ProjectSearchQuery,
  ProjectSearchResponse,
  ProjectSearchResult,
} from './project-search-types';

export interface SearchAssetsOptions {
  text?: string;
  assetTypes?: string[];
  tags?: string[];
  tagMode?: 'all' | 'any';
  limit?: number;
}

export interface SearchRecordsOptions {
  text?: string;
  collections?: AuthoringCollectionKey[];
  tags?: string[];
  tagMode?: 'all' | 'any';
  limit?: number;
}

export interface SearchReferencesOptions {
  referencesTo?: ReferenceTarget[];
  aliases?: string[];
  text?: string;
  limit?: number;
}

export function searchAssets(
  project: AuthoringProject,
  options: SearchAssetsOptions = {},
): ProjectSearchResponse {
  return searchProject(project, {
    text: options.text,
    collections: ['assets'],
    assetTypes: options.assetTypes,
    tags: options.tags,
    tagMode: options.tagMode ?? 'all',
    tokenMode: 'all',
    sort: { kind: 'label' },
    limit: options.limit,
  });
}

export function searchRecords(
  project: AuthoringProject,
  options: SearchRecordsOptions = {},
): ProjectSearchResponse {
  return searchProject(project, {
    text: options.text,
    collections: options.collections,
    tags: options.tags,
    tagMode: options.tagMode ?? 'all',
    tokenMode: 'all',
    sort: { kind: 'label' },
    limit: options.limit,
  });
}

export function searchReferences(
  project: AuthoringProject,
  options: SearchReferencesOptions,
): ProjectSearchResponse {
  if (options.referencesTo?.length && options.aliases?.length) {
    const stable = searchReferences(project, { ...options, aliases: undefined });
    const aliases = searchReferences(project, { ...options, referencesTo: undefined });
    const merged = new Map<string, ProjectSearchResult>();
    for (const result of [...stable.results, ...aliases.results]) {
      const existing = merged.get(result.document.id);
      if (!existing) {
        merged.set(result.document.id, result);
        continue;
      }
      merged.set(result.document.id, {
        ...existing,
        score: existing.score + result.score,
        matches: [...existing.matches, ...result.matches],
      });
    }
    return {
      diagnostics: [...stable.diagnostics, ...aliases.diagnostics],
      results: [...merged.values()].slice(0, options.limit),
    };
  }
  const query: ProjectSearchQuery = {
    text: options.text,
    referencesTo: options.referencesTo,
    aliases: options.aliases,
    tokenMode: 'all',
    sort: { kind: 'label' },
    limit: options.limit,
  };
  return searchProject(project, query);
}
