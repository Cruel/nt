# Runtime UI Documentation Overview

## Purpose

Use this entrypoint before changing RmlUi runtime UI behavior, authored layouts, custom runtime components, event binding, template/document lifecycle, runtime UI assets, DPI/layout behavior, or system layout mounting.

## Current Documents

- `docs/ui/plans/RMLUI_DATA_MODEL_BINDER_REFACTOR_IMPLEMENTATION_PLAN.md` is the active plan to
  replace role-scoped/native DOM population with a shared RmlUi `noveltea` data model, retain
  ActiveText as a specialized custom element, keep Map on a minimal provisional component path, and
  move Text Log and ordinary runtime controls to authored data-driven RML.
- `docs/ui/BUILT_IN_LAYOUT_AUDIT.md` records the built-in system Layout audit, the completed game-HUD
  replacement, asset URL rules, and the remaining menu redesign units.
- `docs/ui/SYSTEM_LAYOUT_RML_CONTRACT.md` is the authoritative role-by-role reference for system
  Layout slot IDs, custom runtime tags, generated markup hooks, and companion Lua handlers.
- `docs/ui/RMLUI_RUNTIME_UI.md` describes runtime UI direction, asset lookup, document slot IDs, authored event handling, visual assets, encoded namespace paths, DPI/layout, binder architecture, template resolver, and document lifecycle.
- `docs/ui/RMLUI_CUSTOM_COMPONENTS.md` describes initial C++-backed RmlUi custom component candidates and runtime contracts.
- `docs/engine/LAYOUT.md` describes the authored layout entity and editor/runtime/export behavior.
- `docs/rendering/RENDERING_STACK.md` documents how runtime UI uses rendering.

## Code Areas

- The private RuntimeUI facade, RmlUi host, lifecycle contexts, document registry, binder, input,
  ActiveText presenter, playback driver, and bgfx adapter live under `engine/src/ui/rmlui/` and are
  owned by `noveltea_engine`.
- `PresentationLayoutReconciler` and `LayoutRealizer` live under `engine/src/host/`; they own snapshot
  mount identity and mounted-Layout-to-document realization respectively.
- Authored layout schema, commands, validation, and editor behavior live under editor shared and renderer layout editor modules.
- Runtime layout export and shell mounting touches runtime/export services and runtime C++ systems.

## Agent Rules

RmlUi is the general runtime UI layer. Complex game widgets should be C++-backed RmlUi custom elements/components when ordinary RML/buttons are insufficient.

When adding authored layout fields or system layout roles, update `docs/engine/LAYOUT.md` and runtime UI docs together.

Do not add custom ad-hoc runtime UI command attributes when the intended activation path belongs in Lua or the runtime command API.
