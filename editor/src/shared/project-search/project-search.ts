import Fuse, { type FuseResult, type FuseResultMatch } from 'fuse.js';
import { normalizeTagKey } from '../project-schema/authoring-tags';
import { referenceTargetKey } from '../project-schema/authoring-references';
import {
  buildProjectSearchIndex,
  referenceTargetKeys,
  type ProjectSearchIndex,
} from './project-search-index';
import type {
  ProjectSearchDiagnostic,
  ProjectSearchDocument,
  ProjectSearchField,
  ProjectSearchMatch,
  ProjectSearchQuery,
  ProjectSearchResponse,
  ProjectSearchResult,
} from './project-search-types';
import type { AuthoringProject } from '../project-schema/authoring-project';

interface FuseSearchItem {
  document: ProjectSearchDocument;
  fields: ProjectSearchField[];
}

function fieldAllowed(field: ProjectSearchField, query: ProjectSearchQuery): boolean {
  if (query.includeFields?.length) return query.includeFields.includes(field.kind);
  if (query.excludeFields?.includes(field.kind)) return false;
  return field.defaultSearchable !== false;
}

function selectableFields(
  document: ProjectSearchDocument,
  query: ProjectSearchQuery,
): ProjectSearchField[] {
  return document.fields.filter((field) => fieldAllowed(field, query));
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

function rangeTuples(
  indices: readonly (readonly [number, number])[] | undefined,
): Array<{ start: number; end: number }> | undefined {
  if (!indices?.length) return undefined;
  return indices.map(([start, end]) => ({ start, end: end + 1 }));
}

function fieldForFuseMatch(
  item: FuseSearchItem,
  match: FuseResultMatch,
): ProjectSearchField | null {
  if (match.key !== 'fields.value' || typeof match.refIndex !== 'number') return null;
  return item.fields[match.refIndex] ?? null;
}

function termsFor(query: ProjectSearchQuery) {
  const text = query.text?.trim() ?? '';
  if (!text) return [];
  if (query.mode === 'regex' || query.mode === 'extended') return [text];
  return text.split(/\s+/).filter(Boolean);
}

function matchesReference(document: ProjectSearchDocument, targets: Set<string>) {
  if (targets.size === 0) return true;
  return document.references.some((usage) => targets.has(referenceTargetKey(usage.target)));
}

function matchesAliases(document: ProjectSearchDocument, aliases: Set<string>) {
  if (aliases.size === 0) return true;
  return document.assetAliasUsages.some((usage) => aliases.has(usage.alias));
}

function facetMatches(
  document: ProjectSearchDocument,
  query: ProjectSearchQuery,
): ProjectSearchMatch[] {
  const matches: ProjectSearchMatch[] = [];
  const requestedTags = (query.tags ?? []).map(normalizeTagKey).filter(Boolean);
  for (const tag of requestedTags) {
    const index = document.facets.tags.findIndex((value) => normalizeTagKey(value) === tag);
    if (index >= 0) {
      matches.push({
        fieldKind: 'tag',
        fieldLabel: 'Tag',
        path: `${document.sourcePath}/tags/${index}`,
        value: document.facets.tags[index]!,
        terms: [document.facets.tags[index]!],
        score: 1,
        mode: 'facet',
      });
    }
  }
  if (query.assetTypes?.includes(document.facets.assetType ?? '')) {
    matches.push({
      fieldKind: 'type',
      fieldLabel: 'Asset Type',
      path: `${document.sourcePath}/data/kind`,
      value: document.facets.assetType!,
      terms: [document.facets.assetType!],
      score: 1,
      mode: 'facet',
    });
  }
  const aliases = new Set(query.aliases ?? []);
  if (aliases.size > 0) {
    for (const usage of document.assetAliasUsages) {
      if (!aliases.has(usage.alias)) continue;
      matches.push({
        fieldKind: 'alias',
        fieldLabel: usage.kind,
        path: usage.path,
        value: usage.alias,
        terms: [usage.alias],
        score: 1,
        mode: 'reference',
      });
    }
  }
  const targetKeys = referenceTargetKeys(query.referencesTo);
  if (targetKeys.size > 0) {
    for (const usage of document.references) {
      if (!targetKeys.has(referenceTargetKey(usage.target))) continue;
      matches.push({
        fieldKind: 'reference',
        fieldLabel: usage.kind,
        path: usage.path,
        value: `${usage.target.collection}/${usage.target.id}`,
        terms: [`${usage.target.collection}/${usage.target.id}`],
        score: 1,
        mode: 'reference',
      });
    }
  }
  return matches;
}

function applyStructuralFilters(
  documents: ProjectSearchDocument[],
  query: ProjectSearchQuery,
): ProjectSearchDocument[] {
  const collections = new Set(query.collections ?? []);
  const documentIds = new Set(query.documentIds ?? []);
  const recordIds = new Set(query.recordIds ?? []);
  const assetTypes = new Set(query.assetTypes ?? []);
  const tagMode = query.tagMode ?? 'any';
  const tags = (query.tags ?? []).map(normalizeTagKey).filter(Boolean);
  const referenceTargets = referenceTargetKeys(query.referencesTo);
  const aliases = new Set(query.aliases ?? []);
  return documents.filter((document) => {
    if (documentIds.size > 0 && !documentIds.has(document.id)) return false;
    if (recordIds.size > 0 && (!document.entityId || !recordIds.has(document.entityId)))
      return false;
    if (collections.size > 0 && (!document.collection || !collections.has(document.collection)))
      return false;
    if (
      assetTypes.size > 0 &&
      (!document.facets.assetType || !assetTypes.has(document.facets.assetType))
    )
      return false;
    if (tags.length > 0) {
      const documentTags = new Set(document.facets.tags.map(normalizeTagKey));
      const matched = tags.filter((tag) => documentTags.has(tag));
      if (tagMode === 'all' ? matched.length !== tags.length : matched.length === 0) return false;
    }
    if (!matchesReference(document, referenceTargets)) return false;
    if (!matchesAliases(document, aliases)) return false;
    return true;
  });
}

function scoreForMatches(matches: ProjectSearchMatch[]) {
  return matches.reduce((sum, match) => sum + match.score, 0);
}

function sortResults(results: ProjectSearchResult[], query: ProjectSearchQuery) {
  const sort =
    query.sort ??
    (query.text?.trim()
      ? { kind: 'rank' as const, direction: 'desc' as const }
      : { kind: 'label' as const, direction: 'asc' as const });
  const direction = sort.direction === 'desc' ? -1 : 1;
  return [...results].sort((left, right) => {
    if (sort.kind === 'rank') {
      const byScore = right.score - left.score;
      if (byScore !== 0) return byScore;
    } else if (sort.kind === 'label') {
      const byLabel = compareText(left.document.label, right.document.label);
      if (byLabel !== 0) return byLabel * direction;
    } else if (sort.kind === 'id') {
      const byId = compareText(
        left.document.entityId ?? left.document.id,
        right.document.entityId ?? right.document.id,
      );
      if (byId !== 0) return byId * direction;
    } else if (sort.kind === 'collection') {
      const byCollection = compareText(
        left.document.collection ?? '',
        right.document.collection ?? '',
      );
      if (byCollection !== 0) return byCollection * direction;
    } else if (sort.kind === 'assetType') {
      const byAssetType = compareText(
        left.document.facets.assetType ?? '',
        right.document.facets.assetType ?? '',
      );
      if (byAssetType !== 0) return byAssetType * direction;
    }
    return (
      compareText(left.document.collection ?? '', right.document.collection ?? '') ||
      compareText(left.document.label, right.document.label) ||
      compareText(
        left.document.entityId ?? left.document.id,
        right.document.entityId ?? right.document.id,
      )
    );
  });
}

function fuseMatches(
  result: FuseResult<FuseSearchItem>,
  query: ProjectSearchQuery,
): ProjectSearchMatch[] {
  const terms = termsFor(query);
  return (
    result.matches?.flatMap((match) => {
      const field = fieldForFuseMatch(result.item, match);
      if (!field) return [];
      const fieldWeight = field.weight ?? 1;
      return [
        {
          fieldKind: field.kind,
          fieldLabel: field.label,
          path: field.path,
          value: field.value,
          terms,
          ranges: rangeTuples(match.indices),
          score: fieldWeight * (1 - Math.min(result.score ?? 0, 1)),
          mode: query.mode === 'fuzzy' ? 'fuzzy' : query.mode === 'extended' ? 'extended' : 'token',
        } satisfies ProjectSearchMatch,
      ];
    }) ?? []
  );
}

function searchWithFuse(
  documents: ProjectSearchDocument[],
  query: ProjectSearchQuery,
): ProjectSearchResult[] {
  const items = documents
    .map((document) => ({ document, fields: selectableFields(document, query) }))
    .filter((item) => item.fields.length > 0);
  if (!query.text?.trim()) {
    return items.map(({ document }) => ({
      document,
      score: 0,
      matches: facetMatches(document, query),
    }));
  }
  const fuse = new Fuse(items, {
    includeScore: true,
    includeMatches: true,
    isCaseSensitive: query.caseSensitive ?? false,
    ignoreLocation: true,
    threshold: query.threshold ?? (query.mode === 'fuzzy' ? 0.45 : 0.35),
    useTokenSearch: query.mode !== 'fuzzy' && query.mode !== 'extended',
    tokenMatch: query.tokenMode ?? 'any',
    useExtendedSearch: query.mode === 'extended',
    keys: ['fields.value'],
  });
  return fuse.search(query.text).map((result) => {
    const matches = [...facetMatches(result.item.document, query), ...fuseMatches(result, query)];
    return { document: result.item.document, score: scoreForMatches(matches), matches };
  });
}

function regexMatches(field: ProjectSearchField, regex: RegExp): ProjectSearchMatch[] {
  const matches: ProjectSearchMatch[] = [];
  for (const match of field.value.matchAll(regex)) {
    const start = match.index ?? 0;
    matches.push({
      fieldKind: field.kind,
      fieldLabel: field.label,
      path: field.path,
      value: field.value,
      terms: [regex.source],
      ranges: [{ start, end: start + match[0].length }],
      score: field.weight ?? 1,
      mode: 'regex',
    });
    if (!regex.global) break;
  }
  return matches;
}

function searchWithRegex(
  documents: ProjectSearchDocument[],
  query: ProjectSearchQuery,
): ProjectSearchResponse {
  const diagnostics: ProjectSearchDiagnostic[] = [];
  const text = query.text?.trim() ?? '';
  if (!text)
    return {
      diagnostics,
      results: documents.map((document) => ({
        document,
        score: 0,
        matches: facetMatches(document, query),
      })),
    };
  let regex: RegExp;
  try {
    regex = new RegExp(text, query.caseSensitive ? 'g' : 'gi');
  } catch (error) {
    return {
      results: [],
      diagnostics: [
        {
          severity: 'error',
          message: error instanceof Error ? error.message : 'Invalid regular expression.',
        },
      ],
    };
  }
  const results = documents.flatMap((document) => {
    const matches = [
      ...facetMatches(document, query),
      ...selectableFields(document, query).flatMap((field) => regexMatches(field, regex)),
    ];
    return matches.some((match) => match.mode === 'regex')
      ? [{ document, score: scoreForMatches(matches), matches }]
      : [];
  });
  return { diagnostics, results };
}

export function searchDocuments(
  documents: ProjectSearchDocument[],
  query: ProjectSearchQuery,
): ProjectSearchResponse {
  const filtered = applyStructuralFilters(documents, query);
  const response =
    query.mode === 'regex'
      ? searchWithRegex(filtered, query)
      : { diagnostics: [], results: searchWithFuse(filtered, query) };
  const results = sortResults(response.results, query);
  return {
    ...response,
    results: typeof query.limit === 'number' ? results.slice(0, query.limit) : results,
  };
}

export function searchProjectIndex(
  index: ProjectSearchIndex,
  query: ProjectSearchQuery,
): ProjectSearchResponse {
  return searchDocuments(index.documents, query);
}

export function searchProject(
  project: AuthoringProject,
  query: ProjectSearchQuery,
): ProjectSearchResponse {
  return searchProjectIndex(buildProjectSearchIndex(project), query);
}
