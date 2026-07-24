import { create } from 'zustand';
import type {
  AssetProfilerWirePayload,
  AssetProfilerWireEntry,
  AssetProfilerWireChange,
} from '../../shared/asset-profiler-protocol';

type AssetProfilerDecimalField =
  | 'sessionId'
  | 'latestSequence'
  | 'capturedAtNs'
  | 'inventoryRevision'
  | 'earliestRetainedSequence'
  | 'lostChangeCount'
  | 'afterSequence'
  | 'sequence'
  | 'timestampNs'
  | 'sourceBytes'
  | 'preparedCpuBytes'
  | 'gpuBytes'
  | 'audioBytes'
  | 'temporaryBytes'
  | 'assetRamBytes'
  | 'ordinaryTextureBytes'
  | 'renderTargetBytes'
  | 'totalGpuResourceBytes'
  | 'inUse'
  | 'prefetched'
  | 'cached'
  | 'loading'
  | 'finishing'
  | 'failed'
  | 'accountingRevision'
  | 'rendererSampledAtNs'
  | 'readyBeforeUse'
  | 'loadedTooLate'
  | 'notPrefetched'
  | 'blockedByMemoryLimit'
  | 'prefetchedButUnused'
  | 'reloadedAfterRemoval'
  | 'assetWaitCount'
  | 'assetWaitTimeNs'
  | 'sourceGeneration'
  | 'loadingMemoryBytes'
  | 'jobId'
  | 'prefetchGeneration'
  | 'reloadCount'
  | 'generation'
  | 'presentationRevision'
  | 'expectedNextCount'
  | 'possibleNextCount'
  | 'usedCount'
  | 'lateCount'
  | 'unusedCount'
  | 'operationId'
  | 'startedAtNs'
  | 'durationNs'
  | 'requestId'
  | 'compressedBytes'
  | 'uncompressedBytes';

const DECIMAL_KEYS = new Set<AssetProfilerDecimalField>([
  'sessionId',
  'latestSequence',
  'capturedAtNs',
  'inventoryRevision',
  'earliestRetainedSequence',
  'lostChangeCount',
  'afterSequence',
  'sequence',
  'timestampNs',
  'sourceBytes',
  'preparedCpuBytes',
  'gpuBytes',
  'audioBytes',
  'temporaryBytes',
  'assetRamBytes',
  'ordinaryTextureBytes',
  'renderTargetBytes',
  'totalGpuResourceBytes',
  'inUse',
  'prefetched',
  'cached',
  'loading',
  'finishing',
  'failed',
  'accountingRevision',
  'rendererSampledAtNs',
  'readyBeforeUse',
  'loadedTooLate',
  'notPrefetched',
  'blockedByMemoryLimit',
  'prefetchedButUnused',
  'reloadedAfterRemoval',
  'assetWaitCount',
  'assetWaitTimeNs',
  'sourceGeneration',
  'loadingMemoryBytes',
  'jobId',
  'prefetchGeneration',
  'reloadCount',
  'generation',
  'presentationRevision',
  'expectedNextCount',
  'possibleNextCount',
  'usedCount',
  'lateCount',
  'unusedCount',
  'operationId',
  'startedAtNs',
  'durationNs',
  'requestId',
  'compressedBytes',
  'uncompressedBytes',
]);

export function normalizeAssetProfilerValue(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && key && DECIMAL_KEYS.has(key as AssetProfilerDecimalField))
    return BigInt(value);
  if (Array.isArray(value)) return value.map((item) => normalizeAssetProfilerValue(item));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        normalizeAssetProfilerValue(child, childKey),
      ]),
    );
  }
  return value;
}

type NormalizeDecimal<T> = T extends string ? bigint : T;
type NormalizeAssetProfiler<T, Key extends PropertyKey = never> = [Key] extends [never]
  ? T extends readonly (infer Item)[]
    ? NormalizeAssetProfiler<Item>[]
    : T extends object
      ? { [Property in keyof T]: NormalizeAssetProfiler<T[Property], Property> }
      : T
  : Key extends AssetProfilerDecimalField
    ? NormalizeDecimal<T>
    : T extends readonly (infer Item)[]
      ? NormalizeAssetProfiler<Item>[]
      : T extends object
        ? { [Property in keyof T]: NormalizeAssetProfiler<T[Property], Property> }
        : T;

export type NormalizedAssetProfilerPayload = NormalizeAssetProfiler<AssetProfilerWirePayload>;
export type NormalizedAssetProfilerEntry = NormalizeAssetProfiler<AssetProfilerWireEntry>;
export type NormalizedAssetProfilerChange = NormalizeAssetProfiler<AssetProfilerWireChange>;

function normalizePayload(payload: AssetProfilerWirePayload) {
  return normalizeAssetProfilerValue(payload) as NormalizedAssetProfilerPayload;
}

export function assetProfilerEntryKey(entry: NormalizedAssetProfilerEntry) {
  return `${entry.assetType}\0${entry.cacheKey.stableIdentity}\0${entry.cacheKey.sourceGeneration}`;
}

function inventoryByKey(entries: NormalizedAssetProfilerEntry[]) {
  return new Map(entries.map((entry) => [assetProfilerEntryKey(entry), entry]));
}

export type AssetProfilerStatus = 'disconnected' | 'unsupported' | 'loading' | 'ready' | 'error';

export type AssetProfilerViewId = 'overview' | 'issues' | 'assets';
export type AssetProfilerApplyResult =
  | 'accepted'
  | 'history-gap'
  | 'session-mismatch'
  | 'cursor-mismatch'
  | 'stale';

interface AssetProfilerLocalState {
  selectedView: AssetProfilerViewId;
  issueQuery: string;
  issueType: string;
  assetQuery: string;
  assetState: string;
  assetType: string;
  assetSort: string;
  expandedIssueIds: string[];
  expandedAssetIds: string[];
}

const defaultLocalState = (): AssetProfilerLocalState => ({
  selectedView: 'overview',
  issueQuery: '',
  issueType: 'all',
  assetQuery: '',
  assetState: 'all',
  assetType: 'all',
  assetSort: 'default',
  expandedIssueIds: [],
  expandedAssetIds: [],
});

export interface AssetProfilerStore extends AssetProfilerLocalState {
  status: AssetProfilerStatus;
  payload: NormalizedAssetProfilerPayload | null;
  assetsByKey: ReadonlyMap<string, NormalizedAssetProfilerEntry>;
  changes: NormalizedAssetProfilerChange[];
  historyGapNotice: boolean;
  error: string | null;
  setStatus: (status: AssetProfilerStatus, error?: string | null) => void;
  setSelectedView: (view: AssetProfilerViewId) => void;
  applyPayload: (payload: AssetProfilerWirePayload) => AssetProfilerApplyResult;
  clear: (status?: AssetProfilerStatus) => void;
}

export const useAssetProfilerStore = create<AssetProfilerStore>()((set) => ({
  ...defaultLocalState(),
  status: 'disconnected',
  payload: null,
  assetsByKey: new Map(),
  changes: [],
  historyGapNotice: false,
  error: null,
  setStatus: (status, error = null) => set({ status, error }),
  setSelectedView: (selectedView) => set({ selectedView }),
  clear: (status = 'disconnected') =>
    set({
      ...defaultLocalState(),
      status,
      payload: null,
      assetsByKey: new Map(),
      changes: [],
      historyGapNotice: false,
      error: null,
    }),
  applyPayload: (wirePayload) => {
    const payload = normalizePayload(wirePayload);
    let result: AssetProfilerApplyResult = 'accepted';
    set((current) => {
      if (payload.kind === 'delta') {
        if (!current.payload || payload.sessionId !== current.payload.sessionId) {
          result = 'session-mismatch';
          return current;
        }
        if (payload.afterSequence !== current.payload.latestSequence) {
          result =
            payload.afterSequence < current.payload.latestSequence ? 'stale' : 'cursor-mismatch';
          return current;
        }
      }
      if (payload.kind === 'full') {
        const replacementSession =
          current.payload !== null && payload.sessionId !== current.payload.sessionId;
        return {
          ...(replacementSession ? defaultLocalState() : current),
          status: 'ready',
          payload,
          assetsByKey: inventoryByKey(payload.assets),
          changes: payload.retainedChanges,
          historyGapNotice: replacementSession
            ? !payload.historyComplete
            : current.historyGapNotice || !payload.historyComplete,
          error: null,
        };
      }
      if (payload.historyGap) {
        result = 'history-gap';
        return {
          ...current,
          status: 'ready',
          payload,
          assetsByKey: payload.replacementInventory
            ? inventoryByKey(payload.replacementInventory)
            : current.assetsByKey,
          changes: payload.changes.slice(-8192),
          historyGapNotice: true,
          error: null,
        };
      }
      return {
        ...current,
        status: 'ready',
        payload,
        assetsByKey: payload.replacementInventory
          ? inventoryByKey(payload.replacementInventory)
          : current.assetsByKey,
        changes: [...current.changes, ...payload.changes].slice(-8192),
        historyGapNotice: current.historyGapNotice,
        error: null,
      };
    });
    return result;
  },
}));
