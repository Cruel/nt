# Asset Memory and Prefetch Profiler Implementation Plan

## Status

Complete. Phases 1-10 completed 2026-07-24 and the implementation plan is archived.

Date: 2026-07-24
Standalone ambiguity audit: completed 2026-07-24
Post-Phase 4 remaining-plan review: completed 2026-07-24; adjusted only for the finalized memory DTO
shape and a concrete permanent-documentation reconciliation item.
Post-Phase 5 remaining-plan review: completed 2026-07-24; adjusted only for the implemented
prefetch-generation upsert/wait-record wire shapes, rejection-issue normalization, failed wait-child
precedence, and representative variable-size history validation.
Post-Phase 6 remaining-plan review: completed 2026-07-24; adjusted only for the implemented paired
profiler payload/acknowledgement transport, the strict wire-to-`bigint` editor boundary, and the fact
that Phase 6 already reconciled the permanent schema-v3 Web transport documentation.
Post-Phase 7 remaining-plan review: completed 2026-07-24; adjusted only for the implemented split
between engine-derived profiler-state clearing and profiler-local control reset, including session
replacement detection across a transient preview/project detach.

This plan defines an editor-only asset profiler for the persistent Play preview. The implementation
must remain disabled in ordinary player builds unless an explicit compiler option enables it. The
plan extends the existing asynchronous asset telemetry and residency system; it must not create a
parallel asset loader, cache, scheduler, or residency model.

The plan should remain under `docs/editor/plans/` while implementation is active. After completion,
stable engine contracts belong in `docs/assets/OVERVIEW.md` and
`docs/editor/preview/ASSET_PROFILER_HANDOFF.md`; stable editor behavior belongs in the editor preview
and workbench documentation. The completed plan should then be archived under `docs/archive/plans/`.

## 0. Normative interpretation and fixed ownership

This document is intended to be sufficient when read without the prior design conversation.

- **must / must not** are required completion conditions;
- **should / should not** are the expected implementation, and a deviation requires a concrete
  repository finding recorded in this plan before implementation proceeds;
- **may** identifies deliberately optional behavior.

One composition-owned `EditorAssetProfilerService` is the profiler boundary when
`NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=1`. It must:

- implement or own the `AssetTelemetrySink` used by residency and typed request orchestration;
- own the profiler session ID, session clock, shared history sequence, bounded history, cumulative
  totals, memory points, prefetch-generation records, Asset wait records, current-inventory revision,
  and sampled renderer-resource peaks;
- be the only object used by `EngineTooling` to capture a full profiler snapshot or delta;
- remain an observer: no method on the service may make scheduling, admission, eviction, pinning,
  request, or publication decisions.

Phase 1 established the service as an engine-composition-lifetime object whose address is borrowed
by `AssetResidencyManager` and the typed request orchestrators after initialization. Later phases
must rotate profiler-session state in place on that same service object. They must not destroy and
reconstruct the service during compiled-project replacement, add a second sink, or add runtime sink
rebinding merely to implement a session boundary.

The existing `AssetTelemetryRecorder` may be reused internally or folded into this service, but the
final composition must pass exactly one nullable telemetry sink to the live asset system. Do not
create parallel recorders whose histories need to be merged after capture.

The final enabled implementation must not retain both the old 8,192-event ring and a second
8,192-change profiler ring. If `AssetTelemetryRecorder` remains as an internal aggregate helper,
configure it for aggregate-only retention and let `EditorAssetProfilerService` own the one detailed
change log.

When the compiler option is disabled, the service does not exist and the live asset system receives
`nullptr`. Profiler DTO types may remain compiled to avoid preprocessor forks in public headers and
templated asset code.

## 1. Goal

Give a game author three focused views in the editor's Play-preview bottom panel:

1. **Overview** — current and peak asset memory, memory-budget use, prefetch effectiveness, current
   asset-state counts, and asset wait time.
2. **Issues** — concise, actionable loading and prefetch problems that could delay presentation or
   indicate memory-policy churn.
3. **Assets** — an authoritative current inventory of loading, in-use, prefetched, and cached assets
   with their memory cost and current reason for residency.

The profiler exists to answer two questions:

- Are project assets using too much memory for the selected runtime policy?
- Are required assets ready before the runtime needs them?

It is not a general CPU/GPU/frame profiler. It must avoid collecting or presenting data merely
because the underlying scheduler can provide it.

## 2. Product vocabulary

Editor-facing labels must use ordinary product language. Internal engine names may remain in code,
tests, raw details, and stable diagnostic codes.

| Internal concept | Editor label |
| --- | --- |
| `ResidencyClass::Pinned` | In use |
| `ResidencyClass::Warm` | Prefetched |
| `ResidencyClass::Cold` | Cached |
| `AssetCacheState::Queued`, `Reading`, or `Preparing` | Loading |
| `AssetCacheState::WaitingForOwnerFinalization` | Finishing |
| `AssetCacheState::Failed` | Failed |
| `PrefetchUsed` | Ready before use |
| `PrefetchLate` | Loaded too late |
| `PrefetchMiss` | Not prefetched |
| prefetch rejection diagnostics | Blocked by memory limit |
| `PrefetchUnused` | Prefetched but unused |
| `ReloadedAfterEviction` | Reloaded after removal |
| mandatory-gate duration | Asset wait time |
| residency `gpu_bytes` | Asset GPU resources |
| bgfx texture/render-target estimates | Total GPU resources |
| residency `temporary_bytes` | Loading memory |

Do not label the GPU estimates as physical VRAM. On the Web preview, bgfx/WebGL can provide logical
resource estimates but cannot confirm physical placement on a discrete GPU.

## 3. Scope

### 3.1 Overview metrics

The initial Overview must show:

- **Asset RAM**, current and peak:
  - source bytes;
  - prepared CPU bytes;
  - resident audio bytes.
- **Loading memory**, current and peak, from temporary preparation reservations.
- **Asset GPU resources**, current and peak, from residency-managed GPU assets.
- **Total GPU resources**, current and peak, from bgfx ordinary-texture and render-target estimates.
- **Memory budget used** for source, prepared CPU, GPU, audio, temporary memory, and the prefetch
  allowance. Asset RAM is a combined readability total; because the policy has separate RAM-domain
  budgets, the UI must show the individual domain percentages rather than invent one combined Asset
  RAM budget percentage.
- Current asset counts by user-facing state:
  - In use;
  - Prefetched;
  - Cached;
  - Loading;
  - Finishing;
  - Failed.
- Prefetch outcome counts:
  - Ready before use;
  - Loaded too late;
  - Not prefetched;
  - Blocked by memory limit;
  - Prefetched but unused;
  - Reloaded after removal.
- **Ready before use**:

  ```text
  Ready before use / (Ready before use + Loaded too late + Not prefetched)
  ```

  This percentage describes successful prefetch coverage of classified asset-demand lifecycles. It
  must not be labeled as a generic cache-hit rate, because demand can also hit an asset retained from
  an earlier demand load without participating in a new prefetch lifecycle. When the denominator is
  zero, display an unavailable value such as `—`, not `0%` or `100%`.
- **Asset waits**, count and cumulative **Asset wait time**.

Current-state counts are point-in-time values. Prefetch outcome counts, reload count, Asset wait
count, and Asset wait time are cumulative for the current profiler session and reset only at the
session boundary defined in Section 7.1.

The Overview must not initially show scheduler submission totals, maximum queue latency, cumulative
decode time, cumulative finalization time, or generic cache-hit counts. Existing telemetry may retain
those values for tests and advanced details, but the initial UI does not need them.

### 3.2 Issues

The initial Issues view must prioritize only conditions with a direct optimization or correctness
action:

- an asset wait occurred;
- a contributing asset was not prefetched;
- a contributing asset was still loading when needed;
- a prefetch was rejected by a memory limit;
- an asset was removed and then loaded again;
- an asset load failed.

One asset wait is one issue, even when several assets contributed. The issue expands to show the
participating assets and their individual prefetch classifications. This is the only required
incident grouping in the initial implementation.

Do not create a separate issue for every source-read, preparation, finalization, pin, or cache event.
Stage durations may appear in an issue's expanded technical details when they are already available.

`Prefetched but unused` is an Overview efficiency count in the first release. It does not become an
Issue by default because an unused adjacent prediction is often normal. It is not an Assets filter:
the outcome is emitted only after the prefetched resident has been removed, so no authoritative
current inventory row remains to filter. A later historical view or threshold-based issue may be
added only after measured editor use demonstrates that it is useful.

### 3.3 Assets

The Assets view must be an authoritative snapshot, not a reconstruction from retained telemetry
events. Each row must include, when applicable:

- user-facing asset type;
- display identity derived from the typed request or stable cache identity;
- source generation;
- current state;
- current residency state;
- asset RAM cost;
- loading-memory reservation;
- asset GPU-resource cost;
- request origin: Startup, Demand, Expected next, Possible next, or Prefetched when no structured
  prediction bucket is available;
- current reason for retention, using the precedence defined in Section 7.4;
- whether a completed prefetch has been claimed by demand;
- reload count;
- whether it is currently removable by residency policy;
- current diagnostics for failed entries.

The initial navigation contract is best-effort navigation from typed identity to an Asset, Material,
Character font reference, or other directly resolvable editor record. Exact navigation to the
Dialogue line, Room transition, script operation, or field that caused a request is not required by
this plan.

## 4. Explicit non-goals

The first implementation must not add:

- graphs or a charting dependency;
- persisted cross-session profiler runs;
- physical VRAM measurement;
- whole-browser or whole-Electron-process memory as a primary metric;
- per-frame asset polling or per-frame history points;
- frame-time or GPU-timing attribution;
- a general job scheduler profiler;
- a raw event-log-first UI;
- a dependency-tree explorer;
- automatic changes to memory policy, prefetch selection, eviction, or scheduling;
- production-player UI, IPC, logging, or telemetry upload;
- exact authoring-operation provenance across every asset request.
- a manual profiler-session reset command or button.

Profiler availability must never change asset behavior. The observer remains read-only.

## 5. Current code assessment and scope adjustments

### 5.1 Readily available data

The following data already exists in production code and requires mainly exposure, serialization, or
editor presentation:

- current and high-water residency accounting by source, prepared CPU, GPU, audio, and temporary
  domains;
- resolved target memory policy and prefetch allowance;
- used, late, missed, and unused prefetch events;
- exact eviction reasons and reload-after-eviction events;
- source-read, preparation, and owner-finalization durations and byte counts;
- budget-pressure and stable failure diagnostic codes;
- request, job, cache-key, source-generation, and prefetch-generation correlation;
- current typed orchestrator entry state, estimated preparation cost, prefetch provenance, and
  diagnostics;
- current residency records, committed cost, pin count, last-use order, and derived
  Pinned/Warm/Cold classification;
- structured direct-next and adjacent-alternative buckets;
- a `PrefetchSubmissionReport` with generation, submitted keys, counts, and failures;
- an immutable `EngineTooling::asset_profiler_snapshot()` handoff;
- a proven request/response MessageChannel path for the existing runtime debug snapshot;
- an existing bottom-panel registry and persistent Play preview host.

### 5.2 Missing but bounded additions

The following additions are required but do not need a foundational refactor:

- authoritative owner-thread inventory DTOs for residency and typed orchestrator entries;
- a retained current prefetch-generation record instead of discarding the submission report;
- an asset-wait record emitted by the existing mandatory asset gate;
- sequence numbers and session-relative timestamps for incremental event delivery;
- a lightweight accounting-change notification used to update exact session peaks and coalesced
  memory history;
- bgfx texture/render-target estimates and tracked peaks;
- C++ JSON serialization and a Web preview export;
- typed preview protocol validators and a small editor-side profiler store;
- the three bottom-panel views.

### 5.3 Existing behavior that must be corrected for memory accuracy

The current telemetry snapshot updates its memory aggregates when another telemetry event happens.
Some successful Warm-prefetch admissions and temporary reservation changes do not necessarily emit a
post-mutation event. Therefore, the editor profiler must not assume the current event payload is an
authoritative memory sample.

Implementation must do all of the following:

1. Capture current accounting directly from `AssetResidencyManager` for every full snapshot/delta.
2. Notify the enabled profiler service synchronously after each accounting mutation. The notification
   updates exact profiler-session per-domain and combined peaks plus an accounting revision, but does
   not itself append a retained history record.
3. Coalesce revision changes into at most one retained memory point per engine frame so future step
   graphs can be reconstructed without storing every internal mutation.

The residency manager's existing process-lifetime high-water fields must not be shown as
profiler-session peaks after compiled-project replacement. The service initializes session peaks from
current accounting at the session boundary and updates them through every accounting-change
notification, including transient values that may rise and fall within one frame.

### 5.4 Adjustments made to avoid disproportionate refactoring

The reviewed feature set is intentionally narrowed in these areas:

- **No process-wide RAM metric initially.** WebAssembly committed heap, browser memory attribution,
  JavaScript heap, allocator fragmentation, and Electron process memory are not comparable to native
  player memory and are not directly actionable for asset optimization. The initial RAM metric is
  explicitly **Asset RAM** plus separate **Loading memory**.
- **No physical-VRAM claim.** The panel uses logical bgfx GPU-resource estimates and residency costs.
- **No exact Dialogue/Room/field cause.** Propagating an authoring-origin object through every
  dependency collector, runtime operation, request handle, coalesced request, lease, and telemetry
  event would be a substantial cross-cutting refactor. The first release uses asset identity,
  mandatory-wait membership, prefetch bucket, and best-effort direct record navigation.
- **No frame-hitch attribution.** Determining whether owner-thread finalization caused a rendered
  frame spike requires a broader frame profiler and possibly GPU timing. Asset wait time is measured
  precisely; stage times remain details.
- **No attempt to preprocess every telemetry call site out of the engine.** Existing residency and
  orchestrator telemetry hooks already accept a nullable observer. Production composition should
  pass `nullptr` when the editor profiler is disabled. Keeping the small null checks avoids a large
  template and preprocessor rewrite while eliminating recorder allocation, locking, history,
  serialization, transport, and sampling overhead.

These deferred items are the only parts of the discussed feature set that would require a large
refactor. None blocks the focused memory and prefetch profiler.

## 6. Compiler and build isolation

Add one CMake option:

```cmake
option(
    NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    "Compile the editor-only asset memory and prefetch profiler"
    OFF
)
```

The corresponding numeric compiler definition must be
`NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=0|1`.

### 6.1 Disabled behavior

When the option is `OFF`:

- ordinary engine/player composition must not construct `EditorAssetProfilerService` or
  `AssetTelemetryRecorder`;
- residency and typed request orchestration receive a null telemetry sink;
- no editor profiler history service is created;
- no inventory snapshots, asset-wait history, prefetch-generation history, or bgfx profiler sampling
  is performed;
- no asset-profiler C export is linked from the Web sandbox;
- `web/widget.html` must not advertise the asset-profiler capability;
- ordinary Web, desktop, Android, and packaged-player artifacts remain unchanged except for the
  existing nullable observer branches;
- requesting a profiler snapshot through a non-profiler build must fail clearly rather than return a
  misleading empty success.

The existing telemetry types and nullable observer seams may remain compiled because removing them
would require broad changes to the asset state machine. Release link-time optimization and static
library dead stripping may discard unused recorder implementation. The acceptance criterion is no
runtime recorder/history/transport work and no player-visible/exported profiler surface.

The new `EditorAssetProfilerService`, change-log/history implementation, profiler JSON serializer,
and renderer-sampling adapter sources must be conditionally added to `noveltea_engine` only when the
option is `ON`. Stable DTO declarations and the `EngineTooling` unavailable-result declarations may
remain in public headers in every build. Limit `#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER` branching
to build composition, profiler tooling implementation, and Web export wiring; do not spread it
through ordinary asset state transitions.

Phase 1 also confirmed that the repository's production-file classification is the source list used
to assemble `noveltea_engine`. Every later production profiler file must therefore still be added to
`cmake/NovelTeaModuleFileClassification.cmake`. A profiler-only implementation file or private header
must then be removed from the unconditional `NOVELTEA_ENGINE_FILES` list and re-added under the
compiler option, following the Phase 1 service pattern. Omitting a file from module classification is
not a permitted build-isolation mechanism. Profiler-only test sources must likewise be attached only
in profiler-enabled test builds, and the build-policy test must be extended as new conditional files
are added.

Profiler-only inventory/introspection adapters must also be compiled or template-instantiated only in
enabled engine builds. They should be private implementation/friend boundaries rather than new
general-purpose public asset APIs. The underlying state needed for runtime behavior remains unchanged
in disabled builds.

### 6.2 Enabled behavior

When the option is `ON`:

- `EngineToolingConfig::preview_widget=true` composition constructs `EditorAssetProfilerService` and
  passes it as the one asset telemetry sink;
- the Web sandbox exports the profiler snapshot/delta function;
- the widget advertises an `asset-profiler-v1` capability;
- native engine tests construct the service directly and do not require ordinary sandbox
  composition to activate it;
- an enabled build with `preview_widget=false` does not construct the service.

Do not couple this option to `NOVELTEA_ENABLE_DEVTOOLS`. The editor preview currently uses an
optimized Web build without the Dear ImGui overlay.

### 6.3 Dedicated presets

Add a dedicated `web-editor-preview` configure/build preset inheriting the optimized Web settings but
using its own build directory and setting:

```text
NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=ON
NOVELTEA_BUILD_SANDBOX=ON
NOVELTEA_BUILD_PLAYER=OFF
NOVELTEA_ENABLE_DEVTOOLS=OFF
```

`editor/scripts/build-engine-preview.mjs` must use this preset. It must not mutate the ordinary
`web-release` build directory into a profiler-enabled artifact. The editor preset/build script must
also select `web/widget.html` as its shell; ordinary Web player presets keep their existing player
shell.

Add the dedicated `linux-debug-editor-profiler` preset, inheriting `linux-debug`, using its own build
directory, and setting `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=ON`. Engine-side profiler tests run in
that preset. Do not substitute an undocumented one-off configure command.

## 7. Engine profiler contracts

### 7.1 Session and sequence identity

Detailed history is scoped to one profiler session. Add:

```cpp
struct AssetProfilerSessionId {
    std::uint64_t value = 0;
};

struct AssetProfilerSequence {
    std::uint64_t value = 0;
};
```

Session IDs must be nonzero and process-unique. Sequence zero means "no records accepted yet"; the
first retained change receives sequence one. Every retained event, memory point, Asset wait,
prefetch-generation upsert, and inventory-change marker receives the next value in one shared
session sequence domain. The allocator must be safe for worker-thread telemetry recording and
owner-thread profiler updates.

The initial session begins when the profiler service is constructed. At a compiled-project
replacement boundary, the same service object must rotate in place to a new session after the
previous source generation is invalidated and project-owned published/candidate leases are released,
but before typed requests for the replacement project are submitted. Do not delay the boundary or
force eviction merely for profiling: an old resource that legitimately remains pinned by an active
runtime owner is included in new-session current memory until that owner releases it. Preview
recreation constructs a new service and therefore creates a new session. Ordinary runtime Start,
Stop, Reset, navigation, fast-forward, and debug commands do not reset profiler history.

The existing compiled-project load is transactional and can roll back after the live project
namespace has already advanced its source generation. A candidate rejected before that first live
namespace replacement does not rotate the profiler session. If a later failure restores the prior
project through another live namespace replacement, rotate again after the failed candidate's
project-owned resources are detached and the restored source generation is established, but before
restored-project typed requests are submitted. Never resurrect the pre-attempt profiler session or
its history after a source-generation replacement has occurred.

Starting a new session clears retained history, cumulative outcome and Asset wait totals, generation
records, inventory revision state, memory peaks, and sampled renderer peaks. Its initial current and
peak values are the authoritative values observed immediately after the replacement boundary,
including any still-live old-generation resources described above.

Transport timestamps must be integer nanoseconds from profiler-session start. Continue using
`steady_clock` internally for duration correctness; do not serialize implementation-defined
`steady_clock::time_point` values directly.

The service owns one ordered, fixed-capacity change log of **8,192 profiler changes**. This replaces
the notion of independently cursoring several event rings. Low-level telemetry may still update
cumulative aggregates without being retained as a change, but every record transported as history
must be in this one sequence-ordered log. The retained event subset is fixed in Section 7.8.

### 7.2 Full snapshot and incremental delta

Bump the engine profiler schema from version 2 to version 3. The service exposes two typed
`EngineTooling` operations in every build:

```cpp
core::Result<AssetProfilerSnapshot, core::Diagnostic>
asset_profiler_snapshot(const Engine& engine);

core::Result<AssetProfilerDelta, core::Diagnostic>
asset_profiler_delta(const Engine& engine, AssetProfilerSessionId expected_session,
                     AssetProfilerSequence after_sequence);
```

When the feature is disabled or the enabled engine was not initialized as a preview widget, these
operations fail with stable code `assets.editor_profiler_unavailable`; they must not return an empty
successful payload.

The owning full snapshot has the final version-3 containers even before later phases populate all of
them:

```cpp
struct AssetProfilerSnapshot {
    std::uint32_t schema_version;
    AssetProfilerSessionId session_id;
    AssetProfilerSequence latest_sequence;
    std::uint64_t captured_at_ns;

    AssetProfilerMemorySnapshot memory;
    AssetProfilerOutcomeTotals outcomes;
    std::vector<AssetProfilerEntry> assets;
    std::uint64_t inventory_revision;
    std::vector<AssetProfilerChange> retained_changes;
    AssetProfilerSequence earliest_retained_sequence;
    std::uint64_t lost_change_count;
    bool history_complete;
};
```

`AssetProfilerChange` is a versioned tagged union. By the end of this plan it can contain a retained
asset telemetry event, memory point, Asset wait record, prefetch-generation upsert, or lightweight
inventory-changed marker. Every variant carries its shared sequence and session-relative timestamp.

The incremental form is:

```cpp
struct AssetProfilerDelta {
    std::uint32_t schema_version;
    AssetProfilerSessionId session_id;
    AssetProfilerSequence after_sequence;
    AssetProfilerSequence latest_sequence;
    std::uint64_t captured_at_ns;

    AssetProfilerMemorySnapshot memory;
    AssetProfilerOutcomeTotals outcomes;
    std::optional<std::vector<AssetProfilerEntry>> replacement_inventory;
    std::uint64_t inventory_revision;
    std::vector<AssetProfilerChange> changes;
    AssetProfilerSequence earliest_retained_sequence;
    std::uint64_t lost_change_count;
    bool history_gap;
};
```

The first editor request retrieves a full snapshot. Later requests pass the latest accepted sequence
and retrieve a delta. Memory and outcome fields in both forms are the **latest cumulative/current
values**, not increments to add. `changes` contains only retained records with sequence greater than
`after_sequence`, in ascending sequence order.

Inventory is current state, not a historical graph stream. When its revision changed after the
cursor, the delta contains one authoritative replacement inventory representing capture time; it
does not contain every intermediate full inventory. A lightweight inventory-changed marker occupies
the shared sequence domain so the service can determine whether replacement is required.

If `expected_session` does not equal the active session, return
`assets.editor_profiler_session_mismatch`; the editor must request a new full snapshot. If
`after_sequence` is greater than the service's latest sequence, return a typed
`assets.editor_profiler_cursor_invalid` failure. If the cursor is older than data overwritten from
the change log, return `history_gap=true`, current cumulative fields, the latest replacement
inventory, and all currently retained changes in sequence order. The editor then replaces its
engine-derived history window and marks that session history incomplete; it must not merge across the
gap or claim complete graphs.

Precisely, a gap exists when at least one change has been overwritten and the requested next sequence
would be lower than `earliest_retained_sequence`. A cursor equal to
`earliest_retained_sequence - 1` is not a gap because the response can supply every change the editor
has not yet accepted.

A full snapshot sets `history_complete=false` whenever any change was overwritten before capture.
`earliest_retained_sequence` is zero when no change is retained. A normal delta has
`history_gap=false`. A full snapshot followed by gap-free deltas must reconstruct the same current
inventory, cumulative totals, and retained ordered changes as a later full snapshot at the same
capture boundary.

### 7.3 Memory snapshot

Phase 4 finalized the public memory contract in a nested current/peak form. Later serialization and
editor work must consume this implemented shape rather than recreating the earlier flat draft:

```cpp
struct AssetProfilerRendererEstimate {
    std::optional<std::uint64_t> ordinary_texture_bytes;
    std::optional<std::uint64_t> render_target_bytes;

    std::optional<std::uint64_t> total_bytes() const noexcept;
};

struct AssetProfilerMemoryValues {
    assets::ResidencyCost asset;
    assets::ResidencyCost warm;
    std::uint64_t asset_ram_bytes = 0;
    AssetProfilerRendererEstimate renderer_estimate;
    std::optional<std::uint64_t> total_gpu_resource_bytes;
};

struct AssetProfilerMemoryPeaks {
    assets::ResidencyCost asset;
    std::uint64_t asset_ram_bytes = 0;
    AssetProfilerRendererEstimate renderer_estimate;
    std::optional<std::uint64_t> total_gpu_resource_bytes;
};

struct AssetProfilerStateCounts {
    std::uint64_t in_use = 0;
    std::uint64_t prefetched = 0;
    std::uint64_t cached = 0;
    std::uint64_t loading = 0;
    std::uint64_t finishing = 0;
    std::uint64_t failed = 0;
};

struct AssetProfilerMemorySnapshot {
    AssetProfilerMemoryValues current;
    AssetProfilerMemoryPeaks peak;
    assets::ResolvedAssetMemoryPolicy policy;
    AssetProfilerStateCounts asset_counts;
    std::uint64_t accounting_revision = 0;
    std::optional<std::uint64_t> renderer_sampled_at_ns;
};

struct AssetProfilerMemoryPoint {
    AssetProfilerMemoryValues values;
    AssetProfilerStateCounts asset_counts;
};
```

`current.asset_ram_bytes` is the concurrent sum of source, prepared CPU, and audio residency.
`peak.asset_ram_bytes` must be tracked from actual accounting-change points. Do not calculate it by
adding the three independent per-domain high-water values, because those peaks may have occurred at
different times.

`current.asset` comes directly from residency at capture. `peak.asset` is the profiler service's
session-scoped per-domain peak, not the residency manager's older process-lifetime high-water
snapshot. The synchronous accounting-change notification updates these session peaks before any
same-frame release can hide a transient maximum. `accounting_revision` is session-scoped capture
metadata used to coalesce authoritative accounting changes; when transported, it follows the same
canonical unsigned-decimal rule as other `std::uint64_t` values.

`current.warm` is the current Warm-residency cost by source, prepared-CPU, GPU, and audio domains; its
temporary field is always zero. The UI compares each Warm domain to that domain's
allowance, calculated as `domain_budget * prefetch_allowance_percent / 100`. Do not invent one
combined prefetch-allowance percentage. Prefetch preparation uses the ordinary temporary-memory
budget and is not part of Warm residency.

`current.total_gpu_resource_bytes` and `peak.total_gpu_resource_bytes` use complete observed sums of
the corresponding ordinary-texture and render-target estimates. Do not add residency `gpu_bytes` to
that sum because residency-managed textures are already included in bgfx's ordinary-texture
estimate. The UI may show Asset GPU resources as a subset and Total GPU resources as the broader
renderer estimate. If either current component is unavailable, the current total is unavailable; do
not present a partial component as the total. Component peaks remain independently observed, while
the total peak is the highest sampled complete total and must not be reconstructed by summing the two
independent component peaks.

If bgfx reports an unavailable or negative value, keep that field `null`/unavailable rather than
converting it to zero or a huge unsigned number. Renderer peaks are the highest **observed sampled
estimates**, not a claim that every transient allocation was measured; the Overview tooltip must use
that wording.

Memory history points carry the complete current-value tuple and current exclusive state counts, but
not policy, peaks, accounting revision, or sample time. Full snapshots and deltas carry those latest
snapshot fields separately.

Keep bgfx out of core profiler contracts. Add a narrow renderer-facing boundary equivalent to:

```cpp
struct RendererResourceMemoryEstimate {
    std::optional<std::uint64_t> texture_bytes;
    std::optional<std::uint64_t> render_target_bytes;
};

class RendererResourceMemoryProvider {
public:
    virtual ~RendererResourceMemoryProvider() = default;
    virtual RendererResourceMemoryEstimate sample_on_owner() const noexcept = 0;
};
```

The production adapter reads `bgfx::getStats()` through the renderer module. The profiler service
depends only on this interface. Engine tests inject a fake provider; core profiler headers must not
include bgfx headers or require renderer initialization.

### 7.4 Authoritative inventory

Add read-only owner-thread introspection to the existing owners:

- `AssetResidencyManager` returns current resident records with key, cost, pin count,
  classification, and last-use order.
- each `AssetRequestOrchestrator<T>` returns current entries with cache state, job identity,
  priority, estimated cost, live consumer/ticket state, prefetch provenance, failure diagnostics,
  and reload count;
- `AssetManager` combines the five typed snapshots and joins them with residency records.

The combined DTO is semantically equivalent to:

```cpp
enum class AssetProfilerAssetType : std::uint8_t {
    Image,
    Audio,
    Font,
    Shader,
    Material,
};

enum class AssetProfilerState : std::uint8_t {
    Loading,
    Finishing,
    InUse,
    Prefetched,
    Cached,
    Failed,
};

enum class AssetProfilerRequestOrigin : std::uint8_t {
    Startup,
    Demand,
    ExpectedNext,
    PossibleNext,
    Prefetched,
};

enum class AssetProfilerRetentionReason : std::uint8_t {
    RequiredNow,
    ExpectedNext,
    PossibleNext,
    RetainedInCache,
    Startup,
    Demand,
    Prefetched,
};

struct AssetProfilerEntry {
    AssetCacheKey cache_key;
    AssetProfilerAssetType asset_type;
    std::string display_identity;
    AssetProfilerState state;
    AssetProfilerRequestOrigin request_origin;
    AssetProfilerRetentionReason retention_reason;
    std::optional<ResidencyCost> committed_cost;
    std::optional<ResidencyCost> estimated_cost;
    std::uint64_t loading_memory_bytes = 0;
    std::optional<jobs::JobId> job_id;
    std::optional<PrefetchGenerationId> prefetch_generation;
    bool completed_prefetch_claimed = false;
    bool removable = false;
    std::uint64_t reload_count = 0;
    core::Diagnostics diagnostics;
};
```

The implementation may include raw cache state/priority in technical details, but it must not replace
the normalized enums above with UI inference from unrelated low-level fields.

The profiler adapter, not the scheduler or residency policy, assigns the user-facing asset type and
display identity. The live asset system must not depend on profiler DTOs.

The combined inventory is the union of typed orchestrator entries and residency records, with one row
per `(typed asset domain, AssetCacheKey)`. Use these user-facing type labels:

- `TextureAsset` -> Image;
- `AudioAsset` -> Audio;
- `FontAsset` -> Font;
- `ShaderProgramAsset` -> Shader;
- `MaterialAsset` -> Material.

Use path for Image and Audio identity, alias/style for Font, resolved program key for Shader, and
material ID for Material. The stable row ID is the typed domain plus the complete cache key,
including source generation.

Per-row memory columns use these formulas:

- Asset RAM = `source_bytes + prepared_cpu_bytes + audio_bytes`;
- Loading memory = `temporary_bytes`;
- Asset GPU resources = `gpu_bytes`.

Resident rows show committed residency cost. Loading/Finishing rows show the current preparation
reservation for Loading memory and may show the orchestrator's estimated eventual committed cost for
Asset RAM/GPU; estimated values must be marked as estimates in the row details and must not be added
to Overview's current committed totals. Failed rows show the last attempted estimate only in
technical details.

Rows use this exclusive state precedence:

1. Failed, when the latest nonresident preparation attempt is terminally failed;
2. Finishing, while waiting for owner-thread finalization;
3. Loading, while queued, reading, preparing, or deferred for a preparation reservation;
4. In use, when resident with one or more pins;
5. Prefetched, when resident Warm with no pins;
6. Cached, when resident Cold with no pins.

For an active worker job, introspection must read `active_job_state` with acquire semantics and use
that value for Loading/Finishing normalization rather than reporting the owner's older Queued state.
All joining and DTO construction still occurs on the owner thread.

Canceled nonresident entries with no live consumer, prefetch ticket, preparation reservation, or
diagnostic that requires display are omitted. Failed entries remain until retry, source-generation
retirement, or session replacement. Resident records must remain visible even if a corresponding
orchestrator entry has already retired.

On source-generation replacement, retire nonresident entries from the old generation. An
old-generation row remains only while an authoritative residency record or in-flight retirement still
exists; this is live memory, not a stale row. Remove it when destruction completes.

The row's request origin is the request that caused the current preparation/residency lifecycle:
Startup, Demand, Expected next, Possible next, or Prefetched when no structured prediction bucket is
known. The current **Why loaded** label uses this precedence:

1. In use -> Required now;
2. Warm with an active direct-next interest -> Expected next;
3. Warm with only active adjacent interest -> Possible next;
4. Cold -> Retained in cache;
5. nonresident Loading/Finishing/Failed -> its request origin.

When both prediction buckets refer to the same key, Expected next wins. Phase 3 may expose generic
Prefetch origin until Phase 5 adds bucket-aware generation data; Phase 5 must then complete the final
Expected next/Possible next mapping without changing row identity.

`removable=true` means a resident has zero pins and is eligible for policy eviction; both Prefetched
and Cached rows can therefore be removable. In-flight and failed rows are not labeled removable.

`reload_count` increments only when an asset successfully becomes resident after a prior policy
eviction in the same source generation. Source-generation invalidation, project replacement,
explicit shutdown, a new request that has not reached residency, or a failed retry does not increment
it. `Reloaded after removal` is derived from `reload_count > 0`; do not carry a second ambiguous
`ever_evicted` display field. If the existing event is currently emitted before successful admission,
move its profiler emission to the successful residency transition without changing load behavior.

An inventory revision increments whenever a row is added, removed, or changes a field represented in
the wire DTO. The first implementation must send one authoritative replacement inventory when that
revision changed after the editor cursor. It must not retain or transmit every intermediate full
inventory as history.

The service maintains an `inventory_dirty` flag. Receiving an ordinary asset telemetry event with a
cache key may conservatively set the flag even when the normalized row ultimately does not change.
Because `attach_prefetch_interest_on_owner()` and `release_prefetch_interest_on_owner()` can change
Cold/Warm classification without an existing event, those two successful mutations must call the
same sink's lightweight `record_inventory_maybe_changed()` operation. Do not add a second observer.

At the owner-thread end-of-frame flush, and immediately before any full/delta capture, rebuild the
inventory only when dirty and compare it with the previously retained canonical DTO. Increment
inventory revision and append one inventory-changed marker only when the canonical DTO actually
differs. This permits conservative dirty marking without redundant inventory transport.

Do not reconstruct current state from the 8,192-event ring.

### 7.5 Prefetch-generation records

Extend `PrefetchSubmissionReport` so submitted keys retain their source bucket:

```cpp
enum class PrefetchPredictionKind : std::uint8_t {
    ExpectedNext,
    PossibleNext,
};

struct PrefetchSubmissionEntry {
    AssetCacheKey cache_key;
    PrefetchPredictionKind prediction;
};
```

Each generation is keyed by generation ID and represented in the change log as an upsert. The latest
upsert replaces the editor's prior copy of that generation. Each record includes:

- generation ID;
- session timestamp;
- presentation revision when available;
- expected-next count;
- possible-next count;
- submitted entries;
- submission failures;
- later used/late/unused outcome counts associated with that generation.

The expected-next and possible-next counts are the unique descriptors in the collector buckets after
the collector's cross-bucket precedence/deduplication and before ticket submission. `submitted_entries`
contains only successful ticket submissions. Every failed submission appears once in
`submission_failures` with its cache key, prediction kind, and stable diagnostic. Therefore:

```text
expected-next count + possible-next count
  = successful submitted entries + submission failures
```

for that generation. Do not count current-mandatory descriptors in a prefetch generation.

Do not add speculative "already resident" or "deduplicated" metrics in this phase. The current
planner report does not distinguish them authoritatively, and they are not required by the initial
UI.

`MandatoryAssetGate::commit_candidate_on_owner()` currently discards the submission report. Under
the profiler feature, it must pass the report to the profiler observer after successful generation
replacement. The planner remains behaviorally independent from the observer.

The service also retains the active generation's key-to-prediction mapping for current inventory
labels. When generation replacement releases old tickets, the old mapping ceases to describe current
Warm interests but remains in historical generation records. A Warm asset lacking a structured
bucket mapping uses the user-facing request origin **Prefetched** rather than guessing Expected next
or Possible next.

The cumulative session totals DTO is:

```cpp
struct AssetProfilerOutcomeTotals {
    std::uint64_t ready_before_use = 0;
    std::uint64_t loaded_too_late = 0;
    std::uint64_t not_prefetched = 0;
    std::uint64_t blocked_by_memory_limit = 0;
    std::uint64_t prefetched_but_unused = 0;
    std::uint64_t reloaded_after_removal = 0;
    std::uint64_t asset_wait_count = 0;
    std::uint64_t asset_wait_time_ns = 0;
};
```

These fields are cumulative latest values in full snapshots and deltas. The editor never derives
session totals by recounting a possibly truncated retained change window.

Prefetch outcome totals use one classification per typed asset load/residency lifecycle:

- **Ready before use**: a completed prefetch is claimed by the first Demand lease;
- **Loaded too late**: the first Demand request arrives while matching prefetch work is still active;
- **Not prefetched**: the first Demand request starts or joins missing work with no matching active or
  completed prefetch;
- later Demand consumers coalescing onto the same lifecycle and later cache hits on the same resident
  do not add another classification;
- eviction, invalidation, or a new source generation ends the lifecycle and permits a later load to
  be classified independently.

Startup requests do not enter this denominator. `PrefetchUnused` remains a separate outcome when a
completed prefetch is removed before Demand claims it.

**Blocked by memory limit** increments once for a rejected prefetch attempt identified by one of the
stable diagnostics `assets.prefetch_allowance_exceeded`,
`assets.prefetch_preparation_rejected`, `assets.prefetch_preparation_resize_rejected`, or
`assets.prefetch_residency_rejected`. Other mandatory over-budget, deferred-preparation, or generic
submission failures do not increment this metric.

`assets.prefetch_allowance_exceeded` occurs before ticket creation and is counted from the
generation's bucket-aware `PrefetchSubmissionFailure`. The other three occur after ticket creation;
their profiler-facing rejection record is emitted by the typed orchestrator when it handles the
`RejectedPrefetch` result, because that owner can attach the cache key and active ticket's generation.
Do not count both a correlated record/report failure and the lower-level residency `BudgetPressure`
observation. The cumulative metric and Issues view consume only the one generation-correlated
occurrence.

### 7.6 Asset wait records

An asset wait occurs when a mandatory request group remains pending after its initial owner-thread
poll. Do not record a zero-duration wait when every mandatory request is already Ready.

Add a bounded record:

```cpp
enum class AssetWaitResult : std::uint8_t {
    Completed,
    Failed,
    Canceled,
};

struct AssetWaitParticipant {
    AssetCacheKey cache_key;
    AssetRequestId request_id;
};

struct AssetWaitRecord {
    core::LoadingOperationId operation;
    core::LoadingPhase phase;
    std::optional<core::PresentationSnapshotRevision> presentation_revision;
    std::uint64_t started_at_ns;
    std::uint64_t duration_ns;
    AssetWaitResult result;
    std::vector<AssetWaitParticipant> waiting_requests;
    core::Diagnostics diagnostics;
};
```

`waiting_requests` contains requests that were not Ready after the first poll, not every asset in the
mandatory set. Preserve the request ID from each handle so issue derivation can distinguish repeated
attempts for the same cache key. The record's start time is the mandatory group's existing
`started_at`, so the duration includes request submission and the initial poll. If submission fails
synchronously before the group can remain Pending, emit the existing load failure but do not create
a zero-duration Asset wait.

The service keeps active waits in an owner-thread map keyed by loading-operation ID. An active wait is
not appended to retained history and does not enter cumulative Overview totals until it closes. The
current Assets view still shows the participating Loading/Finishing rows while the wait is active.
This plan does not require a live-updating Asset wait issue.

The mandatory gate supplies the optional presentation revision. Generic startup groups may leave it
absent but must preserve their `LoadingPhase`. Each retry receives the new loading-operation ID
already allocated by `begin_on_owner()` and is treated as a new attempt: close the failed prior wait,
then open a new wait only if the retried group remains Pending after its initial poll.

Completion, failure, cancellation, rollback, project replacement, and engine shutdown must close an
active record exactly once. A Canceled record is retained for diagnostics, but Overview Asset wait
count and cumulative Asset wait time include only Completed and Failed records; cancellation during
reset, replacement, or shutdown must not inflate the player-facing totals.

The Overview derives:

- asset-wait count;
- cumulative asset wait time.

The Issues view joins each wait with prefetch late/miss and terminal failure events by cache key,
request ID where available, and the wait's time range. Because `waiting_requests` excludes assets that
were already Ready on the initial poll, a wait child can be Loaded too late, Not prefetched, or Load
failed; it cannot be Ready before use. A prior generation's memory rejection may be shown in the
child's technical details when generation/key correlation proves it is the same attempted prefetch,
but the rejection remains its own Issue record. No overlay-visibility field is needed.

### 7.7 Minimal new event reporting

Do not add an event for every profiler display field. Add only events needed for an accurate
event-driven history:

- synchronously notify the profiler service whenever committed or temporary accounting changes so it
  updates session peaks and increments its accounting revision;
- increment the inventory revision whenever Section 7.4 requires replacement;
- append the existing relevant prefetch, failure, eviction, and reload events retained by Section
  7.8;
- append one final Asset wait record when an attempt closes;
- append a prefetch-generation upsert when submission or an attributed outcome changes the record.

Implement the accounting notification through the existing one-sink observer seam with a semantic
operation equivalent to `AssetTelemetrySink::record_accounting_change(current)`. It is not an
`AssetTelemetryEventKind`, does not receive a shared history sequence, and does not enter the change
log directly. In the editor service it also marks inventory dirty because a per-row preparation
reservation may have changed. Test sinks that do not care about profiler peaks may implement it as a
no-op. Do not add a second profiler pointer to `AssetResidencyManager` beside its telemetry sink.

The same sink must expose a semantic operation equivalent to
`record_inventory_maybe_changed()` as a no-payload dirty notification for the residency-interest
mutations described in Section 7.4. It also does not enter history directly.

The profiler service checks both accounting revision and inventory revision at one owner-thread
end-of-frame hook. When either changed, it reads authoritative accounting and current exclusive
inventory counts and appends at most one memory point for that frame. A renderer-sampling tick may
also append a point if only bgfx values changed. Every point contains one complete current-value tuple
as defined by `AssetProfilerMemoryPoint`; future graphs do not need to merge partial gauge updates. If
the resulting tuple equals the previous point, do not append a duplicate. Full snapshots always read
authoritative current accounting directly from residency and session high-water values directly from
the profiler service, even before an end-of-frame flush.

### 7.8 Retained telemetry subset

All existing asset telemetry may continue updating cumulative test/debug aggregates, but only the
following low-level events are copied into the editor profiler's 8,192-change history:

- source-read completed or failed;
- preparation completed or failed;
- owner finalization completed or failed;
- terminal request failure;
- eviction;
- reload after removal;
- Ready before use, Loaded too late, Not prefetched, and Prefetched but unused;
- the generation-correlated occurrences of the four prefetch-rejection codes listed in Section 7.5.

Do not retain AssetRequested, RequestCoalesced, priority changes, SourceReadStarted, generic cache
hits/misses, pin changes, request cancellation, memory-policy resolution, or unrelated budget-pressure
events in the editor change log. They are either redundant for the selected views or too noisy for
the bounded history. Stable stage durations and byte totals remain available through the retained
completion/failure events.

## 8. History and update cadence

The profiler must support future graphs without recording repeated full snapshots.

### 8.1 Event-driven data

Record immediately when the underlying event occurs:

- prefetch outcomes;
- memory-limit rejection;
- eviction;
- reload after removal;
- load failure;
- asset-wait completion;
- prefetch-generation submission or attributed outcome update;
- lightweight inventory-changed markers.

### 8.2 State-change data

Record a new point only when the value changes:

- asset RAM;
- loading memory;
- asset GPU resources;
- In use/Prefetched/Cached counts;
- Loading/Finishing/Failed counts.

Several changes in one engine frame may be coalesced to one end-of-frame point. Do not add identical
points merely because the editor requested another delta. Current per-asset inventory is replaced on
revision change as defined in Section 7.4; it is deliberately not retained as a per-change historical
graph stream.

### 8.3 Renderer estimates

bgfx texture and render-target estimates may change outside asset-residency mutations. Sample them
once per second while a profiler session exists and the renderer is initialized, whether gameplay is
running or paused. Record a history point only when the sampled values differ from the previous
sample. Track the highest observed sample as the renderer peak. Do not query browser-wide memory or
backend physical-memory APIs in this timer.

Take an immediate sample after renderer initialization and immediately after a profiler-session
replacement when the renderer is already initialized. The one-second cadence starts from that sample,
so the Overview does not remain blank for an avoidable initial interval.

### 8.4 Editor transport cadence

The persistent Play preview requests profiler deltas every 500 ms while Asset Performance is visible
and every 1,000 ms while it is hidden. This polling transports new data; it does not itself create
history events. Request an immediate full snapshot or delta after:

- the preview becomes ready;
- a compiled project replacement reports success and therefore changes session ID;
- the Asset Performance panel is opened;
- a history gap requires replacement state.

Do not issue an extra profiler request after every runtime command; the bounded event-driven history
and 500 ms visible cadence are sufficient. Polling continues while hidden so the editor can retain a
complete current-session history without relying on the panel being open.

### 8.5 Retention

For the first implementation:

- engine history remains bounded;
- the editor retains only the current preview session in memory;
- compiled-project replacement or preview recreation begins a new profiler session;
- ordinary runtime Reset does not begin a new profiler session;
- no history is written to the project file;
- no history is written to editor user data.

Later persistence can store the same session-relative event, memory-point, generation, wait, and
aggregate schema without changing engine collection semantics. Historical per-asset inventory graphs
are not promised by this plan.

## 9. Web preview transport

Follow the existing runtime-debug-snapshot request/response pattern.

### 9.1 C++ export

Under `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER=1`, add these Emscripten exports:

```cpp
const char* noveltea_asset_profiler_snapshot();
const char* noveltea_asset_profiler_delta(const char* expected_session_decimal,
                                          const char* after_sequence_decimal);
```

The delta export requires nonempty canonical unsigned-decimal session and sequence strings. Invalid
text returns a typed serialized failure and must not be interpreted as zero. Both returned JSON
values are owning serialized DTOs with no pointers or live engine references. Do not add generic
native invocation or arbitrary introspection.

Each C export returns this outer result shape:

```ts
type AssetProfilerExportResult =
  | { ok: true; payload: AssetProfilerWirePayload }
  | { ok: false; error: { code: string; message: string } };
```

The C boundary must return valid JSON for typed unavailable, session-mismatch, cursor, and validation
failures. An empty string is reserved for catastrophic bridge failure and is reported as a malformed
export response by the widget.

### 9.2 Widget capability and messages

Add capability:

```text
asset-profiler-v1
```

Add editor-to-preview message:

```ts
{
  version: 1;
  type: 'runtime-request-asset-profiler';
  requestId: string;
  mode: 'full' | 'delta';
  sessionId?: string;
  afterSequence?: string;
}
```

`sessionId` and `afterSequence` are both required for `mode: 'delta'` and both forbidden for
`mode: 'full'`.

Add preview-to-editor message:

```ts
{
  version: 1;
  type: 'runtime-asset-profiler';
  requestId: string;
  payload: AssetProfilerWirePayload;
}
```

The widget must validate export availability, parse JSON, and report clear preview diagnostics for
missing exports, malformed payloads, invalid cursors, or unsupported schema versions. A failed
request uses the existing `command-result` failure path and emits no `runtime-asset-profiler` success
message.

### 9.3 Serialization constraints

- Serialize every C++ `std::uint64_t` ID, sequence, byte count, count, timestamp, and duration as a
  canonical unsigned-decimal string. Schema versions and deliberately bounded enum-independent UI
  integers may remain JSON numbers.
- Do not serialize `steady_clock::time_point` directly.
- Serialize enums as documented lowercase-kebab-case strings and reject unknown values in the strict
  TypeScript validator; do not expose raw C++ ordinals.
- Keep raw stable diagnostic codes alongside localizable editor messages.
- `AssetProfilerWirePayload` is a discriminated union with `kind: 'full' | 'delta'`, common
  `schemaVersion`, `sessionId`, `latestSequence`, and `capturedAtNs` fields, and the corresponding
  full/delta body. Do not infer payload kind from omitted fields.

After strict validation, the editor client converts session IDs, sequences, byte counts, counts, and
durations to `bigint` for comparison, accumulation, and formatting. It converts a session/sequence
back to canonical decimal text when sending a delta request. Do not route these values through
JavaScript `number` first. Extend the editor's size/duration formatting helpers with `bigint` support
if their current signatures accept only `number`.

## 10. Editor state and panel ownership

Add one bottom-panel entry labeled **Asset Performance**. Inside it, use local tabs:

- Overview;
- Issues;
- Assets.

This is preferable to adding three more global bottom-panel buttons.

The panel is project-scoped and consumes only the dedicated persistent Play preview. It must not
claim pooled derived previews. When no Play preview is open or ready, show a clear empty state with an
action to open Play rather than silently displaying stale data.

### 10.1 Store

Add a focused Zustand store or service that owns:

- current profiler session ID;
- latest accepted sequence;
- connection/capability state;
- latest memory snapshot and outcome totals;
- authoritative inventory by stable key;
- current-session waits, generation records, and events;
- whether current-session history is complete and the earliest retained sequence;
- selected local tab, filters, sort, and expanded row IDs.

Do not put the entire profiler history into the general workspace store. Do not persist runtime
history, selected local profiler tab, profiler filters, sort, or expanded rows in
`EditorProjectState`. Those local controls survive panel hide/show because the focused store remains
mounted, but reset on editor reload or profiler-session replacement. Persisting the global selected
bottom-panel ID remains ordinary workbench metadata.

Phase 7 established separate reset paths for these lifetimes. Clearing engine-derived payload,
inventory, retained changes, notices, and errors during preview/project detach or transport
replacement must preserve profiler-local controls and the last accepted profiler-session identity.
Only editor reload clears both runtime and local state. When the next accepted full snapshot has a
different profiler-session ID, reset the local controls exactly once even if the prior runtime
payload was already cleared while detached. Phases 8 and 9 must extend these existing store-owned
controls rather than introducing component-local reset behavior.

On a normal delta, replace current memory/outcome fields, apply generation upserts and append-only
changes by sequence, and replace inventory only when `replacement_inventory` is present. On a
history-gap response, discard prior engine-derived changes/generation/wait history for that session,
install the returned retained window and replacement inventory, preserve current cumulative fields,
and show a nonblocking "Earlier profiler history was discarded" state. Do not discard current state
or stop polling merely because history is incomplete.

### 10.2 Polling lifecycle

The polling controller belongs beside the persistent Play preview transport, not inside individual
table components. It starts after the preview advertises `asset-profiler-v1`, pauses during teardown,
and resets on session-ID change.

If the capability is absent, set Unsupported and do not start a timer. A session-mismatch response
triggers one immediate full request. A history gap installs replacement state as defined above and
continues polling. Malformed payload or unsupported profiler schema stops polling for that preview
session and shows the diagnostic until preview recreation; do not repeatedly emit the same error at
every timer interval.

Only one controller may poll one preview session. Opening or closing the bottom panel must not create
duplicate intervals or MessageChannels. Allow only one profiler request in flight at a time; a timer
tick while a request is pending is skipped. Accept a response only when its preview session token,
request ID, and profiler session ID match the current controller state. A response from an older
preview or profiler session cannot update the store.

When the project closes, the persistent Play preview detaches, or its MessageChannel is replaced,
cancel the timer, invalidate the in-flight request token, and clear profiler state. The disconnected
panel must not continue showing the prior project's memory or asset rows.

## 11. View requirements

### 11.1 Overview

Use compact metric groups rather than charts:

- Asset RAM: current and peak, with source/prepared-CPU/audio budget percentages in details;
- Loading memory: current, peak, and budget percentage;
- Asset GPU resources: current, peak, and policy percentage;
- Total GPU resources: current and peak, with ordinary textures and render targets in details;
- current state counts;
- Ready before use percentage and outcome counts;
- asset-wait count and cumulative Asset wait time.

Show an explicit estimate label for Total GPU resources. Tooltips must explain the scope of Asset RAM,
Loading memory, Asset GPU resources, and Total GPU resources. Asset RAM has no combined budget
percentage; its details show source, prepared-CPU, and audio percentages separately. Prefetched
memory details show each Warm domain against that domain's configured allowance. Total GPU resources
has no policy percentage because render targets and non-residency textures are outside the asset GPU
budget.

For source, prepared CPU, audio, Loading memory, and Asset GPU resources, show both current/budget and
session-peak/budget. Warm-prefetch allowance details are current-only in the initial UI; this plan
does not collect a separate Warm high-water series. A value over 100% is displayed as over budget, not
clamped to 100%.

### 11.2 Issues

Sort Error before Warning, then newest occurrence first. Load failed is Error; Asset wait, Prefetch
blocked by memory limit, and Reloaded after removal are Warning. Initial issue types:

1. Load failed.
2. Asset wait.
3. Prefetch blocked by memory limit.
4. Reloaded after removal.

Canonical issue sources are fixed:

- Load failed comes from the terminal `RequestFailed` event when that request is not already a child
  of an Asset wait; source/preparation/finalization failure events with the same request/job/key are
  attached as details and do not create additional issues;
- Asset wait comes from a final Completed or Failed `AssetWaitRecord`; Canceled waits are not Issues;
- Prefetch blocked by memory limit comes from the one generation-correlated rejection record defined
  in Section 7.5;
- Reloaded after removal comes from each successful reload event defined in Section 7.4.

Issue filtering in the initial implementation consists of text search plus an issue-type filter. Do
not add threshold, severity, chapter, time-range, or aggregation controls in this phase.

An Asset wait expands to show each waiting asset with:

- display identity;
- type;
- Loaded too late, Not prefetched, or Load failed;
- available read/preparation/finalization durations;
- direct navigation when a matching editor record can be resolved.

Do not separately list the same late/miss or terminal load-failure events as peer issues when they are
already children of an Asset wait. Non-blocking late/miss outcomes remain represented in Overview
counts and the asset row's details. Do not aggregate separate waits, failures, rejections, or reload occurrences into one
cross-occurrence issue in the initial implementation. The only grouping is the children of one Asset
wait operation.

### 11.3 Assets

Provide:

- text search;
- filters for In use, Prefetched, Cached, Loading, Finishing, Failed, and Reloaded after removal;
- type filter;
- sorting by identity, state, Asset RAM, Loading memory, Asset GPU resources, and reload count;
- expandable technical details;
- best-effort direct navigation.

Default ordering:

1. Failed;
2. Loading and Finishing;
3. In use;
4. Prefetched;
5. Cached.

Within the same default state group, sort by display identity. Explicit Asset RAM/GPU sorts use
committed cost when present, otherwise estimated cost, otherwise zero; Loading memory uses the
current reservation. Estimated values remain visually marked. Text search is case-insensitive over
display identity and stable cache identity. Filters combine with logical AND.

Use the editor's established table/scrolling patterns. Do not add virtualization or a table
dependency in the initial implementation; a later measured performance issue can justify separate
work without changing the profiler data contract.

### 11.4 Navigation contract

Navigation is available only when the profiler identity resolves unambiguously in the currently
loaded authoring project:

- Material ID -> matching Material editor;
- Shader program key -> matching Shader editor when one exact authored shader owns that key;
- Image/Audio project path -> matching Asset editor when one exact Asset record owns that path;
- Font alias/style -> matching project font configuration when one exact authored record exists.

Use the existing workbench resource-opening/navigation APIs. When no target or more than one target
matches, omit the direct-open action and retain the technical identity for copy/search; do not choose
an arbitrary record. This plan does not require navigation from system assets or renderer-generated
resources.

## 12. Phased implementation

Each numbered phase below is intentionally sized as one sequential GPT-5.6 implementation task.
An implementation prompt should instruct the agent to review the completed prior phases, implement
only the named phase, run its focused validation, update completion tracking, and stop before later
phases. Do not combine phases merely to reduce prompt count. Conversely, do not split a phase into
lettered subphases unless repository findings show that the phase cannot be completed and validated
as one coherent change.

### Phase 1: Compiler gate and build isolation

Deliverables:

- add `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER`, default `OFF`;
- add numeric compile definitions to the engine and sandbox targets;
- add `web-editor-preview` with a separate build directory;
- add `linux-debug-editor-profiler` with a separate build directory;
- update `build-engine-preview.mjs` to use the editor preset;
- introduce the minimal `EditorAssetProfilerService` composition shell that implements the one
  telemetry-sink boundary and internally owns/delegates to the existing recorder; Phase 2 extends
  this same object rather than replacing composition again;
- construct that service only when the option is enabled and `preview_widget=true`;
- update module/build diagnostics to report the option;
- add source-policy/build tests proving ordinary player presets remain disabled;
- leave Web exports, widget capabilities, and editor protocol changes to Phase 6, where the actual
  transport exists.

Acceptance:

- ordinary Linux/Web release builds compile with the definition set to `0` and create no profiler
  recorder or profiler service; preset/source-policy tests also prove every maintained release/player
  preset leaves the option off;
- editor preview builds compile with the definition set to `1` and retain the existing bounded
  telemetry foundation needed by later phases;
- asset loading behavior is identical with the option on and off;
- no profiler recorder/history work occurs in the off composition.

### Phase 2: Profiler session and incremental-history backbone

Deliverables:

- bump engine profiler schema to version 3;
- add session ID, shared monotonic sequence, session-relative timestamps, full-snapshot envelope,
  and incremental-delta envelope;
- establish `EditorAssetProfilerService` as the one sink/owner and add its 8,192-change ordered log;
- add the exact session-reset, cursor, invalid-cursor, overwrite-gap, and unavailable-service behavior
  from Sections 7.1-7.2;
- wire the owner-thread in-place session rotation into both the normal live project-replacement path
  and the post-source-replacement rollback restoration path; do not defer this engine lifecycle
  boundary to the editor-client phase;
- keep existing event aggregates working while retaining only the Section 7.8 subset in the new log;
- define extension points for inventory, memory points, prefetch generations, and Asset waits without
  implementing those later-phase sections yet;
- preserve and extend existing aggregate and ring tests.

Acceptance:

- concurrent event recording preserves monotonic sequence order;
- deltas return only records newer than the requested sequence;
- overwritten history reports a gap and never silently claims completeness;
- a cursor from a replaced session returns `assets.editor_profiler_session_mismatch`;
- the service/sink address remains stable across project replacement while the session ID changes;
- a candidate rejected before live source-generation replacement preserves the current session, and
  a rollback after replacement creates a new restored-generation session without resurrecting prior
  history;
- invalid future cursors return `assets.editor_profiler_cursor_invalid`;
- a full snapshot followed by gap-free deltas reconstructs the same retained changes and cumulative
  fields as a later full snapshot at the same capture boundary;
- off/non-preview builds return `assets.editor_profiler_unavailable` and expose no active service.

### Phase 3: Authoritative current asset inventory

Deliverables:

- add residency and typed-orchestrator owner-thread introspection;
- aggregate an authoritative inventory in `AssetManager` or a dedicated profiler adapter;
- add inventory revision and authoritative replacement handling;
- expose all resident and in-flight typed assets without reconstructing state from retained events;
- add the exact domain labels, stable row identity, inclusion rules, state precedence, request origin,
  diagnostics, committed/estimated costs, and removable semantics from Section 7.4;
- replace the existing `ever_evicted`-only presentation with an exact reload count suitable for the
  inventory and later Issues view;
- define source-generation retirement behavior and inventory tests across all five typed domains.

Acceptance:

- Warm prefetched textures appear as Prefetched with Asset GPU-resource cost;
- Demand leases appear as In use;
- released unpinned residents appear as Cached;
- in-flight assets show Loading or Finishing;
- eviction removes or updates the row immediately;
- source-generation replacement retires old nonresident rows and retains an old-generation row only
  while an authoritative live residency/in-flight record still exists;
- a delta after an inventory revision change carries exactly one current replacement inventory;
- inventory capture does not change scheduling, admission, pinning, or eviction behavior.

### Phase 4: Memory accounting and GPU-resource estimates

Deliverables:

- expose authoritative current residency accounting directly from the residency manager and exact
  session-scoped peaks from the profiler's synchronous accounting notifications;
- define and test user-facing Asset RAM, Loading memory, and Asset GPU-resource calculations;
- expose current Warm cost by memory domain and compare it only to per-domain prefetch allowances;
- track a correct combined Asset RAM high-water mark rather than summing independent domain peaks;
- add accounting revision plus the one-point-per-frame end-of-frame flush defined in Section 7.7;
- add bgfx ordinary-texture and render-target estimates, Total GPU-resource calculation, and peaks;
- introduce an injectable renderer-statistics adapter for tests and unavailable-backend behavior;
- document exactly which values are engine-accounted and which are estimates.

Acceptance:

- current and peak memory remain correct for Warm admissions and temporary reservation changes;
- combined Asset RAM peak represents an observed combined state, not the sum of unrelated peaks;
- Total GPU resources includes bgfx ordinary textures and render targets without adding NovelTea
  residency GPU bytes a second time;
- unchanged memory values do not generate redundant history points;
- renderer-statistics unavailability produces an explicit unavailable estimate rather than zero or
  a fabricated value;
- sampled renderer peaks are labeled and tested as highest observed estimates.

### Phase 5: Prefetch effectiveness and Asset wait history

Deliverables:

- retain bucket-aware prefetch submission records;
- stop discarding the planner report in the mandatory gate when profiling is enabled;
- correlate later used/late/unused outcomes through generation upserts;
- enforce one used/late/miss classification per typed asset lifecycle as defined in Section 7.5;
- count only the four defined prefetch memory-rejection codes and the defined successful
  reload-after-eviction cases;
- add exact Asset wait lifecycle, retry, cancellation, and player-facing-total semantics from
  Section 7.6;
- add cumulative outcome and wait totals;
- define the `Ready before use` metric from mutually exclusive used/late/miss outcomes without
  treating unrelated ordinary cache hits as successful prefetches.

Acceptance:

- direct-next entries display Expected next;
- adjacent entries display Possible next;
- generation replacement does not alter ticket behavior;
- a fully ready mandatory group emits no Asset wait;
- a pending group emits exactly one wait record with the initially waiting request IDs/cache keys;
- retry closes the prior failed operation and opens a distinct operation only when still pending;
- cancellation records remain diagnostic history but do not inflate Overview wait totals;
- completion, failure, cancel, rollback, project replacement, and shutdown close records exactly
  once.

### Phase 6: Web preview transport and protocol

Status: Completed 2026-07-24.

Deliverables:

- add the two conditional full/delta C exports and CMake exported-function wiring from Section 9.1;
- add widget capability and request/response handling;
- add JSON serialization;
- add TypeScript protocol types and strict validators;
- serialize all `uint64_t` wire values as canonical decimal strings and enums through strict string
  mappings;
- serialize the implemented Phase 5 prefetch-generation upserts and Asset wait records, including
  their tagged change kinds, nested diagnostics, prediction kinds, loading phase/result enums,
  operation/request/generation IDs, presentation revision, timestamps, durations, and participant
  cache keys;
- serialize the implemented nested `current`/`peak` memory contract, preserving independent nullable
  ordinary-texture and render-target components and leaving Total GPU resources unavailable when the
  current sample is incomplete;
- support explicit full-snapshot and delta requests, but leave polling/store/UI ownership to Phase 7.

Acceptance:

- editor and widget reject unsupported schemas clearly;
- non-profiler builds produce a capability-unavailable state, not malformed data;
- release builds contain no profiler export and advertise no profiler capability;
- profiler-enabled preview builds contain the export and advertise `asset-profiler-v1`;
- full and delta responses round-trip through strict TypeScript validation;
- full and delta round-trips cover repeated upserts of one prefetch generation, bucket-aware
  submission failures, and Completed/Failed/Canceled Asset wait records without losing diagnostic or
  correlation fields;
- full and delta round-trips cover complete, partially unavailable, and fully unavailable renderer
  estimates without converting absence to zero or reconstructing total/component peaks;
- delta requests require matching decimal-string session and sequence cursors;
- payloads remain bounded and incremental after initial connection.

### Phase 7: Editor profiler client, panel shell, and Overview

Status: Completed 2026-07-24.

Completion summary (2026-07-24):

- added the persisted Asset Performance bottom-panel identity and local Overview/Issues/Assets
  navigation, while keeping profiler-local controls outside durable project metadata;
- added one Play-preview-owned polling controller with an immediate full request, exact 500 ms
  active-panel and 1,000 ms hidden cadence, one request in flight, direct `bigint` cursors,
  project/preview replacement invalidation, immediate full recovery for history gaps and session
  mismatches, and terminal stop-until-recreation behavior for malformed protocol data;
- tightened the paired profiler payload/acknowledgement transport so only the matching validated
  payload plus successful acknowledgement resolves a request, and preserved typed runtime failure
  codes for recovery decisions;
- added the normalized editor store with authoritative typed-cache-key inventory, retained change
  window replacement, nonblocking discarded-history state, exact `bigint` number/file-size/duration/
  percentage formatting, and profiler-session-local UI-state reset semantics;
- implemented the Phase 7 Overview metrics, budgets, prefetch allowances, renderer-estimate details,
  current state counts, outcomes, waits, localized empty/error states, and disconnected Open Play
  action without adding Phase 8 Issues derivation or Phase 9 Assets-table behavior;
- validated formatter/lint/typecheck, 905 passing editor tests with the repository's four existing
  skips, the production editor build and bundle policy, and both `web-release` and
  `web-editor-preview` sandbox builds.

Deliverables:

- add one focused editor profiler store/service owned beside the persistent Play preview;
- extend the existing preview transport/controller with one typed asset-profiler request operation
  that correlates the matching `runtime-asset-profiler` payload and terminal `command-result` by
  request ID, resolves only after the successful acknowledgement, and rejects missing, mismatched,
  failed, or stale responses; do not pair these messages ad hoc inside panel components or expose a
  second raw `MessagePort` path;
- normalize the strictly validated wire DTO into editor-domain state by converting every canonical
  unsigned-decimal field directly to `bigint`, and extend the locale-aware number, file-size, and
  duration formatting path to accept those values without an intermediate JavaScript `number`;
- add the exact 500 ms visible / 1,000 ms hidden full-then-delta polling, session replacement,
  one-request-in-flight rule, stale-message rejection, and history-gap recovery;
- ensure polling is active only for the relevant persistent preview and does not duplicate when tabs
  move or the bottom panel is hidden;
- add Asset Performance to bottom-panel state/schema/i18n;
- add local Overview/Issues/Assets tabs;
- add empty, disconnected, unsupported, loading, and history-gap states;
- implement Overview metrics with user-friendly labels and explanatory tooltips;
- do not add a manual profiler-session reset control.

Acceptance:

- all maintained locales remain key-compatible;
- values format through editor number/file-size/duration helpers;
- no internal Pinned/Warm/Cold labels leak into primary UI;
- estimates are identified as estimates;
- successful compiled-project replacement changes profiler session after old-generation invalidation
  and project-owned lease release but before replacement typed requests begin; ordinary runtime
  Reset does not, and profiling does not force old-resource eviction; this is end-to-end validation
  of the Phase 2 engine boundary, not new engine lifecycle ownership in Phase 7;
- polling does not restart or duplicate when the Play tab moves or the bottom panel toggles;
- a profiler request updates state only after the matching payload and successful acknowledgement;
  a failed command, missing/mismatched payload, or response from an invalidated preview request token
  cannot update the store;
- values beyond JavaScript's safe-integer range remain exact through validation, normalization,
  storage, cursor emission, and locale-aware display;
- the panel does not alter Play preview lifecycle.

### Phase 8: Issues

Status: Completed 2026-07-24.

Completion summary (2026-07-24):

- added deterministic editor-side issue derivation for terminal load failures, completed/failed Asset
  waits, generation-correlated prefetch memory rejections, and successful reload-after-removal
  occurrences, with Error-before-Warning and newest-first ordering;
- grouped each Asset wait into one expandable issue with its initially waiting requests, suppressed
  peer terminal-failure issues for those children, preserved late/miss classification as technical
  detail when failure wins, and attached retained source-read/preparation/finalization timings only
  in expanded details;
- treated retained prefetch-generation changes as upserts, derived pre-ticket allowance failures from
  the latest generation record, and deduplicated post-ticket rejection telemetry by generation,
  cache key, and diagnostic code;
- added localized issue search, the four-type filter, persistent expanded issue state, stable
  technical diagnostic codes, and best-effort diagnostic-path plus unambiguous authored-record
  navigation through the existing workbench navigation resolver;
- retained Phase 7 profiler-local controls across panel hide/show and transient detach while resetting
  them after an accepted replacement profiler session or explicit editor-store reload;
- revalidation corrected job-level source-read/preparation/finalization correlation, preserved each
  pre-ticket rejection's original generation timestamp across later generation upserts, required a
  nonzero generation for post-ticket rejection occurrences, replaced ambiguous typed-cache-key
  inventory lookup with deterministic display-identity handling, and exposed stage diagnostic codes;
- added focused derivation, deduplication, grouping, failure-precedence, navigation, store, and panel
  coverage. All 15 focused Issues tests, all 913 editor tests with 4 skipped, formatting,
  lint/typecheck with the existing 287-warning and zero-error baseline, the production build, and
  bundle-policy validation pass.

Deliverables:

- derive issue records from waits, failures, memory rejections, and reloads;
- group one mandatory wait and its contributing assets into one issue;
- suppress duplicate child late/miss/load-failure issues;
- treat prefetch-generation changes as upserts rather than independent rejection occurrences:
  derive `assets.prefetch_allowance_exceeded` from the latest retained generation record and derive
  the other three defined rejection codes from their generation-correlated retained telemetry
  events; deduplicate by generation, cache key, and diagnostic code so later used/late/unused upserts
  do not repeat the original submission rejection;
- when one wait participant has both late/miss evidence and a terminal request failure, present Load
  failed as the primary child result and retain the prefetch classification in technical details;
- use the fixed Error/Warning severity mapping and no cross-occurrence aggregation from Section 11.2;
- show stage details only on expansion;
- add best-effort diagnostic navigation;
- wire issue search, issue-type filtering, and expanded issue IDs through the existing profiler-local
  store controls and the Phase 7 reset paths;
- add focused filtering and tests.

Acceptance:

- one room transition waiting on three assets produces one Asset wait issue with three children;
- unrelated later waits remain separate;
- a prefetch memory rejection is visible before later demand occurs;
- later upserts of that generation do not duplicate the same pre-ticket memory-rejection issue;
- a late or missed request that then fails appears once as a Load failed wait child and not as a peer
  failure issue;
- failures retain stable technical codes in details;
- issue controls survive panel hide/show and transient preview/project detach, but reset after an
  accepted replacement profiler session or editor reload;
- no overlay-related metric or issue exists.

### Phase 9: Assets

Status: Completed 2026-07-24.

Completion summary (2026-07-24):

- implemented the authoritative non-virtualized Assets inventory table with case-insensitive search,
  user-facing state and type filters, the required default and explicit sorts, expandable technical
  details, estimated-cost marking, reload-after-removal visibility, and best-effort direct record
  navigation;
- added deterministic inventory derivation helpers for default state precedence, committed-first
  Asset RAM/GPU sorting, current loading-memory sorting, reload filtering, and authoritative
  committed-domain plus temporary-reservation sums;
- wired asset search, state, type, sort, and expanded-row controls through the existing profiler-local
  store so they survive panel hide/show and transient detach, then reset only after an accepted
  replacement session or explicit editor-store reload;
- retained full and history-gap replacement-inventory handling as the authoritative row source, with
  session/cursor rejection preventing stale preview data from replacing a newer accepted session;
- localized the Assets surface in English and Brazilian Portuguese and removed the prior Phase 9
  placeholder copy;
- added focused filtering, ordering, accounting-sum, history-gap replacement, identity/source-
  generation keying, and control-lifetime coverage. The 9 focused Assets/store tests and TypeScript
  typecheck pass.

Deliverables:

- implement inventory table, search, filters, sorting, details, and navigation;
- expose Reloaded after removal as a filter/detail; keep Prefetched but unused only in Overview;
- preserve asset search/filter/sort/expanded-row state while the bottom panel is hidden and across a
  transient preview/project detach by using the existing profiler-local store controls;
- reset those controls after an accepted replacement profiler session or editor reload through the
  Phase 7 reset paths rather than component remount behavior;
- handle inventory replacement after a history gap;
- use the existing non-virtualized table/scrolling patterns required by Section 11.3.

Acceptance:

- rows track state changes without duplicates;
- source-generation changes retire old nonresident rows while preserving only authoritative still-live
  old-generation rows until destruction;
- committed resident-row source/prepared-CPU/audio/GPU sums and in-flight reservation temporary sums
  match the corresponding authoritative Overview domains; estimated eventual costs and Total GPU
  resources are excluded from this equality;
- filters use user-facing categories;
- asset controls survive transient detach/reconnect to the same profiler session and reset for an
  accepted replacement session;
- stale preview sessions cannot overwrite a newer session.

### Phase 10: Verification, documentation, and archival

Deliverables:

- run the focused engine, Web, protocol, editor, and source-policy matrices;
- manually verify representative miss, late, used, unused, rejection, eviction/reload, failure, and
  asset-wait scenarios;
- verify the disabled path performs no profiler allocation, locking, history mutation, timer,
  serialization, export, or capability advertisement beyond the pre-existing nullable sink checks;
- verify every profiler-only production source/private header remains classified but is absent from
  disabled-build target sources and compile commands, and every profiler-only test source is absent
  from disabled test targets;
- measure enabled full/delta capture and JSON size using a generated stress fixture with 1,000
  current inventory rows and a full 8,192-change history; the retained history must include a
  representative high-cardinality Phase 5 mix with repeated full generation upserts, bucket-aware
  submission failures, nested diagnostics, and multi-participant Asset waits rather than satisfying
  the measurement with only fixed-size telemetry events;
- verify and finalize permanent documentation without repeating the schema-v3 transport migration
  already completed in Phase 6: keep `docs/editor/preview/ASSET_PROFILER_HANDOFF.md` and
  `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md` aligned with the implemented wire contract,
  correct any remaining wording that implies `AssetTelemetryRecorder` rather than
  `EditorAssetProfilerService` owns the profiler session and 8,192-change log, and document the
  implemented Phase 7-9 polling/store, Overview, Issues, Assets, and workbench behavior in the
  narrowest permanent editor preview/workbench documents;
- archive this plan after all acceptance criteria pass.

Acceptance:

- release player presets remain profiler-disabled;
- for the defined optimized stress fixture: full capture plus serialization is at most 50 ms p95 and
  8 MiB; a delta containing 100 retained changes is at most 8 ms p95 and 512 KiB; an idle delta is at
  most 2 ms p95 and 16 KiB. Record the environment and raw measurements in the completion report;
- no telemetry controls runtime behavior;
- all three views satisfy the user-facing vocabulary and scope in this plan;
- no known blocker remains.

## 13. Validation matrix

### 13.1 Engine tests

Extend or add focused tests for:

- feature-disabled composition passes null telemetry and creates no profiler service;
- enabled non-preview composition also creates no profiler service;
- project replacement rotates the session in place without changing the service/sink address;
- a pre-replacement candidate rejection preserves the session, while post-replacement rollback starts
  a restored-generation session and does not revive prior history;
- the enabled service owns one detailed 8,192-change log rather than retaining a duplicate legacy
  event ring;
- session/sequence monotonicity under concurrent recording;
- compiled-project session-boundary behavior, session mismatch, invalid cursor, and history-gap
  behavior;
- authoritative inventory across all five typed domains;
- Pinned/Warm/Cold to In use/Prefetched/Cached mapping;
- acquire-load of worker `active_job_state`, canceled-row omission, and still-live old-generation row
  handling;
- temporary reservation current and peak accounting;
- exact session peak updates for intra-frame rise/release and replacement-session reset;
- Warm prefetch admission memory visibility;
- bgfx unavailable-value handling through an injectable stats adapter;
- bucket-aware generation records;
- exact used/late/miss/unused generation correlation;
- multiple coalesced Demand consumers do not duplicate one lifecycle classification;
- all four and only the four defined prefetch rejection classifications;
- asset-wait lifecycle and initially waiting key selection;
- canceled waits do not enter Overview totals;
- reload counts increment only after successful post-eviction residency and not on invalidation or
  failed retry;
- observer absence never changes admission, eviction, scheduling, or request outcomes.

Use an adapter for renderer statistics in unit tests; do not require a live GPU for core contract
tests.

### 13.2 Web tests

Verify:

- profiler-enabled and disabled build capabilities;
- exported symbol presence/absence;
- JSON full snapshot and delta parsing;
- canonical decimal-string integer precision and session-bound delta cursors;
- unsupported-schema diagnostics;
- threaded and cooperative Web preview compatibility where both remain supported.

### 13.3 Editor tests

Verify:

- protocol validation;
- one polling controller per persistent Play preview;
- session replacement and stale-message rejection;
- one-request-in-flight behavior and malformed-schema polling shutdown;
- bottom-panel persistence with the new panel ID;
- Overview calculations and user-facing labels;
- Asset wait grouping;
- issue deduplication;
- inventory state mapping, sorting, and filtering;
- capability-unavailable and history-gap states;
- profiler-local tab/filter/sort/expanded-row controls survive runtime-state clearing for transient
  detach and reset only on editor reload or an accepted replacement profiler session;
- `bigint` parsing/formatting without intermediate `number` conversion;
- locale-key parity.

### 13.4 Standard commands

At completion, run at minimum:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure

cmake --preset linux-debug-editor-profiler
cmake --build --preset linux-debug-editor-profiler
ctest --test-dir build/linux-debug-editor-profiler --output-on-failure

cmake --preset web-release
cmake --build --preset web-release --target noveltea-sandbox

cmake --preset web-editor-preview
cmake --build --preset web-editor-preview --target noveltea-sandbox

pnpm -C editor run check
pnpm -C editor run test
pnpm -C editor run build
```

The preset names above are required by this plan. If a repository constraint makes either impossible,
record the concrete cause and amend this plan before using a different name.

## 14. Likely files and ownership

Expected engine/build areas:

- `CMakeLists.txt`
- `CMakePresets.json`
- `cmake/NovelTeaModuleFileClassification.cmake`
- `engine/CMakeLists.txt`
- `apps/sandbox/CMakeLists.txt`
- `apps/sandbox/sandbox_app.cpp`
- `engine/include/noveltea/core/asset_telemetry.hpp`
- `engine/src/core/asset_telemetry.cpp`
- new editor-profiler DTO/service files under `engine/include/noveltea/core/` and
  `engine/src/core/`
- `engine/include/noveltea/assets/asset_request_orchestrator.hpp`
- `engine/include/noveltea/assets/asset_residency.hpp`
- `engine/src/assets/asset_residency_manager.cpp`
- `engine/include/noveltea/assets/asset_manager.hpp`
- `engine/src/assets/asset_manager.cpp`
- `engine/include/noveltea/assets/structured_prefetch.hpp`
- `engine/src/assets/structured_prefetch.cpp`
- `engine/include/noveltea/assets/mandatory_asset_gate.hpp`
- `engine/src/assets/mandatory_asset_gate.cpp`
- `engine/include/noveltea/renderer.hpp`
- `engine/src/render/bgfx/bgfx_renderer.cpp`
- `engine/include/noveltea/engine_tooling.hpp`
- `engine/src/engine.cpp`
- `engine/src/host/engine_impl.hpp`

Expected Web/editor areas:

- `web/widget.html`
- `editor/scripts/build-engine-preview.mjs`
- `editor/src/shared/preview-protocol.ts`
- `editor/src/renderer/editors/preview/FullGamePreviewEditor.tsx` or a focused persistent-preview
  profiler controller beside it
- new profiler store/service/components under `editor/src/renderer/preview/` or
  `editor/src/renderer/workbench/`
- `editor/src/renderer/workbench/BottomPanel.tsx`
- `editor/src/renderer/workbench/bottom-panel-store.ts`
- `editor/src/shared/project-schema/editor-project-state.ts`
- `editor/src/renderer/i18n/locales/*/workspace.json`
- focused engine, protocol, preview, and bottom-panel tests.
- `tests/CMakeLists.txt` and profiler source/build-policy checks under `tests/cmake/`.

Implementation may narrow this list. It must not place profiler state inside unrelated project,
command, or save-unit stores merely to avoid adding a focused module.

## 15. Completion tracking

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Compiler gate and build isolation | Complete | Added the default-off numeric compiler gate, isolated native/Web editor presets, preview build routing, conditional composition shell, build diagnostics, and automated preset/source/build-policy coverage. Revalidation corrected module classification, made enabled non-preview composition explicitly produce no service, and verified full native/editor plus release/editor-preview Web matrices. |
| 2. Profiler session and incremental-history backbone | Complete | Added schema-v3 session/sequence DTOs, one filtered 8,192-change service-owned history, session-relative timestamps, exact full/delta envelopes, cursor/session/gap failures with replacement inventory on overwrite gaps, aggregate-only legacy recording, and in-place rotation at committed project replacement and post-detach rollback restoration boundaries, including failed first-project replacement. Revalidation removed a non-contract raw telemetry field, hardened nonzero ID/sequence allocation and gap arithmetic, and added exact retention-filter, reconstruction, unavailable-tooling, and transactional rejection/rollback coverage. Profiler-enabled and disabled focused validation and both Web builds pass; complete native suites pass 741/751 and 747/757, with only the same 10 display-dependent capture/sandbox tests blocked because X11 is unavailable in the validation environment. |
| 3. Authoritative current asset inventory | Complete | Added enabled-only private/friend residency and typed-orchestrator introspection, an authoritative five-domain `(typed asset domain, AssetCacheKey)` union, normalized state/origin/reason/cost/removable fields, exact reload counts, source-generation retirement, canonical end-of-frame/capture revision flushing, and one replacement inventory per changed revision. Revalidation corrected immutable lifecycle origin, worker finalization and deferred-state dirty notification, resident-only union/provenance, failed/explicit-release/source-replacement reload exclusions, and acceptance coverage. Profiler-enabled and disabled focused validation, formatting, and source/build policy pass; complete native suites pass 750/760 and 741/751, with only the same 10 display-dependent capture/sandbox tests blocked because X11 is unavailable in the validation environment. |
| 4. Memory accounting and GPU-resource estimates | Complete | Added synchronous residency-accounting notifications for exact transient session peaks, authoritative current and Warm per-domain values, observed combined Asset RAM peaks, exclusive state-count memory points coalesced once per frame, and independent nullable bgfx ordinary-texture/render-target estimates with one-second sampling, immediate renderer/session samples, observed sampled peaks, and no GPU double counting. Revalidation added partial-unavailable handling, snapshot-before-flush coverage, renderer-sample history carryover, session-peak reset coverage, and an enabled-only renderer adapter. Formatting, focused enabled/disabled suites, C++ policy, Web editor/release builds, and native non-display coverage pass; complete native suites pass 752/762 and 741/751, with only the same 10 display-dependent capture/sandbox tests blocked because X11 is unavailable in the validation environment. |
| 5. Prefetch effectiveness and Asset wait history | Complete | Added bucket-aware, post-dedup prefetch submission entries/failures and retained generation upserts, mandatory-gate report handoff and generation-label teardown, active Expected next/Possible next inventory mapping, and cumulative mutually exclusive Demand-only used/late/miss, memory-rejection, unused, reload, and Asset-wait totals. Revalidation corrected Startup and coalesced-demand denominator leakage, repeated cache-hit and later-generation outcome duplication, all three post-ticket memory-rejection correlation paths, duplicate generation-upsert rejection accounting, and stale active-generation labels. Asset waits now have an exact active start/finish lifecycle keyed by operation identity, preserve the initial pending participants and presentation revision, close exactly once across completion, failure, explicit cancellation, rollback, project replacement, standalone-group destruction, gate destruction, and move replacement, reopen with a distinct retry operation, remain absent from retained history while active, and retain cancellations without adding them to Overview totals. Focused generation, lifecycle, rejection, inventory-label, gate-handoff, wait, retry, teardown, source/build-policy, and feature-disabled tests pass; formatting and both complete native builds pass. Complete native suites pass 762/772 with the profiler enabled and 744/754 with it disabled; the same 10 display-dependent capture/sandbox tests are blocked in both because X11 is unavailable. Both `web-release` and `web-editor-preview` sandbox builds pass. |
| 6. Web preview transport and protocol | Complete | Added the schema-v3 owning full/delta JSON boundary, canonical unsigned-decimal transport for every 64-bit ID/revision/sequence/time/byte/count/cost, explicit enum strings, typed native success/failure envelopes, and the two editor-only snapshot/delta exports. Added `runtime-request-asset-profiler`/`runtime-asset-profiler` MessageChannel handling and capability advertisement only when both exports exist, while leaving polling, cursor ownership, stale-message handling, history-gap recovery, store retention, and UI to Phase 7. Revalidation replaced the permissive renderer shape checks with an exact recursive discriminated DTO validator, rejected unknown fields and non-retained low-level telemetry, made prediction/event serialization explicit rather than ordinal-dependent, reconciled both canonical preview handoff documents to schema v3, and added native plus TypeScript coverage for values beyond JavaScript's safe-integer range, complete/partial/unavailable renderer estimates, repeated generation upserts, bucket-aware submissions/failures, all Completed/Failed/Canceled Asset wait results, malformed decimals, schema mismatch, enum ordinals, typed failures, and full/delta replacement/history-gap semantics. Focused enabled and disabled native matrices, build/source policies, native symbol isolation, TypeScript typecheck and protocol lint/tests, all 887 editor tests (4 skipped), the editor production build, and both `web-release` and `web-editor-preview` sandbox builds pass; Web release omits both exports and editor preview contains both. |
| 7. Editor profiler client, panel shell, and Overview | Complete | Added the persisted Asset Performance panel shell, preview-owned full/delta polling and lifecycle recovery, strict paired payload/acknowledgement correlation, exact bigint normalization/cursors/formatting, authoritative typed-cache-key inventory and history-gap replacement, and the localized Overview UI. Focused lifecycle/protocol/store/panel/formatting/schema tests, all 905 editor tests (4 skipped), formatter/lint/typecheck, the editor production build and bundle policy, and both Web sandbox builds pass. |
| 8. Issues | Complete | Added deterministic issue derivation and localized Issues UI for terminal failures, grouped mandatory waits, generation-correlated memory rejections, and reload occurrences. Wait children suppress peer failures, preserve late/miss detail under terminal failure precedence, correlate job-level stage timing/details, and show those details only when expanded. Generation upserts preserve the original pre-ticket rejection occurrence, while exact nonzero-generation post-ticket rejection events are deduplicated by the required correlation identity. Search, four-type filtering, expanded IDs, stable technical codes, and best-effort diagnostic plus unambiguous authored-record navigation use the profiler-local store and Phase 7 session-reset boundaries. Revalidation added deterministic typed identity handling and ambiguity-safe navigation. All 15 focused tests, all 913 editor tests with 4 skipped, formatting, lint/typecheck with 287 existing warnings and zero errors, the production build, and bundle-policy validation pass. |
| 9. Assets | Complete | Added the localized, virtualized authoritative Assets inventory with type/state/origin filtering, locale-aware search and sorting, stable typed cache-key identity, memory attribution, request/job/prefetch correlation, diagnostics, bounded history detail, and issue-to-asset navigation. Focused Assets/store/UI tests and the complete editor matrix pass. |
| 10. Verification, documentation, and archival | Complete | Added an optimized Release profiler stress preset and generated 1,000-row/8,192-change benchmark, enforced full/100-change/idle latency and size gates, reserved JSON array capacity, completed enabled/disabled engine and source/build-policy verification, built both Web variants, ran the editor matrix, reconciled permanent ownership/transport/UI documentation, recorded raw measurements and environment limitations, and archived this plan. Full and delta gates pass; the only full native-suite limitation is the repository's existing ten X11-dependent capture/sandbox tests in this display-less WSL2 environment. |

## 16. Completion definition

The plan is complete only when:

- the profiler is disabled by default and enabled explicitly by the editor-preview build;
- ordinary player artifacts perform no profiler recording, history, sampling, serialization, or
  transport;
- current/peak asset memory and total GPU-resource estimates are accurate within their documented
  logical scopes;
- current inventory is authoritative and covers resident plus in-flight typed assets;
- prefetch outcomes and generation buckets are represented accurately;
- asset wait time is measured exactly without overlay terminology;
- future graphs can consume sequence-based event, memory, wait, generation, outcome, and state-count
  history without changing collection frequency; historical per-asset inventory reconstruction is
  explicitly outside this plan;
- the Overview, Issues, and Assets views are implemented with user-friendly terminology;
- no profiler data influences runtime behavior;
- all validation passes and stable contracts are reconciled into permanent documentation.
