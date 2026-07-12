# Documentation Overview

## Purpose

This is the top-level map for current NovelTea documentation. Agents should start here when they need project context, then follow the area overview for the code they are changing.

Do not treat `docs/archive/` as current implementation direction. Archive files are historical references only.

## First Documents To Read

- `AGENTS.md` defines root repository rules, migration constraints, and verification expectations.
- `docs/architecture/OVERVIEW.md` routes top-level architecture work.
- `docs/architecture/CXX_RUNTIME_DEPENDENCY_POLICY.md` is the authoritative shipped-C++ dependency
  admission and host-tool exemption policy.
- `docs/build/OVERVIEW.md` routes build, test, and platform verification work.
- The area overview below should be read before changing code in that area.

## Area Entry Points

- `docs/architecture/OVERVIEW.md` — framework architecture, subsystem ownership, initialization, runtime loop, and project/asset loading boundaries.
- `docs/build/OVERVIEW.md` — CMake options, platform builds, shader/toolchain notes, and verification command routing.
- `docs/engine/OVERVIEW.md` — authoring/project entity docs, current implementation files, validation behavior, commands, editor integration, runtime/export status, and known gaps.
- `docs/editor/OVERVIEW.md` — Electron editor architecture, workbench conventions, UI components, previews, ComfyUI workflow import, localization, packaging, and editor verification.
- `docs/runtime/OVERVIEW.md` — runtime state/playback, Lua runtime, shell/layout flow, full-game preview/debugger/test recorder, and package export.
- `docs/rendering/OVERVIEW.md` — bgfx rendering stack, text pipeline, shader/material policy, ActiveText styling, and render-related verification.
- `docs/ui/OVERVIEW.md` — RmlUi runtime UI, custom components, authored event handling, template/document lifecycle, and UI verification.
- `docs/assets/OVERVIEW.md` — asset manager direction and typed asset loading work.
- `docs/migration/OVERVIEW.md` — current migration plan/status, compatibility notes, unmigrated audit, and historical-reference policy.
- `docs/archive/OVERVIEW.md` — historical reports and old planning notes. Read only for background.

## Documentation Maintenance Rules


When a task materially changes behavior, update the narrowest relevant document or explicitly state why no documentation update was needed.

Prefer adding or updating an area overview before adding scattered root-level references. `AGENTS.md` should route agents to top-level documentation entry points; area overviews should route agents to detailed documents.

Stable/current behavior docs live at subsystem roots or in named subsystem directories. Implementation plans live under `plans/`. Historical reports live under `archive/`.

When adding a substantial new editor, runtime, rendering, engine component, build/platform workflow, or integration surface, either add a dedicated document for it or add a clearly named section to the relevant area overview. If the section grows beyond routing/summary information, split it into its own document and link it from the overview.

## Current Audit Notes

- The editor has the most detailed operational docs and should keep using `docs/editor/OVERVIEW.md` as the top entrypoint.
- Engine entity docs are substantial and should remain split per entity under `docs/engine/`.
- Runtime/rendering/UI docs are thinner than editor/engine docs; agents should update them when changing those areas rather than relying only on implementation plans.
- Platform-specific Android/Web packaging behavior is partly documented through build/runtime docs, but it may eventually need a dedicated platform hierarchy if platform work grows.
