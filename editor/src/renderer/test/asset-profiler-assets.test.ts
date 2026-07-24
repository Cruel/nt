import { describe, expect, it } from 'vite-plus/test';
import {
  filterAndSortAssetProfilerEntries,
  sumAuthoritativeInventory,
} from '@/asset-profiler/asset-profiler-assets';
import { normalizeAssetProfilerValue } from '@/asset-profiler/asset-profiler-store';
import { assetProfilerEntry } from './fixtures/asset-profiler';

function entry(identity: string, overrides: Partial<ReturnType<typeof assetProfilerEntry>> = {}) {
  return normalizeAssetProfilerValue({
    ...assetProfilerEntry(identity),
    ...overrides,
  }) as never;
}

describe('asset profiler inventory derivation', () => {
  it('uses user-facing AND filters and searches both display and stable identities', () => {
    const entries = [
      entry('project:/hero.png', { state: 'in-use', assetType: 'image' }),
      entry('material:hero', {
        displayIdentity: 'Hero portrait material',
        state: 'cached',
        assetType: 'material',
        reloadCount: '2',
      }),
    ];

    expect(
      filterAndSortAssetProfilerEntries(entries, 'hero', 'reloaded', 'material', 'default'),
    ).toHaveLength(1);
    expect(
      filterAndSortAssetProfilerEntries(entries, 'project:/hero', 'in-use', 'image', 'default')[0]
        ?.displayIdentity,
    ).toBe('project:/hero.png');
  });

  it('orders failed, loading or finishing, in-use, prefetched, then cached by default', () => {
    const entries = [
      entry('cached', { state: 'cached' }),
      entry('in-use', { state: 'in-use' }),
      entry('failed', { state: 'failed' }),
      entry('finishing', { state: 'finishing' }),
      entry('loading', { state: 'loading' }),
      entry('prefetched', { state: 'prefetched' }),
    ];

    expect(
      filterAndSortAssetProfilerEntries(entries, '', 'all', 'all', 'default').map(
        (candidate) => candidate.displayIdentity,
      ),
    ).toEqual(['failed', 'finishing', 'loading', 'in-use', 'prefetched', 'cached']);
  });

  it('uses committed costs for authoritative domain sums and excludes eventual estimates', () => {
    const committed = entry('committed', {
      committedCost: {
        sourceBytes: '2',
        preparedCpuBytes: '3',
        gpuBytes: '5',
        audioBytes: '7',
        temporaryBytes: '0',
      },
      loadingMemoryBytes: '11',
    });
    const estimated = entry('estimated', {
      committedCost: null,
      estimatedCost: {
        sourceBytes: '13',
        preparedCpuBytes: '17',
        gpuBytes: '19',
        audioBytes: '23',
        temporaryBytes: '0',
      },
      loadingMemoryBytes: '29',
    });

    expect(sumAuthoritativeInventory([committed, estimated])).toEqual({
      sourceBytes: 2n,
      preparedCpuBytes: 3n,
      audioBytes: 7n,
      gpuBytes: 5n,
      temporaryBytes: 40n,
    });
  });
});
