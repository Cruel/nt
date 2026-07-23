# Assets Documentation Overview

## Purpose

Use this entrypoint before changing asset loading, asset metadata, project asset import, package asset export, font/material asset lookup, or typed asset-manager behavior.

## Current Documents

- `docs/engine/ASSET.md` describes the authoring asset entity, editor behavior, validation, runtime/export status, and implementation files.
- `docs/runtime/PACKAGE_EXPORT.md` describes runtime package layout and manifest shape.
- `docs/editor/export/EXPORT_AND_PACKAGING.md` describes the editor export workflow and asset packaging surface.
- `docs/assets/ASSET_MEMORY_PROFILES.md` records measured residency units, target presets, Custom
  validation, and runtime pressure semantics.

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
optional observer and must not influence scheduling or residency decisions.

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
The synchronous typed load methods remain compatibility paths, although long-form synchronous audio
also uses seekable streaming rather than whole-file `AssetBlob` residency. Platform export profiles
now resolve measured Low, Balanced, High, or Custom memory policy. The runtime enforces both total
evictable residency and the configured Warm-prefetch share while preserving mandatory correctness;
the player startup log and telemetry snapshots retain the fully resolved policy.

## Agent Rules

Do not add a new asset lookup path without documenting ownership, path safety, runtime/export behavior, and editor diagnostics.

When changing authoring asset shape, update `docs/engine/ASSET.md`. When changing runtime asset loading or package layout, update the runtime/export docs as well.
