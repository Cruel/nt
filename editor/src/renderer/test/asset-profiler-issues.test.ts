import { describe, expect, it } from 'vite-plus/test';
import type {
  AssetProfilerRetainedTelemetryEventKind,
  AssetProfilerWireChange,
} from '../../shared/asset-profiler-protocol';
import { deriveAssetProfilerIssues } from '@/asset-profiler/asset-profiler-issues';
import {
  normalizeAssetProfilerValue,
  type NormalizedAssetProfilerChange,
} from '@/asset-profiler/asset-profiler-store';

const key = (stableIdentity: string) => ({ stableIdentity, sourceGeneration: '1' });
const zeroCost = () => ({
  sourceBytes: '0',
  preparedCpuBytes: '0',
  gpuBytes: '0',
  audioBytes: '0',
  temporaryBytes: '0',
});

function telemetry({
  sequence,
  timestampNs,
  stableIdentity,
  requestId,
  eventKind,
  diagnosticCode = '',
  jobId = '1',
  prefetchGeneration = '1',
  durationNs = '0',
}: {
  sequence: string;
  timestampNs: string;
  stableIdentity: string;
  requestId: string;
  eventKind: AssetProfilerRetainedTelemetryEventKind;
  diagnosticCode?: string;
  jobId?: string;
  prefetchGeneration?: string;
  durationNs?: string;
}): AssetProfilerWireChange {
  return {
    kind: 'telemetry-event',
    sequence,
    timestampNs,
    event: {
      eventKind,
      executionMode: 'threaded',
      cacheKey: key(stableIdentity),
      jobId,
      requestId,
      prefetchGeneration,
      requestReason: 'demand',
      jobPriority: 'critical',
      memory: zeroCost(),
      compressedBytes: '0',
      uncompressedBytes: '0',
      durationNs,
      diagnosticCode,
      evictionReason: null,
      memoryPolicy: null,
    },
  };
}

function normalized(changes: AssetProfilerWireChange[]) {
  return normalizeAssetProfilerValue(changes) as NormalizedAssetProfilerChange[];
}

describe('asset profiler issue derivation', () => {
  it('groups one wait with three children, attaches job-stage details, and keeps later waits separate', () => {
    const changes = normalized([
      telemetry({
        sequence: '1',
        timestampNs: '110',
        stableIdentity: 'texture|project:/late.png|0',
        requestId: '10',
        eventKind: 'prefetch-late',
        jobId: '101',
      }),
      telemetry({
        sequence: '2',
        timestampNs: '115',
        stableIdentity: 'texture|project:/late.png|0',
        requestId: '0',
        eventKind: 'source-read-completed',
        jobId: '101',
        durationNs: '5',
      }),
      telemetry({
        sequence: '3',
        timestampNs: '120',
        stableIdentity: 'texture|project:/failed.png|0',
        requestId: '11',
        eventKind: 'prefetch-miss',
        jobId: '102',
      }),
      telemetry({
        sequence: '4',
        timestampNs: '125',
        stableIdentity: 'texture|project:/failed.png|0',
        requestId: '0',
        eventKind: 'preparation-failed',
        diagnosticCode: 'assets.decode_failed',
        jobId: '102',
        durationNs: '6',
      }),
      telemetry({
        sequence: '5',
        timestampNs: '130',
        stableIdentity: 'texture|project:/failed.png|0',
        requestId: '11',
        eventKind: 'request-failed',
        diagnosticCode: 'assets.decode_failed',
        jobId: '102',
      }),
      telemetry({
        sequence: '6',
        timestampNs: '140',
        stableIdentity: 'audio|project:/voice.ogg|0|0',
        requestId: '12',
        eventKind: 'prefetch-miss',
        jobId: '103',
      }),
      {
        kind: 'asset-wait',
        sequence: '7',
        timestampNs: '200',
        wait: {
          operationId: '7',
          phase: 'loading-runtime-demand',
          presentationRevision: '2',
          startedAtNs: '100',
          durationNs: '100',
          result: 'failed',
          waitingRequests: [
            { cacheKey: key('texture|project:/late.png|0'), requestId: '10' },
            { cacheKey: key('texture|project:/failed.png|0'), requestId: '11' },
            { cacheKey: key('audio|project:/voice.ogg|0|0'), requestId: '12' },
          ],
          diagnostics: [],
        },
      },
      telemetry({
        sequence: '8',
        timestampNs: '310',
        stableIdentity: 'texture|project:/later.png|0',
        requestId: '0',
        eventKind: 'source-read-completed',
        jobId: '104',
        durationNs: '7',
      }),
      {
        kind: 'asset-wait',
        sequence: '9',
        timestampNs: '350',
        wait: {
          operationId: '8',
          phase: 'loading-runtime-demand',
          presentationRevision: '3',
          startedAtNs: '300',
          durationNs: '50',
          result: 'completed',
          waitingRequests: [{ cacheKey: key('texture|project:/later.png|0'), requestId: '20' }],
          diagnostics: [],
        },
      },
      {
        kind: 'asset-wait',
        sequence: '10',
        timestampNs: '400',
        wait: {
          operationId: '9',
          phase: 'loading-runtime-demand',
          presentationRevision: '4',
          startedAtNs: '375',
          durationNs: '25',
          result: 'canceled',
          waitingRequests: [{ cacheKey: key('texture|project:/canceled.png|0'), requestId: '21' }],
          diagnostics: [],
        },
      },
    ]);

    const issues = deriveAssetProfilerIssues(changes);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.id)).toEqual(['wait-8', 'wait-7']);
    expect(issues[0]?.children[0]?.stageDetails).toEqual([
      {
        kind: 'source-read',
        durationNs: 7n,
        failed: false,
        diagnosticCode: '',
      },
    ]);
    const groupedWait = issues[1];
    expect(groupedWait).toMatchObject({ type: 'asset-wait', severity: 'warning' });
    expect(groupedWait?.children.map((child) => child.result)).toEqual([
      'loaded-too-late',
      'load-failed',
      'not-prefetched',
    ]);
    expect(groupedWait?.children[0]).toMatchObject({
      displayIdentity: 'project:/late.png',
      assetType: 'image',
      stageDetails: [{ kind: 'source-read', durationNs: 5n }],
    });
    expect(groupedWait?.children[1]).toMatchObject({
      displayIdentity: 'project:/failed.png',
      prefetchClassification: 'not-prefetched',
      diagnosticCode: 'assets.decode_failed',
      stageDetails: [
        {
          kind: 'preparation',
          durationNs: 6n,
          failed: true,
          diagnosticCode: 'assets.decode_failed',
        },
      ],
    });
    expect(issues.some((issue) => issue.type === 'load-failed')).toBe(false);
  });

  it('deduplicates generation upserts without moving the original rejection occurrence', () => {
    const generation = {
      generation: '9',
      timestampNs: '10',
      presentationRevision: null,
      expectedNextCount: '1',
      possibleNextCount: '0',
      submittedEntries: [],
      submissionFailures: [
        {
          cacheKey: key('project:/large.png'),
          prediction: 'expected-next' as const,
          diagnostic: {
            code: 'assets.prefetch_allowance_exceeded',
            message: 'limit',
            severity: 'warning' as const,
            sourcePath: '',
            jsonPointer: '',
            causes: [],
          },
        },
      ],
      usedCount: '0',
      lateCount: '0',
      unusedCount: '0',
    };
    const changes = normalized([
      { kind: 'prefetch-generation-upsert', sequence: '1', timestampNs: '10', generation },
      {
        kind: 'prefetch-generation-upsert',
        sequence: '2',
        timestampNs: '30',
        generation: { ...generation, usedCount: '1' },
      },
      telemetry({
        sequence: '3',
        timestampNs: '20',
        stableIdentity: 'texture|project:/reload.png|0',
        requestId: '20',
        eventKind: 'reloaded-after-eviction',
      }),
      telemetry({
        sequence: '4',
        timestampNs: '40',
        stableIdentity: 'texture|project:/reload.png|0',
        requestId: '21',
        eventKind: 'reloaded-after-eviction',
      }),
    ]);

    const issues = deriveAssetProfilerIssues(changes);
    const rejection = issues.filter((issue) => issue.type === 'prefetch-blocked');
    expect(rejection).toHaveLength(1);
    expect(rejection[0]?.timestampNs).toBe(10n);
    expect(issues.map((issue) => issue.timestampNs)).toEqual([40n, 20n, 10n]);
    expect(issues.filter((issue) => issue.type === 'reloaded')).toHaveLength(2);
  });

  it('deduplicates only generation-correlated post-ticket memory rejections', () => {
    const rejection = (sequence: string, prefetchGeneration: string) =>
      telemetry({
        sequence,
        timestampNs: sequence,
        stableIdentity: 'texture|project:/large.png|0',
        requestId: '30',
        eventKind: 'budget-pressure',
        diagnosticCode: 'assets.prefetch_residency_rejected',
        prefetchGeneration,
      });

    const issues = deriveAssetProfilerIssues(
      normalized([rejection('1', '0'), rejection('2', '4'), rejection('3', '4')]),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      type: 'prefetch-blocked',
      diagnosticCode: 'assets.prefetch_residency_rejected',
      timestampNs: 2n,
    });
  });

  it('sorts terminal failures before newer warnings and retains stable technical codes', () => {
    const issues = deriveAssetProfilerIssues(
      normalized([
        telemetry({
          sequence: '1',
          timestampNs: '10',
          stableIdentity: 'audio|project:/broken.ogg|0|0',
          requestId: '40',
          eventKind: 'request-failed',
          diagnosticCode: 'assets.audio_decode_failed',
          jobId: '200',
        }),
        telemetry({
          sequence: '2',
          timestampNs: '20',
          stableIdentity: 'audio|project:/reloaded.ogg|0|0',
          requestId: '41',
          eventKind: 'reloaded-after-eviction',
        }),
      ]),
    );

    expect(issues.map((issue) => issue.type)).toEqual(['load-failed', 'reloaded']);
    expect(issues[0]).toMatchObject({
      displayIdentity: 'project:/broken.ogg',
      assetType: 'audio',
      diagnosticCode: 'assets.audio_decode_failed',
    });
  });
});
