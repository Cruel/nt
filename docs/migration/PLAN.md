# NovelTea Runtime, UI, Rendering, and Editor Migration Plan

This is the active migration plan for `Cruel/nt` after completion of the backend-neutral core-domain migration.

The previous core migration established old-compatible project/save/package data boundaries, typed project models, runtime session/controller foundations, rich-text semantics, legacy package reading, and editor-preview APIs. This plan covers the remaining migration work needed to turn that foundation into a complete NovelTea runtime/editor stack.

## Status Legend

- `[done]`: phase acceptance criteria are complete.
- `[next]`: next phase to plan or implement.
- `[active]`: implementation is in progress.
- `[blocked]`: cannot proceed until a listed dependency is resolved.
- `[pending]`: not started.

## Current Direction

`nt` is the new portable NovelTea runtime/framework. It targets SDL3 for platform/input/windowing, bgfx for rendering, RmlUi for runtime UI composition, Dear ImGui for developer/debug UI only, Lua for scripting, and Electron/TanStack/Vite for the future editor.

The old `refs/NovelTea/` tree remains available as read-only reference material. It must not be added as a production include path, CMake subdirectory, or linked target. Port behavior intentionally into the new architecture.

JavaScript and Duktape compatibility are not migration goals. All script fields execute as Lua. If an imported legacy project contains JavaScript source, it should fail as Lua with a normal Lua diagnostic unless/until project migration tooling converts it.

`twink` is the external tween engine. Do not re-port the old NovelTea TweenEngine into `nt`. Use `https://github.com/Cruel/twink` as an external dependency through `find_package(twink CONFIG)`, FetchContent, a vcpkg port, or another low-friction package route. `twink` should remain general-purpose and independent from `nt`.

## Non-Negotiable Architecture Rules

Keep backend-neutral core code free of SDL3, bgfx, RmlUi, ImGui, Lua, sol, Electron, Android, Emscripten, SFML, and Qt types.

Do not port old SFML renderers, drawables, game states, widgets, or Qt editor classes directly.

RmlUi is the primary general runtime UI layer. Baseline `.rml` and `.rcss` files may use dimensions, percentages, flex layout, anchors, and responsive styling. They should be DPI-aware through the existing logical-size/framebuffer-size/density model.

Complex game widgets should be C++-backed RmlUi components/elements when normal RML/buttons/data binding are insufficient. Initial target components are `ActiveText`, `MapView`, and `TextLog`; later candidates include inventory/object/action/choice views if they need nontrivial behavior.

Dear ImGui remains developer/debug-only.

Runtime/editor/test playback must use deterministic runtime inputs and outputs, not ad hoc UI event paths.

## Target Runtime Stack

The final runtime should have these layers:

1. `noveltea_core`: project/save/package data, typed project model, runtime session state, deterministic controller/state machine, rich-text semantics, editor/test-preview facades, and backend-neutral diagnostics.

2. Lua runtime adapter: script execution, bindings, hook execution, error reporting, and runtime mutation APIs. Lua types stay outside backend-neutral core.

3. Runtime presentation state: backend-neutral view/presentation data derived from `RuntimeController` and `RuntimeSessionHost`, suitable for both RmlUi runtime UI and editor preview.

4. RmlUi runtime UI: baseline runtime documents/styles plus custom C++ elements for complex widgets.

5. bgfx renderer: 2D primitives, texture/material/shader resources, engine-owned text rendering, render-target/effect support where needed by custom components.

6. `twink` animation layer: tween primitives used by ActiveText, UI transitions, map animations, object movement, and other engine-owned animation behavior.

7. Editor bridge: Electron/web preview integration, project editing APIs, test playback APIs, validation/diagnostics, and command/state inspection.

## Phase 0 [done]: Documentation Reset

Status: complete.

Before further implementation, the docs were cleaned so future agents do not follow stale plans.

Update `AGENTS.md` to say Lua is the only scripting target, Duktape/dukglue/JavaScript compatibility are non-goals, RmlUi is the runtime UI layer, and complex NovelTea widgets may be C++-backed RmlUi elements.

Rewrite `docs/migration/PLAN.md` with this plan.

Condense `docs/migration/STATUS.md` into a current status board.

Rewrite `docs/migration/COMPATIBILITY.md` so compatibility means project/save/package data compatibility, not JavaScript execution compatibility.

Move renderer/text technical docs out of `docs/migration/` into `docs/rendering/`.

Archive old slice reports after preserving the useful legacy-core analysis.

Acceptance criteria:

- Active docs do not instruct agents to preserve Duktape or implement JavaScript compatibility.
- Historical docs are clearly marked historical.
- `PLAN.md`, `STATUS.md`, and `COMPATIBILITY.md` each have a distinct purpose.

## Phase 1 [done]: Runtime State and Input/Output Model

Goal: replace the old implicit `StateEventManager`/UI/script coupling with a deterministic runtime input/output contract.

The old engine split flow across `Game`, `StateEventManager`, script callbacks, and SFML UI/state classes, which made direct porting risky because behavior was entangled with global subsystem lookup, Duktape values, SFML drawables, and state classes.  The old `StateEventManager` is still useful as a behavioral reference for active modes, entrypoint startup, save restoration, room text updates, dialogue state, cutscene transitions, script/custom-script execution, and entity queue popping. 

Implement or formalize:

- `RuntimeInput`
  - `Start`
  - `Stop`
  - `Reset`
  - `Tick`
  - `Continue`
  - `SelectDialogueOption`
  - `Navigate`
  - `SelectObject`
  - `ClearObjectSelection`
  - `RunAction`
  - `SetEntrypoint`
  - `LoadSave`
  - `ApplyTestStep`
  - future editor/debug inputs

- `RuntimeOutput`
  - mode changes
  - view/presentation updates
  - script execution requests/results
  - save mutation requests
  - text log entries
  - notifications
  - diagnostics
  - editor/test playback observations

- `RuntimeDiagnostic`
  - severity
  - category
  - source entity/ref
  - script/hook context
  - message
  - optional Lua traceback
  - deterministic playback step index when applicable

Refactor RmlUi click handling and editor preview injection so both map into the same runtime input API. Avoid adding more direct RmlUi-to-controller special cases.

Acceptance criteria:

- Runtime can be driven headlessly without RmlUi.
- RmlUi runtime UI and editor preview use the same input pathway.
- Existing room/dialogue/cutscene/action behavior remains covered by tests.
- Diagnostics are structured enough for editor display.

## Phase 2 [done]: Lua Runtime Execution

Goal: make runtime script points execute Lua through the new runtime architecture.

Policy:

- All scripts are Lua.
- No JavaScript runtime.
- No Duktape.
- No source translation in the runtime.
- Invalid script source fails as Lua and produces diagnostics.
- Project migration tooling may later assist conversion, but it is not runtime compatibility.

Implement:

- Wire `ScriptDeferred` or equivalent controller outputs into the Lua runtime adapter.
- Execute project hooks in the old behavioral order where relevant:
  - before/after save
  - before/after load
  - before/after action
  - undefined/default action
  - room before/after enter
  - room before/after leave
  - dialogue condition/script nodes
  - cutscene script segments
  - autorun scripts
- Complete the Lua bindings needed for runtime behavior:
  - `Game`
  - `Save`
  - `Script`
  - `Log`
  - `Timer`
  - entity/property helpers
  - object/inventory/location helpers
  - notifications/toasts
- Ensure errors are captured as runtime diagnostics and playback failures.

Acceptance criteria:

- A Lua script can mutate properties, object locations, log entries, notifications, timers, and save-relevant state through explicit APIs.
- Lua errors do not crash the engine; they stop or continue according to a documented policy.
- Runtime tests cover successful script execution and failing script diagnostics.
- Active docs no longer describe JavaScript compatibility as an implementation path.

## Phase 3 [done]: Save, Autosave, and Object Placement Runtime Policy

Goal: finish the runtime behavior that sits on top of already parsed save/profile data.

Status: complete for the backend-neutral core/runtime slice. Platform-specific disk/browser save persistence and runtime save/load screens remain later-phase work.

Implement:

- Save-slot abstraction for runtime use.
- Manual save.
- Load/restore.
- Autosave policy.
- Before/after save/load Lua hooks.
- Object location mutation and restoration.
- Property override mutation and restoration.
- Visited room tracking.
- Room description diff/restoration behavior.
- Text log persistence.
- Current room/map/entity/queue persistence.
- Navigation/map enabled flags.
- Save diagnostics for stale/missing entities.

Acceptance criteria:

- Save documents can round-trip runtime mutations.
- Object placement is not limited to starting inventory/current room visibility.
- Autosave-triggering dialogue/cutscene/action behavior is deterministic.
- Editor preview can load a save or run from a clean project state.

## Phase 4 [done]: RmlUi Runtime UI Baseline

Goal: make RmlUi the real runtime UI shell, not a temporary string-injected smoke view.


Baseline RmlUi should own:

- runtime root layout
- mode/title/notification placement
- room body panel
- dialogue/cutscene panel
- choices/options
- object/inventory/action panels
- text log placement
- map/minimap placement
- save/load/settings/profile screens later
- responsive layout and style through `.rml`/`.rcss`

The current baseline RML/RCSS may continue to exist, but evolve it toward user-overridable runtime templates.

Implement:

- Stable project/system paths for built-in runtime RML/RCSS.
- Override lookup policy:
  - project override first
  - theme override second
  - system default fallback
- Runtime presentation data binding strategy.
- DPI expectations documented and tested.
- UI event translation into `RuntimeInput`.

Acceptance criteria:

- Existing runtime project sandbox still works.
- Baseline RML/RCSS can be overridden by a project asset without recompiling.
- Layout remains correct across at least two logical sizes and high-DPI scale.
- RmlUi remains independent from Dear ImGui.

## Phase 5 [done]: C++-Backed RmlUi Custom Components

Goal: create the extension model for complex NovelTea widgets.

Status: complete for the component foundation. Runtime UI registers `nt-active-text`,
`nt-map-view`, and `nt-text-log` as C++-backed RmlUi elements, and the document binder
feeds current `RuntimeUIViewState` into deterministic fallback RML. Full ActiveText
animation/effects, real map rendering, and text-log scrollback behavior remain in
Phases 7, 8, and 9.

Components to define first:

- `nt-active-text`
- `nt-map-view`
- `nt-text-log`

Possible later components:

- `nt-object-view`
- `nt-inventory-view`
- `nt-action-bar`
- `nt-choice-list`
- `nt-save-slot-list`
- `nt-profile-list`

The component model should support:

- structured data input from runtime presentation state
- style hooks from RmlUi/RCSS
- custom rendering through RmlUi geometry or bgfx where needed
- custom event emission mapped to `RuntimeInput`
- deterministic behavior for tests
- no backend-neutral core dependency on RmlUi

Acceptance criteria:

- Component registration happens in the RmlUi runtime layer.
- Components can be present in baseline RML.
- Missing component data fails gracefully.
- Component tests or sandbox smoke prove at least one component lifecycle.

## Phase 6 [done]: Tween Integration Through `twink`

Goal: make tweening a reusable engine service while keeping `twink` external and general-purpose.

Status: complete for the initial engine/UI integration slice. `twink` is resolved as an
external package or pinned FetchContent fallback, `TweenService` owns the engine tween
manager, and ActiveText fallback presentation uses deterministic reveal progress.

Dependency strategy:

- Prefer `find_package(twink CONFIG QUIET)` first.
- Provide a controlled FetchContent fallback if no package is found.
- Pin to a tag or commit SHA. Do not track a moving branch in CI.
- Link `twink::twink` only into engine/UI/render targets that need animation.
- Keep `noveltea_core` free of `twink` unless a specific backend-neutral animation data model is proven necessary. Prefer core stores declarative animation semantics and engine runtime owns tween instances.

Potential `nt` wrapper:

- `TweenService`
- owns `twink::TweenManager`
- advances from engine tick using deterministic delta
- supports named channels/groups
- supports pause/resume/kill by owner id
- exposes debug inspection
- handles callbacks safely
- integrates with playback deterministic stepping

Use cases:

- ActiveText reveal/effects
- map transitions
- UI panel transitions
- notification fade
- object sprite movement
- editor preview animation stepping

Acceptance criteria:

- `twink` is not vendored into `nt` source.
- Build works on Linux/Web/Android.
- Tween updates are deterministic under fixed timestep playback.
- At least one runtime component uses `TweenService` in tests or sandbox.

## Phase 7 [done]: ActiveText

Goal: migrate NovelTea’s animated/rich text behavior without directly porting old SFML `ActiveText`.

Status: complete except for real rendering hooks. Runtime view state now
preserves backend-neutral `RichTextDocument` data, the engine exposes deterministic
ActiveText frame data with per-glyph reveal/effect state, and `nt-active-text` projects
that state into fallback RML with object/style/effect/material/shader metadata and page-break
prompts. Material and shader ids are preserved as metadata stubs for later renderer work.

Use the existing rich-text semantic model as the source of truth. It already models text styles, object spans, page breaks, shader IDs, offsets, diff spans, and effects such as fade, glow, nod, shake, tremble, and pop.

ActiveText depends on the Phase 5 custom-component model and Phase 6 `TweenService`.

ActiveText responsibilities:

- parse/render `RichTextDocument`
- preserve object link spans
- preserve page breaks and wait/continue behavior
- support reveal/typing progression
- support per-run/per-glyph animation state
- support hit testing for object/text spans
- support skip/fast-forward where cutscenes/dialogue allow it
- support diff room descriptions
- support text-log-friendly plain/rich snapshots
- expose deterministic state for playback/tests

Rendering strategy:

1. First pass: RmlUi fallback spans/plain text with correct state and events.
2. Second pass: engine-owned shaped text layout with style runs.
3. Third pass: per-glyph effects/tweens through `twink`.
4. Fourth pass: material/shader hooks where needed.

Use `twink` for ActiveText animation timelines rather than ad hoc interpolation. `twink` supports basic tweens, callbacks, delay, repeat, yoyo, pause/resume/kill, easing equations, and multi-value/path properties. It should be wrapped in an engine adapter so ActiveText does not expose `twink` details through backend-neutral core APIs.

Acceptance criteria:

- Dialogue/cutscene/room text can use rich-text payloads instead of flattened escaped paragraphs.
- Page breaks and continue prompts are driven by ActiveText state.
- Tests cover parsing-to-presentation behavior and at least one deterministic animation/reveal path.
- Visual effects can be unsupported initially only if the semantic data is preserved and diagnostics/fallback behavior are explicit.

## Phase 8 [blocked]: MapView

Goal: replace old map presentation with a new RmlUi-hosted custom component.

MapView should consume typed map data from `ProjectModel` and runtime state:

- map rooms
- room bounds
- connections
- visibility state
- current room
- path availability
- styles
- click/hit targets
- optional transition animation

Behavior:

- Render map rooms/connections.
- Highlight current room.
- Hide/disable rooms/connections based on runtime state and Lua visibility scripts.
- Emit navigation/runtime inputs where applicable.
- Support responsive sizing from RmlUi layout.

Rendering may start with RmlUi geometry or simple DOM children. Move to bgfx/custom geometry only when needed.

Acceptance criteria:

- A project map appears in runtime UI.
- Current room updates deterministically.
- Visibility and click behavior are testable.
- Editor preview can inspect map presentation state.

Status: complete for the v1 RmlUi DOM-backed MapView slice, but not fully complete against the
original Phase 8 behavior list. Runtime view state now exposes typed map presentation data, the host
derives it from `ProjectModel` plus current runtime room/map flags, editor preview can inspect it,
and `nt-map-view` renders deterministic fallback RML with current-room highlighting and `nt-nav`
targets for directly reachable rooms.

Blocked/deferred before Phase 8 can be marked fully done:

- Lua-evaluated room/connection visibility. `noveltea_core` must remain Lua-free, so this needs an
  explicit engine-layer contract for evaluating map visibility scripts, applying boolean results
  back to `RuntimeUIViewState`, and surfacing diagnostics deterministically.
- Optional transition animation. No concrete behavior is specified yet.
- bgfx/custom map geometry. This is deferred until the RmlUi DOM fallback proves insufficient.

## Phase 9 [done]: TextLog

Goal: turn text log into a real runtime component.

Status: complete for the v1 structured runtime/UI slice. Runtime view state now exposes structured
text-log entries with rich-text snapshots, speaker/source/category metadata, and deterministic
sequence ids. Legacy save `/log` remains a string array for compatibility, and saved string log
entries are restored into structured runtime view entries. `nt-text-log` renders deterministic RmlUi
fallback markup with entry wrappers and metadata attributes, while runtime `TextLogEntry` outputs
carry structured payloads for playback assertions.

TextLog should support:

- structured entries
- plain text and rich text snapshots
- source metadata where useful
- scrollback
- restore from save
- editor/test inspection
- optional filtering later
- RmlUi styling
- deterministic playback assertions

Acceptance criteria:

- Runtime log entries are visible and persisted.
- TextLog does not depend on direct string-injected DOM updates.
- Playback tests can assert log contents.

Deferred beyond v1:

- Optional filtering UI.
- Platform-specific save/load screens that expose log scrollback.

## Phase 10 [done]: Object, Inventory, and Action Presentation

Goal: make old object/action interaction work cleanly in the new UI model.

Implement structured presentation for:

- room objects
- inventory objects
- selected objects
- verbs/actions
- object count constraints
- action labels
- disabled/invalid action states
- diagnostics for invalid selection/action

RmlUi can render ordinary lists/buttons, but selection state and action resolution should be backed by runtime presentation/input models. Add custom components only where needed.

Acceptance criteria:

- Multi-object actions work.
- Position-dependent and order-insensitive action semantics remain correct.
- Selection state is visible and clearable.
- Editor playback can express object selection and action execution.

## Phase 11 [done]: Runtime Renderer and Asset Presentation

Goal: make the runtime visually complete beyond text/UI controls.

Status: acceptance criteria are met.

Implement:

- texture loading for project visuals
- cover/background/image slots — v1 done via RmlUi `<img>` elements backed by
  the existing bgfx RmlUi texture loader (bimg decode).
- room/object image presentation where project data supports it
- shader/material resolution policy — deferred (see below)
- render layers and ordering — 4-layer view system (Background, Main, Foreground,
  UIOverlay) via `GameLayer` enum, each mapped to its own bgfx view.
- scissor/clip integration — push/pop scissor stack on `Renderer`, applied
  per draw call in `submit_quad()`.
- frame timing and animation update policy — wall-clock delta drives ActiveText
  reveal progress. Fixed-step deferred to Phase 12.
- fallback visuals for missing assets
- diagnostics for missing/invalid assets

Do not invent old SFML behavior blindly. Use `refs/NovelTea/` only to understand intended semantics and project fields.

Deferred items:

- Material/shader resolution (`render/material.hpp` and `render/shader.hpp`
  contain deferred stubs). When implemented this must define property-key →
  MaterialId mapping, a material registry resolving MaterialId → bgfx
  ProgramHandle with platform-aware variant selection, and a bind() path on
  QuadCommand. ActiveText effects, map overlays, per-object materials, and
  per-room background materials all depend on this step.

Acceptance criteria:

- Runtime can show a project-backed background/cover/texture where available.
- Missing assets are diagnosable.
- Linux/Web/Android asset paths behave consistently.

## Phase 12 [done]: Editor Preview and Recorded Test Playback

Goal: build the future editor’s runtime-preview/test foundation.

Status: acceptance criteria are met for the backend-neutral playback runner.

The current preview facade already supports start, stop, reset, entrypoint override, step/tick, state inspection, input injection, and command capture. Preserve and expand that seam.

Implement:

- `RuntimePlaybackSession` — done in the core editor API.
- recorded step format — done, including JSON parsing and project `tests` discovery.
- deterministic tick policy — done with fixed-delta support and zero-delta drain ticks after non-tick inputs.
- fixed delta option — done.
- assertion/check format — done for mode, current room/title, text log, properties, inventory/object locations, outputs, and diagnostics.
- Lua test setup/check hooks — done through an engine/script callback that keeps core Lua-free.
- command/output capture — done.
- diagnostics capture — done.
- final pass/fail report — done.
- branch/story traversal support — v1 foundation only; richer graph traversal tooling remains future editor work.
- editor-friendly JSON result export — done.

Playback inputs should be the same `RuntimeInput` used by RmlUi.

Support tests stored in project data where appropriate. Existing project key constants include `tests`, `init`, `check`, and `steps`, so future project-level test definitions should build on those names rather than inventing unrelated schema. 

Acceptance criteria:

- A headless playback can run a sequence of navigation/dialogue/continue/action steps.
- Lua errors fail playback with structured diagnostics.
- Assertions can check current mode, room, log, properties, inventory/object locations, and emitted outputs.
- The editor can call the same API later.

## Phase 13 [done]: Package Writing and Export

Goal: move from read-only legacy package support to editor/runtime package workflows.

Status: complete for the v1 runtime package/export slice. Runtime packages are ZIP-based
`.ntpkg` files with a NovelTea manifest and legacy-compatible runtime entries, so current
sandbox/runtime loading can consume them through the existing package fallback path.

Implement:

- new runtime package format decision
- legacy package write only if truly needed
- project export
- runtime asset packaging
- compiled shader variant inclusion
- font/texture/audio/text resource inclusion
- package manifest
- checksum/version metadata
- editor export API hooks
- CI packaging tests

Policy:

- Runtime packages should contain compiled shader variants for supported targets.
- Editable project packages may contain source/editor assets.
- Keep old package import available for compatibility.
- Do not expose ZIP/miniz types through public engine APIs.

Acceptance criteria:

- Runtime can export a project package usable by sandbox/runtime.
- Linux/Web/Android package smoke tests pass.
- Missing target shader variants are reported clearly.

## Phase 14 [done]: Editor Integration

Goal: integrate the runtime/editor bridge into the Electron/TanStack/Vite editor.

Status: complete for the V1 helper-CLI/editor-workspace slice. Typed editors,
theme/UI override editing, and richer workflow fixtures remain later work.

Implement:

- project open/import
- validation diagnostics panel
- raw entity browser initially
- typed editors for object/verb/action/room/map/dialogue/cutscene/script
- runtime preview panel
- input injection from editor controls
- output/diagnostic timeline
- test playback runner
- save/package/export UI backed by the Phase 13 package/export API
- asset browser
- theme/UI override editing later

Constraints:

- Do not port Qt.
- Keep editor dependencies out of `noveltea_core`.
- Keep the engine preview boundary narrow and replaceable.

Acceptance criteria:

- Editor can load a project and launch preview.
- Editor can run a recorded playback test and show results.
- Editor can display validation/runtime/Lua diagnostics.
- Editor can invoke package/export flows without owning packaging internals.

## Phase 15 [pending]: Real Project Fixtures and Compatibility Verification

Goal: verify with actual old projects, not only synthetic fixtures.

Add fixture strategy:

- private fixtures ignored by git but supported by local test runner
- redistributable reduced fixtures committed to repo
- generated synthetic fixtures for CI
- fixture manifest describing expected support level
- screenshot/readback baselines where practical
- playback tests for branching stories

Compatibility claims should be tied to fixture results.

Acceptance criteria:

- At least one realistic project runs through import, runtime start, room/dialogue/cutscene/action flow, save/load, and playback.
- Known unsupported behavior is documented.
- CI covers synthetic fixtures; local/private fixtures can be run by developers.

## Verification Strategy

Core/runtime changes:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
```

Web-impacting changes:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
```

Renderer/RmlUi/text changes:

```sh
ctest --test-dir build/linux-debug -R "rmlui|RmlUi|text|Text|shader|material" --output-on-failure
./build/linux-debug/apps/sandbox/noveltea-sandbox --demo all --frames 180
```

Android-impacting changes:

```sh
cd android
./gradlew --no-daemon :app:assembleDebug
```

Editor changes:

```sh
cd editor
pnpm lint
pnpm typecheck
pnpm test
```

Full release/package changes should verify the relevant GitHub Actions workflow or equivalent local package scripts.

## Immediate Next Slices

1. Runtime input/output model and state/playback design.
2. Lua execution wiring for deferred script points.
3. Save/autosave/object-location runtime policy.
4. RmlUi baseline template/data-binding pass.
5. RmlUi custom component scaffolding.
6. `twink` dependency integration and `TweenService`.
7. ActiveText first pass.
8. Playback test runner foundation.

## Definition of Done for This Migration

The migration is complete when:

* old project data can be imported and validated;
* runtime starts and progresses through room, dialogue, cutscene, map, object, action, timer, text-log, save/load, and Lua-scripted behavior;
* general UI is RmlUi-driven and project/theme-overridable;
* ActiveText, MapView, and TextLog exist as real custom runtime components;
* animations use `twink` through an engine adapter;
* editor preview and recorded playback tests use the same deterministic runtime input/output model as the game UI;
* package export works for runtime use;
* Linux, Web, and Android build/smoke paths pass;
* remaining incompatibilities are explicitly documented and not caused by stale JavaScript/Duktape assumptions.
