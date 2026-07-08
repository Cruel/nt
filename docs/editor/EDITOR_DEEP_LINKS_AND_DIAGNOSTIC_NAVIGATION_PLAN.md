# Editor Deep Links and Diagnostic Navigation Implementation Plan

## Purpose

The editor needs a reusable way to navigate to a location inside an existing or newly opened workbench tab. The immediate regression is that the image generation editor's **Open ComfyUI Settings** button now opens the editor-wide Settings tab but no longer scrolls to the ComfyUI settings card. The older project-settings-only `noveltea:project-settings-scroll` event is now stale and too narrow.

The broader requirement is that diagnostics and validation messages should be actionable. A diagnostic card such as:

```text
warning /characters/dfs/data/preview
Selected pose/expression has no sprite asset yet.
```

should be clickable and should open or focus the Character editor for `dfs`, reveal the preview pose/expression area, and briefly emphasize the target.

This plan creates a general workbench target/deep-link system and then routes diagnostics through it.

## Current Code Observations

- `ImageGenerationEditor.openComfyUiSettings()` currently calls `openWorkbenchTab(buildSettingsTab())`, which opens/focuses the Settings tab but does not reveal `settings.comfyui`.
- `ProjectSettingsEditor` still contains an editor-local `window` listener for `noveltea:project-settings-scroll` and a `comfyUiSectionRef`. Search currently finds the listener but no active dispatcher, so this code is obsolete.
- `openWorkbenchTab` already deduplicates tabs by `editorType + resource.stableId`. Deep-link target data should not alter tab identity.
- Editors already have scroll containers and local sections, but section identity is not standardized. Examples include Settings cards, Project Settings cards, Layout source sections, and diagnostics panels.
- Diagnostics are currently rendered ad hoc in many editors. Most include a `path`, but the UI generally treats the path as inert text.

## Design Goals

1. One workbench-level navigation path for "open/focus this tab, reveal this thing inside it".
2. No new one-off global DOM/window events for editor navigation.
3. Deep-link targets must be short-lived navigation requests, not part of tab identity.
4. Explicit navigation must run after normal tab-state restoration and must win over restored scroll state.
5. Simple section navigation should be declarative with DOM anchors.
6. Complex navigation, such as CodeMirror line/column or graph node selection, should be possible through optional editor handlers without rewriting the system.
7. Diagnostics with paths or entity refs should resolve to the closest useful workbench target and should be clickable when a resolver exists.
8. Broken or unresolved diagnostic paths should remain visible as plain diagnostics; do not pretend navigation exists if it cannot be resolved.

## Core Concepts

### Workbench target request

Add a workbench navigation module, likely `editor/src/renderer/workbench/workbench-navigation.ts`, with types like:

```ts
export interface WorkbenchRevealTarget {
  id: string;
  block?: ScrollLogicalPosition;
  inline?: ScrollLogicalPosition;
  flash?: boolean;
  focus?: boolean;
  payload?: unknown;
}

export interface WorkbenchNavigationRequest {
  tab: WorkbenchTab;
  target?: WorkbenchRevealTarget;
  options?: OpenWorkbenchTabOptions;
}
```

The helper should enqueue the target against the tab's workbench resource key, then open/focus the tab:

```ts
navigateToWorkbenchTarget({
  tab: buildSettingsTab(),
  target: { id: 'settings.comfyui', block: 'center', flash: true },
});
```

The target should be consumed once the relevant tab is active. Repeated clicks should issue a new target request even if the tab is already active.

### Declarative anchors

Simple targets should be declared in editor markup:

```tsx
<Card data-workbench-anchor="settings.comfyui">
  ...
</Card>
```

`WorkbenchEditorPane` or a dedicated hook used by it should locate `[data-workbench-anchor="..."]`, call `scrollIntoView`, and apply a short-lived flash marker such as `data-workbench-anchor-flash`.

### Flash behavior

Add a shared CSS animation for target emphasis. It should be visible but not disruptive: approximately one second, outline/ring based, and compatible with light/dark themes. Prefer data attributes over custom per-editor classes.

### Optional imperative handlers

Some destinations are not a plain DOM section. Add an optional per-tab handler registry after declarative anchors are working:

```ts
registerWorkbenchTargetHandler(tab.id, 'layout.source.rcss', (target) => {
  // scroll section, focus SourceEditor, optionally reveal line/column later
});
```

The initial implementation can defer exact CodeMirror line/column navigation, but the system should leave space for it.

## Standard Anchor IDs

Start with a stable, documented string namespace:

```text
settings.theme
settings.codeEditor
settings.language
settings.window
settings.workspace
settings.preview
settings.comfyui

projectSettings.metadata
projectSettings.startup
projectSettings.runtime
projectSettings.titleScreen
projectSettings.packageIdentity
projectSettings.comfyuiWorkflows
projectSettings.exportReadiness
projectSettings.diagnostics

layout.summary
layout.source.rml
layout.source.rcss
layout.source.lua
layout.sampleState
layout.dependencies
layout.diagnostics

character.summary
character.defaults
character.preview
character.poses
character.expressions
character.diagnostics

room.summary
room.description
room.background
room.paths
room.hotspots
room.overlays
room.scripts
room.diagnostics
```

Add more anchor IDs as editors are integrated. Keep IDs semantic and stable; do not encode translated labels.

## Diagnostic Navigation Model

Create a shared renderer-side diagnostic shape, likely in `editor/src/renderer/diagnostics/`:

```ts
export interface EditorDiagnosticItem {
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  category?: string;
  target?: WorkbenchNavigationRequest;
}
```

Add a reusable `DiagnosticList` / `DiagnosticCard` component that renders severity, message, path/detail, and optional navigation affordance. If `target` exists, the entire card or a clear "Go to" button should call `navigateToWorkbenchTarget(target)`. Avoid forcing users to click only the small path text.

### Path resolver

Add a resolver that maps project diagnostic paths to tabs and anchors:

```ts
resolveProjectDiagnosticTarget(project, diagnostic.path)
```

The resolver should parse JSON-pointer-like paths and return the closest meaningful target. Examples:

- `/characters/dfs/data/preview` -> `buildCharacterDetailTabForRecord('dfs', label)`, target `character.preview`.
- `/characters/dfs/data/poses/2/sprite/$ref` -> Character tab, target `character.poses` initially; later exact pose row.
- `/layouts/room_1/data/rcss/sourceText` -> Layout tab, target `layout.source.rcss`.
- `/settings/ui/systemLayouts/title/$ref` -> Project Settings tab, target `projectSettings.runtime` or a future system-layouts anchor.
- `/entrypoint` -> Project Settings tab, target `projectSettings.runtime` or `projectSettings.exportReadiness` depending on the displayed surface.

Resolver behavior should favor useful navigation over perfect precision. Field-level precision can be added incrementally through editor-specific handlers.

## Implementation Status

Status: implemented for coarse section-level navigation and current row-level collection targets. Keep this plan until the source-position follow-ups below are complete.

Completed:

- Phase 0: editor guide and plan are present, and root `AGENTS.md` points editor work at the guide.
- Phase 1: `workbench-navigation.ts` provides target request types, target queueing, resource-key matching, consume-on-active behavior, and repeated target reissue behavior.
- Phase 2: `WorkbenchEditorPane` reveals `[data-workbench-anchor="..."]` targets after tab-state restoration, applies `data-workbench-anchor-flash`, and has regression coverage for DOM reveal/flash.
- Phase 3: Settings and Project Settings have standard anchors, the Image Generation ComfyUI button navigates to `settings.comfyui`, and the stale `noveltea:project-settings-scroll` listener/ref path has been removed.
- Phase 4: shared `DiagnosticList` / `DiagnosticCard` components render plain and clickable diagnostics.
- Phase 5: `resolveProjectDiagnosticTarget(project, path)` handles JSON-pointer-like project paths for characters, layouts, rooms, project settings, entrypoint, dialogues, scenes, tests, assets, materials, shaders, variables, and unknown-path fallback.
- Phase 6: shared diagnostic navigation is integrated into Character, Layout, Room, Dialogue, Scene, Test, Project Settings, Problems, Command History, and Package Export surfaces where project paths can be resolved.
- Phase 7: an optional per-tab target handler registry exists, including prefix handlers for dynamic row targets; `SourceEditorHandle.focus()` / `SourceEditorHandle.revealLine()` provide source-editor plumbing for later source-position targets.
- Phase 8: row-level diagnostic navigation is implemented for character poses/expressions, room hotspots, scene steps, dialogue blocks/segments/edges, and test steps/assertions. Stateful editors update the active row before reveal where needed.
- Phase 9 partial: automated lint, typecheck, and tests pass for the current implementation; obsolete project-settings navigation events are removed.

Remaining:

- Exact source line/column diagnostic navigation is not wired end to end. The `SourceEditor` handle supports line reveal, but current validators generally do not emit reliable line/column/range payloads.
- Diagnostic target payloads do not yet include source-editor keys or ranges. Add these once validators or tool diagnostics can identify exact RML/RCSS/Lua/JSON positions.
- Runtime, preview, shader-compile, and other tool diagnostics remain plain unless they provide authoring-project JSON-pointer paths or future source-position metadata that can be mapped safely.
- A manual Electron smoke pass is still recommended for visual confirmation of the ComfyUI settings deep link and clickable diagnostics, even though automated coverage exists.

## Implementation Phases

### Phase 0: Documentation and conventions

- Add `docs/editor/EDITOR_AGENT_GUIDE.md` as the editor documentation entrypoint.
- Reference the guide from root `AGENTS.md` so agents know to read it before editor work.
- Add this implementation plan and link it from the guide.
- Record the rule that diagnostics should be actionable when they contain a resolvable path or entity reference.

### Phase 1: Workbench target plumbing

- Add `workbench-navigation.ts` with `navigateToWorkbenchTarget`, target request types, pending target storage, and helper functions for matching targets to existing tabs.
- Reuse the same conceptual resource key as `openWorkbenchTab` uses: `editorType + resource.stableId`.
- Ensure a target request can be queued before the destination tab is mounted.
- Ensure a second request to the same active tab is still consumed and replays the reveal/flash.
- Add focused unit tests for queuing, consuming once, and replacing/reissuing requests.

### Phase 2: Anchor reveal and flash

- Teach `WorkbenchEditorPane` to consume pending targets when active.
- Implement generic DOM reveal for `[data-workbench-anchor="target.id"]`.
- Schedule reveal after tab-state restoration. Use `requestAnimationFrame` sequencing so explicit navigation is not overwritten by restored scroll state.
- Add the shared flash CSS/data attribute behavior.
- Add tests using a mock editor pane with scrollable content and anchor targets.

### Phase 3: Settings and Project Settings integration

- Add standard anchors to Settings cards, especially `settings.comfyui`.
- Replace `ImageGenerationEditor.openComfyUiSettings()` with `navigateToWorkbenchTarget({ tab: buildSettingsTab(), target: { id: 'settings.comfyui', block: 'center', flash: true } })`.
- Remove `ProjectSettingsEditor`'s obsolete `noveltea:project-settings-scroll` listener and `comfyUiSectionRef`.
- Add project settings anchors, including `projectSettings.comfyuiWorkflows` for project-local workflow files.
- Update existing tests for the ComfyUI settings button to assert that the navigation helper is called or that the pending target exists.

### Phase 4: Shared diagnostic UI

- Add `DiagnosticCard` and `DiagnosticList` components for editor diagnostics.
- Support non-clickable diagnostics, clickable diagnostics, path display, category display, and severity styling.
- Replace at least one ad hoc diagnostic block with the shared component to validate the API.
- Keep the component presentation close to current editor styling: compact cards, severity badge, monospace path, short message.

### Phase 5: Project diagnostic target resolver

- Implement `resolveProjectDiagnosticTarget(project, path)` in a renderer-side diagnostics module.
- Parse enough JSON pointer structure to identify collection, record id, and coarse section.
- Use existing tab builders from `editor-registry.tsx`.
- Add tests for common path families: characters, layouts, rooms, project settings, entrypoint, tests, scenes, dialogues, materials, shaders, variables, and assets where practical.
- Unknown paths should return `null`, not throw.

### Phase 6: First diagnostic integrations

- Integrate the shared diagnostic list and resolver into `CharacterEditor` first, because `/characters/<id>/data/preview` is the motivating case from the screenshot.
- Add anchors to Character editor sections so `/characters/dfs/data/preview` reveals the preview pose/expression area.
- Integrate Layout editor diagnostics next, especially `layout.source.rml`, `layout.source.rcss`, and `layout.source.lua`.
- Integrate Project Settings diagnostics for entrypoint and UI/system layout settings.
- Keep each editor migration small and separately testable.

### Phase 7: Source-editor and field-level follow-up

- Add prefix-capable editor-specific handlers and row anchors for collection sections such as character poses/expressions, room hotspots, scene steps, dialogue blocks/segments/edges, and test steps/assertions.
- Extend `SourceEditorHandle` with optional `focus`, `revealLine`, or `revealRange` methods when exact source locations become available.
- Allow diagnostic targets to include a source-editor key and optional line/column/range payload.
- Add editor-specific handlers for exact RML/RCSS/Lua/JSON source positioning.

### Phase 8: Verification and cleanup

- Remove any remaining obsolete navigation events or per-editor scroll request props.
- Check for duplicated diagnostic card markup and migrate obvious duplicates.
- Run editor verification:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

- Run a manual smoke test in the editor for:
  - Open ComfyUI Settings from Image Generation when ComfyUI is disabled.
  - Click a character preview diagnostic and confirm it opens/focuses the Character tab, scrolls to Preview, and flashes.
  - Click a layout RCSS diagnostic and confirm it opens/focuses the Layout tab and scrolls to RCSS Source.

## Risks and Constraints

- Tab state restoration can race explicit navigation. The implementation must ensure explicit target reveal happens after restoration.
- Some editors use split panes or nested scroll containers. The first implementation should reveal the nearest anchor in the active editor pane and may need editor handlers for nested panes later.
- Diagnostics may be generated from runtime/export contexts whose paths do not exactly match authoring editor paths. The resolver should be conservative and should not create misleading links.
- Exact CodeMirror line/column navigation should be a follow-up unless diagnostics already carry reliable source offsets.

## Definition of Done

Completed coarse-navigation definition:

- The root `AGENTS.md` points agents to a main editor guide.
- The editor guide references this plan and the relevant editor docs.
- Opening ComfyUI settings navigates to and highlights the editor-wide ComfyUI settings card.
- The stale project-settings scroll event path is removed.
- Workbench target navigation is reusable by any editor or command.
- Character, Layout, Room, Dialogue, Scene, Test, Project Settings, Problems, Command History, and Package Export diagnostics use shared diagnostic UI where project paths can be resolved.
- Tests cover workbench target queueing/consumption, imperative handler registration, DOM anchor reveal/flash, settings deep-link behavior, diagnostic target resolution, and the bottom-panel character preview diagnostic click path.

Remaining precision-navigation definition:

- Validators or tool diagnostics emit reliable source positions or row identities where available.
- Source-editor targets carry source key plus line/column/range payloads and reveal exact RML/RCSS/Lua/JSON positions.
- Runtime/preview/shader diagnostics are mapped only when a resolver can do so without misleading users.
