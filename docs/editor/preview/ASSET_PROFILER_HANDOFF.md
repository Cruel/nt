# Asset Profiler Handoff

## Purpose

The engine provides a telemetry sink, an editor-only profiler service with owning schema-versioned
DTOs, and a narrow Web preview transport. The editor provides the polling controller, bounded store,
and the **Asset Performance** panel. The first UI is limited to asset memory, prefetch effectiveness,
Asset wait time, actionable issues, and authoritative live asset inventory. It is observational only:
it does not change scheduling, prefetch admission, eviction, loading gates, or runtime correctness.

Preview snapshots observe the same asynchronous request/residency/lease system used by runtime
consumers. Collection, JSON serialization, native exports, and capability advertisement are compiled
only when `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=1`; ordinary player and release Web outputs contain
none of them.

The public tooling boundary consists of `noveltea::core::AssetProfilerSnapshot` and
`noveltea::core::AssetProfilerDelta`, returned by `EngineTooling::asset_profiler_snapshot()` and
`EngineTooling::asset_profiler_delta()` on the engine owner thread. Both DTOs own all data. Transport
may serialize, move, retain, aggregate, or discard them after capture without holding references to
the job executor, residency manager, request orchestrators, or recorder.

## Snapshot And Delta Contract

`AssetProfilerSnapshot` is schema version `3`. It contains a nonzero session ID, latest sequence,
session-relative capture timestamp, complete current/peak memory snapshot, cumulative user-facing
outcomes, authoritative current asset inventory, inventory revision, retained sequence-ordered
changes, earliest retained sequence, lost-change count, and `history_complete`.

`AssetProfilerDelta` carries the same session/current aggregate state plus the requested
`after_sequence`, optional replacement inventory, changes newer than the cursor, and `history_gap`.
A stale session or cursor newer than the active session is a typed failure. A cursor older than the
retained ring produces `history_gap=true` and a replacement inventory.

Retained changes form one ordered variant log:

- selected telemetry events;
- complete memory points;
- Asset wait records;
- prefetch-generation upserts;
- lightweight inventory-revision markers.

The profiler does not retain requested/coalesced/start/pin/generic cache/policy events. It retains
source-read, preparation, and owner-finalization completion/failure, terminal request failure,
eviction, reload after removal, the four prefetch outcomes, and generation-correlated occurrences of
the four defined prefetch memory-rejection diagnostics.

## Prefetch Outcomes

The four prefetch outcomes are mutually exclusive for one demand/use lifecycle:

- `PrefetchUsed`: demand acquires the first lease from an already-resident entry completed by
  prefetch. Creating or canceling a Ready request handle is not use.
- `PrefetchLate`: demand reaches an entry whose matching prefetch is queued, reading, preparing, or
  waiting for owner finalization.
- `PrefetchMiss`: demand finds neither a matching resident entry nor active prefetch work.
- `PrefetchUnused`: a completed Warm prefetch is evicted or invalidated before demand claims it.

Outcome events preserve request, job, and generation correlation wherever those identifiers exist.
Only the first Demand lease acquisition claims one completed-prefetch lifecycle; later concurrent
Demand leases do not duplicate the outcome. Eviction before that acquisition reports
`PrefetchUnused`.

## Memory Accounting And Estimates

Profiler memory values distinguish engine accounting from renderer estimates:

- source, prepared CPU, audio, temporary, and residency-managed GPU bytes are authoritative values
  owned by `AssetResidencyManager`;
- Asset RAM is the observed sum of source, prepared CPU, and audio bytes at one instant;
- its session peak is the highest observed combined value, not the sum of independent domain peaks;
- Warm/prefetched cost is reported per memory domain and compared only with that domain's resolved
  prefetch allowance;
- ordinary texture and render-target bytes come from bgfx logical resource estimates;
- Total GPU resources is ordinary textures plus render targets. Residency-managed GPU bytes are
  descriptive attribution inside that total and are not added again;
- each renderer component may be unavailable independently. Unavailability is `null`, not zero, and
  Total GPU resources is unavailable unless both components are available;
- renderer estimates are sampled immediately after renderer initialization and session replacement,
  then no more than once per second. Peaks are the highest observed samples.

Accounting and inventory revisions are coalesced into at most one complete memory point per engine
frame and unchanged points are omitted. Full snapshots still read authoritative current accounting
directly and do not depend on a pending frame-history flush.

## Profiler Service And Retention

One composition-owned `EditorAssetProfilerService` is created before the residency manager and typed
request orchestrators. Its embedded aggregate recorder and ordered change ring observe both through
the same `AssetTelemetrySink`; neither controls runtime behavior. `AssetTelemetryRecorder` remains the
small cumulative-event recorder and does not own the profiler session, inventory, memory history,
prefetch-generation history, Asset wait history, sequence cursor, or `8,192`-change ring.

- Ordinary players compile no editor profiler service and retain no editor history.
- Editor preview and authoring-test runtimes retain the newest `8,192` profiler changes.
- The ring is fixed-capacity after construction. Worker-side recording does not grow it.
- The recorder assigns timestamps inside its bounded recording critical section, preserving
  chronological retained events across worker threads.
- Overwrite increments `lost_change_count`; cumulative totals remain complete.
- Snapshot and delta capture are owner-thread-only. Recording is safe from worker and owner threads.

## Web Preview Wire Contract

The editor-only preview advertises `asset-profiler-v1` only when both exports are present:

```cpp
const char* noveltea_asset_profiler_snapshot();
const char* noveltea_asset_profiler_delta(const char* expected_session_decimal,
                                          const char* after_sequence_decimal);
```

Each returns valid JSON in one outer envelope:

```ts
type AssetProfilerExportResult =
  | { ok: true; payload: AssetProfilerWirePayload }
  | { ok: false; error: { code: string; message: string } };
```

Every C++ `uint64_t` ID, revision, sequence, timestamp, duration, byte value, cost, and counter is a
canonical unsigned-decimal JSON string. This includes zero-valued invalid IDs where the C++ field is
non-optional. Optional integer fields are a decimal string or `null`. Schema version and bounded
`prefetchAllowancePercent` remain JSON numbers. Enums cross only as explicit lowercase-kebab-case
strings; C++ ordinals are not wire values.

The full payload has exactly these top-level keys:

```text
kind, schemaVersion, sessionId, latestSequence, capturedAtNs, memory, outcomes, assets,
inventoryRevision, retainedChanges, earliestRetainedSequence, lostChangeCount, historyComplete
```

The delta payload replaces `assets`, `retainedChanges`, and `historyComplete` with exactly:

```text
afterSequence, replacementInventory, changes, historyGap
```

Nested camelCase mapping is exact:

- `AssetProfilerEntry`: `cacheKey`, `assetType`, `displayIdentity`, `state`, `requestOrigin`,
  `retentionReason`, `committedCost`, `estimatedCost`, `loadingMemoryBytes`, `jobId`,
  `prefetchGeneration`, `completedPrefetchClaimed`, `removable`, `reloadCount`, `diagnostics`.
- Cache key: `stableIdentity`, `sourceGeneration`. Residency cost: `sourceBytes`,
  `preparedCpuBytes`, `gpuBytes`, `audioBytes`, `temporaryBytes`.
- Memory snapshot: `current`, `peak`, `policy`, `assetCounts`, `accountingRevision`,
  `rendererSampledAtNs`. Current values contain `asset`, `warm`, `assetRamBytes`,
  `rendererEstimate`, `totalGpuResourceBytes`; peaks intentionally omit `warm`. Renderer estimate
  contains independently nullable `ordinaryTextureBytes` and `renderTargetBytes`. Policy contains
  `target`, `preset`, and `budget`; counts contain `inUse`, `prefetched`, `cached`, `loading`,
  `finishing`, `failed`.
- Outcome totals: `readyBeforeUse`, `loadedTooLate`, `notPrefetched`, `blockedByMemoryLimit`,
  `prefetchedButUnused`, `reloadedAfterRemoval`, `assetWaitCount`, `assetWaitTimeNs`.
- Every retained change contains `sequence`, `timestampNs`, and `kind`. Variant payloads are
  `telemetry-event/event`, `memory-point/memory`, `asset-wait/wait`,
  `prefetch-generation-upsert/generation`, or `inventory-changed/inventoryRevision`.
- Prefetch generation: `generation`, `timestampNs`, `presentationRevision`, `expectedNextCount`,
  `possibleNextCount`, `submittedEntries`, `submissionFailures`, `usedCount`, `lateCount`,
  `unusedCount`. Submission entries contain `cacheKey` and `prediction`; failures additionally carry
  one recursive `diagnostic`.
- Asset wait: `operationId`, `phase`, `presentationRevision`, `startedAtNs`, `durationNs`, `result`,
  `waitingRequests`, `diagnostics`. Participants contain `cacheKey` and `requestId`; results are
  `completed`, `failed`, or `canceled`.
- Retained telemetry: `eventKind`, `executionMode`, `cacheKey`, `jobId`, `requestId`,
  `prefetchGeneration`, `requestReason`, `jobPriority`, `memory`, `compressedBytes`,
  `uncompressedBytes`, `durationNs`, `diagnosticCode`, `evictionReason`, `memoryPolicy`.
- Diagnostic: `code`, `message`, `severity`, `sourcePath`, `jsonPointer`, recursive `causes`.

The strict TypeScript validator mirrors these DTOs as a discriminated union. It rejects unknown or
missing keys, unsupported versions, malformed decimal strings, invalid enum strings, out-of-range
bounded integers, and telemetry kinds outside the retained subset before payloads reach editor state.

The MessageChannel request, response, and acknowledgement rules are documented in
`ENGINE_PREVIEW_COMMUNICATION.md`. While the Asset Performance panel is visible, the renderer-owned
controller requests one full snapshot and then one in-flight delta at a time. The store owns the
session/cursor, rejects stale request IDs and older sequences, replaces state after session changes or
history gaps, and keeps bounded derived history for Overview, Issues, and Assets. Hidden panels stop
polling without resetting the engine session; preview replacement and teardown reset editor state.
The transport does not create a second engine-side profiler model or influence runtime scheduling,
admission, eviction, loading gates, or correctness.

## Asset Performance Panel

The Play preview exposes one workbench panel with three views:

- **Overview** shows current and peak Asset RAM, GPU-resource estimates, Warm/prefetch memory against
  resolved allowances, state counts, outcome totals, bounded memory history, and recent Asset waits.
- **Issues** derives actionable rows from authoritative diagnostics and lifecycle history, including
  failed assets, memory-limit rejections, late/missed prefetches, unused prefetches, reloads after
  removal, and Asset waits. Issue rows can navigate to the matching Assets row.
- **Assets** presents the authoritative live inventory with type/state/origin filters, locale-aware
  search and sorting, memory attribution, request/prefetch correlation, diagnostics, and bounded
  history detail. Virtualized rows preserve stable cache-key identity.

The panel remains mounted with its Play preview host while open, follows normal workbench visibility
and group ownership, and retains only editor-derived bounded state. No profiler data is persisted to
the project or user settings.

## Validation Boundary

`noveltea_asset_telemetry_tests` is the focused engine matrix. In profiler-enabled builds it parses
native full/delta JSON and verifies exact version-3 envelopes, decimal transport beyond JavaScript's
safe-integer range, explicit prediction strings, generation upserts, failed and canceled Asset waits,
replacement inventory, history-gap fields, and typed failure envelopes. It also validates collection,
memory, inventory, prefetch, wait, and concrete asset preparation behavior across inline,
cooperative, and SDL-threaded execution.

`editor/src/renderer/test/asset-profiler-protocol.test.ts` validates the matching recursive
TypeScript boundary, including malformed decimals, unsupported versions, enum ordinals, unknown
keys, out-of-range bounded integers, and rejection of non-retained telemetry.

The CMake build-policy tests verify that profiler sources are omitted when the option is disabled.
Release/editor-preview Web builds and native symbol inspection verify that ordinary outputs omit the
two exports while the editor preview contains them and advertises `asset-profiler-v1`.

`noveltea_editor_asset_profiler_stress`, built from the optimized
`linux-release-editor-profiler` preset, constructs `1,000` inventory rows and a full `8,192`-change
history containing repeated complete generation upserts, prediction-aware submission failures with
nested diagnostics, multi-participant Asset waits, memory points, telemetry outcomes, and inventory
revision markers. It enforces the full, 100-change delta, idle-delta, and serialized-size thresholds
from the implementation plan and prints raw p95 measurements for archival evidence.

`noveltea_production_asset_path_policy` separately enforces the production asset-path boundary so a
compatibility edit cannot reintroduce synchronous prepared loads, raw/path-based production audio
playback, whole-package memory expansion, or a Web VFS package copy underneath the profiler.
