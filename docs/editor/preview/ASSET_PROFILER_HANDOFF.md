# Asset Profiler Handoff

## Purpose

Phase 8 establishes the engine-side telemetry recorder and the stable data handoff required by a
future editor profiler. It deliberately does not add a profiler panel, charting dependency, polling
loop, MessageChannel command, preload IPC method, or persistence format.

The public boundary is `noveltea::core::AssetProfilerSnapshot`, returned by
`EngineTooling::asset_profiler_snapshot()` on the engine owner thread. The snapshot owns all of its
data. Editor transport code may serialize, move, retain, aggregate, or discard it after capture
without holding references to the job executor, residency manager, asset request orchestrators, or
telemetry recorder.

## Snapshot Contract

`AssetProfilerSnapshot` contains:

- `schema_version`, currently `1`;
- `captured_at`, using the same monotonic clock domain as job and asset timings;
- the copied `JobExecutorSnapshot`, including per-priority submitted/completed/failed/canceled
  totals, queue depth, active count, and maximum queue latency;
- the copied `AssetTelemetrySnapshot`, including event totals, aggregate source/preparation/finalize
  timings, compressed/uncompressed byte totals, current and high-water memory by residency domain,
  resolved memory policy, retained events, and overwritten-event count.

Retained asset events include the execution mode and, when applicable, cache key, asset request ID,
job ID, prefetch generation, request reason, job priority, memory state, stage byte totals and
duration, stable diagnostic code, exact eviction reason, and resolved memory policy.

The four prefetch outcomes are mutually exclusive for one demand/use lifecycle:

- `PrefetchUsed`: demand leases an already-resident Warm entry with matching active prefetch
  interest.
- `PrefetchLate`: demand reaches an entry whose matching prefetch is queued, reading, preparing, or
  waiting for owner finalization.
- `PrefetchMiss`: demand finds neither a matching resident entry nor active prefetch work.
- `PrefetchUnused`: a completed Warm prefetch is evicted or invalidated before demand claims it.

Outcome events preserve request, job, and generation correlation wherever those identifiers exist.

## Recorder Retention

One composition-owned `AssetTelemetryRecorder` is created before the residency manager and typed
request orchestrators. The same sink observes both; it never controls their behavior.

- Ordinary players use event capacity `0`. They retain aggregate counters, timings, current/high-water
  memory, and resolved policy without retaining detailed events.
- Editor preview and authoring-test runtimes retain the newest `8,192` detailed events.
- The ring is fixed-capacity after construction. Worker-side recording does not grow it.
- When the ring overwrites an event, `lost_event_count` increases. Aggregate totals remain complete.
- Snapshot capture is owner-thread-only. Recording is safe from worker and owner threads.

These capacities are measured policy values. A later change must be justified by memory and profiler
capture measurements and documented here and in the threading/asset plan.

## Future Transport Rules

A future editor transport should request snapshots at a bounded cadence and serialize the owning DTO
off the engine frame-critical path. It must not expose a live recorder pointer, query per-event state
through repeated IPC calls, or make telemetry availability influence scheduling, admission, eviction,
loading gates, or runtime correctness.

Transport should carry `schema_version` and reject or adapt unknown versions explicitly. The first UI
should derive views from the copied data rather than introducing a second profiler state model. Useful
initial surfaces include priority queue latency/depth, stage timing and byte throughput, domain memory
current/high-water values, budget-pressure and reload churn, and used/late/miss/unused prefetch ratios.

Snapshot cadence, serialization encoding, renderer-store retention, charting/virtualization choices,
and UI interaction design remain later editor work.

## Validation Boundary

`noveltea_asset_telemetry_tests` is the focused engine matrix. It verifies aggregate-only and bounded
ring modes, concurrent recording, lost-event accounting, immutable snapshot capture, queue latency,
memory high-water values, stage byte/timing payloads, stable pressure/failure evidence, eviction and
reload churn, concrete texture/shader/material/font/audio preparation, stored-package audio streaming,
and all four prefetch outcomes across inline, cooperative, and SDL-threaded execution.
