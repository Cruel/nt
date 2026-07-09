# Editor Milestone 1 Workbench Shell Implementation Plan

## Purpose

This plan turns Milestone 1 from `IMPLEMENTATION_PLAN.md` into an
implementation-ready work breakdown. The goal is to replace the current
single-surface workspace route with a reusable workbench shell that can host
multiple editor tabs, split those tabs side by side, preserve the existing engine
preview, and keep the bottom diagnostic/output surfaces global.

Milestone 1 is deliberately a renderer/editor-shell milestone. It should not
implement the persistent command bus, undo/redo, project save/autosave, the new
authoring schema, typed entity editors, or PreviewManager pooling. It may add
narrow interfaces and placeholders where later milestones need stable seams.

## Inputs Reviewed

- `docs/editor/plans/IMPLEMENTATION_PLAN.md`
- `docs/editor/TECH_STACK.md`
- `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`
- `docs/editor/preview/PREVIEW_AND_TEST_PLAYBACK.md`
- `docs/architecture/ENGINE_ARCHITECTURE.md`
- `docs/migration/STATUS.md`
- `editor/README.md`
- `editor/package.json`
- `editor/src/renderer/routes/workspace.tsx`
- `editor/src/renderer/stores/workspace-store.ts`
- `editor/src/renderer/components/engine-preview.tsx`
- Existing renderer tests under `editor/src/renderer/test/`

## Current Repository Starting Point

The editor already has the dependency set needed for Milestone 1:

- `react-resizable-panels`
- `@dnd-kit/core`
- `@dnd-kit/sortable`
- `@dnd-kit/modifiers`
- `zod`
- `@tanstack/react-virtual`

Do not add a docking framework for this milestone. The editor should own the
workbench model itself, using `react-resizable-panels` only for pane resizing and
`@dnd-kit` only for tab drag/reorder/move behavior.

The current workspace implementation is intentionally monolithic:

- `routes/workspace.tsx` owns project open/validate/playback/export actions.
- The project tree, preview, inspector, diagnostics, and timeline are all local
  components inside the route file.
- `workspace-store.ts` mixes project/tooling state with preview state and a few
  shell visibility flags.
- The raw JSON inspector is a side panel, not a tab/editor surface.
- The engine preview is fixed as the central workspace surface.

Milestone 1 should split those responsibilities without changing the underlying
project load/validation/playback/export behavior.

## Scope

### In Scope

- Workbench state model for groups, tabs, split tree, active group/tab, dirty tab
  flags, and recently closed tabs.
- Editor registry for mapping tab/editor descriptors to React editor surfaces.
- Split-tab UI using `react-resizable-panels`.
- Basic tab open, activate, close, split right, split down, move/reorder within
  the implemented constraints.
- Bottom panel state and UI with the planned panel tabs.
- Existing engine preview hosted as an editor tab.
- Existing raw JSON inspection hosted as a fallback editor tab.
- Existing project tree opening records into tabs.
- Tests for pure workbench model behavior and basic registry behavior.
- Minimal component tests for route/workbench smoke behavior if practical.

### Out of Scope

- Persistent command bus and undo/redo.
- Dirty state derived from project command history.
- Project save/autosave implementation.
- New authoring schema conversion.
- Typed entity editors beyond the fallback JSON editor.
- PreviewManager session pooling.
- Source editor/CodeMirror integration.
- Full context-menu polish.
- Full drag/drop coverage for every edge case.
- Old Qt/SFML editor compatibility.
- Changes under `refs/`.

## Architecture Decisions

### 1. Keep Workbench State Separate From Project State

Create a dedicated workbench model/store rather than expanding
`workspace-store.ts` into a general shell store. `workspace-store.ts` should
continue to own loaded project data, diagnostics, playback reports, export
results, preview status, and existing preview control state until Milestone 2+
introduces a dedicated project store.

Recommended files:

```text
editor/src/renderer/workbench/workbench-types.ts
editor/src/renderer/workbench/workbench-model.ts
editor/src/renderer/workbench/workbench-store.ts
editor/src/renderer/workbench/editor-registry.tsx
editor/src/renderer/workbench/default-editors.tsx
editor/src/renderer/workbench/bottom-panel-store.ts
editor/src/renderer/workbench/Workbench.tsx
editor/src/renderer/workbench/WorkbenchGroup.tsx
editor/src/renderer/workbench/WorkbenchTabs.tsx
editor/src/renderer/workbench/BottomPanel.tsx
```

Keep pure state transitions in `workbench-model.ts` so they can be tested
without rendering React components.

### 2. Use a Split Tree, Not Ad Hoc Nested JSX State

Represent the workbench layout as a split tree. Groups are leaves. Split nodes
carry a direction and child layout nodes.

Suggested type shape:

```ts
export type WorkbenchSplitDirection = 'horizontal' | 'vertical';

export interface WorkbenchTab {
  id: string;
  title: string;
  editorType: string;
  resource?: WorkbenchResource;
  dirty?: boolean;
  pinned?: boolean;
  preview?: boolean;
}

export interface WorkbenchResource {
  kind: 'record' | 'preview' | 'tool' | 'raw';
  collection?: string;
  entityId?: string;
  testId?: string;
  stableId: string;
}

export interface WorkbenchGroup {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export interface WorkbenchLayoutGroupNode {
  kind: 'group';
  groupId: string;
}

export interface WorkbenchLayoutSplitNode {
  kind: 'split';
  id: string;
  direction: WorkbenchSplitDirection;
  children: WorkbenchLayoutNode[];
  sizes?: number[];
}

export type WorkbenchLayoutNode =
  | WorkbenchLayoutGroupNode
  | WorkbenchLayoutSplitNode;
```

This is enough for side-by-side tabs and future session persistence. It also
avoids committing to a third-party docking framework.

### 3. De-Dupe Resource Tabs

Opening the same resource should activate an existing tab unless the caller
explicitly asks for a duplicate. The stable key should be based on editor type
plus resource stable ID, for example:

```text
raw-json:record:room:foyer
engine-preview:preview:primary
```

This prevents a single-click explorer workflow from creating unbounded duplicate
raw JSON tabs.

### 4. Keep Tab Dirty Flags Local and Non-Authoritative

Milestone 1 can show tab dirty flags, but they are placeholders. Project dirty
state must wait for Milestone 2 because it needs command history and save
revision tracking.

Expose tab dirty APIs, but use them only for UI scaffolding/tests unless an
existing surface already has a meaningful transient dirty state.

### 5. Preserve Existing Preview Behavior Without Generalizing It Too Early

Wrap `EnginePreview` in an editor registration called something like
`engine-preview`. Do not change the MessageChannel protocol or add
PreviewManager yet.

The default workspace should open the primary preview tab on first load or when
there are no tabs. Toolbar play/stop can continue to use the existing custom
window events until PreviewManager replaces that path.

### 6. Turn the Raw JSON Inspector Into the Fallback Editor

Move the record lookup and JSON rendering logic out of the current right
inspector into a fallback editor component. This editor should accept a record
resource descriptor and read the current project from `workspace-store.ts`.

Recommended component:

```text
editor/src/renderer/editors/raw-json/RawJsonEditor.tsx
```

The editor should show:

- record title and type;
- collection/entity ID;
- pretty-printed JSON for the record;
- a clear missing-record state if the record no longer exists.

For Milestone 1, this remains read-only. Editing raw JSON through commands waits
for Milestone 2.

### 7. Replace the Global Right Inspector With Editor-Owned Layouts

The milestone acceptance criteria says each tab owns its local editor layout. The
old right inspector should not remain the primary raw record surface. It can be
removed from the outer workspace route or reduced to a temporary runtime/status
side surface only if needed during transition.

Preferred v1 outcome:

- Project explorer remains in the primary sidebar.
- Workbench center hosts preview/raw JSON tabs.
- Bottom panel hosts diagnostics/timeline/output/test/export surfaces.
- No permanent global right inspector in the workspace route.

### 8. Make Bottom Panel Global

Create a small bottom panel store/service independent of tab groups. It should
track:

- visible/collapsed state;
- active panel ID;
- panel ordering;
- optional per-panel badge counts.

Initial panels:

```text
problems
output
preview-events
test-playback
shader-compile
package-export
command-history
```

For this milestone, the panels can reuse existing data from `workspace-store.ts`:

- Problems: `diagnostics`
- Output: `timeline` filtered or grouped as general output
- Preview Events: `lastPreviewEvent` plus timeline preview entries if present
- Test Playback: `lastPlaybackReport`
- Shader Compile: empty state
- Package Export: `lastExportResult`
- Command History: empty placeholder until Milestone 2

Use `react-resizable-panels` to make the bottom panel resizable relative to the
main workbench area.

## Implementation Phases

### Phase 1: Extract Existing Workspace Subcomponents

Purpose: reduce risk before introducing split tabs.

Tasks:

1. Move `AssetTreeItem` and `AssetTree` out of `routes/workspace.tsx` into a
   project/sidebar component module.
2. Move diagnostics/timeline rendering into reusable bottom-panel-friendly
   components.
3. Preserve current behavior and tests after extraction.
4. Keep `buildProjectTree()` in `workspace-store.ts` for now unless a small
   model module makes tests cleaner.

Suggested files:

```text
editor/src/renderer/workspace/ProjectExplorer.tsx
editor/src/renderer/workspace/workspace-panels.tsx
```

Acceptance for this phase:

- Workspace still opens projects, shows the tree, embeds preview, and displays
  diagnostics/timeline.
- Existing tests continue to pass.

### Phase 2: Add Pure Workbench Model and Store

Purpose: establish the tab/group/split state before wiring UI.

Tasks:

1. Add workbench types.
2. Add a pure `createInitialWorkbenchState()` that creates one group with one
   primary preview tab.
3. Add pure operations:
   - `openTab`
   - `activateTab`
   - `closeTab`
   - `splitGroup`
   - `moveTab`
   - `setTabDirty`
   - `reopenLastClosedTab`
4. Add a Zustand store that delegates to the pure operations.
5. Add deterministic ID generation hooks for tests. Avoid `Date.now()` for core
   workbench IDs.

Recommended tests:

```text
editor/src/renderer/test/workbench-model.test.ts
```

Test cases:

- initial state contains a primary preview tab;
- opening a record adds a raw JSON tab to the active group;
- opening the same record twice activates the existing tab;
- splitting right creates a second group and moves or clones the requested tab
  according to the chosen operation;
- closing the last tab in a secondary group removes that empty group or leaves a
  valid empty group according to the chosen invariant;
- recently closed tabs can be reopened;
- active group/tab remains valid after close/move.

Recommended invariants:

- There is always at least one group.
- `activeGroupId` always references an existing group.
- A group's `activeTabId` is either `null` or contained in `tabIds`.
- Every tab ID referenced by a group exists in `tabsById`.
- Empty secondary groups are removed when practical; the root group may be empty
  only if a preview tab will be recreated immediately.

### Phase 3: Add Editor Registry and Default Editors

Purpose: make tabs render by editor type instead of hard-coded route layout.

Tasks:

1. Add an editor registry type that maps `editorType` to:
   - display name;
   - render component;
   - optional toolbar contribution component;
   - optional resource compatibility predicate;
   - optional fallback icon metadata.
2. Register `engine-preview`.
3. Register `raw-json`.
4. Add helper `getEditorTypeForProjectNode(node)` that returns `raw-json` for
   all current project records/tests.
5. Add fallback behavior for unknown editor types.

Suggested files:

```text
editor/src/renderer/workbench/editor-registry.tsx
editor/src/renderer/workbench/default-editors.tsx
editor/src/renderer/editors/raw-json/RawJsonEditor.tsx
editor/src/renderer/editors/preview/EnginePreviewEditor.tsx
```

Recommended tests:

```text
editor/src/renderer/test/editor-registry.test.tsx
```

Test cases:

- default registry resolves engine preview;
- default registry resolves raw JSON;
- unknown editor type returns a controlled missing-editor surface;
- record resource helper produces stable raw JSON tab descriptors.

### Phase 4: Implement Workbench UI

Purpose: render groups/tabs/splits and make the route use them.

Tasks:

1. Add `Workbench` component that renders the layout tree.
2. Render split nodes with `PanelGroup`, `Panel`, and `PanelResizeHandle` from
   `react-resizable-panels`.
3. Render group leaves with:
   - tab strip;
   - active editor surface;
   - simple empty-group placeholder if needed.
4. Add tab close and activation.
5. Add split-right and split-down actions from a group toolbar or tab menu.
6. Add minimal tab move/reorder support. Start with same-strip reorder and a
   simple move-to-group operation if full cross-group drag is too risky for the
   first patch.
7. Keep CSS/Tailwind styling local and consistent with existing shadcn/Base UI
   surfaces.

Drag/drop guidance:

- Use `@dnd-kit/sortable` for tab reordering inside a group.
- Add cross-group moves only after same-group reorder is stable.
- Do not let drag/drop mutate project data.
- Keep DnD state in the workbench store or transient component state, not in
  project state.

Acceptance for this phase:

- A primary preview tab renders in the workbench.
- A raw JSON tab can render next to it.
- Split right/down creates visible tab groups.
- Closing/activating tabs works without invalid state.

### Phase 5: Wire Project Explorer to Open Tabs

Purpose: satisfy the milestone requirement that existing project records open
into editor tabs.

Tasks:

1. Keep explorer selection state for highlighting/current selection if useful.
2. Add open behavior for entity/test nodes. Recommended v1 UX:
   - single click selects and opens the record in the active group, or
   - single click selects and double click opens, with an explicit Open action.
3. Use the workbench store's `openTab()` with a stable raw JSON resource.
4. Tests should assert that explorer interaction dispatches a tab open for a
   record node.

Recommendation: use single click to select and open for Milestone 1 unless it
becomes annoying in practice. De-duping prevents tab spam, and it minimizes
implementation/UX ambiguity.

### Phase 6: Add Global Bottom Panel

Purpose: move diagnostics/output/test/export/preview events out of the inspector
and into the intended global panel.

Tasks:

1. Add bottom panel types/store.
2. Add `BottomPanel` with tab buttons and content surfaces.
3. Add resize/collapse behavior.
4. Wire existing `workspace-store.ts` data into panel content.
5. Add placeholder content for Shader Compile and Command History.

Suggested files:

```text
editor/src/renderer/workbench/bottom-panel-store.ts
editor/src/renderer/workbench/BottomPanel.tsx
editor/src/renderer/workbench/BottomPanelTabs.tsx
```

Acceptance for this phase:

- Problems panel shows validation diagnostics.
- Preview Events and Output show existing preview/timeline data.
- Test Playback shows the latest playback report.
- Package Export shows the latest export result.
- Shader Compile and Command History have clear empty states.

### Phase 7: Replace Workspace Route Layout

Purpose: complete the transition from the monolithic route to the workbench shell.

Tasks:

1. Keep `PageHeader` top actions for open/validate/test/export/play/stop.
2. Replace the fixed center preview and right inspector with:
   - primary sidebar/project explorer;
   - resizable workbench area;
   - global bottom panel;
   - status bar.
3. Keep existing preview toolbar play/stop behavior working with the preview tab.
4. Ensure the route remains usable when no project is loaded.
5. Ensure default preview tab can be reopened if closed.

Acceptance for this phase:

- Existing project open/validate/playback/export actions still work.
- Existing preview still connects and receives toolbar play/stop commands.
- Existing raw JSON inspection behavior survives as a tab.
- The right inspector is no longer required for record inspection.

### Phase 8: Tests and Verification

Add or update tests before considering the milestone complete.

Required test coverage:

```text
editor/src/renderer/test/workbench-model.test.ts
editor/src/renderer/test/editor-registry.test.tsx
editor/src/renderer/test/workbench-ui.test.tsx       # if practical
editor/src/renderer/test/workspace-store.test.ts     # update only as needed
```

Minimum verification commands:

```sh
cd editor
pnpm typecheck
pnpm test
pnpm lint
```

Run preview build checks only if preview protocol/build plumbing changes. The
preferred Milestone 1 implementation should not require engine/web rebuilds.

Optional manual smoke:

```sh
cd editor
pnpm start
```

Manual smoke checklist:

- Open a project.
- Click/open a project record and verify a raw JSON tab appears.
- Open or focus the preview tab.
- Split right and place a raw JSON tab beside the preview.
- Close tabs and verify active tab/group stays valid.
- Run Validate and verify Problems updates.
- Run first playback test if available and verify Test Playback updates.
- Run export and verify Package Export updates.
- Use toolbar play/stop and verify preview state changes.

## Detailed File-Level Plan

### New Workbench Model Files

```text
editor/src/renderer/workbench/workbench-types.ts
```

Owns stable TypeScript types for tabs, resources, groups, layout nodes, and
state snapshots.

```text
editor/src/renderer/workbench/workbench-model.ts
```

Owns pure reducers/operations. No React imports. No DOM. No Zustand. This is the
main unit-tested workbench state engine.

```text
editor/src/renderer/workbench/workbench-store.ts
```

Small Zustand adapter over the pure model. It may own ID generation and action
methods, but the actual layout logic should stay in `workbench-model.ts`.

### New Editor Registry Files

```text
editor/src/renderer/workbench/editor-registry.tsx
```

Defines registration types and lookup helpers.

```text
editor/src/renderer/workbench/default-editors.tsx
```

Registers the current built-in editor surfaces: primary engine preview and raw
JSON fallback.

### New Editor Surface Files

```text
editor/src/renderer/editors/preview/EnginePreviewEditor.tsx
```

Thin wrapper around `EnginePreview`. Keep this wrapper so future preview-manager
changes do not require every tab registration to import the low-level preview
component directly.

```text
editor/src/renderer/editors/raw-json/RawJsonEditor.tsx
```

Read-only fallback editor for current project records/tests.

### New Workbench UI Files

```text
editor/src/renderer/workbench/Workbench.tsx
editor/src/renderer/workbench/WorkbenchGroup.tsx
editor/src/renderer/workbench/WorkbenchTabs.tsx
editor/src/renderer/workbench/BottomPanel.tsx
```

These should be feature components, not generic shadcn primitives. Only promote
small style-neutral widgets into `components/ui` if they are clearly reusable
outside the workbench.

### Existing Files To Change

```text
editor/src/renderer/routes/workspace.tsx
```

Convert from a monolithic layout into the route-level composition of toolbar,
project explorer, workbench, bottom panel, and status bar.

```text
editor/src/renderer/stores/workspace-store.ts
```

Keep project/preview/tooling data here. Avoid adding tab/group/split state here.
Small helper exports for record lookup are acceptable if shared by the raw JSON
editor and project explorer.

```text
editor/src/renderer/components/engine-preview.tsx
```

Should need little or no change. If toolbar events become awkward because the
preview is tab-hosted, keep changes narrow and do not alter the protocol.

## Data Flow After Milestone 1

```text
Project open
-> workspace-store project/tooling state
-> project explorer builds nodes
-> user opens record
-> workbench-store openTab(raw-json record resource)
-> Workbench renders RawJsonEditor
-> RawJsonEditor reads current project from workspace-store
```

```text
Preview tab render
-> Workbench renders EnginePreviewEditor
-> EnginePreview uses existing useEnginePreview hook
-> MessageChannel protocol remains unchanged
-> preview events update workspace-store
-> BottomPanel reads workspace-store preview/timeline state
```

```text
Validate/playback/export
-> workspace route toolbar calls existing preload API
-> workspace-store receives diagnostics/report/export result
-> BottomPanel surfaces the result globally
```

## Edge Cases To Handle

- No project loaded: explorer shows empty state; workbench still has preview tab.
- Project record deleted externally or missing: raw JSON tab shows missing-record
  state instead of crashing.
- Same record opened twice: existing tab activates.
- Active tab closed: nearest tab becomes active; if none remain, group remains
  empty or preview is recreated according to the chosen invariant.
- Secondary group becomes empty: remove it if doing so keeps layout valid.
- Root group becomes empty: recreate primary preview tab or show a controlled
  empty workbench state with an action to reopen preview.
- Preview tab closed: toolbar play/stop should not throw; reopening preview
  should reinitialize as before.
- Validation diagnostics empty: Problems panel shows empty state.
- Playback/export result is null: panel shows empty state.

## Recommended Acceptance Criteria

Milestone 1 is complete when:

1. The workspace route is no longer a fixed preview-plus-right-inspector layout.
2. The workbench can show at least two editor tabs side by side.
3. The primary preview is an editor tab/surface.
4. Current project records/tests can open into fallback raw JSON tabs.
5. Opening an already-open record focuses the existing tab.
6. Each tab owns its local editor content; there is no permanent global right
   inspector required for record inspection.
7. The bottom panel remains global and shows existing Problems, Output, Preview
   Events, Test Playback, Shader Compile, Package Export, and Command History
   surfaces or placeholders.
8. Existing project open, validation, playback, package export, preview play/stop,
   and preview events still work.
9. Workbench state model tests cover open/close/split/move/reopen invariants.
10. `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass in `editor/`.

## Risks and Mitigations

### Risk: Workbench and Project Stores Become Coupled Too Early

Mitigation: workbench tabs should carry resource descriptors, not actual project
record objects. Editor surfaces can read project data by resource ID.

### Risk: Drag/Drop Consumes the Milestone

Mitigation: implement same-group tab reorder first. Add cross-group moves through
explicit tab menu actions if full cross-group DnD is too much for the first
slice. The acceptance criteria requires moving tabs between groups eventually,
but the first patch can make this explicit rather than fully polished drag/drop.

### Risk: Closing/Splitting Invalidates Layout State

Mitigation: centralize all layout mutations in pure tested functions. Do not
spread split-tree mutation across React components.

### Risk: Preview Breaks Because It Assumed a Fixed Route Surface

Mitigation: do not alter `EnginePreview` internals unless necessary. Host it
inside an `EnginePreviewEditor` wrapper and keep existing toolbar custom events
until PreviewManager replaces that path.

### Risk: Bottom Panel Becomes a Dumping Ground

Mitigation: use explicit panel IDs and content components. Avoid allowing random
feature components to append arbitrary UI outside the panel registry.

## Suggested Implementation Prompt

```text
@dev nt Implement Milestone 1 using `docs/editor/plans/MILESTONE_1_WORKBENCH_PLAN.md` as the source plan. Read `docs/editor/plans/IMPLEMENTATION_PLAN.md`, `docs/editor/TECH_STACK.md`, `docs/editor/preview/ENGINE_PREVIEW_COMMUNICATION.md`, and the current `editor/src` structure first. Keep this to the workbench shell only: add a pure workbench tab/group/split model, a Zustand workbench store, editor registry, split-tab UI with `react-resizable-panels`, fallback raw JSON editor, primary engine preview editor tab, project explorer record opening into tabs, and global bottom panel scaffolding. Do not implement the persistent command bus, undo/redo, save/autosave, new schema conversion, typed entity editors, PreviewManager pooling, or any changes under `refs/`. Preserve existing project open/validate/playback/export and preview behavior. Add tests for the pure workbench model and registry, then run `cd editor && pnpm typecheck && pnpm test && pnpm lint`.
```
