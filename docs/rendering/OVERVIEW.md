# Rendering Documentation Overview

## Purpose

Use this entrypoint before changing bgfx renderer behavior, text shaping/layout/rasterization, shader/material runtime policy, ActiveText rendering, RmlUi renderer integration, render perf diagnostics, or platform rendering behavior.

## Current Documents

- `docs/rendering/RENDERING_STACK.md` describes runtime rendering layers, engine 2D rendering, shader/material policy, runtime UI usage, and verification.
- `docs/rendering/ANIMATION_AND_TWEENING.md` defines the backend-local tween boundary, Twink
  integration, clock ownership, lifecycle restrictions, and intended presentation/UI consumers.
- `docs/rendering/PRESENTATION_STATE_AND_TRANSITION_SPEC.md` defines the normative backend-neutral
  desired-presentation, scoped ownership, immutable snapshot, Room/Scene transition, finite-operation,
  Layout, audio-intent, checkpoint, and reconstruction contracts implemented by the current
  presentation/runtime stack.
- `docs/rendering/REFERENCE_RESOLUTION_AND_PRESENTATION_SPEC.md` defines the normative project
  reference frame, host and fitted-viewport domains, world/UI raster policies, RmlUi layout and media
  environments, input projection, raster snapping, transition/postprocess composition, preview
  sizing, and fitted-viewport capture contracts.
- Checkpoint integration binds metadata and optional PNG thumbnails to the exact retained
  save and displayed presentation revision. Runtime publications and preview/editor protocol output
  expose readiness, replay distance, reconstructible activity, retained metadata, and thumbnail state
  without permitting a safety override.
- `docs/rendering/TEXT_IMPLEMENTATION.md` describes the current text pipeline, dependencies, atlas strategy, font styling, and deferred work.
- `docs/rendering/plans/SHADER_MATERIAL_PLAN.md` describes shader/material schema, runtime architecture, editor/import compilation, package/export integration, and current implementation status.
- `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md` describes font-family resolution and styled-span shaping work.
- `docs/rendering/plans/TEXT_FONT_STYLE_PLAN.md` describes text font style and synthetic styling direction.
- `docs/ui/RMLUI_RUNTIME_UI.md` and `docs/ui/RMLUI_CUSTOM_COMPONENTS.md` cover runtime UI behavior layered on rendering.

## Code Areas

- Backend-neutral presentation projection and operation coordination live under
  `engine/src/presentation/` in `noveltea_presentation`.
- bgfx renderer code and shader loading live under `engine/src/render/bgfx/` in `noveltea_engine`;
  backend-neutral shader/material contracts and content codecs remain in their classified modules.
- Text shaping/layout/rasterization code lives under `engine/src/text/` in `noveltea_engine`.
- RmlUi renderer integration lives under `engine/src/ui/rmlui/` in `noveltea_engine`.
- Shader/material authoring and editor compilation also touches `editor/src/shared/`, editor services, and shader/material editors.

Production world draws, material/shader programs, package-backed material textures, mounted-Layout
fonts, and ActiveText font sources are residency-managed resources. World and Layout publication retain
their mandatory leases, the bgfx material binder borrows only resident lease handles and owns no
duplicate raw texture cache, and ActiveText owns an asynchronous startup font request/lease. Missing
mandatory leases are diagnostics and publication failures rather than synchronous loading fallbacks.
Direct renderer font loading in the sandbox demonstration harness is a tooling-only backend exercise,
not an `AssetManager` production path.

## Agent Rules

Keep backend-neutral text/layout/state separate from bgfx submission and platform windowing details.

When changing shaders/materials, update both rendering docs and engine component docs for `SHADER` / `MATERIAL` when authoring data changes.

When changing RmlUi renderer behavior, update rendering docs and `docs/ui/OVERVIEW.md` or the relevant RmlUi doc.
