import { create } from 'zustand';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type { ReferenceTarget } from '../../shared/project-schema/authoring-project';
import type { AssetAliasUsage } from '../../shared/project-schema/authoring-asset-references';
import type { ReferenceUsage } from '../../shared/project-schema/authoring-references';
import type { ProjectSearchResult } from '../../shared/project-search/project-search-types';
import type { SemanticGraphUsage } from './authoring-graph-consumers';

export type EntityUsageRow =
  | { kind: 'reference'; usage: ReferenceUsage }
  | { kind: 'asset-alias'; usage: AssetAliasUsage }
  | { kind: 'source-reference'; usage: SemanticGraphUsage };

export interface EntityUsagesResult {
  target: ReferenceTarget;
  displayLabel?: string;
  usages: ReferenceUsage[];
  aliasUsages: AssetAliasUsage[];
  usageRows: EntityUsageRow[];
  searchResults?: ProjectSearchResult[];
  requestedAt: number;
}

interface EntityUsagesStore {
  result: EntityUsagesResult | null;
  setUsages: (target: ReferenceTarget, usages: ReferenceUsage[], displayLabel?: string) => void;
  setSearchResults: (target: ReferenceTarget, results: ProjectSearchResult[]) => void;
  setSearchAndSourceResults: (
    target: ReferenceTarget,
    results: ProjectSearchResult[],
    sourceUsages: readonly SemanticGraphUsage[],
  ) => void;
  clearUsages: () => void;
}

export const useEntityUsagesStore = create<EntityUsagesStore>()((set) => ({
  result: null,
  setUsages: (target, usages, displayLabel) =>
    set({
      result: {
        target,
        ...(displayLabel ? { displayLabel } : {}),
        usages,
        aliasUsages: [],
        usageRows: usages.map((usage) => ({ kind: 'reference', usage })),
        requestedAt: Date.now(),
      },
    }),
  setSearchResults: (target, results) =>
    set(() => {
      const usages = results.flatMap((item) =>
        item.document.references.filter(
          (usage) => usage.target.collection === target.collection && usage.target.id === target.id,
        ),
      );
      const aliasUsages = results.flatMap((item) =>
        item.document.assetAliasUsages.filter((usage) =>
          item.matches.some(
            (match) =>
              match.fieldKind === 'alias' &&
              match.path === usage.path &&
              match.value === usage.alias,
          ),
        ),
      );
      return {
        result: {
          target,
          usages,
          aliasUsages,
          usageRows: [
            ...usages.map((usage) => ({ kind: 'reference' as const, usage })),
            ...aliasUsages.map((usage) => ({ kind: 'asset-alias' as const, usage })),
          ],
          searchResults: results,
          requestedAt: Date.now(),
        },
      };
    }),
  setSearchAndSourceResults: (target, results, sourceUsages) =>
    set(() => {
      const usages = results.flatMap((item) =>
        item.document.references.filter(
          (usage) => usage.target.collection === target.collection && usage.target.id === target.id,
        ),
      );
      const aliasUsages = results.flatMap((item) =>
        item.document.assetAliasUsages.filter((usage) =>
          item.matches.some(
            (match) =>
              match.fieldKind === 'alias' &&
              match.path === usage.path &&
              match.value === usage.alias,
          ),
        ),
      );
      return {
        result: {
          target,
          usages,
          aliasUsages,
          usageRows: [
            ...usages.map((usage) => ({ kind: 'reference' as const, usage })),
            ...sourceUsages.map((usage) => ({ kind: 'source-reference' as const, usage })),
            ...aliasUsages.map((usage) => ({ kind: 'asset-alias' as const, usage })),
          ],
          searchResults: results,
          requestedAt: Date.now(),
        },
      };
    }),
  clearUsages: () => set({ result: null }),
}));

export function usageSourceIsRecord(
  sourceCollection: AuthoringCollectionKey | 'project',
): sourceCollection is AuthoringCollectionKey {
  return sourceCollection !== 'project';
}
