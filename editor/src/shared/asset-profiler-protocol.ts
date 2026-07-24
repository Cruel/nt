export const ASSET_PROFILER_SCHEMA_VERSION = 3;

export type CanonicalDecimal = string;
export type AssetProfilerPayloadKind = 'full' | 'delta';

export type AssetProfilerDiagnosticSeverity = 'info' | 'warning' | 'error' | 'fatal';

export interface AssetProfilerDiagnostic {
  code: string;
  message: string;
  severity: AssetProfilerDiagnosticSeverity;
  sourcePath: string;
  jsonPointer: string;
  causes: AssetProfilerDiagnostic[];
}

export interface AssetProfilerResidencyCost {
  sourceBytes: CanonicalDecimal;
  preparedCpuBytes: CanonicalDecimal;
  gpuBytes: CanonicalDecimal;
  audioBytes: CanonicalDecimal;
  temporaryBytes: CanonicalDecimal;
}

export interface AssetProfilerCacheKey {
  stableIdentity: string;
  sourceGeneration: CanonicalDecimal;
}

export interface AssetProfilerRendererEstimate {
  ordinaryTextureBytes: CanonicalDecimal | null;
  renderTargetBytes: CanonicalDecimal | null;
}

export interface AssetProfilerMemoryValues {
  asset: AssetProfilerResidencyCost;
  warm: AssetProfilerResidencyCost;
  assetRamBytes: CanonicalDecimal;
  rendererEstimate: AssetProfilerRendererEstimate;
  totalGpuResourceBytes: CanonicalDecimal | null;
}

export interface AssetProfilerMemoryPeaks {
  asset: AssetProfilerResidencyCost;
  assetRamBytes: CanonicalDecimal;
  rendererEstimate: AssetProfilerRendererEstimate;
  totalGpuResourceBytes: CanonicalDecimal | null;
}

export interface AssetProfilerStateCounts {
  inUse: CanonicalDecimal;
  prefetched: CanonicalDecimal;
  cached: CanonicalDecimal;
  loading: CanonicalDecimal;
  finishing: CanonicalDecimal;
  failed: CanonicalDecimal;
}

export type AssetProfilerMemoryTarget = 'desktop' | 'android' | 'web';
export type AssetProfilerMemoryPreset = 'low' | 'balanced' | 'high' | 'custom';

export interface AssetProfilerMemoryBudget extends AssetProfilerResidencyCost {
  prefetchAllowancePercent: number;
}

export interface AssetProfilerMemoryPolicy {
  target: AssetProfilerMemoryTarget;
  preset: AssetProfilerMemoryPreset;
  budget: AssetProfilerMemoryBudget;
}

export interface AssetProfilerMemorySnapshot {
  current: AssetProfilerMemoryValues;
  peak: AssetProfilerMemoryPeaks;
  policy: AssetProfilerMemoryPolicy;
  assetCounts: AssetProfilerStateCounts;
  accountingRevision: CanonicalDecimal;
  rendererSampledAtNs: CanonicalDecimal | null;
}

export interface AssetProfilerOutcomeTotals {
  readyBeforeUse: CanonicalDecimal;
  loadedTooLate: CanonicalDecimal;
  notPrefetched: CanonicalDecimal;
  blockedByMemoryLimit: CanonicalDecimal;
  prefetchedButUnused: CanonicalDecimal;
  reloadedAfterRemoval: CanonicalDecimal;
  assetWaitCount: CanonicalDecimal;
  assetWaitTimeNs: CanonicalDecimal;
}

export type AssetProfilerAssetType = 'image' | 'audio' | 'font' | 'shader' | 'material';
export type AssetProfilerAssetState =
  | 'loading'
  | 'finishing'
  | 'in-use'
  | 'prefetched'
  | 'cached'
  | 'failed';
export type AssetProfilerRequestOrigin =
  | 'startup'
  | 'demand'
  | 'expected-next'
  | 'possible-next'
  | 'prefetched';
export type AssetProfilerRetentionReason =
  | 'required-now'
  | 'expected-next'
  | 'possible-next'
  | 'retained-in-cache'
  | 'startup'
  | 'demand'
  | 'prefetched';

export interface AssetProfilerWireEntry {
  cacheKey: AssetProfilerCacheKey;
  assetType: AssetProfilerAssetType;
  displayIdentity: string;
  state: AssetProfilerAssetState;
  requestOrigin: AssetProfilerRequestOrigin;
  retentionReason: AssetProfilerRetentionReason;
  committedCost: AssetProfilerResidencyCost | null;
  estimatedCost: AssetProfilerResidencyCost | null;
  loadingMemoryBytes: CanonicalDecimal;
  jobId: CanonicalDecimal | null;
  prefetchGeneration: CanonicalDecimal | null;
  completedPrefetchClaimed: boolean;
  removable: boolean;
  reloadCount: CanonicalDecimal;
  diagnostics: AssetProfilerDiagnostic[];
}

export type AssetProfilerPredictionKind = 'expected-next' | 'possible-next';

export interface AssetProfilerPrefetchSubmissionEntry {
  cacheKey: AssetProfilerCacheKey;
  prediction: AssetProfilerPredictionKind;
}

export interface AssetProfilerPrefetchSubmissionFailure {
  cacheKey: AssetProfilerCacheKey;
  prediction: AssetProfilerPredictionKind;
  diagnostic: AssetProfilerDiagnostic;
}

export interface AssetProfilerPrefetchGenerationRecord {
  generation: CanonicalDecimal;
  timestampNs: CanonicalDecimal;
  presentationRevision: CanonicalDecimal | null;
  expectedNextCount: CanonicalDecimal;
  possibleNextCount: CanonicalDecimal;
  submittedEntries: AssetProfilerPrefetchSubmissionEntry[];
  submissionFailures: AssetProfilerPrefetchSubmissionFailure[];
  usedCount: CanonicalDecimal;
  lateCount: CanonicalDecimal;
  unusedCount: CanonicalDecimal;
}

export type AssetProfilerWaitPhase =
  | 'downloading-package'
  | 'verifying-package'
  | 'opening-package-index'
  | 'loading-startup-content'
  | 'loading-runtime-demand';
export type AssetProfilerWaitResult = 'completed' | 'failed' | 'canceled';

export interface AssetProfilerWaitParticipant {
  cacheKey: AssetProfilerCacheKey;
  requestId: CanonicalDecimal;
}

export interface AssetProfilerWaitRecord {
  operationId: CanonicalDecimal;
  phase: AssetProfilerWaitPhase;
  presentationRevision: CanonicalDecimal | null;
  startedAtNs: CanonicalDecimal;
  durationNs: CanonicalDecimal;
  result: AssetProfilerWaitResult;
  waitingRequests: AssetProfilerWaitParticipant[];
  diagnostics: AssetProfilerDiagnostic[];
}

export type AssetProfilerRetainedTelemetryEventKind =
  | 'source-read-completed'
  | 'source-read-failed'
  | 'preparation-completed'
  | 'preparation-failed'
  | 'owner-finalization-completed'
  | 'owner-finalization-failed'
  | 'request-failed'
  | 'evicted'
  | 'reloaded-after-eviction'
  | 'prefetch-used'
  | 'prefetch-late'
  | 'prefetch-miss'
  | 'prefetch-unused'
  | 'budget-pressure';

export interface AssetProfilerTelemetryEvent {
  eventKind: AssetProfilerRetainedTelemetryEventKind;
  executionMode: 'threaded' | 'cooperative' | 'inline-test';
  cacheKey: AssetProfilerCacheKey | null;
  jobId: CanonicalDecimal;
  requestId: CanonicalDecimal;
  prefetchGeneration: CanonicalDecimal;
  requestReason: 'startup' | 'demand' | 'prefetch' | null;
  jobPriority: 'critical' | 'normal' | 'prefetch' | null;
  memory: AssetProfilerResidencyCost;
  compressedBytes: CanonicalDecimal;
  uncompressedBytes: CanonicalDecimal;
  durationNs: CanonicalDecimal;
  diagnosticCode: string;
  evictionReason:
    | 'budget-pressure'
    | 'explicit-release'
    | 'generation-invalidated'
    | 'prefetch-rejected'
    | null;
  memoryPolicy: AssetProfilerMemoryPolicy | null;
}

interface AssetProfilerWireChangeBase {
  sequence: CanonicalDecimal;
  timestampNs: CanonicalDecimal;
}

export type AssetProfilerWireChange =
  | (AssetProfilerWireChangeBase & {
      kind: 'telemetry-event';
      event: AssetProfilerTelemetryEvent;
    })
  | (AssetProfilerWireChangeBase & {
      kind: 'memory-point';
      memory: {
        values: AssetProfilerMemoryValues;
        assetCounts: AssetProfilerStateCounts;
      };
    })
  | (AssetProfilerWireChangeBase & {
      kind: 'asset-wait';
      wait: AssetProfilerWaitRecord;
    })
  | (AssetProfilerWireChangeBase & {
      kind: 'prefetch-generation-upsert';
      generation: AssetProfilerPrefetchGenerationRecord;
    })
  | (AssetProfilerWireChangeBase & {
      kind: 'inventory-changed';
      inventoryRevision: CanonicalDecimal;
    });

interface AssetProfilerWirePayloadBase {
  schemaVersion: 3;
  sessionId: CanonicalDecimal;
  latestSequence: CanonicalDecimal;
  capturedAtNs: CanonicalDecimal;
  memory: AssetProfilerMemorySnapshot;
  outcomes: AssetProfilerOutcomeTotals;
  inventoryRevision: CanonicalDecimal;
  earliestRetainedSequence: CanonicalDecimal;
  lostChangeCount: CanonicalDecimal;
}

export interface AssetProfilerFullWirePayload extends AssetProfilerWirePayloadBase {
  kind: 'full';
  assets: AssetProfilerWireEntry[];
  retainedChanges: AssetProfilerWireChange[];
  historyComplete: boolean;
}

export interface AssetProfilerDeltaWirePayload extends AssetProfilerWirePayloadBase {
  kind: 'delta';
  afterSequence: CanonicalDecimal;
  replacementInventory: AssetProfilerWireEntry[] | null;
  changes: AssetProfilerWireChange[];
  historyGap: boolean;
}

export type AssetProfilerWirePayload = AssetProfilerFullWirePayload | AssetProfilerDeltaWirePayload;

export type AssetProfilerExportResult =
  | { ok: true; payload: AssetProfilerWirePayload }
  | { ok: false; error: { code: string; message: string } };

const decimalPattern = /^(0|[1-9][0-9]*)$/;

const costKeys = [
  'sourceBytes',
  'preparedCpuBytes',
  'gpuBytes',
  'audioBytes',
  'temporaryBytes',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function isCanonicalUnsignedDecimal(value: unknown): value is CanonicalDecimal {
  return typeof value === 'string' && decimalPattern.test(value);
}

function isNullableDecimal(value: unknown): value is CanonicalDecimal | null {
  return value === null || isCanonicalUnsignedDecimal(value);
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isDiagnostic(value: unknown): value is AssetProfilerDiagnostic {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['code', 'message', 'severity', 'sourcePath', 'jsonPointer', 'causes']) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    isEnum(value.severity, ['info', 'warning', 'error', 'fatal']) &&
    typeof value.sourcePath === 'string' &&
    typeof value.jsonPointer === 'string' &&
    Array.isArray(value.causes) &&
    value.causes.every(isDiagnostic)
  );
}

function isCost(value: unknown): value is AssetProfilerResidencyCost {
  return (
    isRecord(value) &&
    hasExactKeys(value, costKeys) &&
    costKeys.every((key) => isCanonicalUnsignedDecimal(value[key]))
  );
}

function isCacheKey(value: unknown): value is AssetProfilerCacheKey {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['stableIdentity', 'sourceGeneration']) &&
    typeof value.stableIdentity === 'string' &&
    isCanonicalUnsignedDecimal(value.sourceGeneration)
  );
}

function isRendererEstimate(value: unknown): value is AssetProfilerRendererEstimate {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ordinaryTextureBytes', 'renderTargetBytes']) &&
    isNullableDecimal(value.ordinaryTextureBytes) &&
    isNullableDecimal(value.renderTargetBytes)
  );
}

function isMemoryValues(value: unknown): value is AssetProfilerMemoryValues {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'asset',
      'warm',
      'assetRamBytes',
      'rendererEstimate',
      'totalGpuResourceBytes',
    ]) &&
    isCost(value.asset) &&
    isCost(value.warm) &&
    isCanonicalUnsignedDecimal(value.assetRamBytes) &&
    isRendererEstimate(value.rendererEstimate) &&
    isNullableDecimal(value.totalGpuResourceBytes)
  );
}

function isMemoryPeaks(value: unknown): value is AssetProfilerMemoryPeaks {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['asset', 'assetRamBytes', 'rendererEstimate', 'totalGpuResourceBytes']) &&
    isCost(value.asset) &&
    isCanonicalUnsignedDecimal(value.assetRamBytes) &&
    isRendererEstimate(value.rendererEstimate) &&
    isNullableDecimal(value.totalGpuResourceBytes)
  );
}

function isStateCounts(value: unknown): value is AssetProfilerStateCounts {
  const keys = ['inUse', 'prefetched', 'cached', 'loading', 'finishing', 'failed'] as const;
  return (
    isRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => isCanonicalUnsignedDecimal(value[key]))
  );
}

function isPolicy(value: unknown): value is AssetProfilerMemoryPolicy {
  const budget = isRecord(value) ? value.budget : undefined;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['target', 'preset', 'budget']) ||
    !isEnum(value.target, ['desktop', 'android', 'web']) ||
    !isEnum(value.preset, ['low', 'balanced', 'high', 'custom']) ||
    !isRecord(budget) ||
    !hasExactKeys(budget, [...costKeys, 'prefetchAllowancePercent']) ||
    !costKeys.every((key) => isCanonicalUnsignedDecimal(budget[key]))
  ) {
    return false;
  }
  return (
    typeof budget.prefetchAllowancePercent === 'number' &&
    Number.isInteger(budget.prefetchAllowancePercent) &&
    budget.prefetchAllowancePercent >= 0 &&
    budget.prefetchAllowancePercent <= 100
  );
}

function isMemory(value: unknown): value is AssetProfilerMemorySnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'current',
      'peak',
      'policy',
      'assetCounts',
      'accountingRevision',
      'rendererSampledAtNs',
    ]) &&
    isMemoryValues(value.current) &&
    isMemoryPeaks(value.peak) &&
    isPolicy(value.policy) &&
    isStateCounts(value.assetCounts) &&
    isCanonicalUnsignedDecimal(value.accountingRevision) &&
    isNullableDecimal(value.rendererSampledAtNs)
  );
}

function isOutcomes(value: unknown): value is AssetProfilerOutcomeTotals {
  const keys = [
    'readyBeforeUse',
    'loadedTooLate',
    'notPrefetched',
    'blockedByMemoryLimit',
    'prefetchedButUnused',
    'reloadedAfterRemoval',
    'assetWaitCount',
    'assetWaitTimeNs',
  ] as const;
  return (
    isRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => isCanonicalUnsignedDecimal(value[key]))
  );
}

function isAssetEntry(value: unknown): value is AssetProfilerWireEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'cacheKey',
      'assetType',
      'displayIdentity',
      'state',
      'requestOrigin',
      'retentionReason',
      'committedCost',
      'estimatedCost',
      'loadingMemoryBytes',
      'jobId',
      'prefetchGeneration',
      'completedPrefetchClaimed',
      'removable',
      'reloadCount',
      'diagnostics',
    ]) &&
    isCacheKey(value.cacheKey) &&
    isEnum(value.assetType, ['image', 'audio', 'font', 'shader', 'material']) &&
    typeof value.displayIdentity === 'string' &&
    isEnum(value.state, ['loading', 'finishing', 'in-use', 'prefetched', 'cached', 'failed']) &&
    isEnum(value.requestOrigin, [
      'startup',
      'demand',
      'expected-next',
      'possible-next',
      'prefetched',
    ]) &&
    isEnum(value.retentionReason, [
      'required-now',
      'expected-next',
      'possible-next',
      'retained-in-cache',
      'startup',
      'demand',
      'prefetched',
    ]) &&
    (value.committedCost === null || isCost(value.committedCost)) &&
    (value.estimatedCost === null || isCost(value.estimatedCost)) &&
    isCanonicalUnsignedDecimal(value.loadingMemoryBytes) &&
    isNullableDecimal(value.jobId) &&
    isNullableDecimal(value.prefetchGeneration) &&
    typeof value.completedPrefetchClaimed === 'boolean' &&
    typeof value.removable === 'boolean' &&
    isCanonicalUnsignedDecimal(value.reloadCount) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isSubmissionEntry(value: unknown): value is AssetProfilerPrefetchSubmissionEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['cacheKey', 'prediction']) &&
    isCacheKey(value.cacheKey) &&
    isEnum(value.prediction, ['expected-next', 'possible-next'])
  );
}

function isSubmissionFailure(value: unknown): value is AssetProfilerPrefetchSubmissionFailure {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['cacheKey', 'prediction', 'diagnostic']) &&
    isCacheKey(value.cacheKey) &&
    isEnum(value.prediction, ['expected-next', 'possible-next']) &&
    isDiagnostic(value.diagnostic)
  );
}

function isGeneration(value: unknown): value is AssetProfilerPrefetchGenerationRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'generation',
      'timestampNs',
      'presentationRevision',
      'expectedNextCount',
      'possibleNextCount',
      'submittedEntries',
      'submissionFailures',
      'usedCount',
      'lateCount',
      'unusedCount',
    ]) &&
    isCanonicalUnsignedDecimal(value.generation) &&
    isCanonicalUnsignedDecimal(value.timestampNs) &&
    isNullableDecimal(value.presentationRevision) &&
    isCanonicalUnsignedDecimal(value.expectedNextCount) &&
    isCanonicalUnsignedDecimal(value.possibleNextCount) &&
    Array.isArray(value.submittedEntries) &&
    value.submittedEntries.every(isSubmissionEntry) &&
    Array.isArray(value.submissionFailures) &&
    value.submissionFailures.every(isSubmissionFailure) &&
    isCanonicalUnsignedDecimal(value.usedCount) &&
    isCanonicalUnsignedDecimal(value.lateCount) &&
    isCanonicalUnsignedDecimal(value.unusedCount)
  );
}

function isWaitParticipant(value: unknown): value is AssetProfilerWaitParticipant {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['cacheKey', 'requestId']) &&
    isCacheKey(value.cacheKey) &&
    isCanonicalUnsignedDecimal(value.requestId)
  );
}

function isWait(value: unknown): value is AssetProfilerWaitRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'operationId',
      'phase',
      'presentationRevision',
      'startedAtNs',
      'durationNs',
      'result',
      'waitingRequests',
      'diagnostics',
    ]) &&
    isCanonicalUnsignedDecimal(value.operationId) &&
    isEnum(value.phase, [
      'downloading-package',
      'verifying-package',
      'opening-package-index',
      'loading-startup-content',
      'loading-runtime-demand',
    ]) &&
    isNullableDecimal(value.presentationRevision) &&
    isCanonicalUnsignedDecimal(value.startedAtNs) &&
    isCanonicalUnsignedDecimal(value.durationNs) &&
    isEnum(value.result, ['completed', 'failed', 'canceled']) &&
    Array.isArray(value.waitingRequests) &&
    value.waitingRequests.every(isWaitParticipant) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isDiagnostic)
  );
}

function isTelemetry(value: unknown): value is AssetProfilerTelemetryEvent {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'eventKind',
      'executionMode',
      'cacheKey',
      'jobId',
      'requestId',
      'prefetchGeneration',
      'requestReason',
      'jobPriority',
      'memory',
      'compressedBytes',
      'uncompressedBytes',
      'durationNs',
      'diagnosticCode',
      'evictionReason',
      'memoryPolicy',
    ]) &&
    isEnum(value.eventKind, [
      'source-read-completed',
      'source-read-failed',
      'preparation-completed',
      'preparation-failed',
      'owner-finalization-completed',
      'owner-finalization-failed',
      'request-failed',
      'evicted',
      'reloaded-after-eviction',
      'prefetch-used',
      'prefetch-late',
      'prefetch-miss',
      'prefetch-unused',
      'budget-pressure',
    ]) &&
    isEnum(value.executionMode, ['threaded', 'cooperative', 'inline-test']) &&
    (value.cacheKey === null || isCacheKey(value.cacheKey)) &&
    isCanonicalUnsignedDecimal(value.jobId) &&
    isCanonicalUnsignedDecimal(value.requestId) &&
    isCanonicalUnsignedDecimal(value.prefetchGeneration) &&
    (value.requestReason === null ||
      isEnum(value.requestReason, ['startup', 'demand', 'prefetch'])) &&
    (value.jobPriority === null || isEnum(value.jobPriority, ['critical', 'normal', 'prefetch'])) &&
    isCost(value.memory) &&
    isCanonicalUnsignedDecimal(value.compressedBytes) &&
    isCanonicalUnsignedDecimal(value.uncompressedBytes) &&
    isCanonicalUnsignedDecimal(value.durationNs) &&
    typeof value.diagnosticCode === 'string' &&
    (value.evictionReason === null ||
      isEnum(value.evictionReason, [
        'budget-pressure',
        'explicit-release',
        'generation-invalidated',
        'prefetch-rejected',
      ])) &&
    (value.memoryPolicy === null || isPolicy(value.memoryPolicy))
  );
}

function isChange(value: unknown): value is AssetProfilerWireChange {
  if (
    !isRecord(value) ||
    !isCanonicalUnsignedDecimal(value.sequence) ||
    !isCanonicalUnsignedDecimal(value.timestampNs) ||
    typeof value.kind !== 'string'
  ) {
    return false;
  }
  switch (value.kind) {
    case 'telemetry-event':
      return (
        hasExactKeys(value, ['sequence', 'timestampNs', 'kind', 'event']) &&
        isTelemetry(value.event)
      );
    case 'memory-point':
      return (
        hasExactKeys(value, ['sequence', 'timestampNs', 'kind', 'memory']) &&
        isRecord(value.memory) &&
        hasExactKeys(value.memory, ['values', 'assetCounts']) &&
        isMemoryValues(value.memory.values) &&
        isStateCounts(value.memory.assetCounts)
      );
    case 'asset-wait':
      return hasExactKeys(value, ['sequence', 'timestampNs', 'kind', 'wait']) && isWait(value.wait);
    case 'prefetch-generation-upsert':
      return (
        hasExactKeys(value, ['sequence', 'timestampNs', 'kind', 'generation']) &&
        isGeneration(value.generation)
      );
    case 'inventory-changed':
      return (
        hasExactKeys(value, ['sequence', 'timestampNs', 'kind', 'inventoryRevision']) &&
        isCanonicalUnsignedDecimal(value.inventoryRevision)
      );
    default:
      return false;
  }
}

const payloadBaseKeys = [
  'kind',
  'schemaVersion',
  'sessionId',
  'latestSequence',
  'capturedAtNs',
  'memory',
  'outcomes',
  'inventoryRevision',
  'earliestRetainedSequence',
  'lostChangeCount',
] as const;

export function isAssetProfilerWirePayload(value: unknown): value is AssetProfilerWirePayload {
  if (
    !isRecord(value) ||
    (value.kind !== 'full' && value.kind !== 'delta') ||
    value.schemaVersion !== ASSET_PROFILER_SCHEMA_VERSION ||
    !isCanonicalUnsignedDecimal(value.sessionId) ||
    !isCanonicalUnsignedDecimal(value.latestSequence) ||
    !isCanonicalUnsignedDecimal(value.capturedAtNs) ||
    !isMemory(value.memory) ||
    !isOutcomes(value.outcomes) ||
    !isCanonicalUnsignedDecimal(value.inventoryRevision) ||
    !isCanonicalUnsignedDecimal(value.earliestRetainedSequence) ||
    !isCanonicalUnsignedDecimal(value.lostChangeCount)
  ) {
    return false;
  }
  if (value.kind === 'full') {
    return (
      hasExactKeys(value, [...payloadBaseKeys, 'assets', 'retainedChanges', 'historyComplete']) &&
      Array.isArray(value.assets) &&
      value.assets.every(isAssetEntry) &&
      Array.isArray(value.retainedChanges) &&
      value.retainedChanges.every(isChange) &&
      typeof value.historyComplete === 'boolean'
    );
  }
  return (
    hasExactKeys(value, [
      ...payloadBaseKeys,
      'afterSequence',
      'replacementInventory',
      'changes',
      'historyGap',
    ]) &&
    isCanonicalUnsignedDecimal(value.afterSequence) &&
    (value.replacementInventory === null ||
      (Array.isArray(value.replacementInventory) &&
        value.replacementInventory.every(isAssetEntry))) &&
    Array.isArray(value.changes) &&
    value.changes.every(isChange) &&
    typeof value.historyGap === 'boolean'
  );
}

export function parseAssetProfilerWirePayload(value: unknown): AssetProfilerWirePayload {
  if (!isAssetProfilerWirePayload(value))
    throw new Error('Unsupported or malformed asset profiler payload');
  return value;
}
