import type {
  AssetProfilerAssetType,
  AssetProfilerDiagnostic,
} from '../../shared/asset-profiler-protocol';
import type {
  NormalizedAssetProfilerChange,
  NormalizedAssetProfilerEntry,
} from './asset-profiler-store';

export type AssetProfilerIssueType = 'load-failed' | 'asset-wait' | 'prefetch-blocked' | 'reloaded';
export type AssetProfilerIssueSeverity = 'error' | 'warning';
export type AssetProfilerWaitChildResult = 'load-failed' | 'loaded-too-late' | 'not-prefetched';

export interface AssetProfilerIssueStageDetail {
  kind: 'source-read' | 'preparation' | 'owner-finalization';
  durationNs: bigint;
  failed: boolean;
  diagnosticCode: string;
}

export interface AssetProfilerWaitIssueChild {
  id: string;
  stableIdentity: string;
  displayIdentity: string;
  assetType: AssetProfilerAssetType | null;
  sourceGeneration: bigint;
  requestId: bigint;
  result: AssetProfilerWaitChildResult;
  prefetchClassification: Exclude<AssetProfilerWaitChildResult, 'load-failed'> | null;
  diagnosticCode: string;
  stageDetails: AssetProfilerIssueStageDetail[];
}

export interface AssetProfilerIssue {
  id: string;
  type: AssetProfilerIssueType;
  severity: AssetProfilerIssueSeverity;
  timestampNs: bigint;
  stableIdentity: string | null;
  displayIdentity: string | null;
  assetType: AssetProfilerAssetType | null;
  sourceGeneration: bigint | null;
  diagnosticCode: string;
  diagnostic: AssetProfilerDiagnostic | null;
  durationNs: bigint | null;
  phase: string | null;
  children: AssetProfilerWaitIssueChild[];
  stageDetails: AssetProfilerIssueStageDetail[];
}

const rejectionCodes = new Set([
  'assets.prefetch_allowance_exceeded',
  'assets.prefetch_preparation_rejected',
  'assets.prefetch_preparation_resize_rejected',
  'assets.prefetch_residency_rejected',
]);

type TelemetryChange = Extract<NormalizedAssetProfilerChange, { kind: 'telemetry-event' }>;

function cacheKeyId(stableIdentity: string, sourceGeneration: bigint) {
  return `${stableIdentity}\0${sourceGeneration}`;
}

function participantId(stableIdentity: string, sourceGeneration: bigint, requestId: bigint) {
  return `${cacheKeyId(stableIdentity, sourceGeneration)}\0${requestId}`;
}

function fallbackAssetIdentity(stableIdentity: string): {
  displayIdentity: string;
  assetType: AssetProfilerAssetType | null;
} {
  const strip = (prefix: string) =>
    stableIdentity.startsWith(prefix) ? stableIdentity.slice(prefix.length) : null;
  const texture = strip('texture|');
  if (texture !== null) {
    const suffix = texture.lastIndexOf('|');
    return {
      displayIdentity: suffix < 0 ? texture : texture.slice(0, suffix),
      assetType: 'image',
    };
  }
  const audio = strip('audio|');
  if (audio !== null) {
    const last = audio.lastIndexOf('|');
    const previous = last < 0 ? -1 : audio.lastIndexOf('|', last - 1);
    return {
      displayIdentity: previous < 0 ? audio : audio.slice(0, previous),
      assetType: 'audio',
    };
  }
  const font = strip('font-source|');
  if (font !== null) return { displayIdentity: font, assetType: 'font' };
  const shader = strip('shader-material|program|');
  if (shader !== null) return { displayIdentity: shader, assetType: 'shader' };
  const material = strip('shader-material|material|');
  if (material !== null) return { displayIdentity: material, assetType: 'material' };
  return { displayIdentity: stableIdentity, assetType: null };
}

function indexedAssetIdentity(
  assetsByCacheKey: ReadonlyMap<string, NormalizedAssetProfilerEntry[]>,
  stableIdentity: string,
  sourceGeneration: bigint,
) {
  const entries = assetsByCacheKey.get(cacheKeyId(stableIdentity, sourceGeneration)) ?? [];
  if (entries.length !== 1) return fallbackAssetIdentity(stableIdentity);
  return {
    displayIdentity: entries[0]!.displayIdentity,
    assetType: entries[0]!.assetType,
  };
}

function inTimeRange(change: TelemetryChange, startedAtNs: bigint, finishedAtNs: bigint) {
  return change.timestampNs >= startedAtNs && change.timestampNs <= finishedAtNs;
}

function stageDetail(change: NormalizedAssetProfilerChange): AssetProfilerIssueStageDetail | null {
  if (change.kind !== 'telemetry-event') return null;
  const mapping = {
    'source-read-completed': ['source-read', false],
    'source-read-failed': ['source-read', true],
    'preparation-completed': ['preparation', false],
    'preparation-failed': ['preparation', true],
    'owner-finalization-completed': ['owner-finalization', false],
    'owner-finalization-failed': ['owner-finalization', true],
  } as const;
  const mapped = mapping[change.event.eventKind as keyof typeof mapping];
  return mapped
    ? {
        kind: mapped[0],
        failed: mapped[1],
        durationNs: change.event.durationNs,
        diagnosticCode: change.event.diagnosticCode,
      }
    : null;
}

export function deriveAssetProfilerIssues(
  changes: NormalizedAssetProfilerChange[],
  assetsByKey: ReadonlyMap<string, NormalizedAssetProfilerEntry> = new Map(),
): AssetProfilerIssue[] {
  const issues: AssetProfilerIssue[] = [];
  const requestFailuresInWaits = new Set<string>();
  const telemetryByCacheKey = new Map<string, TelemetryChange[]>();
  for (const change of changes) {
    if (change.kind !== 'telemetry-event' || change.event.cacheKey === null) continue;
    const key = cacheKeyId(
      change.event.cacheKey.stableIdentity,
      change.event.cacheKey.sourceGeneration,
    );
    const events = telemetryByCacheKey.get(key) ?? [];
    events.push(change);
    telemetryByCacheKey.set(key, events);
  }
  const assetsByCacheKey = new Map<string, NormalizedAssetProfilerEntry[]>();
  for (const entry of assetsByKey.values()) {
    const key = cacheKeyId(entry.cacheKey.stableIdentity, entry.cacheKey.sourceGeneration);
    const entries = assetsByCacheKey.get(key) ?? [];
    entries.push(entry);
    assetsByCacheKey.set(key, entries);
  }

  for (const change of changes) {
    if (change.kind !== 'asset-wait' || change.wait.result === 'canceled') continue;
    const finishedAtNs = change.wait.startedAtNs + change.wait.durationNs;
    const children = change.wait.waitingRequests.map((participant) => {
      const identity = indexedAssetIdentity(
        assetsByCacheKey,
        participant.cacheKey.stableIdentity,
        participant.cacheKey.sourceGeneration,
      );
      const keyedEvents =
        telemetryByCacheKey.get(
          cacheKeyId(participant.cacheKey.stableIdentity, participant.cacheKey.sourceGeneration),
        ) ?? [];
      const matching = keyedEvents.filter(
        (candidate) =>
          inTimeRange(candidate, change.wait.startedAtNs, finishedAtNs) &&
          candidate.event.requestId === participant.requestId,
      );
      const failed = matching.find((candidate) => candidate.event.eventKind === 'request-failed');
      const late = matching.some((candidate) => candidate.event.eventKind === 'prefetch-late');
      const miss = matching.some((candidate) => candidate.event.eventKind === 'prefetch-miss');
      const classification = late ? 'loaded-too-late' : miss ? 'not-prefetched' : null;
      if (failed) {
        requestFailuresInWaits.add(
          participantId(
            participant.cacheKey.stableIdentity,
            participant.cacheKey.sourceGeneration,
            participant.requestId,
          ),
        );
      }
      const relatedJobIds = new Set(
        matching.map((candidate) => candidate.event.jobId).filter((jobId) => jobId !== 0n),
      );
      const rangedEvents = keyedEvents.filter((candidate) =>
        inTimeRange(candidate, change.wait.startedAtNs, finishedAtNs),
      );
      if (relatedJobIds.size === 0) {
        const stageJobIds = new Set(
          rangedEvents
            .filter((candidate) => stageDetail(candidate) !== null)
            .map((candidate) => candidate.event.jobId)
            .filter((jobId) => jobId !== 0n),
        );
        if (stageJobIds.size === 1) relatedJobIds.add([...stageJobIds][0]!);
      }
      const stageDetails = rangedEvents
        .filter(
          (candidate) =>
            candidate.event.requestId === participant.requestId ||
            (candidate.event.jobId !== 0n && relatedJobIds.has(candidate.event.jobId)),
        )
        .map(stageDetail)
        .filter((detail): detail is AssetProfilerIssueStageDetail => detail !== null);
      return {
        id: `wait-${change.wait.operationId}-${participant.requestId}-${participant.cacheKey.stableIdentity}`,
        stableIdentity: participant.cacheKey.stableIdentity,
        displayIdentity: identity.displayIdentity,
        assetType: identity.assetType,
        sourceGeneration: participant.cacheKey.sourceGeneration,
        requestId: participant.requestId,
        result: failed ? 'load-failed' : (classification ?? 'not-prefetched'),
        prefetchClassification: classification,
        diagnosticCode: failed?.event.diagnosticCode ?? '',
        stageDetails,
      } satisfies AssetProfilerWaitIssueChild;
    });
    issues.push({
      id: `wait-${change.wait.operationId}`,
      type: 'asset-wait',
      severity: 'warning',
      timestampNs: change.timestampNs,
      stableIdentity: null,
      displayIdentity: null,
      assetType: null,
      sourceGeneration: null,
      diagnosticCode: change.wait.diagnostics[0]?.code ?? '',
      diagnostic: change.wait.diagnostics[0] ?? null,
      durationNs: change.wait.durationNs,
      phase: change.wait.phase,
      children,
      stageDetails: [],
    });
  }

  const latestGenerations = new Map<
    bigint,
    Extract<NormalizedAssetProfilerChange, { kind: 'prefetch-generation-upsert' }>
  >();
  for (const change of changes) {
    if (change.kind === 'prefetch-generation-upsert')
      latestGenerations.set(BigInt(change.generation.generation), change);
  }
  for (const change of latestGenerations.values()) {
    const seenFailures = new Set<string>();
    const generationId = BigInt(change.generation.generation);
    const generationTimestampNs = BigInt(change.generation.timestampNs);
    for (const failure of change.generation.submissionFailures) {
      if (failure.diagnostic.code !== 'assets.prefetch_allowance_exceeded') continue;
      const sourceGeneration = BigInt(failure.cacheKey.sourceGeneration);
      const occurrenceId = `${cacheKeyId(failure.cacheKey.stableIdentity, sourceGeneration)}\0${failure.diagnostic.code}`;
      if (seenFailures.has(occurrenceId)) continue;
      seenFailures.add(occurrenceId);
      const identity = indexedAssetIdentity(
        assetsByCacheKey,
        failure.cacheKey.stableIdentity,
        sourceGeneration,
      );
      issues.push({
        id: `rejection-${generationId}-${occurrenceId}`,
        type: 'prefetch-blocked',
        severity: 'warning',
        timestampNs: generationTimestampNs,
        stableIdentity: failure.cacheKey.stableIdentity,
        displayIdentity: identity.displayIdentity,
        assetType: identity.assetType,
        sourceGeneration,
        diagnosticCode: failure.diagnostic.code,
        diagnostic: failure.diagnostic,
        durationNs: null,
        phase: null,
        children: [],
        stageDetails: [],
      });
    }
  }

  const seenRejections = new Set<string>();
  for (const change of changes) {
    if (change.kind !== 'telemetry-event' || !change.event.cacheKey) continue;
    const event = change.event;
    const key = event.cacheKey!;
    const stableIdentity = key.stableIdentity;
    const sourceGeneration = key.sourceGeneration;
    const identity = indexedAssetIdentity(assetsByCacheKey, stableIdentity, sourceGeneration);
    if (event.eventKind === 'request-failed') {
      if (
        requestFailuresInWaits.has(participantId(stableIdentity, sourceGeneration, event.requestId))
      )
        continue;
      const related = (
        telemetryByCacheKey.get(cacheKeyId(stableIdentity, sourceGeneration)) ?? []
      ).filter(
        (candidate) =>
          candidate.sequence <= change.sequence &&
          ((event.jobId !== 0n && candidate.event.jobId === event.jobId) ||
            candidate.event.requestId === event.requestId),
      );
      issues.push({
        id: `failure-${change.sequence}`,
        type: 'load-failed',
        severity: 'error',
        timestampNs: change.timestampNs,
        stableIdentity,
        displayIdentity: identity.displayIdentity,
        assetType: identity.assetType,
        sourceGeneration,
        diagnosticCode: event.diagnosticCode,
        diagnostic: null,
        durationNs: null,
        phase: null,
        children: [],
        stageDetails: related
          .map(stageDetail)
          .filter((detail): detail is AssetProfilerIssueStageDetail => detail !== null),
      });
    } else if (event.eventKind === 'reloaded-after-eviction') {
      issues.push({
        id: `reload-${change.sequence}`,
        type: 'reloaded',
        severity: 'warning',
        timestampNs: change.timestampNs,
        stableIdentity,
        displayIdentity: identity.displayIdentity,
        assetType: identity.assetType,
        sourceGeneration,
        diagnosticCode: event.diagnosticCode,
        diagnostic: null,
        durationNs: null,
        phase: null,
        children: [],
        stageDetails: [],
      });
    } else if (
      rejectionCodes.has(event.diagnosticCode) &&
      event.diagnosticCode !== 'assets.prefetch_allowance_exceeded' &&
      event.prefetchGeneration !== 0n
    ) {
      const id = `${event.prefetchGeneration}\0${cacheKeyId(stableIdentity, sourceGeneration)}\0${event.diagnosticCode}`;
      if (seenRejections.has(id)) continue;
      seenRejections.add(id);
      issues.push({
        id: `rejection-${id}`,
        type: 'prefetch-blocked',
        severity: 'warning',
        timestampNs: change.timestampNs,
        stableIdentity,
        displayIdentity: identity.displayIdentity,
        assetType: identity.assetType,
        sourceGeneration,
        diagnosticCode: event.diagnosticCode,
        diagnostic: null,
        durationNs: null,
        phase: null,
        children: [],
        stageDetails: [],
      });
    }
  }

  return issues.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
    if (left.timestampNs === right.timestampNs) return left.id.localeCompare(right.id);
    return left.timestampNs > right.timestampNs ? -1 : 1;
  });
}
