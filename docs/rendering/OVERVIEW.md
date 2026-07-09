# Rendering Documentation Overview

## Purpose

Use this entrypoint before changing bgfx renderer behavior, text shaping/layout/rasterization, shader/material runtime policy, ActiveText rendering, RmlUi renderer integration, render perf diagnostics, or platform rendering behavior.

## Current Documents

- `docs/rendering/RENDERING_STACK.md` describes runtime rendering layers, engine 2D rendering, shader/material policy, runtime UI usage, and verification.
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
