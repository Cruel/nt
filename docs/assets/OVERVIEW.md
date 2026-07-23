# Assets Documentation Overview

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
events through `lost_event_count`.

`AssetManager` exposes `request_*()` and `prefetch_*()` entry points over typed loader-provided
preparation tasks. Texture reads, image decode and mip generation, compiled shader-binary reads,
material setup, and font-source reads now advance as bounded preparation steps; bgfx and text-engine
resource creation/destruction remains owner-thread work and reports source, prepared-CPU, or GPU
residency cost. Audio requests now use concrete preparation tasks as well. SFX source reads and PCM
decode advance in bounded 256 KiB steps and retain an exact 48 kHz stereo float cache charged to the
audio domain. Music and ambience retain a source-bound reader factory rather than encoded file bytes;
miniaudio opens an independent seekable reader through its custom VFS and owns two bounded one-second
decode pages, conservatively charged as 768,000 audio bytes per resident stream source. Playing from
an `AssetLease<AudioAsset>` retains the lease until the voice ends, so active audio cannot be evicted.
The synchronous prepared-asset facade has been removed. Production consumers realize typed resources
only from retained leases or asynchronous request handles: world/material/Layout publication consumes
mandatory leases, ActiveText owns an asynchronous startup font request, and editor preview audio owns
asynchronous Demand requests. Missing mandatory leases are publication failures rather than a reason
to load synchronously. Platform export profiles resolve measured Low, Balanced, High, or Custom memory
policy. The runtime enforces both total evictable residency and the configured Warm-prefetch share
while preserving mandatory correctness; the player startup log and telemetry snapshots retain the
fully resolved policy.

Runtime packages remain one indexed ZIP source. Production never converts a complete `.ntpkg` or all
of its entries into `MemoryAssetSource`; that source remains available for tests and deliberately
assembled tooling fixtures. Web transfers the downloaded archive directly to C++ ownership and never
writes the package to Emscripten's virtual filesystem. The permanent
`noveltea_phase_9a_production_asset_paths` source-policy test rejects reintroduction of those package
copies, synchronous prepared facades, raw/path-based `AudioSystem` playback, stale thread-option
symbols, and synchronous fallbacks in the audited production consumers.

`structured_prefetch.hpp` and `engine/src/assets/structured_prefetch.cpp` add the structured
dependency and speculative-generation boundary. `StructuredAssetDependencyIndex` builds immutable
asset, Layout, material, and gameplay lookup data from one `LoadedCompiledPackage` and its prepared
resource registries for the active renderer shader variant. The collector emits typed request
descriptors plus semantic cache keys in current-mandatory, direct-next, and adjacent-alternative
buckets. Material closure includes the material, its resolved shader program, and package-backed
static texture assignments while excluding renderer-generated sources such as `$draw.texture`.
Traversal is deterministic, preserves direct-next precedence, deduplicates across buckets, and stops
cycles without reading assets, decoding media, or evaluating Lua. `PrefetchPlanner` allocates a new
process-unique generation, submits only typed `AssetManager::prefetch_*()` requests, retains the
move-only tickets for that generation, and releases stale tickets only after replacement interests
have been attached. Collector diagnostics retain their semantic bucket: current-publication failures
can stop the mandatory gate, while direct-next and adjacent speculative diagnostics remain observable
without blocking otherwise-valid content. Production runtime publication changes use mandatory asset
gates and loading progress while speculative entries remain evictable.

`asset_telemetry.hpp` and `engine/src/core/asset_telemetry.cpp` define the worker-safe recorder and
the editor-profiler handoff. Events carry execution mode, cache/request/job/prefetch correlation,
actual compressed and uncompressed source totals for fully-read entries, measured source,
preparation, and owner-finalization durations for both successful and failed stages, stable
diagnostic codes, memory snapshots, and exact eviction reasons. Preparation-only work does not emit
placeholder source-read events. Prefetch demand is classified once as late or miss at request time,
used at the first actual Demand lease acquisition, or unused at eviction/invalidation. Completed
prefetch provenance survives stale-ticket release until that lifecycle is claimed or evicted.
`capture_asset_profiler_snapshot_on_owner()` combines copied asset data
with `JobExecutorSnapshot`; `EngineTooling::asset_profiler_snapshot()` exposes that owning DTO without
granting the editor access to live runtime objects.

The profiler snapshot schema is version `2`. Editor preview/test composition retains an 8,192-event
ring while ordinary player composition retains aggregate data with event capacity zero. This phase
adds no editor IPC, MessageChannel command, renderer store, polling loop, or profiler UI; those remain
future consumers of the immutable snapshot boundary.

## Agent Rules

Do not add a new asset lookup path without documenting ownership, path safety, runtime/export behavior, and editor diagnostics.

When changing authoring asset shape, update `docs/engine/ASSET.md`. When changing runtime asset loading or package layout, update the runtime/export docs as well.
