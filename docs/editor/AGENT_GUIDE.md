# Editor Agent Guide

## Purpose

This is the operational guide for agentic work on the Electron editor. `docs/editor/OVERVIEW.md` is the editor documentation entrypoint; read that overview and this guide before editing code under `editor/`, then follow the more specific documents linked below for the area being changed.

The goal is to keep editor work consistent across many agent sessions. Cross-cutting behavior should be documented here or linked from here instead of being rediscovered from individual components.

## Current Editor Direction

- The editor is the new Electron/TanStack/Vite editor, not the old Qt editor.
- The editor should be new-engine-first. Do not preserve old NovelTea editor behavior unless the current task explicitly requires it.
- Every versioned editor boundary follows `docs/architecture/SCHEMA_VERSION_POLICY.md`: normal open,
  restore, preview, cache, and export readers accept only their declared current identity/version and
  reject or discard incompatible state instead of migrating it.
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

Each editor tab-state or serializable draft owner must declare its exact schema identity and version.
The shared restoration boundary discards a mismatch before invoking editor-specific restore logic.

### Diagnostics and Validation Messages

Diagnostics displayed in the editor should be actionable when they refer to project/editor data. If a diagnostic includes a JSON-pointer-like path or entity reference, the UI should attempt to resolve it to a workbench target and render the diagnostic as clickable.

Ordinary project validation warnings and errors belong in the Problems panel, not as summary cards in record editor bodies. Record tabs and matching Project Explorer items should reflect their highest current diagnostic severity so users can locate affected records without sacrificing editor space. Project Explorer collection rows should also show compact warning and error counts alongside their record count. Keep technical diagnostic paths hidden from ordinary users and show them in Problems only when Developer Mode is enabled.

Developer Mode is an editor-wide persisted preference that defaults off. Use it for optional technical detail or developer-focused behavior; ordinary editing, validation, and navigation must not depend on enabling it.

Clickable diagnostics should open or focus the relevant tab, scroll to the closest meaningful section or field, and briefly highlight the destination. If exact field-level navigation is not available yet, link to the closest section and document the limitation in the implementation plan or follow-up notes.

Do not duplicate diagnostic card markup across editors when adding new diagnostic surfaces. Prefer a shared diagnostic list/card component that accepts severity, message, path/detail, and an optional navigation target.

### Project Save and Structural Persistence

`Ctrl+S` saves only the active tab's logical save unit. Resolve ownership through
`project/save-unit-registry.ts`; never replace this with a full working-document write. Save All
selects the maximal stable valid set, writes it once, and leaves blocked units dirty. Save As is a
copy of the saved baseline plus complete editor metadata and recovery overlays, so it preserves dirty
work without committing it or changing the active project identity.

Project and window close flush editor metadata/recovery only. They must not commit content. Closing a
non-final duplicate tab never prompts; the final dirty view uses the shared Save / Don't Save /
Cancel save-unit dialog.

Structural `auto-commit` commands must be classified by
`docs/editor/project/PROJECT_STRUCTURAL_COMMAND_PERSISTENCE.md` and produce an `AutoCommitPlan`.
Do not add an ad-hoc filesystem write or call the legacy full-project save after a command. Persisted
Undo/Redo, recovery rebase, identity remap, and the declared unsafe policy belong to the structural
persistence coordinator.

The complete save-unit ownership and recovery contract is documented in
`docs/editor/project/PROJECT_SAVE_UNITS_AND_RECOVERY.md`. Diagnostic producers and boundary owners
must remain consistent with `docs/editor/project/PROJECT_VALIDATION_DIAGNOSTIC_MATRIX.md`.
The latest repository-level certification record is
`docs/editor/project/PROJECT_VALIDATION_AND_SAVING_CERTIFICATION.md`.

### Tab State

Open tabs should preserve expected user-facing state: scroll positions, source-editor selection/scroll, selected panels, split sizes, graph viewports, and similar state. See the editor agent guide before changing tab mounting, restoration, or preview ownership.

For any tab with a collapsible preview widget, preview collapse is tab-scoped view state. Collapsing
one tab must not collapse other tabs, while the expanded preview size remains an editor-wide
orientation-specific preference. A collapsed preview releases its active preview lease so the
retained dedicated host follows the same inactive pacing and visibility behavior as an open tab that
is not currently visible.

Tabs with collapsible preview widgets expose preview visibility through the tab context menu, the
renderer-owned View menu, and the Command Palette. These entry points share one tab-state command; do
not add editor-local floating controls or independent visibility state. Tabs without that capability
omit the context-menu item, while the stable View-menu item remains disabled. No default keyboard
shortcut is assigned.

Restore project-scoped tabs only after the opened document has passed the current authoring-project schema check. An unsupported or legacy project must clear project-scoped tabs instead of attempting to restore its saved editor session.

Editors registered as `keep-mounted-while-open` are owned by the stable
workbench host layer, not a tab group. Moving or docking one must preserve its
React subtree and live resources; cross-group state capture must not be restored
over that still-mounted state. See
`docs/editor/workbench/PERSISTENT_EDITOR_HOSTS.md` for the complete contract.

### Preview Ownership

Preview iframe/runtime ownership is separate from editor mounting. Built-in derived entity editors
remain `active-only`, but their visual preview uses a workbench-hosted `dedicated-while-open` iframe
keyed by tab ID. Switching tabs, moving between existing groups, and edge docking may remount the
editor subtree while retaining that tab's iframe and engine state. Closing the tab removes the host.
Use `pooled-per-tab-group` only as an explicit logical allocation policy when semantic host reuse is
intentionally required and covered by transfer tests; pooled iframe DOM ownership still belongs to
the stable workbench manager. Stateful runtime previews keep their dedicated lifecycle explicit.

The Play editor is the stronger persistence case: both its editor subtree and its audio-capable
preview stay mounted for the open-tab lifetime. Derived preview iframes are visual-only, audio-off by
default, and suspended while inactive. See `docs/editor/workbench/PERSISTENT_EDITOR_HOSTS.md`.

### Localization

Stable user-facing strings should use i18n resources under `editor/src/renderer/i18n/locales/`. Keep `en-US` as the source locale and keep other maintained locales key-compatible. Fast-moving experimental text may stay inline only while the UI is still unstable.

### UI Components

Use shadcn Base UI components whenever an appropriate component exists. Keep generated components close to upstream output and adapt usage code rather than rewriting generated primitives.

Editors that divide a large form into a left category rail must use
`editor/src/renderer/components/CategorizedEditorLayout.tsx`. This shared shell owns the responsive
vertical/sidebar and narrow horizontal navigation patterns, active-category accessibility state,
optional category counts, content scrolling, header placement, and sidebar footer. Settings, Project
Settings, and the Room editor use this same component; do not create editor-local copies of the
category list layout or its responsive behavior.

Editor-wide Settings and Project Settings share the compact category-selector layout. Keep new
settings in the narrowest existing category where possible; when adding a category, preserve the
responsive horizontal selector used by narrow editor panes and map workbench targets to the owning
category so deep links do not point at unrendered content.

The editor-wide Reset All Settings action lives in the category sidebar footer. It is explicitly
editor-wide, requires confirmation, and restores every visible settings category rather than only
the selected category. The Command Palette exposes the same action and routes through the same
Settings confirmation dialog rather than maintaining a second reset implementation. Both entry
points are disabled when the resettable preference store and the platform-dependent native-frame
preference already match their defaults.

## Verification

For editor changes, run the smallest relevant checks first, but finish with the standard editor checks unless the environment blocks them:

```sh
pnpm -C editor run check
pnpm -C editor run test
```

Run `pnpm -C editor run build` when build configuration, main/preload code, shared production code, or Node
tools change. Distribution changes additionally require the stage, package verification, and package
smoke commands in `docs/editor/BUILD_AND_DISTRIBUTION.md`.

Run the editor application or a narrow UI smoke test for changes that affect rendering, interaction, routing, preview behavior, or workbench navigation. If a full app run is not practical, state that and list the closest completed verification.
