import type {
  AssetProfilerAssetState,
  AssetProfilerAssetType,
} from '../../shared/asset-profiler-protocol';
import type { NormalizedAssetProfilerEntry } from './asset-profiler-store';

export type AssetProfilerAssetStateFilter = 'all' | AssetProfilerAssetState | 'reloaded';
export type AssetProfilerAssetTypeFilter = 'all' | AssetProfilerAssetType;
export type AssetProfilerAssetSort =
  | 'default'
  | 'identity'
  | 'state'
  | 'asset-ram'
  | 'loading-memory'
  | 'asset-gpu'
  | 'reload-count';

const DEFAULT_STATE_ORDER: Record<AssetProfilerAssetState, number> = {
  failed: 0,
  loading: 1,
  finishing: 1,
  'in-use': 2,
  prefetched: 3,
  cached: 4,
};

function selectedCost(entry: NormalizedAssetProfilerEntry) {
  return entry.committedCost ?? entry.estimatedCost;
}

export function assetProfilerAssetRam(entry: NormalizedAssetProfilerEntry) {
  const cost = selectedCost(entry);
  return cost ? cost.sourceBytes + cost.preparedCpuBytes + cost.audioBytes : 0n;
}

export function assetProfilerAssetGpu(entry: NormalizedAssetProfilerEntry) {
  return selectedCost(entry)?.gpuBytes ?? 0n;
}

export function assetProfilerEntryUsesEstimate(entry: NormalizedAssetProfilerEntry) {
  return entry.committedCost === null && entry.estimatedCost !== null;
}

export interface AssetProfilerInventoryTotals {
  sourceBytes: bigint;
  preparedCpuBytes: bigint;
  audioBytes: bigint;
  gpuBytes: bigint;
  temporaryBytes: bigint;
}

export function sumAuthoritativeInventory(entries: Iterable<NormalizedAssetProfilerEntry>) {
  const totals: AssetProfilerInventoryTotals = {
    sourceBytes: 0n,
    preparedCpuBytes: 0n,
    audioBytes: 0n,
    gpuBytes: 0n,
    temporaryBytes: 0n,
  };
  for (const entry of entries) {
    if (entry.committedCost) {
      totals.sourceBytes += entry.committedCost.sourceBytes;
      totals.preparedCpuBytes += entry.committedCost.preparedCpuBytes;
      totals.audioBytes += entry.committedCost.audioBytes;
      totals.gpuBytes += entry.committedCost.gpuBytes;
    }
    totals.temporaryBytes += entry.loadingMemoryBytes;
  }
  return totals;
}

export function filterAndSortAssetProfilerEntries(
  entries: Iterable<NormalizedAssetProfilerEntry>,
  query: string,
  state: AssetProfilerAssetStateFilter,
  type: AssetProfilerAssetTypeFilter,
  sort: AssetProfilerAssetSort,
) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = [...entries].filter((entry) => {
    if (state === 'reloaded') {
      if (entry.reloadCount === 0n) return false;
    } else if (state !== 'all' && entry.state !== state) {
      return false;
    }
    if (type !== 'all' && entry.assetType !== type) return false;
    if (!needle) return true;
    return [entry.displayIdentity, entry.cacheKey.stableIdentity].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    );
  });

  return filtered.sort((left, right) => {
    const identity = left.displayIdentity.localeCompare(right.displayIdentity);
    const compareBigInt = (a: bigint, b: bigint) => (a === b ? identity : a > b ? -1 : 1);
    switch (sort) {
      case 'identity':
        return identity;
      case 'state':
        return left.state === right.state ? identity : left.state.localeCompare(right.state);
      case 'asset-ram':
        return compareBigInt(assetProfilerAssetRam(left), assetProfilerAssetRam(right));
      case 'loading-memory':
        return compareBigInt(left.loadingMemoryBytes, right.loadingMemoryBytes);
      case 'asset-gpu':
        return compareBigInt(assetProfilerAssetGpu(left), assetProfilerAssetGpu(right));
      case 'reload-count':
        return compareBigInt(left.reloadCount, right.reloadCount);
      default: {
        const stateOrder = DEFAULT_STATE_ORDER[left.state] - DEFAULT_STATE_ORDER[right.state];
        return stateOrder === 0 ? identity : stateOrder;
      }
    }
  });
}
