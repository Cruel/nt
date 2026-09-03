# Assets Documentation Overview

Hotspot alpha coverage, generated masks, residency, and prefetch integration are specified in
`docs/architecture/HOTSPOT_AUTHORING_INTERACTION_AND_RUNTIME.md`.

## Purpose

Use this entrypoint before changing asset loading, asset metadata, project asset import, package asset export, font/material asset lookup, or typed asset-manager behavior.

## Current Documents

- `docs/engine/ASSET.md` describes the authoring asset entity, editor behavior, validation, runtime/export status, and implementation files.
- `docs/runtime/PACKAGE_EXPORT.md` describes runtime package layout and manifest shape.
- `docs/editor/export/EXPORT_AND_PACKAGING.md` describes the editor export workflow and asset packaging surface.
- `docs/assets/ASSET_MEMORY_PROFILES.md` records measured residency units, target presets, Custom
  validation, and runtime pressure semantics.
- `docs/editor/preview/ASSET_PROFILER_HANDOFF.md` defines the immutable job/asset profiler snapshot
  boundary that future editor transport and UI work may consume.
- `docs/editor/plans/ASSET_MEMORY_AND_PREFETCH_PROFILER_IMPLEMENTATION_PLAN.md` defines the active,
  compiler-gated implementation plan for exposing focused asset memory and prefetch diagnostics in
  the editor Play preview.

## Code Areas

- `engine/src/assets/` and related engine headers own runtime asset loading behavior.
- `editor/src/shared/project-schema/authoring-assets*` and editor asset operations own authoring asset schema/commands.
- `editor/src/renderer/editors/assets/` owns the asset library/editor UI.
- Runtime export/package builders live under editor services and shared export code.

## Asynchronous Request and Residency Foundation

`engine/include/noveltea/assets/asset_request_orchestrator.hpp` owns the nonblocking typed request
state machine introduced by the threading/streaming plan. It coalesces equivalent cache keys,
tracks independent consumer and prefetch interest, reprioritizes shared jobs, transfers Ready
reservation pins into copyable leases, publishes Queued/Reading/Preparing/owner-finalization cache
states, and invalidates cache entries by source generation.

`AssetResidencyManager` in `asset_residency.hpp` and `engine/src/assets/asset_residency_manager.cpp`
owns preparation reservations, per-domain memory accounting, Pinned/Warm/Cold classification,
admission, deterministic cost-aware LRU eviction, and owner-thread destruction. Telemetry is an
optional observer and must not influence scheduling or residency decisions. Production composition
installs one `AssetTelemetryRecorder` before residency/request orchestration and passes the same sink
to both owners. Ordinary players retain aggregate counters and high-water marks without a detailed
event ring; editor preview/test composition retains the newest 8,192 events and reports overwritten
events through `lost_event_count`. When multiple mandatory preparations discover larger temporary
requirements concurrently, one reservation becomes the expansion arbiter and is fully charged while
the other preparations remain parked. Completion or cancellation releases that arbiter before the
next waiter retries, preventing mutually deferred reservations from deadlocking. If the final live
interest disappears from a parked preparation, the orchestrator destroys the retained task and its
buffers before releasing the reservation and marking the entry canceled, so temporary accounting
never understates live memory and cannot leak after cancellation.

`AssetManager` exposes `request_*()` and `prefetch_*()` entry points over typed loader-provided
preparation tasks. Texture reads, image decode and mip generation, compiled shader-binary reads,
material setup, and font-source reads now advance as bounded preparation steps; bgfx and text-engine
resource creation/destruction remains owner-thread work and reports source, prepared-CPU, or GPU
residency cost. `TextureAssetRequest` carries runtime preparation capabilities such as retained alpha
coverage directly alongside the runtime path and sampler. Mandatory structured dependencies,
speculative prefetch, and focused preview all propagate that capability on the typed request, so
initial image preparation does not depend on a separately installed requirement or caller ordering.
The separate texture-preparation requirement registry has been removed. Compatible weak and strong
requests use one texture cache identity and one GPU-resident texture: a stronger request can join an
in-flight preparation until its capability set freezes, while a stronger request arriving afterward
performs bounded follow-up enrichment for the missing auxiliary data. Retained alpha coverage uses
that enrichment path to reread/decode source pixels and grow prepared-CPU residency without
recreating, reuploading, or duplicating the GPU texture. Capability joins and successful enrichment
are observable through asset telemetry. Structured dependency deduplication preserves a stronger
speculative capability even when current mandatory content already names the same weaker texture, so
prefetch can union or enrich that resident ahead of use. If Demand joins an in-flight speculative
enrichment, the same job is promoted to blocking priority rather than restarting preparation. Texture
cache identity remains the resolved runtime path plus sampler and `AssetSourceGeneration`; source
generation is the sole runtime content invalidation generation. Export-time compression, resize, and
transcode policy are upstream packaging concerns rather than runtime preparation identity. Image
preparation parses encoded dimensions before decode,
atomically expands its temporary reservation for encoded input, decoder output, upload copies, mip
storage, and scratch, and rejects unsupported or overflowing dimensions before allocating those
buffers. Audio requests now
use concrete preparation tasks as well. SFX source reads and PCM decode advance in bounded 256 KiB
steps; after decoder initialization, the task calculates the complete 48 kHz stereo float size and
expands its temporary reservation before allocating PCM. Unknown or overflowing decoded lengths fail
before unbounded growth. The exact completed PCM cache is charged to the audio domain. Music and
ambience retain a source-bound reader factory rather than encoded file bytes;
miniaudio opens an independent seekable reader through its custom VFS and owns two bounded one-second
decode pages, conservatively charged as 768,000 audio bytes per resident stream source. Playing from
an `AssetLease<AudioAsset>` retains the lease until the voice ends, so active audio cannot be evicted.
The synchronous prepared-asset facade has been removed. Production consumers realize typed resources
only from retained leases or asynchronous request handles: world/material/Layout publication consumes
mandatory leases, ActiveText owns an asynchronous startup font request, and editor preview audio owns
asynchronous Demand requests. ActiveText compares its request/lease generation with `AssetManager`
each refresh, releases stale font state, and reacquires the system font after project/font
reconfiguration. Snapshot-owned audio remains part of the mandatory publication gate. Standalone
causal audio creates a Demand request and holds presentation delivery until its lease is ready;
disposable UI audio creates the same asynchronous request without blocking gameplay, then plays when
ready or is dropped with a diagnostic if loading fails or the operation becomes obsolete. No audio
adapter path assumes that an unpublished lease already exists, and no path falls back to synchronous
loading. Platform export profiles resolve measured Low, Balanced, High, or Custom memory
policy. The runtime enforces both total evictable residency and the configured Warm-prefetch share
while preserving mandatory correctness; the player startup log and telemetry snapshots retain the
fully resolved policy.

`AssetProgressOrchestrator` is the owner-frame progress boundary above `AssetManager`. It derives a
small `Idle`/`Background`/`Blocking` urgency from live typed request state so the engine can choose its
own normal-versus-loading job-service budget without knowing which presentation consumer created the
requests. `AssetRequestReason` remains the preparation/admission priority signal, while
`AssetRequestUrgency` independently states whether a pending consumer blocks host progress. Mandatory
publication and causal audio use `Blocking`; disposable cosmetic audio and editor audio preview use
`Background` even though they retain `Demand` priority. Temporary-reservation release raises a
shared owner-thread wake signal across typed asset domains, and owner-frame servicing retries viable
deferred non-prefetch requests of either urgency; the same deferred scan is also the safety fallback
if a wake signal is missed. Runtime input suppression remains `GameHost` presentation policy and is
not implied by generic Blocking asset work. Speculative prefetch stays Background work and remains
rejectable under memory pressure rather than becoming publication-blocking work. Presentation
consumers do not expose or call deferred-retry APIs; they observe request/publication state while
`AssetProgressOrchestrator` owns deferred progress.

Runtime packages remain one indexed ZIP source. Production never converts a complete `.ntpkg` or all
of its entries into `MemoryAssetSource`; that source remains available for tests and deliberately
assembled tooling fixtures. Web transfers the downloaded archive directly to C++ ownership and never
writes the package to Emscripten's virtual filesystem. Native path-backed ZIP sources retain one open
archive file identity and serve all independent readers through synchronized read-at operations, so
leases and reader factories from an older source generation cannot observe a replacement archive
renamed onto the same pathname. The permanent
`noveltea_production_asset_path_policy` source-policy test rejects reintroduction of those package
copies, synchronous prepared facades, raw/path-based `AudioSystem` playback, stale thread-option
symbols, and synchronous fallbacks in the audited production consumers.

`structured_prefetch.hpp` and `engine/src/assets/structured_prefetch.cpp` own structured dependency
resolution plus the speculative planner boundary. `StructuredAssetDependencyIndex` builds immutable
asset, Layout, material, gameplay, package-size, and image-dimension lookup data from one
`LoadedCompiledPackage` and its prepared resource registries for the active renderer shader variant.
`MandatoryAssetDependencyCollector` emits only the typed dependency closure required by the current
presentation and required system Layouts. It has no Scene/Dialogue/Room speculative traversal and no
prediction buckets. Material closure includes the material, its resolved shader program, and
package-backed static texture assignments while excluding renderer-generated sources such as
`$draw.texture`.

Production Flow speculation resolves semantic predictor output into ranked `PrefetchCandidate`s that
retain execution distance/order, confidence, dependency sub-priority, provenance, and an advisory
`ResidencyCost` estimate. Estimates use package/compiler metadata where available and conservative
type-specific values otherwise; the planner never prepares an asset merely to discover prediction
cost. `PrefetchPlanner` ranks semantic usefulness before cost, admits candidates against the same
configured Warm allowance calculation used by `AssetResidencyManager`, and leaves final residency
admission to that manager. Candidate normalization and semantic expansion are bounded by a generous
4,096-entry structural safety ceiling rather than an author-facing tuning value. Alternative branches
at the same semantic distance do not gain priority from traversal/authored order.

Each meaningful prediction refresh receives a new logical process-unique generation. Reconciliation
keeps equivalent move-only prefetch tickets and migrates their generation/residency interest in place,
attaches new work before obsolete interests are released, and reports retained provenance without
restarting unchanged preparation. Stronger compatible texture capability can still join/enrich through
the ordinary request substrate. If speculative work becomes Demand, the existing orchestrator promotes
or coalesces that same in-flight/resident work. Collector/prediction diagnostics remain
separate: mandatory-closure failures can stop the mandatory gate, while Flow prediction diagnostics
or Warm admission rejection are optimization-only and never invalidate otherwise-correct gameplay.
The existing editor-profiler generation handoff advances on those same meaningful Flow-frontier
replacements, treats retained interests as active entries in the replacement logical generation, and
classifies planner-side Warm rejection as a memory-blocked speculative outcome. Rich prediction-index
and provenance visualization remains a tooling concern rather than a second prediction implementation.

Flow-aware speculative prediction now has a separate tracer-bullet seam from mandatory dependency
closure. The compiler can publish a compact `Flow Prediction Index` in the Compiled Project;
`runtime::FlowPredictor` consumes that metadata and returns semantic dependencies plus execution
distance without walking the covered raw Scene definitions. `resolve_flow_prediction()` maps that
read-only semantic projection through `StructuredAssetDependencyIndex` into a `PrefetchPlan`, and
`PrefetchPlanner` can submit that plan directly through the existing typed prefetch/request/residency
machinery. Scene and Dialogue entry slices expose their immediate presentation dependencies, while a
prospective Room-entry root exposes the target Room presentation plus successful lifecycle Flow. Room
presentation remains a semantic dependency and is expanded through the existing structured dependency
index rather than duplicating an asset snapshot in prediction metadata. Scene execution slices likewise
carry semantic Asset, Character-presentation, Layout, and Material dependencies; resolution expands
those through the same structured dependency index already used by mandatory/prefetch collection.
Dialogue execution slices use the same semantic dependency vocabulary for live Stage/media,
speaker/cue presentation, voice/SFX, Gameplay Command effects, Choices, redirects, child Flow, and
completion. They are keyed to the runtime Dialogue block/segment/edge stage plus cue/effect cursor so
live prediction resumes from the current execution position without replaying Dialogue entry or
already-consumed work.
Execution distance advances with Scene progress and semantic frontiers, while prediction confidence
maps to `ExpectedNext` or `PossibleNext`; unknown typed Conditions, Choices, strong waits, detached
deep continuation, and Lua opacity widen or demote work without assigning probabilities or executing
gameplay. The predictor also publishes semantic execution order, dependency sub-priority, and compact
execution-point provenance; it still performs no residency budgeting itself. Production uses the same predictor for the package entrypoint,
for the authoritative foreground Scene or Dialogue position published by the Runtime Session, and,
once a Room is current, for each adjacent exit as a prospective source-to-target Room transition.
After a completed Room publication commits, production also admits a distinct resident-Room root
containing Interaction/default/fallback programs whose enabled Verb slots can be satisfied by eligible
subjects in that Current Room, plus the relevant action Layouts. Interaction Guards are not executed
just to refine speculation; a guard that cannot be known without actual invocation remains a plausible
alternative. Resident work is resolved through the same dependency index, ranked as `PossibleNext`,
and submitted to the same `PrefetchPlanner`/residency pool as every other speculative candidate. It is
deliberately absent from an adjacent Room's prospective-entry root, so clicking or opening content that
only becomes meaningful after entry does not inflate adjacency prefetch.
Runtime publication updates foreground Flow prediction independently of visual snapshot equality, so
advancing through a Scene or Dialogue can rotate the speculative generation even when rendered
presentation has not changed. The first Scene
publication therefore consumes the entry root once; later publications root prediction at the current
`SceneFramePosition` and do not replay already-consumed Stage/Event dependencies. Adjacent transition
candidates are submitted as `PossibleNext` after the normal mandatory publication transaction commits,
so their lifecycle handoffs can warm before navigation without becoming correctness requirements.
Repeated runtime publications with the same prediction-relevant Scene or Dialogue position do not
rotate the speculative generation; only a changed prediction root/frontier refreshes the active Flow
plan. Resident Room roots follow the same semantic replacement rule: exact root equality causes no
generation churn, while a changed set of plausible programs or Layouts replaces the shared plan.
This is the sole production speculative path. There is no raw-definition direct-next/adjacent walker
or compatibility bucket fallback: Scene, Dialogue, Room lifecycle, resident Room actions, and authored
supplemental hints all enter through the compiled Flow Prediction Index, `FlowPredictor`,
`resolve_flow_prediction()`, and `PrefetchPlanner`. Mandatory publication remains independently driven
by `MandatoryAssetDependencyCollector`; missing prediction metadata or an empty/unsupported projection
therefore disables or degrades prefetch only and never blocks publication or changes gameplay
correctness. The `noveltea_speculative_prefetch_boundary_policy` source-policy test rejects
reintroduction of the retired mixed speculative collector/bucket seam.

Mandatory dependency descriptors are generation-scoped. If the project asset namespace advances to
a new `AssetSourceGeneration` after a package was indexed, such as during editor-preview asset
staging or rebinding, the gate rebuilds its structured dependency index before issuing the next
mandatory publication requests. Request handles, staged leases, and renderer lookups therefore use
the same current-generation cache keys; a Ready request must not be published under a stale
descriptor generation and then appear missing to world presentation. The same check applies while a
mandatory request group is already pending: a mid-flight namespace generation change cancels the
retired group, rebuilds the dependency index, and restarts the retained presentation snapshot against
the new generation before any candidate lease can be promoted.

`StructuredAssetLeaseSet` resolves a resident asset by the ready lease's own authoritative
`AssetCacheKey`, not by the descriptor key captured during dependency collection. Descriptor keys
remain planning metadata and must not make an actually resident lease invisible after request-time
generation changes.

Mandatory publication lifetime is owned by `MandatoryPublicationScope` and its move-only
`MandatoryPublicationTransaction`. A complete ready lease set is staged only when a transaction is
created, remains pinned while the consumer realizes backend state, and replaces the prior committed
publication only after explicit transaction commit. Destroying or explicitly rolling back an
uncommitted transaction releases only candidate state. Commit rechecks `AssetSourceGeneration`, so a
source refresh cannot promote a ready-but-stale candidate while the previous committed publication
remains pinned. Runtime uses its own scope and advances speculative-prefetch generation only after
that transaction commit succeeds. Focused Room, Layout, and Shader preview owns a separate
`FocusedPreview` scope; it realizes against that scope's candidate leases and commits independently
without sharing, replacing, or cancelling runtime publication state. Raw runtime/focused candidate,
published, and predecessor lease slots are private `AssetManager` implementation details reachable
only by the shared publication scope; production consumers cannot stage, commit, roll back, or clear
those slots directly. Lease lookup is scope-aware as well: runtime realization can resolve only the
runtime candidate/current/predecessor publication, while focused-preview realization can resolve
only the focused candidate/current publication. Stable-identity fallback therefore preserves an old
committed publication across source-generation refresh without allowing that retained publication to
satisfy the other scope's realization request. Explicit supplemental tooling leases remain a shared
exact-key fallback behind either publication scope.

Runtime commits may retain one bounded predecessor lease set in addition to the current published
set. Finite world presentation operations can therefore realize their exact source and target
revisions concurrently even though the target snapshot is reconciled before its finite operation is
accepted. When replacing an existing runtime publication, the bridge retains that predecessor across
the handoff and explicitly releases it once no visual operation remains active. The slot remains
bounded to one predecessor, so settled publications do not accumulate historical lease sets.

`asset_telemetry.hpp` and `engine/src/core/asset_telemetry.cpp` define the worker-safe recorder and
the editor-profiler handoff. Events carry execution mode, cache/request/job/prefetch correlation,
actual compressed and uncompressed source totals for fully-read entries, measured source,
preparation, and owner-finalization durations for both successful and failed stages, stable
diagnostic codes, memory snapshots, and exact eviction reasons. Preparation-only work does not emit
placeholder source-read events. Prefetch demand is classified once as late or miss at request time,
used at the first actual Demand lease acquisition, or unused at eviction/invalidation. Completed
prefetch provenance survives stale-ticket release until that lifecycle is claimed or evicted.
Publication telemetry retains candidate staging, explicit commit, rollback, predecessor release,
stale-generation rejection, and source-generation advancement. Runtime and focused-preview
publication events carry stable scope diagnostic codes, while generation-scoped request/cache-key
records and the explicit source-generation advancement event preserve invalidation correlation.
Combined with asset-wait records, budget/rejection events, and capability join/enrichment events,
deepening the operational boundary does not remove the diagnostics needed to explain
blocking/background progress or publication lifetime.
`capture_asset_profiler_snapshot_on_owner()` combines copied asset data
with `JobExecutorSnapshot`; `EngineTooling::asset_profiler_snapshot()` exposes that owning DTO without
granting the editor access to live runtime objects.

The profiler snapshot schema is version `2`. Editor preview/test composition retains an 8,192-event
ring while ordinary player composition retains aggregate data with event capacity zero. The snapshot
boundary adds no editor IPC, MessageChannel command, renderer store, polling loop, or profiler UI;
those remain future consumers of the immutable snapshot boundary.

`noveltea_asset_lifecycle_boundary_policy` certifies the production seam. It rejects reintroduction
of consumer-triggered deferred retry entry points, the removed generation-scoped texture preparation
requirement registry, or raw publication-slot choreography outside `AssetManager` and
`MandatoryPublicationScope`, while requiring runtime, focused preview, and the engine owner-frame to
remain wired to the shared transaction/progress boundaries. Export-time compression, resizing, and
transcoding remain package-construction concerns upstream of this policy; runtime preparation and
publication operate only on the resolved runtime resource and its typed consumption capabilities.

Profiler-enabled preview composition also exposes exact session-scoped memory accounting. Residency
mutations synchronously update per-domain and combined Asset RAM peaks before same-frame releases can
hide transient reservations; end-of-frame history coalesces current residency, Warm-residency, and
exclusive asset-state counts into at most one changed point. bgfx ordinary-texture and render-target
estimates are supplied through an enabled-only renderer adapter, sampled immediately at renderer or
session initialization and then at one-second cadence. Each component remains independently
nullable, Total GPU resources is available only when both are available, and its observed sampled
peak never adds residency GPU attribution a second time. Ordinary player builds compile neither the
profiler service implementation nor the renderer-memory adapter.

## Agent Rules

Do not add a new asset lookup path without documenting ownership, path safety, runtime/export behavior, and editor diagnostics.

When changing authoring asset shape, update `docs/engine/ASSET.md`. When changing runtime asset loading or package layout, update the runtime/export docs as well.
