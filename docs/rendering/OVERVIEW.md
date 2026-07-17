# Rendering Documentation Overview

## Purpose

Use this entrypoint before changing bgfx renderer behavior, text shaping/layout/rasterization, shader/material runtime policy, ActiveText rendering, RmlUi renderer integration, render perf diagnostics, or platform rendering behavior.

## Current Documents

- `docs/rendering/RENDERING_STACK.md` describes runtime rendering layers, engine 2D rendering, shader/material policy, runtime UI usage, and verification.
- `docs/rendering/ANIMATION_AND_TWEENING.md` defines the backend-local tween boundary, Twink
  integration, clock ownership, lifecycle restrictions, and intended presentation/UI consumers.
- `docs/rendering/PRESENTATION_STATE_AND_TRANSITION_SPEC.md` defines the normative backend-neutral
  desired-presentation, scoped ownership, immutable snapshot, Room/Scene transition, finite-operation,
  Layout, audio-intent, checkpoint, and reconstruction contracts that govern the unfinished
  presentation implementation phases.
- `docs/rendering/plans/PRESENTATION_COORDINATOR_AND_RUNTIME_LAYOUT_IMPLEMENTATION_PLAN.md` preserves
  completed checkpoint/clock/Layout/coordinator/RmlUi work and orders the remaining world/Room,
  scoped-presentation, renderer, transition, audio, checkpoint, menu, and consumer-cutover work.
- Presentation Phase 9C binds checkpoint metadata and optional PNG thumbnails to the exact retained
  save and displayed presentation revision. Runtime publications and preview/editor protocol output
  expose readiness, replay distance, reconstructible activity, retained metadata, and thumbnail state
  without permitting a safety override.
- `docs/rendering/TEXT_IMPLEMENTATION.md` describes the current text pipeline, dependencies, atlas strategy, font styling, and deferred work.
- `docs/rendering/plans/SHADER_MATERIAL_PLAN.md` describes shader/material schema, runtime architecture, editor/import compilation, package/export integration, and current phase status.
- `docs/rendering/plans/ACTIVE_TEXT_FONT_RESOLVER_IMPLEMENTATION_PLAN.md` describes font-family resolution and styled-span shaping work.
- `docs/rendering/plans/TEXT_FONT_STYLE_PLAN.md` describes text font style and synthetic styling direction.
- `docs/ui/RMLUI_RUNTIME_UI.md` and `docs/ui/RMLUI_CUSTOM_COMPONENTS.md` cover runtime UI behavior layered on rendering.

## Code Areas

- bgfx renderer code and shader loading live under `engine/src/render*` and related shader/material modules.
- Text shaping/layout/rasterization code lives under `engine/src/text*` or equivalent text modules.
- RmlUi renderer integration lives under the engine UI/RmlUi renderer modules.
- Shader/material authoring and editor compilation also touches `editor/src/shared/`, editor services, and shader/material editors.

## Agent Rules

Keep backend-neutral text/layout/state separate from bgfx submission and platform windowing details.

When changing shaders/materials, update both rendering docs and engine component docs for `SHADER` / `MATERIAL` when authoring data changes.

When changing RmlUi renderer behavior, update rendering docs and `docs/ui/OVERVIEW.md` or the relevant RmlUi doc.
