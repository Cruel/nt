import type {
  AssetProfilerDeltaWirePayload,
  AssetProfilerFullWirePayload,
  AssetProfilerWireEntry,
} from '../../../shared/asset-profiler-protocol';

const zeroCost = () => ({
  sourceBytes: '0',
  preparedCpuBytes: '0',
  gpuBytes: '0',
  audioBytes: '0',
  temporaryBytes: '0',
});

const zeroValues = () => ({
  asset: zeroCost(),
  warm: zeroCost(),
  assetRamBytes: '0',
  rendererEstimate: { ordinaryTextureBytes: '0', renderTargetBytes: '0' },
  totalGpuResourceBytes: '0',
});

const zeroPeaks = () => ({
  asset: zeroCost(),
  assetRamBytes: '0',
  rendererEstimate: { ordinaryTextureBytes: '0', renderTargetBytes: '0' },
  totalGpuResourceBytes: '0',
});

const zeroCounts = () => ({
  inUse: '0',
  prefetched: '0',
  cached: '0',
  loading: '0',
  finishing: '0',
  failed: '0',
});

const zeroOutcomes = () => ({
  readyBeforeUse: '0',
  loadedTooLate: '0',
  notPrefetched: '0',
  blockedByMemoryLimit: '0',
  prefetchedButUnused: '0',
  reloadedAfterRemoval: '0',
  assetWaitCount: '0',
  assetWaitTimeNs: '0',
});

const memory = () => ({
  current: zeroValues(),
  peak: zeroPeaks(),
  policy: {
    target: 'desktop' as const,
    preset: 'balanced' as const,
    budget: { ...zeroCost(), prefetchAllowancePercent: 25 },
  },
  assetCounts: zeroCounts(),
  accountingRevision: '0',
  rendererSampledAtNs: '0',
});

export function assetProfilerEntry(stableIdentity = 'project:/image.png'): AssetProfilerWireEntry {
  return {
    cacheKey: { stableIdentity, sourceGeneration: '1' },
    assetType: 'image',
    displayIdentity: stableIdentity,
    state: 'cached',
    requestOrigin: 'demand',
    retentionReason: 'retained-in-cache',
    committedCost: zeroCost(),
    estimatedCost: null,
    loadingMemoryBytes: '0',
    jobId: null,
    prefetchGeneration: null,
    completedPrefetchClaimed: false,
    removable: true,
    reloadCount: '0',
    diagnostics: [],
  };
}

export function assetProfilerFullPayload({
  sessionId = '1',
  latestSequence = '1',
  assets = [],
  historyComplete = true,
}: {
  sessionId?: string;
  latestSequence?: string;
  assets?: AssetProfilerWireEntry[];
  historyComplete?: boolean;
} = {}): AssetProfilerFullWirePayload {
  return {
    schemaVersion: 3,
    kind: 'full',
    sessionId,
    latestSequence,
    capturedAtNs: '1',
    memory: memory(),
    outcomes: zeroOutcomes(),
    inventoryRevision: '1',
    earliestRetainedSequence: '1',
    lostChangeCount: '0',
    assets,
    retainedChanges: [],
    historyComplete,
  };
}

export function assetProfilerDeltaPayload({
  sessionId = '1',
  afterSequence = '1',
  latestSequence = '2',
  replacementInventory = null,
  historyGap = false,
}: {
  sessionId?: string;
  afterSequence?: string;
  latestSequence?: string;
  replacementInventory?: AssetProfilerWireEntry[] | null;
  historyGap?: boolean;
} = {}): AssetProfilerDeltaWirePayload {
  return {
    schemaVersion: 3,
    kind: 'delta',
    sessionId,
    latestSequence,
    capturedAtNs: '2',
    memory: memory(),
    outcomes: zeroOutcomes(),
    inventoryRevision: '2',
    earliestRetainedSequence: '1',
    lostChangeCount: historyGap ? '1' : '0',
    afterSequence,
    replacementInventory,
    changes: [],
    historyGap,
  };
}
