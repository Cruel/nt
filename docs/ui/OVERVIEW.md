# Runtime UI Documentation Overview

## Purpose

Use this entrypoint before changing RmlUi runtime UI behavior, authored layouts, custom runtime components, event binding, template/document lifecycle, runtime UI assets, DPI/layout behavior, or system layout mounting.

## Current Documents

- `docs/ui/RMLUI_RUNTIME_UI.md` describes runtime UI direction, asset lookup, document slot IDs, authored event handling, visual assets, encoded namespace paths, DPI/layout, binder architecture, template resolver, and document lifecycle.
- `docs/ui/RMLUI_CUSTOM_COMPONENTS.md` describes initial C++-backed RmlUi custom component candidates and phase contracts.
- `docs/engine/LAYOUT.md` describes the authored layout entity and editor/runtime/export behavior.
- `docs/rendering/RENDERING_STACK.md` documents how runtime UI uses rendering.

## Code Areas

- RmlUi runtime integration lives under engine UI/RmlUi modules.
- Authored layout schema, commands, validation, and editor behavior live under editor shared and renderer layout editor modules.
- Runtime layout export and shell mounting touches runtime/export services and runtime C++ systems.

## Agent Rules

RmlUi is the general runtime UI layer. Complex game widgets should be C++-backed RmlUi custom elements/components when ordinary RML/buttons are insufficient.

When adding authored layout fields or system layout roles, update `docs/engine/LAYOUT.md` and runtime UI docs together.

Do not add custom ad-hoc runtime UI command attributes when the intended activation path belongs in Lua or the runtime command API.
