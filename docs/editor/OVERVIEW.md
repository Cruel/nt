# Editor Documentation Overview

## Purpose

Use this entrypoint before changing the Electron editor under `editor/`. It routes agents to current editor conventions and the specific docs for each major editor subsystem.

`docs/editor/AGENT_GUIDE.md` is the operational guide for editor-wide practices. Read it before editing editor code, then follow the subsystem docs below.

## Required Reading For Editor Work

- `docs/editor/AGENT_GUIDE.md` — editor-wide agent practices, workbench navigation, diagnostics, tab state, preview ownership, localization, UI components, and verification.
- `docs/editor/TECH_STACK.md` — editor dependency and component standards, shadcn/Base UI usage, forms, tables, source editing, preview, localization, and testing standards.
- `docs/editor/LOCALIZATION.md` — current locale status, namespace coverage, and translation conventions.

## Workbench, Tabs, Navigation, and Diagnostics

Workbench navigation, deep links, diagnostics, tab state, and preview ownership rules are currently centralized in `docs/editor/AGENT_GUIDE.md`.

Deep links and diagnostic navigation are currently described by `AGENT_GUIDE.md`. If the system grows enough to need a dedicated document, create one under `docs/editor/workbench/` and link it here instead of adding one-off navigation rules to individual editor docs.

## Preview and Test Playback

- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md` — preview iframe protocol, MessageChannel handshake, IPC, security, commands, events, and preview-managed authoring surfaces.
- `docs/editor/preview/PREVIEW_AND_TEST_PLAYBACK.md` — current preview and authoring-test playback direction.
- `docs/runtime/OVERVIEW.md` — runtime/package/test recorder context that editor preview work must align with.
- `docs/engine/TEST.md` — authoring test editor and playback integration.

## Project and Entity Editor Surfaces

- `docs/editor/project/PROJECT_EXPLORER.md` — project explorer persistence, ordering, categories, context menus, chapters, and visual identity.
- `docs/editor/project/PROJECT_SETTINGS.md` — project settings behavior, stored data, built-in fallbacks, validation, and project-local ComfyUI workflow management.
- `docs/engine/OVERVIEW.md` — component docs for individual project entity editors such as rooms, characters, dialogue, scenes, layouts, shaders, materials, variables, assets, and tests.

## ComfyUI Workflow Integration

- `docs/editor/comfyui/WORKFLOW_IMPORT.md` — user-facing workflow import guidance, node-title conventions, bindings, outputs, and repair.
- `docs/editor/project/PROJECT_SETTINGS.md` — Project Settings entrypoint for installed workflow table, import, repair, and diagnostics.

When changing ComfyUI workflows, update the user-facing import doc when behavior or validation changes.

## Export and Packaging

- `docs/editor/export/EXPORT_AND_PACKAGING.md` — editor export/package workflow, profiles, authoring-to-runtime export builder, assets, shaders, IPC surface, and verification.
- `docs/runtime/PACKAGE_EXPORT.md` — runtime package layout and manifest details.

## Plans

- `docs/editor/plans/IMPLEMENTATION_PLAN.md` — broad editor implementation plan and workbench/project-service architecture.
- `docs/editor/plans/MILESTONE_1_WORKBENCH_PLAN.md` — workbench shell milestone plan.

Plans should not silently become stale. If a plan phase is complete or superseded, update its status notes or move durable behavior into a current subsystem doc.

## Editor Rules To Keep Centralized

- Use shadcn/Base UI components where appropriate. Keep generated component files close to upstream output.
- Stable user-facing strings belong in `editor/src/renderer/i18n/locales/`. Keep `en-US` as source copy and other maintained locales key-compatible.
- Use whole-message i18n keys with interpolation, not concatenated sentence fragments.
- Use the editor formatting helpers for locale-aware dates, times, relative time, numbers, percentages, and file sizes.
- Do not add or restore a native Electron application menu; the editor owns app chrome in renderer UI.
- Avoid one-off window events for navigation. Workbench navigation/deep-link behavior should be centralized.
- Tab state and preview ownership rules are documented in `docs/editor/AGENT_GUIDE.md` until a tracked workbench behavior doc is added.

## Verification

For editor code changes, run the narrow relevant tests first when useful, then finish with:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

If UI behavior changes, run the editor app or a narrow UI smoke test when practical. Report any environment limitation explicitly.
