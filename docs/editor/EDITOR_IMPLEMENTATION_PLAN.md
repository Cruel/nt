# NovelTea Editor Implementation Plan

## Purpose

This document defines the current implementation direction for the new NovelTea
editor. It is intentionally a forward-looking plan for the new engine and new
editor, not a compatibility plan for the old Qt editor or the old game format.
The old `refs/NovelTea` editor remains useful as a workflow reference, but new
editor architecture, project schema, visual tooling, runtime preview, and user
experience may deviate freely.

The immediate goal is to build a solid editor workbench before filling in every
specific entity editor. The workbench must make project editing, undo/redo,
preview integration, diagnostics, tab splitting, and persistence reliable enough
that later editors can be implemented one at a time without rewriting the shell.

Editor-side dependency and component choices are standardized in
`docs/editor/EDITOR_TECH_STACK.md`. Check that document before adding React UI,
state, table, graph, source editor, validation, drag/drop, or workbench layout
dependencies.

## Guiding Decisions

- Treat the editor as a new product for the new engine. Avoid old-format lock-in.
- Keep Electron/React authoring code out of `noveltea_core`.
- Keep Qt/SFML-era editor classes as read-only reference only.
- Use the engine web build for accurate previews, but do not create unbounded
  full engine instances for every thumbnail or card.
- Make the project document the persistent source of truth.
- Route persistent edits through explicit commands, transactions, and undo/redo.
- Keep transient UI state separate from project data.
- Prefer editor-owned inspectors over one global right inspector so split tabs
  stay coherent.
- Build the foundation first, then add typed editors in dependency order.

## Current Starting Point

The repository already has a useful editor foundation:

- Electron + React + TypeScript renderer.
- TanStack Router route shell.
- Zustand stores for current workspace state.
- shadcn/Base UI component setup.
- A left navigation/sidebar and central workspace route.
- An Emscripten engine preview embedded through an iframe.
- A typed `MessageChannel` preview handshake and command/event protocol.
- A loopback-only preview server owned by the Electron main process.
- A `noveltea-editor-tool` helper executable for project load/import,
  validation, raw entity edits, playback tests, shader compilation, package
  export, and related privileged work.
- Basic project tree, raw JSON inspector, diagnostics, timeline, playback, and
  package export scaffolding.

The weak points are expected for this stage:

- Typed editors are mostly absent.
- Preview protocol is still demo/runtime-command shaped rather than
  authoring-preview shaped.
- The project schema still mostly reflects current engine/test scaffolding and
  should evolve into a new authoring schema.

## Workbench Layout Model

The editor should use a VS Code-like workbench instead of a fixed
explorer/editor/inspector layout.

### Outer Shell

The outer shell owns global navigation and durable workspace surfaces:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Top command bar / toolbar                                                   │
├────┬───────────────────────┬────────────────────────────────────────────────┤
│    │                       │                                                │
│ A  │ Primary sidebar       │ Editor workbench                               │
│ c  │                       │                                                │
│ t  │ - Project explorer    │ ┌───────────────┬────────────────────────────┐ │
│ i  │ - Search              │ │ Tab group A   │ Tab group B                │ │
│ v  │ - Assets              │ │               │                            │ │
│ i  │ - Validation          │ │ editor-owned  │ editor-owned               │ │
│ t  │ - Tests               │ │ inspector     │ inspector                  │ │
│ y  │ - Settings            │ │ if needed     │ if needed                  │ │
│    │                       │ └───────────────┴────────────────────────────┘ │
├────┴───────────────────────┴────────────────────────────────────────────────┤
│ Bottom panel: Problems | Output | Preview Events | Tests | Shader Compile   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Activity Rail

The activity rail switches the primary sidebar content. Initial activities:

1. Project
2. Search
3. Assets
4. Validation
5. Tests
6. Settings

The rail should stay small and global. It should not become a list of every
entity type.

### Primary Sidebar

The primary sidebar changes based on activity:

- Project: entity/project explorer.
- Search: full project search and reference results.
- Assets: asset folders, filters, import queue, alias conflicts.
- Validation: project-wide diagnostics grouped by severity/entity/path.
- Tests: playback test list and status summary.
- Settings: workspace/editor preferences shortcuts.

The Project explorer should support hierarchy, filtering, type grouping,
creation actions, context menus, color labels/tags, reference previews, and
parent assignment where applicable.

### Editor Workbench

The central workbench should support:

- Multiple editor tabs.
- Split groups horizontally and vertically.
- Moving tabs between groups.
- Reopening recently closed tabs.
- Dirty indicators.
- Per-tab close prompts when needed.
- Per-tab editor type registration.
- Active editor focus tracking.
- Editor-specific toolbar contributions.

Do not build a permanent global right inspector into the outer shell. Each editor
tab can include its own local inspector or side panel. This avoids ambiguity
when two editor groups are visible side by side.

Example tab-local layouts:

- Material editor: material list + uniform/property panel + engine preview.
- Scene editor: sequence/graph/timeline + local inspector + preview.
- Dialogue editor: graph/tree + node inspector + preview-from-node controls.
- Layout editor: RML/RCSS source panes + preview + diagnostics.
- Variables editor: table/grid, no extra inspector required.
- Assets editor: asset browser + detail panel + import diagnostics.

### Bottom Panel

The bottom panel is global because output streams are naturally shared across
the project and preview/tooling boundary.

Initial bottom panel tabs:

- Problems: validation diagnostics and schema errors.
- Output: general editor/tool logs.
- Preview Events: engine-to-editor events, preview errors, state snapshots.
- Test Playback: test observations, assertions, outputs, final state.
- Shader Compile: compiler diagnostics, variants, command lines, cache hits.
- Package Export: manifest, asset list, warnings, byte counts.
- Command History: undo/redo transaction log for debugging.

### Top Command Bar / Toolbar

The top command bar owns global actions:

- Open project.
- New project.
- Save.
- Save all.
- Undo.
- Redo.
- Validate.
- Preview play/stop/reset.
- Select preview target/orientation/device profile.
- Export/package.
- Command palette entry point.

Editor-specific actions can contribute to the top bar while an editor is active,
but command ownership should still route through the command bus.

## Project State Model

Separate the editor state into three categories.

### Persistent Project State

This is saved into the project document and exported, partially or fully, into
runtime packages.

Examples:

- Project settings.
- Assets and aliases.
- Materials and shader records.
- Layouts and UI style resources.
- Variables.
- Characters.
- Scenes.
- Dialogues.
- Rooms.
- Maps.
- Inventory items.
- Actions/interactions.
- Tests.

### Persistent Editor Session State

This is editor-only state that may be saved in a workspace/session file, not in
the runtime game schema.

Examples:

- Open tabs and split layout.
- Expanded explorer folders.
- Last active activity/sidebar.
- Bottom panel visibility and selected tab.
- Recent project list.
- Per-editor zoom/camera/view preferences where useful.
- Preview device/orientation selection.

This can live in a `.noveltea/editor-session.json`-style file or equivalent,
not in exported runtime packages.

### Transient UI State

This stays in memory only unless explicitly promoted to editor session state.

Examples:

- Current selection.
- Hovered graph node.
- Drag operation state.
- In-progress text selection/cursor state.
- Temporary preview request IDs.
- Open dropdowns/popovers.
- Unsaved form draft fields before command commit.

## Project Schema Direction

The project schema should be new-engine-first. Do not preserve old collection
names or old array layouts merely for compatibility.

Recommended high-level authoring collections:

```text
project
assets
materials
shaders
layouts
variables
characters
scenes
dialogues
rooms
maps
inventoryItems
actions
tests
editor
```

The exact shape should be formalized incrementally, but all records should have
stable IDs and clear ownership:

```json
{
  "id": "dialogue.default",
  "name": "Default Dialogue",
  "parentId": null,
  "tags": [],
  "properties": {},
  "editor": {}
}
```

Use object maps keyed by stable ID for most top-level collections. Use arrays
where order is semantically important inside a record, such as scene steps,
dialogue node ordering, animation tracks, material uniform order, or test steps.

### Runtime vs Authoring Data

Keep authoring-only data distinct from runtime data:

- Authoring data may include thumbnails, editor node positions, comments,
  disabled draft records, source shader text, import metadata, validation cache,
  graph layout, and editor hints.
- Runtime export should include only data needed to run the game plus explicitly
  included diagnostics/debug metadata for dev exports.
- Export should strip editor-only fields from runtime packages.

## Identity, References, and Inheritance

### Entity Identity

Every persistent authoring record should have:

- Stable string ID.
- Human display name.
- Optional parent ID where supported.
- Optional tags/categories.
- Optional user color/label.
- Optional description/notes.

IDs should be stable and explicit. Display names can change freely. Renaming an
ID should be a refactoring command that updates references transactionally.

### References

Use typed references rather than unqualified strings where ambiguity is possible:

```json
{ "type": "material", "id": "mat.dialogue_glow" }
```

For compact authoring fields, shorthand strings may be acceptable only when the
schema context makes the type unambiguous.

The editor should maintain a reference index for:

- Find usages.
- Rename/update references.
- Delete warnings.
- Missing reference diagnostics.
- Dependency-aware asset/material export.

### Inheritance

Inheritance should be explicit and opt-in per entity type.

Good candidates:

- Materials.
- Characters.
- Character poses/expressions.
- Rooms.
- Inventory items.
- Actions/interactions.
- Layout/style presets.
- Asset import presets.

Questionable or deferred candidates:

- Dialogue graph nodes.
- Scene timeline events.
- Test steps.

Inheritance rules:

- Parent must be same type or from an explicitly allowed base type.
- Cycles are invalid.
- The editor should show inherited values distinctly.
- Overridden values should be clear.
- Reset-to-inherited should be available per field.
- Merged/computed values should be inspectable.
- Validation should report missing parents and invalid cycles.

## Command, Transaction, Undo, and Redo Model

Persistent project edits must go through a command bus. Editors should not
mutate the project store directly for saved data.

### Command Bus Requirements

A command should define:

- Stable command type.
- User-facing label.
- Payload.
- Preconditions.
- Apply function.
- Inverse operation or before/after patch.
- Affected records/paths.
- Diagnostics produced by the command.
- Whether it starts/updates/commits a transaction.

Example command names:

```text
project.setSetting
asset.import
asset.renameAlias
asset.delete
material.create
material.updateUniform
material.setParent
shader.updateSource
uiLayout.updateSource
variable.create
variable.setDefaultValue
character.createPose
scene.insertStep
scene.moveStep
scene.updateStep
room.placeObject
dialogue.createNode
dialogue.linkNode
test.insertStep
entity.renameId
entity.delete
```

### Transaction Model

Transactions group multiple low-level edits into a single undo entry.

Use transactions for:

- Dragging/reordering scene steps.
- Moving graph nodes.
- Importing multiple files.
- Renaming IDs and updating references.
- Applying a material preset.
- Multi-select property edits.
- Asset reimport plus dependent thumbnail updates.
- Scene template insertion.

Command history should be project-level first. Tab-local undo can be simulated by
routing active-editor shortcuts to the global stack, but the stack must remain
project coherent.

### Patch Strategy

Recommended v1 strategy:

- Represent project edits as JSON-patch-like operations or immutable project
  document replacements at narrow paths.
- Store inverse patches for undo.
- Validate command preconditions before applying.
- Rebuild derived indexes after committed transactions.
- Debounce expensive validation/preview refresh after high-frequency edits.

Avoid a model where each editor keeps private mutable copies and periodically
flushes them into the project without command history. Text/code editors can use
drafts internally, but they should commit through commands at clear points:
idle debounce, blur, explicit save, or command completion.

### Dirty State and Save

Dirty state should derive from command history since the last successful save.

Required behavior:

- `Save` writes current project document to disk.
- `Save All` saves project plus editor session state and dirty external files if
  the editor supports external source files later.
- Autosave can write project/session periodically or on idle.
- Failed save preserves dirty state and reports diagnostics.
- Undo back to the saved revision clears dirty state.
- Redo away from saved revision marks dirty again.

## Project Services

The editor should grow a small set of internal TypeScript services around the
current Zustand store and Electron helper boundary.

### Suggested Renderer Services

- `ProjectStore`: current project document, revision, dirty state.
- `CommandBus`: apply/undo/redo/transactions.
- `SelectionService`: active selection per editor group/tab.
- `WorkbenchService`: tabs, groups, splits, active editor tracking.
- `ReferenceIndexService`: usages, dependencies, rename/delete support.
- `ValidationService`: schema/runtime/tooling diagnostics.
- `PreviewManager`: live preview sessions, pooling, state replay, thumbnails.
- `AssetIndexService`: asset records, file status, import/reimport state.
- `EditorRegistry`: maps record types/routes to editor components.
- `PanelService`: bottom panel state and output streams.

### Electron Main Process Services

Keep privileged operations in Electron main or helper tools:

- Native file dialogs.
- Project filesystem reads/writes.
- Asset import file copying.
- External file watching.
- Spawning `noveltea-editor-tool`.
- Preview server lifecycle.
- Opening external URLs.

Do not expose generic filesystem or IPC access to the renderer.

### Native Helper Services

The `noveltea-editor-tool` should remain the native/engine-adjacent tool for:

- Project validation.
- Runtime export/package building.
- Shader compilation.
- Headless test playback.
- New project normalization/migration for the new schema.
- Asset dependency analysis where native decoders are useful.
- Runtime-safe schema export.

As editor needs grow, prefer explicit helper commands over a generic command
interpreter.

## Preview Architecture

The editor should support multiple preview types, but manage them deliberately.

### Preview Types

1. Primary runtime preview
   - Runs the current project or current exported/dev package.
   - Supports play, pause, reset, continue, choices, navigation, interactions,
     save/load, and state inspection.

2. Entity preview
   - Shows one authored record in isolation.
   - Examples: material swatch, room, scene section, character pose, Layout,
     dialogue node, map.

3. Thumbnail preview
   - Produces cached visual summaries for lists and sidebars.
   - Examples: material cards, Layout thumbnails, character pose cards.

4. Test playback preview
   - Shows deterministic recorded test state and output timeline.
   - Supports step/scrub/replay, assertions, and diagnostics.

### Preview Manager

Do not let arbitrary React components spawn unlimited full engine iframes.
Introduce a `PreviewManager` with policies:

- Reuse the primary runtime preview.
- Allow a small bounded pool of live entity previews.
- Use on-demand thumbnail rendering for many cards.
- Dispose idle preview sessions.
- Replay latest editor state after reload.
- Track preview capabilities.
- Surface preview errors into bottom panel diagnostics.
- Support visible-only rendering for virtualized thumbnail lists.

### Preview Protocol Direction

The current protocol is adequate for demo/runtime commands. Add authoring-preview
messages explicitly rather than generic JSON eval.

Potential editor-to-preview messages:

```text
load-preview-document
update-preview-document
set-preview-mode
set-preview-camera
set-preview-device-profile
request-preview-state
request-preview-snapshot
runtime-play
runtime-stop
runtime-reset
runtime-input
```

Potential preview-to-editor messages:

```text
ready
capabilities
command-result
preview-state
preview-snapshot
preview-diagnostic
preview-object-selected
preview-object-hovered
runtime-output
runtime-error
```

Preview documents should be narrow and mode-specific. Example preview documents:

- `material-preview`: material ID, shader/material metadata, test geometry,
  texture bindings, background.
- `layout-preview`: RML/RCSS asset references or source text, viewport size,
  injected sample data.
- `room-preview`: room ID, resolved room data, visible objects, background,
  sample runtime state.
- `scene-preview`: scene ID, selected step range, sample variables/state.
- `character-preview`: character ID, pose/expression, material overrides.

### Snapshot and Thumbnail Strategy

Thumbnail previews should not require one always-live iframe per thumbnail.
Recommended v1 approach:

- Use one preview session to render requested thumbnails sequentially.
- Cache thumbnails by content hash/revision.
- Invalidate thumbnails when dependent records/assets/materials change.
- Store generated thumbnails as editor cache, not runtime project data.
- Fall back to symbolic cards when preview is unavailable.

## Editor Dependency Order

Implement editors in dependency order so each slice supports the next.

1. Project shell/workbench and command infrastructure.
2. Project settings and new project schema foundation.
3. Assets and aliases.
4. Shaders/materials.
5. Variables.
6. Layouts.
7. Characters.
8. Rooms.
9. Dialogues.
10. Scenes.
11. Maps.
12. Inventory items.
13. Actions/interactions.
14. Tests/playback authoring.
15. Export/package workflow polish.

Assets and materials should come early because many later editors depend on
images, fonts, audio, aliases, shader/material references, and preview cards.

## Entity Editor Direction

These are not all immediate implementation tasks. They define the intended shape
so the workbench and schema can be designed without blocking on every detail.

### Project Settings Editor

Purpose: define global project/runtime/editor defaults.

Initial fields:

- Game title.
- Author/version.
- Startup entrypoint.
- Default Layout.
- Default font/text style.
- Default resolution/aspect/device profile.
- Supported orientation: portrait, landscape, or both.
- Whether map is enabled.
- Whether inventory is enabled.
- Whether adventure actions/interactions are enabled.
- Export/package defaults.

Preview needs:

- Device/orientation preview profile.
- Startup runtime preview reset.

### Assets Editor

Purpose: import, organize, alias, inspect, and validate project resources.

Asset types:

- Images/textures.
- Fonts.
- Audio: sound effects, music/loops, voice.
- RML/RCSS.
- Lua scripts.
- Shader source files.
- Data/text files.
- Future: Live2D model assets.

Initial features:

- Import file/folder.
- Copy into project asset directory.
- Assign stable asset ID and alias.
- Type detection.
- Preview image/audio/font where possible.
- Reference usage display.
- Rename alias transactionally.
- Delete with usage warnings.
- Reimport/update source.
- Asset diagnostics.

Dependencies:

- Main-process filesystem service.
- Project command bus.
- Reference index.
- Preview thumbnails for visual assets.

### Shader and Material Editor

Purpose: author shader records, material definitions, presets, and runtime-safe
material metadata.

Initial features:

- Shader list and material list.
- Shader source editing or source asset references.
- Vertex/fragment stage association.
- Uniform declarations with type, defaults, labels, ranges, and engine standard
  input bindings.
- Texture slot declarations.
- Material instances with inherited defaults.
- Material preview mode with engine-rendered swatch/test geometry.
- Compile variants through `noveltea-editor-tool`.
- Compile diagnostics and cache-hit display.
- Keep previous valid preview after failed compile.
- Material thumbnail sidebar.

Dependencies:

- Assets editor for textures/shader files.
- PreviewManager entity/thumbnail previews.
- Command bus transactions.
- Shader compile helper command.

### Variables Editor

Purpose: manage global game variables/properties and reduce typo-prone script
state.

Initial features:

- Variable ID.
- Display name/description.
- Type: boolean, number, string, enum, object/json where needed.
- Default value.
- Category/tags.
- Usage search.
- Diagnostics for unknown/unused/conflicting variable references.

Future features:

- Variable watch during preview.
- Test assertions generated from variables.
- Visual branch condition builders.

### Layout Editor

Purpose: author RML/RCSS runtime Layouts with live engine preview.

Initial features:

- RML source editor.
- RCSS source editor.
- Asset picker for fonts/textures/materials.
- Live preview.
- Inject sample runtime state.
- Diagnostics from RmlUi parse/load.
- Layout assignment targets: default UI, scene overlay, room overlay, dialogue UI,
  menu UI, custom overlay.

Future features:

- Visual element selection.
- Inspector for selected RML node.
- Style property editor.
- Template/component browser.

### Characters Editor

Purpose: make VN characters first-class entities.

Initial features:

- Character ID/name.
- Dialogue display name.
- Dialogue color/text style defaults.
- Sprite asset sets.
- Poses.
- Expressions.
- Optional per-pose material overrides.
- Character preview.

Future features:

- Layered outfits/accessories.
- Voice profile.
- Lip sync hooks.
- Live2D scaffold and preview integration.

### Room Editor

Purpose: support both old-style interactive text rooms and new visual rooms.

Initial features:

- Room name.
- Background image/material.
- Description/rich text.
- Enter/leave scripts.
- Navigation/path exits.
- Placed objects/hotspots.
- Optional room-specific UI overlays.
- Object placement canvas.
- Engine preview of room state.

Future features:

- Parallax/background layers.
- Room transition previews.
- Visual conditional visibility.

### Dialogue Editor

Purpose: author branching dialogue as graph/tree data that can be run directly
or embedded in scenes.

Initial features:

- Node graph/tree hybrid.
- Dialogue text nodes.
- Choice/option nodes.
- Conditional visibility/enabled scripts.
- Script hooks.
- Speaker/character association.
- Log behavior.
- Link/reuse nodes.
- Preview from selected node.

Future features:

- Inline variable condition builder.
- Coverage visualization from tests.
- Localization tables.

### Scene Editor

Purpose: become the main orchestration editor for VN-style content.

This replaces the old "cutscene" concept in UX, though runtime implementation
may reuse lower-level sequence concepts where appropriate.

Initial features:

- Ordered timeline/sequence.
- Step list plus optional graph/branch view.
- Background changes.
- Character enter/exit/move/pose/expression changes.
- Dialogue block insertion.
- Audio cues: sound effect, music track, fade in/out, stop.
- Layout add/remove/swap.
- Variable set/check.
- Lua script step.
- Wait/page-break/continue gates.
- Branch/choice step.
- Transition step.
- Engine preview from beginning or selected step.

Future features:

- Timeline tracks.
- Keyframes/tweens.
- Branch coverage overlay.
- Scene templates/macros.

### Map Editor

Purpose: optional navigation map support.

Initial features:

- Room nodes.
- Connections.
- Attached room IDs.
- Visibility/enabled scripts.
- Current-room preview.
- Navigation binding.

Future features:

- Custom map materials/styles.
- Visual map themes.
- Runtime map overlay preview.

### Inventory Items Editor

Purpose: support adventure/point-and-click inventory systems without forcing VN
projects to use them.

Initial features:

- Item ID/name.
- Description/rich text.
- Icon/image/material.
- Default properties.
- Usable/inspectable flags.
- Preview card.

### Actions and Interactions Editor

Purpose: support verb/object/action mechanics for adventure games.

Initial features:

- Verb definitions.
- Object count/structure.
- Action builder.
- Target object references.
- Condition script.
- Execution script or scene/dialogue target.
- Optional visual action button labels.

This area should be grouped as optional "Interactions" tooling so pure VN
projects can ignore it.

### Tests Editor

Purpose: author deterministic runtime playback tests and debug story branches.

Initial features:

- Test list.
- Entrypoint selection.
- Ordered steps.
- Step types: tick, continue, dialogue option, navigate, select object, run
  action, set variable, load save, set entrypoint.
- Assertions: mode, current room/scene/dialogue, text contains, variable value,
  inventory contains, object location, diagnostics, output type.
- Run all/run selected/run from step.
- Failure timeline.
- State snapshot inspection.
- Preview replay/scrub if runtime support is available.

Future features:

- Record from live preview.
- Branch coverage.
- CI export for project tests.

## Milestone Plan

### Milestone 0: Documentation and Agreement

Status: this document.

Goals:

- Establish workbench direction.
- Establish command/undo model direction.
- Establish preview manager direction.
- Establish entity rollout order.

Acceptance criteria:

- The editor plan exists under `docs/editor/`.
- Future implementation prompts can reference this plan.

### Milestone 1: Workbench Shell

Goal: replace the single workspace route layout with a reusable workbench.

Before implementing this milestone, review `docs/editor/EDITOR_TECH_STACK.md`.
The intended foundation is local shadcn/Base UI wrappers, `react-resizable-panels`
for split panes, `@dnd-kit` for tab/list drag behavior, and the editor's own
workbench/tab model rather than a full docking-layout framework.

Tasks:

1. Add workbench state model.
   - Editor groups.
   - Tabs.
   - Active tab/group.
   - Split direction.
   - Dirty flags.
   - Recently closed tabs.

2. Add editor registry.
   - Register editor type by record kind.
   - Open record in matching editor.
   - Fallback raw JSON editor.
   - Editor toolbar contribution hook.

3. Add split tab UI.
   - Open tab.
   - Close tab.
   - Split right/down.
   - Move tab between groups.
   - Activate tab/group.

4. Add bottom panel service and UI.
   - Problems.
   - Output.
   - Preview Events.
   - Test Playback.
   - Shader Compile.
   - Package Export.
   - Command History.

5. Preserve existing preview component as a tab/editor surface, not only a fixed
   central workspace.

Acceptance criteria:

- Two editor tabs can be opened side by side.
- Each tab owns its local editor layout.
- The bottom panel remains global.
- Existing project tree can open records into tabs.
- Existing raw JSON inspector behavior survives as a fallback editor.

### Milestone 2: Project Store, Save, and Command Bus

Status: complete.

Milestone 2 made persistent editing explicit, undoable, redoable, and saveable.
The editor now has a dedicated project store, JSON pointer/patch helpers, a
project command bus, command history, transactions, undo/redo actions and
shortcuts, command-backed raw JSON editing, save/save-as IPC through Electron
main, conservative autosave behind a workspace toggle, dirty-state tracking from
command history, command diagnostics/history in the bottom panel, and focused
coverage for project patches, command behavior, dirty state, and raw JSON editing.

### Milestone 3: New Project Schema Skeleton

Status: complete.

Milestone 3 defined the new-engine-first editor authoring schema v1 independent
of old project-format compatibility concerns. The editor now has shared
TypeScript/zod schema metadata, top-level authoring collections, `layouts`
collection naming, project creation defaults, entity ID validation, parent and
inheritance reference conventions, local authoring validation diagnostics,
authoring project tree grouping, unsaved new-project dirty state, disabled
playback/export until authoring-to-runtime conversion exists, and a reference
index skeleton for entrypoint, parent, inheritance, and explicit `$ref` usages.

### Milestone 4: Project Explorer and Entity Operations

Status: complete.

Milestone 4 made basic authoring operations available before specialized entity
editors. The editor now has authoring-aware entity commands for create, rename
ID, duplicate, reference-aware delete, metadata updates, and same-collection
parent assignment; rename rewrites supported references transactionally;
reference-aware deletes require force when usages exist; the project explorer has
row/folder actions and lightweight operation dialogs; raw JSON tabs expose Find
Usages; and a global References bottom panel shows entrypoint, parent,
inheritance, and explicit `$ref` usages with source-record open actions.

### Milestone 5: Preview Manager Foundation

Status: complete.

Milestone 5 introduced a renderer-side `PreviewManager` foundation so preview
ownership is no longer just ad hoc React component state. The manager now models
preview sessions, capabilities, diagnostics, primary runtime replay state,
bounded entity preview requests, and thumbnail request/cache state. The existing
primary iframe preview is still the visible runtime preview, but it now mirrors
connection state, capabilities, transport errors, runtime diagnostics, and replay
state through the manager. The shared preview protocol now includes explicit
authoring-preview messages and validators, and the workbench has a dedicated
Preview Diagnostics bottom panel.

### Milestone 6: Assets Editor V1

Status: complete.

Milestone 6 implemented the first typed dependency editor. The editor now has a
shared asset data schema, asset validation, safe Electron import/reimport IPC,
command-backed asset import, alias assignment/removal/transactional rename,
explicit asset-alias usage indexing, reference-aware asset delete, typed asset
detail tabs, raw JSON fallback, and PreviewManager-backed symbolic thumbnail
requests/fallback previews for imported asset records.

### Milestone 7: Shader and Material Editor V1

Goal: exercise assets, command bus, helper CLI, preview, diagnostics, and
thumbnails through one high-value editor.

Before implementing this milestone, review `docs/editor/EDITOR_TECH_STACK.md`.
Shader/source editing should use the local CodeMirror wrapper once source editor
work begins, uniform/variant tables should use TanStack Table when needed, and
material thumbnail lists should use PreviewManager plus virtualization/caching
rather than permanent live preview instances per card.

Tasks:

1. Add shader/material schema records.
2. Add shader source editor/source asset selection.
3. Add material uniform/property editor.
4. Add texture slot asset picker.
5. Add material inheritance support.
6. Add compile-shaders command integration.
7. Add material preview document protocol.
8. Add material thumbnail sidebar.
9. Add diagnostics and fallback behavior.

Acceptance criteria:

- A material can be created, edited, previewed, and undone/redone.
- Shader compile diagnostics appear in the bottom panel.
- Invalid shader changes do not crash the preview.
- Material thumbnails are cached or pooled rather than permanently live per card.

### Milestone 8: Dirty Tabs and Close Guard

Goal: make unsaved editor state deterministic at the entity/tab level before
more typed entity editors are added.

This milestone implements VS Code-like dirty tab indicators and guarded tab
closure without scattering `dirty = true` calls across individual form controls.
Entity editors should commit persistent changes through typed commands, and a
central dirty-state layer should derive tab dirtiness by comparing the current
project resource against the last successfully saved project resource. Local
source/raw JSON drafts should register with a shared draft-dirty store.

Tasks:

1. Add a saved project document snapshot to `ProjectStore`.
2. Add resource path/equality helpers for workbench record resources.
3. Add central persistent resource dirty selectors.
4. Add an editor-local draft dirty registry for unapplied raw JSON/source drafts.
5. Derive dirty tab markers from resource dirty state plus draft dirty state.
6. Replace direct user tab close calls with a guarded close request flow.
7. Add a Save/Discard/Cancel modal for dirty tabs.
8. Add command-backed discard/restore behavior for record-backed tabs.
9. Wire raw JSON and shader source draft editors into the draft dirty registry.
10. Add tests for dirty derivation, undo/redo-to-clean behavior, and guarded
    close behavior.

Acceptance criteria:

- Editing a command-backed entity marks every tab linked to that entity dirty
  when it differs from the saved project value.
- Undoing back to the saved value clears the dirty marker.
- Redoing away from the saved value marks the tab dirty again.
- Unapplied raw JSON and shader source drafts mark their tabs dirty.
- Dirty tabs cannot be closed without Save, Discard, or Cancel.
- Dirty state is derived centrally rather than manually set by every widget.

### Milestone 9: Variables Editor V1

Goal: create typed global state authoring before scene/dialogue conditions become
common.

Tasks:

1. Add variable schema.
2. Add variable table editor.
3. Add create/rename/delete commands.
4. Add default value validation by type.
5. Add usage/reference index hooks.

Acceptance criteria:

- Variables can be authored and referenced by later editors.
- Invalid default values are diagnosed.
- Rename/delete are command-based.

### Milestone 10: Layout Editor V1

Goal: make RmlUi authoring visible and previewable.

Before implementing this milestone, review `docs/editor/EDITOR_TECH_STACK.md`.
RML/RCSS source editing should use the local CodeMirror wrapper, diagnostics
should flow through the shared validation/preview surfaces, and visual design
primitives should remain shadcn/Base UI based.

Tasks:

1. Add Layout schema.
2. Add RML/RCSS source editor.
3. Add asset/material picker hooks.
4. Add live preview document protocol.
5. Add parse/load diagnostics.
6. Add default UI assignment through project settings.

Acceptance criteria:

- A Layout can be edited and previewed live.
- Layout diagnostics surface without crashing preview.
- Project settings can choose a default layout.

### Milestone 11: Character Editor V1

Goal: establish first-class VN character authoring.

Tasks:

1. Add character schema.
2. Add pose/expression schema.
3. Add sprite asset selection.
4. Add material override selection.
5. Add dialogue display style fields.
6. Add character preview.

Acceptance criteria:

- A character with at least one pose/expression can be authored.
- Character records can be referenced by scenes and dialogue.

### Milestone 12: Room Editor V1

Goal: support visual room authoring and interactive text room basics.

Tasks:

1. Add room schema or evolve existing new schema.
2. Add background asset/material selection.
3. Add description/rich text source editing.
4. Add enter/leave script hooks.
5. Add placed object/hotspot basics.
6. Add navigation/path fields.
7. Add room preview.

Acceptance criteria:

- A room can be visually previewed.
- Room data can be used by runtime preview/export path.

### Milestone 13: Dialogue Editor V1

Goal: author branching dialogue and embed it later in scenes.

Before implementing this milestone, review `docs/editor/EDITOR_TECH_STACK.md`.
Dialogue graph work should use `@xyflow/react` when the graph editor is
implemented, while ordered/reorderable lists should continue to use dnd-kit.

Tasks:

1. Add dialogue schema.
2. Add graph/tree editor.
3. Add node inspector.
4. Add speaker/character references.
5. Add choice/condition/script fields.
6. Add preview from selected node.

Acceptance criteria:

- Dialogue can be authored as nodes and choices.
- Dialogue can reference characters.
- Preview from selected node works or reports missing runtime support cleanly.

### Milestone 14: Scene Editor V1

Goal: implement the core VN orchestration authoring surface.

Before implementing this milestone, review `docs/editor/EDITOR_TECH_STACK.md`.
Scene step ordering should start with local components plus dnd-kit. Add a
specialized timeline package only after concrete scene timeline requirements
justify it.

Tasks:

1. Add scene schema.
2. Add sequence/timeline editor.
3. Add step insertion and reorder commands.
4. Add basic step types:
   - background change
   - character show/hide/pose
   - dialogue block
   - audio cue
   - variable set/check
   - script
   - wait/continue
   - branch
   - Layout change
5. Add local inspector.
6. Add preview from start/selected step.

Acceptance criteria:

- A simple VN scene can be authored using assets, materials, characters,
  variables, layouts, and dialogue.
- Scene editing is undoable.
- Preview can play or approximate the authored sequence.

### Milestone 15: Map, Inventory, and Actions V1

Goal: add optional adventure/point-and-click systems after the VN basics exist.

Tasks:

1. Map graph editor.
2. Inventory item editor.
3. Verb/action/interactions editor.
4. Optional project setting gates.
5. Runtime preview integration as engine support matures.

Acceptance criteria:

- VN-only projects can ignore these systems.
- Adventure projects can author core interaction data.

### Milestone 16: Tests Editor V1

Goal: make deterministic playback tests authorable and debuggable.

Tasks:

1. Add test schema for new project format.
2. Add test step editor.
3. Add assertion editor.
4. Add run selected/run all.
5. Add playback report visualization.
6. Add failure timeline and state inspector.
7. Add optional recording from live preview when runtime hooks exist.

Acceptance criteria:

- Tests can be created, run, and inspected from the editor.
- Failures are actionable and tied to project references.

### Milestone 17: Export and Packaging Workflow

Goal: make editor-authored projects produce runtime packages.

Tasks:

1. Add export profile UI.
2. Add validation-before-export flow.
3. Add shader compile-before-export flow.
4. Add asset dependency collection.
5. Strip editor-only data for runtime packages.
6. Show manifest/package diagnostics.
7. Add preview-from-exported-package option.

Acceptance criteria:

- A project can be validated, compiled, packaged, and previewed from export.
- Export diagnostics are visible and actionable.

## Deferrals and Non-Goals For Early Work

These should not block the workbench and first editor slices:

- Full visual RML designer.
- Full scene timeline keyframe animation editor.
- Live2D runtime implementation.
- Localization editor.
- Collaborative editing.
- Plugin system.
- Marketplace/template store.
- Old project format compatibility.
- Native SDL window embedding into Electron.
- Generic scripting/eval command channel between editor and preview.

## Verification Strategy

For docs-only changes:

```sh
git diff -- docs/editor/EDITOR_IMPLEMENTATION_PLAN.md
```

For editor shell changes:

```sh
cd editor
pnpm typecheck
pnpm test
pnpm lint
```

For preview protocol or web preview changes:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
cd editor
pnpm engine:preview:build
pnpm test
```

For native helper changes:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
```

For runtime/export/rendering-impacting changes, also run the smallest relevant
Linux/Web/Android checks documented in `AGENTS.md` and `docs/BUILD_AND_VERIFY.md`.

## Suggested First Implementation Prompt

```
@dev nt Review `/home/thomas/dev/nt/docs/editor/EDITOR_IMPLEMENTATION_PLAN.md` and all relevant files, including some that may be in the reference project dir `/home/thomas/dev/nt/refs/NovelTea/src/editor/`. Create an implementation plan for Milestone X.
```
