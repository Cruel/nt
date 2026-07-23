# Assets Documentation Overview

## Purpose

Use this entrypoint before changing asset loading, asset metadata, project asset import, package asset export, font/material asset lookup, or typed asset-manager behavior.

## Current Documents

- `docs/engine/ASSET.md` describes the authoring asset entity, editor behavior, validation, runtime/export status, and implementation files.
- `docs/runtime/PACKAGE_EXPORT.md` describes runtime package layout and manifest shape.
- `docs/editor/export/EXPORT_AND_PACKAGING.md` describes the editor export workflow and asset packaging surface.

## Code Areas

- `engine/src/assets/` and related engine headers own runtime asset loading behavior.
- `editor/src/shared/project-schema/authoring-assets*` and editor asset operations own authoring asset schema/commands.
- `editor/src/renderer/editors/assets/` owns the asset library/editor UI.
- Runtime export/package builders live under editor services and shared export code.

## Asynchronous Request and Residency Foundation

`engine/include/noveltea/assets/asset_request_orchestrator.hpp` owns the nonblocking typed request
state machine introduced by the threading/streaming plan. It coalesces equivalent cache keys,
tracks independent consumer and prefetch interest, reprioritizes shared jobs, transfers Ready
reservation pins into copyable leases, and invalidates cache entries by source generation.

`AssetResidencyManager` in `asset_residency.hpp` and `engine/src/assets/asset_residency_manager.cpp`
owns preparation reservations, per-domain memory accounting, Pinned/Warm/Cold classification,
admission, deterministic cost-aware LRU eviction, and owner-thread destruction. Telemetry is an
optional observer and must not influence scheduling or residency decisions.

`AssetManager` exposes compatibility `request_*()` and `prefetch_*()` entry points over the existing
typed loaders. Until the dedicated visual and audio migration workstreams are complete, those
legacy loaders still execute during owner-thread finalization and report zero prepared-resource
cost; source reads/decode migration, backend resource costing, and profile defaults belong to the
later texture/audio/profile workstreams rather than this foundation.

## Agent Rules

Do not add a new asset lookup path without documenting ownership, path safety, runtime/export behavior, and editor diagnostics.

When changing authoring asset shape, update `docs/engine/ASSET.md`. When changing runtime asset loading or package layout, update the runtime/export docs as well.
