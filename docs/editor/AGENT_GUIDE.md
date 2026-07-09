# Editor Agent Guide

## Purpose

This is the operational guide for agentic work on the Electron editor. `docs/editor/OVERVIEW.md` is the editor documentation entrypoint; read that overview and this guide before editing code under `editor/`, then follow the more specific documents linked below for the area being changed.

The goal is to keep editor work consistent across many agent sessions. Cross-cutting behavior should be documented here or linked from here instead of being rediscovered from individual components.

## Current Editor Direction

- The editor is the new Electron/TanStack/Vite editor, not the old Qt editor.
- The editor should be new-engine-first. Do not preserve old NovelTea editor behavior unless the current task explicitly requires it.
- The workbench is the main shell for editor tabs, project-scoped tools, global tools, preview panes, tab state, and navigation.
- User-facing editor features should behave like a normal multi-tab editor: opening a record focuses the relevant tab, switching tabs preserves user-facing state, and diagnostics or validation messages should take the user directly to the problematic location whenever possible.

## Documentation Map

Use these documents as the main references for editor work:

- `docs/editor/OVERVIEW.md` is the editor documentation map.
- `docs/editor/TECH_STACK.md` describes the editor technology direction.
- `docs/editor/plans/MILESTONE_1_WORKBENCH_PLAN.md` describes the workbench milestone direction.
- the editor agent guide describes tab-state preservation and preview host ownership.
- `docs/editor/LOCALIZATION.md` describes localization status and conventions.
- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md` describes renderer-to-preview communication.
- `docs/editor/preview/PREVIEW_AND_TEST_PLAYBACK.md` describes preview and test playback direction.
- `docs/editor/project/PROJECT_EXPLORER.md` describes project explorer behavior.
- `docs/editor/project/PROJECT_SETTINGS.md` describes project settings behavior.
- `docs/editor/export/EXPORT_AND_PACKAGING.md` describes export and packaging behavior.

When a task materially changes one of these areas, update the relevant document or explicitly report why no documentation change was needed.

## Editor-Wide Practices

### Workbench Navigation and Deep Links

Do not add one-off `window` events or editor-local scroll callback props for navigation between editor surfaces. Use a workbench-level navigation/deep-link mechanism so links to settings sections, project settings sections, source sections, record fields, and diagnostics all behave consistently.

Tabs should still deduplicate by their stable workbench resource identity. A target inside the tab, such as `settings.comfyui` or `layout.source.rcss`, must not become part of the tab ID or `resource.stableId` unless the target is genuinely a different resource.

Explicit navigation should win over restored tab state. If a tab restores scroll/source/splitter state on activation and a user action requested a target, the target reveal should run after restoration.

### Diagnostics and Validation Messages

Diagnostics displayed in the editor should be actionable when they refer to project/editor data. If a diagnostic includes a JSON-pointer-like path or entity reference, the UI should attempt to resolve it to a workbench target and render the diagnostic as clickable.

Clickable diagnostics should open or focus the relevant tab, scroll to the closest meaningful section or field, and briefly highlight the destination. If exact field-level navigation is not available yet, link to the closest section and document the limitation in the implementation plan or follow-up notes.

Do not duplicate diagnostic card markup across editors when adding new diagnostic surfaces. Prefer a shared diagnostic list/card component that accepts severity, message, path/detail, and an optional navigation target.

### Tab State

Open tabs should preserve expected user-facing state: scroll positions, source-editor selection/scroll, selected panels, split sizes, graph viewports, and similar state. See the editor agent guide before changing tab mounting, restoration, or preview ownership.

### Preview Ownership

Preview iframe/runtime ownership must follow the preview pooling plan. Derived entity previews should not create ad-hoc iframe hosts when a pooled `PreviewPane`/`PreviewHostPool` path exists or is planned for that editor type. Stateful runtime previews should keep their dedicated lifecycle explicit.

### Localization

Stable user-facing strings should use i18n resources under `editor/src/renderer/i18n/locales/`. Keep `en-US` as the source locale and keep other maintained locales key-compatible. Fast-moving experimental text may stay inline only while the UI is still unstable.

### UI Components

Use shadcn Base UI components whenever an appropriate component exists. Keep generated components close to upstream output and adapt usage code rather than rewriting generated primitives.

## Verification

For editor changes, run the smallest relevant checks first, but finish with the standard editor checks unless the environment blocks them:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

Run the editor application or a narrow UI smoke test for changes that affect rendering, interaction, routing, preview behavior, or workbench navigation. If a full app run is not practical, state that and list the closest completed verification.
