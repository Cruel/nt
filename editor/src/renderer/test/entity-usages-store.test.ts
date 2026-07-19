import { describe, expect, it } from 'vite-plus/test';
import { useEntityUsagesStore } from '@/project/entity-usages-store';
import type { ProjectSearchResult } from '../../shared/project-search/project-search-types';

describe('entity usages store', () => {
  it('stores search-backed reference results while preserving legacy usage summaries', () => {
    const target = { collection: 'rooms' as const, id: 'classroom' };
    const result: ProjectSearchResult = {
      document: {
        id: 'record:scenes:opening',
        kind: 'record',
        collection: 'scenes',
        entityId: 'opening',
        label: 'Opening',
        sourcePath: '/scenes/opening',
        fields: [],
        facets: { collection: 'scenes', tags: [] },
        references: [
          {
            sourceCollection: 'scenes',
            sourceId: 'opening',
            path: '/scenes/opening/data/room/$ref',
            target,
            kind: 'explicit-ref',
          },
        ],
        assetAliasUsages: [],
      },
      score: 1,
      matches: [
        {
          fieldKind: 'reference',
          fieldLabel: 'explicit-ref',
          path: '/scenes/opening/data/room/$ref',
          value: 'rooms/classroom',
          terms: ['rooms/classroom'],
          score: 1,
          mode: 'reference',
        },
      ],
    };

    useEntityUsagesStore.getState().setSearchResults(target, [result]);
    const stored = useEntityUsagesStore.getState().result;

    expect(stored?.target).toEqual(target);
    expect(stored?.searchResults).toEqual([result]);
    expect(stored?.usages).toEqual(result.document.references);
    expect(stored?.usageRows).toEqual([
      { kind: 'reference', usage: result.document.references[0] },
    ]);
  });

  it('stores asset alias usages from search-backed results as first-class rows', () => {
    const target = { collection: 'assets' as const, id: 'logo' };
    const result: ProjectSearchResult = {
      document: {
        id: 'record:scenes:opening',
        kind: 'record',
        collection: 'scenes',
        entityId: 'opening',
        label: 'Opening',
        sourcePath: '/scenes/opening',
        fields: [],
        facets: { collection: 'scenes', tags: [] },
        references: [],
        assetAliasUsages: [
          {
            sourceCollection: 'scenes',
            sourceId: 'opening',
            path: '/scenes/opening/data/portrait/$asset/alias',
            alias: 'sarah_portrait',
            kind: 'asset-alias',
          },
        ],
      },
      score: 1,
      matches: [
        {
          fieldKind: 'alias',
          fieldLabel: 'asset-alias',
          path: '/scenes/opening/data/portrait/$asset/alias',
          value: 'sarah_portrait',
          terms: ['sarah_portrait'],
          score: 1,
          mode: 'reference',
        },
      ],
    };

    useEntityUsagesStore.getState().setSearchResults(target, [result]);
    const stored = useEntityUsagesStore.getState().result;

    expect(stored?.aliasUsages).toEqual(result.document.assetAliasUsages);
    expect(stored?.usageRows).toEqual([
      { kind: 'asset-alias', usage: result.document.assetAliasUsages[0] },
    ]);
  });
});
