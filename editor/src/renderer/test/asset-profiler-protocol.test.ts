import { describe, expect, it } from 'vite-plus/test';

import {
  isAssetProfilerWirePayload,
  isCanonicalUnsignedDecimal,
} from '../../shared/asset-profiler-protocol';
import { isEditorToPreviewMessage, isPreviewToEditorMessage } from '../../shared/preview-protocol';

const decimalCost = {
  sourceBytes: '1',
  preparedCpuBytes: '2',
  gpuBytes: '3',
  audioBytes: '4',
  temporaryBytes: '5',
};

const diagnostic = {
  code: 'assets.prefetch_allowance_exceeded',
  message: 'Blocked by memory limit',
  severity: 'warning',
  sourcePath: '',
  jsonPointer: '',
  causes: [],
};

const memory = {
  current: {
    asset: decimalCost,
    warm: decimalCost,
    assetRamBytes: '7',
    rendererEstimate: { ordinaryTextureBytes: null, renderTargetBytes: '9' },
    totalGpuResourceBytes: null,
  },
  peak: {
    asset: decimalCost,
    assetRamBytes: '8',
    rendererEstimate: { ordinaryTextureBytes: null, renderTargetBytes: '10' },
    totalGpuResourceBytes: null,
  },
  policy: {
    target: 'web',
    preset: 'balanced',
    budget: { ...decimalCost, prefetchAllowancePercent: 25 },
  },
  assetCounts: {
    inUse: '1',
    prefetched: '2',
    cached: '3',
    loading: '4',
    finishing: '5',
    failed: '6',
  },
  accountingRevision: '11',
  rendererSampledAtNs: null,
};

const outcomes = {
  readyBeforeUse: '1',
  loadedTooLate: '2',
  notPrefetched: '3',
  blockedByMemoryLimit: '4',
  prefetchedButUnused: '5',
  reloadedAfterRemoval: '6',
  assetWaitCount: '7',
  assetWaitTimeNs: '8',
};

const key = { stableIdentity: 'image:hero', sourceGeneration: '3' };

const generationChange = {
  sequence: '1',
  timestampNs: '20',
  kind: 'prefetch-generation-upsert',
  generation: {
    generation: '8',
    timestampNs: '19',
    presentationRevision: '4',
    expectedNextCount: '1',
    possibleNextCount: '1',
    submittedEntries: [{ cacheKey: key, prediction: 'expected-next' }],
    submissionFailures: [{ cacheKey: key, prediction: 'possible-next', diagnostic }],
    usedCount: '1',
    lateCount: '0',
    unusedCount: '0',
  },
};

const waitChange = (result: 'completed' | 'failed' | 'canceled') => ({
  sequence: result === 'completed' ? '3' : result === 'failed' ? '4' : '5',
  timestampNs: '30',
  kind: 'asset-wait',
  wait: {
    operationId: '12',
    phase: 'loading-runtime-demand',
    presentationRevision: '5',
    startedAtNs: '21',
    durationNs: '9',
    result,
    waitingRequests: [{ cacheKey: key, requestId: '13' }],
    diagnostics: result === 'completed' ? [] : [diagnostic],
  },
});

const telemetryChange = {
  sequence: '6',
  timestampNs: '31',
  kind: 'telemetry-event',
  event: {
    eventKind: 'source-read-failed',
    executionMode: 'threaded',
    cacheKey: key,
    jobId: '18446744073709551615',
    requestId: '9007199254740993',
    prefetchGeneration: '8',
    requestReason: 'demand',
    jobPriority: 'critical',
    memory: decimalCost,
    compressedBytes: '9007199254740993',
    uncompressedBytes: '9007199254740994',
    durationNs: '9007199254740995',
    diagnosticCode: 'assets.source_read_failed',
    evictionReason: null,
    memoryPolicy: null,
  },
};

const full = {
  kind: 'full',
  schemaVersion: 3,
  sessionId: '18446744073709551615',
  latestSequence: '6',
  capturedAtNs: '40',
  memory,
  outcomes,
  assets: [],
  inventoryRevision: '2',
  retainedChanges: [
    generationChange,
    {
      ...generationChange,
      sequence: '2',
      generation: { ...generationChange.generation, usedCount: '2' },
    },
    waitChange('failed'),
    waitChange('canceled'),
    telemetryChange,
  ],
  earliestRetainedSequence: '1',
  lostChangeCount: '0',
  historyComplete: true,
};

describe('asset profiler protocol', () => {
  it('accepts canonical decimal strings without routing through number', () => {
    expect(isCanonicalUnsignedDecimal('18446744073709551615')).toBe(true);
    expect(isCanonicalUnsignedDecimal('01')).toBe(false);
    expect(isCanonicalUnsignedDecimal('-1')).toBe(false);
  });

  it('strictly validates full and delta payloads with generation upserts and wait results', () => {
    expect(isAssetProfilerWirePayload(full)).toBe(true);
    expect(
      isAssetProfilerWirePayload({
        ...full,
        memory: {
          ...memory,
          current: {
            ...memory.current,
            rendererEstimate: { ordinaryTextureBytes: '8', renderTargetBytes: '9' },
            totalGpuResourceBytes: '20',
          },
        },
      }),
    ).toBe(true);
    const delta = {
      kind: 'delta',
      schemaVersion: 3,
      sessionId: full.sessionId,
      afterSequence: '0',
      latestSequence: '6',
      capturedAtNs: '41',
      memory: {
        ...memory,
        current: {
          ...memory.current,
          rendererEstimate: { ordinaryTextureBytes: null, renderTargetBytes: null },
          totalGpuResourceBytes: null,
        },
      },
      outcomes,
      replacementInventory: null,
      inventoryRevision: '2',
      changes: [
        generationChange,
        waitChange('completed'),
        waitChange('failed'),
        waitChange('canceled'),
        telemetryChange,
      ],
      earliestRetainedSequence: '1',
      lostChangeCount: '0',
      historyGap: false,
    };
    expect(isAssetProfilerWirePayload(delta)).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-asset-profiler',
        requestId: 'request-1',
        payload: delta,
      }),
    ).toBe(true);
  });

  it('rejects unsupported schemas, enum ordinals, and invalid delta cursor combinations', () => {
    expect(isAssetProfilerWirePayload({ ...full, schemaVersion: 2 })).toBe(false);
    expect(
      isAssetProfilerWirePayload({
        ...full,
        retainedChanges: [
          {
            ...generationChange,
            generation: {
              ...generationChange.generation,
              submittedEntries: [{ cacheKey: key, prediction: 0 }],
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-request-asset-profiler',
        requestId: 'request-2',
        mode: 'delta',
        sessionId: '1',
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-request-asset-profiler',
        requestId: 'request-3',
        mode: 'full',
        sessionId: '1',
        afterSequence: '0',
      }),
    ).toBe(false);
  });

  it('rejects unknown fields, unsafe numbers, and telemetry outside the retained subset', () => {
    expect(isAssetProfilerWirePayload({ ...full, unexpected: true })).toBe(false);
    expect(
      isAssetProfilerWirePayload({
        ...full,
        memory: { ...memory, accountingRevision: Number.MAX_SAFE_INTEGER + 2 },
      }),
    ).toBe(false);
    expect(
      isAssetProfilerWirePayload({
        ...full,
        retainedChanges: [
          {
            ...telemetryChange,
            event: { ...telemetryChange.event, eventKind: 'source-read-started' },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isAssetProfilerWirePayload({
        ...full,
        memory: {
          ...memory,
          policy: {
            ...memory.policy,
            budget: { ...memory.policy.budget, prefetchAllowancePercent: 101 },
          },
        },
      }),
    ).toBe(false);
  });
});
