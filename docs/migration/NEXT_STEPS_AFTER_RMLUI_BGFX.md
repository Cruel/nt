# NovelTea Migration Next Steps After RmlUi-bgfx Stabilization

Date: 2026-06-26

## Purpose

This document records the recommended migration direction after the external `rmlui-bgfx` renderer became stable enough to use as NovelTea's real RmlUi/bgfx backend. It is intended as a reviewable planning document, not an implementation patch.

The main conclusion is that the old backend-neutral core migration is no longer the active bottleneck. The new `nt` engine has already moved well past the original core/data phase and into runtime presentation, RmlUi integration, shader/material integration, package export, and editor tooling. The next work should focus on visual/runtime parity, real fixture coverage, and project-authored presentation rather than broad core scaffolding.

## Current Repository State

### New `nt` engine foundation

The current engine already has substantial coverage in these areas:

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- External `rmlui-bgfx` package integration through `rmlui_bgfx::rmlui_bgfx`.
- RmlUi runtime UI shell with project/theme/system fallback templates.
- Dear ImGui separated as developer/debug UI only.
- Backend-neutral legacy `game` JSON import and validation.
- Legacy package reader for read-only compatibility imports.
- Typed project model and entity-schema parsing for old-compatible entity records.
- Backend-neutral save/settings/profile document support.
- Runtime session/controller model through `GameSession`, `RuntimeController`, and `RuntimeSessionHost`.
- Shared deterministic `RuntimeInput` / `RuntimeOutput` path for headless tests, editor preview, and RmlUi event routing.
- Save slot abstraction, in-memory slot store, manual save/load/autosave APIs, runtime save snapshots, and save-backed object placement.
- Lua-only script runtime with bindings for the current runtime host/session APIs.
- Structured runtime diagnostics for Lua errors, invalid input, stale save references, and editor/playback reporting.
- Runtime view-state adapter exposing room/dialogue/cutscene/body/log/map/object/action visual state.
- RmlUi custom component foundation for `nt-active-text`, `nt-map-view`, and `nt-text-log`.
- `twink` integration through `TweenService` for deterministic animation services.
- Backend-neutral rich-text semantics and ActiveText frame metadata.
- Engine-owned Unicode text system based on FreeType, HarfBuzz, SheenBidi, and libunibreak.
- bgfx renderer layer/view model, scissor stack, quad batching, and frame timing hooks.
- Shader/material schema records, shader roles, validation, shader manifest/program resolution, host shader compilation, runtime bgfx program cache, engine 2D material binding, and RmlUi decorator material binding.
- Runtime package export with `manifest.json`, `shader-materials.json`, compiled shader variants, safe asset inclusion, and source stripping for runtime packages.
- Editor helper tooling and Electron integration for project load/import/validation/raw edits/playback/package export/preview controls.

### Old `refs/NovelTea/` reference scope

The old engine remains useful as reference material, but should not be ported directly. Its durable behavior is mostly in data formats and runtime semantics, while its implementation is tightly coupled to old architecture choices:

- `Context`, `ContextObject`, and subsystem macros hide runtime dependencies.
- `Game` and `StateEventManager` coordinate runtime state, entity queues, room transitions, script hooks, save/load, object placement, and UI-facing messages.
- `ScriptManager`, `Script`, Duktape, dukglue, and `core.js` define the old JavaScript runtime. These are reference-only; the new runtime is Lua-only.
- `ActiveText`, `ActiveTextSegment`, `CutsceneRenderer`, `DialogueRenderer`, `MapRenderer`, old GUI widgets, and state classes are SFML-era renderer/UI implementations and must not be copied directly.
- Qt editor classes and `.ui` forms are workflow/reference material only; the new editor direction is Electron/TanStack/Vite.

The migration strategy remains: preserve formats and behavior where intended, but re-express runtime behavior through the new backend-neutral model, Lua adapter, RmlUi runtime components, and bgfx renderer services.

## Recent Verification Snapshot

A local verification run was performed against the local updated renderer using CMake's FetchContent source override:

```sh
cmake --preset linux-debug -DFETCHCONTENT_SOURCE_DIR_RMLUI_BGFX=/home/thomas/dev/nt/rmlui-bgfx
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
```

Results:

- Linux debug configure succeeded.
- Linux debug build succeeded.
- Full CTest ran 291 tests.
- 290 tests passed.
- 1 test failed: `noveltea_rmlui_feature_fixtures_verify`.

The failing check is in `tests/ui/rmlui_feature_fixtures_verifier.cpp`, in the backdrop-filter fixture. The captured image had cyan-like output at pixel `(68, 56)` where the test expected magenta-like output. The sampled values from `build/linux-debug/rmlui-feature-fixtures.ppm` were:

```text
(50, 56)  = (255, 0, 0)
(100, 48) = (0, 255, 0)
(62, 56)  = (34, 255, 255)
(68, 56)  = (34, 255, 255)
```

This means the local `rmlui-bgfx` integration compiles and mostly works, but the NovelTea readback fixture or backdrop-filter behavior needs one focused review before the renderer integration should be treated as fully green.

## Key Migration Assessment

The previous mental model of "core first, then rendering layer" is mostly complete. `nt` is now in a new phase:

```text
Completed or largely complete:
  legacy data import
  typed project/save/package models
  deterministic runtime controller/session foundation
  Lua runtime foundation
  RmlUi runtime UI shell
  custom component scaffolding
  shader/material runtime data and compiled shader pipeline
  package export
  editor tool bridge

Active migration frontier:
  renderer fixture green state
  real ActiveText rendering
  MapView Lua visibility and visual rendering
  project-authored room/object/material presentation
  platform save persistence and runtime save/load UI
  real old-project fixture coverage
  editor material/shader UI and typed editors
```

The next migration steps should therefore be organized around visual/runtime parity and compatibility evidence, not more general scaffolding.

## Non-Negotiable Rules For The Next Phase

- Keep `refs/NovelTea/` read-only.
- Do not add old `refs/NovelTea/` include paths or targets to production builds.
- Do not port old SFML drawable classes directly into bgfx classes.
- Keep `noveltea_core` free of SDL3, bgfx, RmlUi, ImGui, Lua, sol, Electron, Android, and Emscripten types.
- Keep RmlUi renderer internals in the standalone `rmlui-bgfx` repository.
- Keep the NovelTea side responsible only for integration policy: asset loading, shader loading, material provider, diagnostics, runtime view ranges, and project schema/material resolution.
- Lua remains the only runtime scripting target.
- Imported JavaScript source is not runtime-compatible script. It should fail as Lua unless future project migration tooling converts it.
- Dear ImGui remains developer/debug-only.
- Use `twink` through `TweenService`; do not re-vendor or re-port the old TweenEngine into `nt`.

## Recommended Work Sequence

### Phase A: [done, omitted]

### Phase B: Implement real ActiveText rendering `[implemented v1]`

Goal: keep ActiveText as a renderer-backed NovelTea text object. RmlUi may host layout/input and provide attributes/properties, but it must not generate or render ActiveText glyph RML under the hood.

Current state:

- `RichTextDocument` preserves old BBCode semantics.
- `ActiveTextFrame` preserves per-glyph reveal/effect/style/object/material/shader metadata.
- `nt-active-text` is an RmlUi custom element host for layout/input; it does not project glyph fallback RML.
- Engine-owned text layout/rendering exists independently of RmlUi text.

Implemented v1:

- `ActiveTextLayout` is a backend-neutral layout/presentation layer over `RichTextDocument`, `ActiveTextFrame`, and shaped `TextLayout` glyph data.
- RuntimeUI keeps `nt-active-text` as the RmlUi layout host only, then snapshots the resolved content box after `Rml::Context::Update()` so direct layout uses current RmlUi bounds.
- RuntimeUI shapes the visible ActiveText string through the engine text stack and maps shaped glyph byte ranges back to rich-text run/glyph metadata where possible.
- `Renderer::draw_active_text()` draws the mapped shaped glyphs through the existing FreeType/HarfBuzz glyph atlas and bgfx text submission path after RmlUi has rendered. This is the only visible ActiveText glyph renderer.
- Reveal, rich-text color, alpha, offsets, best-effort scale, font alias/size/style metadata, renderer-side synthetic bold/italic/underline/strike styling, deterministic fade/pop/nod/shake/tremble/glow metadata, page-break/awaiting-continue state, and object hit rectangles are represented.
- RuntimeUI advances reveal by visible glyph count instead of treating the 0-1 reveal fraction as a fixed duration; the twink-backed and non-twink paths both use the same glyph-rate basis.
- Object span clicks route through `RuntimeInputType::SelectObject` using the direct layout hit rectangles; event routing walks ancestors so clicks on child spans or descendants inside `nt-active-text` are handled. Non-object body clicks now skip an in-progress reveal or continue after reveal completion.
- Per-frame material/shader stderr logging was removed. ActiveText material/direct-shader metadata is preserved; failed material or direct shader-pair resolution falls back to default text rendering with deduped diagnostics.

Remaining gap:

Old `ActiveText` was a real drawable/runtime object with reveal progression, segment timing, wait-for-click behavior, skip behavior, cursor state, highlight/object hit testing, alpha/show/hide tweening, layout bounds, line spacing, font scaling, and visual effects. The new v1 direct path establishes the renderer boundary and direct shaped drawing with basic reveal skip/continue behavior and first-pass synthetic font styling, but exact legacy segment timing, outline/border text, high-quality glow, custom ActiveText shader uniform/sampler binding, real multi-face font-family resolution, FreeType-backed synthetic style rasterization, advanced mixed-font fallback, and full visual parity remain deferred.

Implementation slices:

1. Define an engine/runtime ActiveText renderer boundary.
   - Input: `RuntimeUIViewState` active text payload or `RichTextDocument` plus `ActiveTextOptions`.
   - Output: engine text draw commands or a component-owned draw submission path.
   - Keep core free of renderer types.

2. Render basic shaped text through the existing engine text stack.
   - Use FreeType/HarfBuzz layout data.
   - Respect logical bounds, line wrapping, alignment, color, font size, and reveal progress.
   - Do not reintroduce ActiveText glyph fallback RML; fix direct renderer parity in the bgfx/text path.

3. Map rich-text style runs to renderer styles.
   - Colors.
   - Fonts and sizes.
   - Offsets.
   - Diff spans.
   - Object spans.
   - Page-break and continue prompt state.

4. Add deterministic effect rendering.
   - Start with fade/pop/nod/shake/tremble/glow as metadata-to-transform/alpha/material operations.
   - Use `TweenService` or deterministic time from `ActiveTextOptions`; avoid ad hoc untracked animation state.
   - Preserve reproducibility under playback fixed-step tests.

5. Add material/shader hooks.
   - Rich-text `[mat]` metadata should resolve to material ids when appropriate.
   - Low-level ActiveText shader-pair metadata should use `resolve_direct_shader_pair_program()`.
   - Missing material/program variants should fall back to default text rendering with structured diagnostics.

6. Add hit testing for object/text spans.
   - Map click positions to rich-text object spans.
   - Emit the correct shared runtime input or a new explicit input type if needed.
   - Avoid direct RmlUi-to-controller special cases.

Acceptance criteria:

- Existing rich-text and ActiveText metadata tests continue to pass.
- New tests cover layout/reveal/effect frame behavior without renderer coupling.
- A renderer smoke path demonstrates visible rich text with reveal progression.
- Missing fonts/materials/shaders produce actionable diagnostics.
- RmlUi fallback remains available until direct rendering reaches feature parity.

### Phase C: Add Lua-evaluated MapView visibility

Goal: unblock the deferred MapView behavior while preserving the core/engine boundary.

Current state:

- `RuntimeUIViewState` exposes map rooms, connections, current room, direct navigation targets, styles, and visibility script metadata.
- `nt-map-view` renders a deterministic fallback RML map and emits `nt-nav` click targets for reachable rooms.
- Lua visibility scripts are not evaluated because `noveltea_core` must remain Lua-free.

Implementation direction:

1. Define an engine-layer visibility evaluation contract.
   - Core continues to expose visibility script text and source entity metadata.
   - Engine/script layer evaluates those scripts through the active Lua runtime.
   - Results are applied back to presentation state or to a separate evaluated presentation overlay.
   - Diagnostics include map id, room/connection id, script context, Lua error, and fallback behavior.

2. Decide result policy.
   - Boolean true: visible/enabled.
   - Boolean false/nil: hidden or disabled depending on old semantics and project data.
   - Lua error: likely hidden/disabled with warning, or visible with warning; choose and document explicitly.

3. Add tests.
   - Room visibility true/false.
   - Connection visibility true/false.
   - Lua error diagnostic.
   - Deterministic playback state after visibility evaluation.

4. Wire `nt-map-view` click target generation to evaluated visibility.

Acceptance criteria:

- Map rooms/connections can be hidden or disabled by Lua scripts.
- Lua errors do not crash runtime.
- `noveltea_core` stays Lua-free.
- Editor preview/playback can inspect visibility diagnostics.

### Phase D: Move MapView toward real visual geometry

Goal: replace or supplement the DOM fallback map with a renderer-backed map presentation when behavior is correct.

Precondition: Phase C visibility behavior should be implemented first.

Tasks:

1. Audit old `Map`, `MapRenderer`, and editor map forms for durable semantics:
   - room bounds;
   - connection endpoints;
   - styles;
   - current-room highlight;
   - click/hit behavior;
   - optional transition behavior.

2. Decide render path:
   - RmlUi DOM fallback retained for simple/project-overridable styling;
   - RmlUi custom geometry if the component should remain layout-hosted inside RmlUi;
   - engine 2D/bgfx geometry if map rendering should share material-backed scene rendering.

3. Implement room and connection rendering.
   - Rects/regions.
   - Lines/curves if supported by old data.
   - Current-room highlight.
   - Disabled/hidden states.
   - Style/material ids.

4. Add optional transition animation through `TweenService` only after static rendering is correct.

Acceptance criteria:

- Runtime map is visible and interactive in the sandbox/runtime UI.
- Current room updates deterministically.
- Hidden/disabled rooms do not produce active hit targets.
- Rendering remains correct under RmlUi clipping/layout constraints.

### Phase E: Integrate project-authored materials into real room/object presentation

Goal: use the shader/material system for actual NovelTea content, not only demos and renderer fixtures.

Current state:

- Shader/material project records parse and validate.
- Shader compiler service can compile supported variants.
- Runtime shader program resolution and program cache exist.
- Engine 2D material-backed quads exist.
- RmlUi `shader("material-id")` decorators resolve through the NovelTea adapter.
- Package export can include shader-material metadata and compiled binaries.

Remaining gap:

Project room/object visual presentation mostly uses texture slots and RmlUi image binding. Per-room/per-object materials are not yet a first-class runtime path.

Tasks:

1. Define supported runtime material properties.
   - Rooms: background material, overlay material, image material.
   - Objects: sprite/image material.
   - UI/theme: decorator material already exists through RmlUi.
   - Avoid broad arbitrary property interpretation in the first pass.

2. Extend `RuntimeUIViewState` or engine presentation state with material ids for room/object visuals.

3. Render material-backed room/object quads through the engine 2D renderer.

4. Ensure package export gathers all referenced material shader binaries.

5. Add diagnostics for:
   - unknown material id;
   - unsupported shader role;
   - missing compiled variant;
   - missing texture assignment;
   - runtime package missing binary.

Acceptance criteria:

- A sample project uses a custom material on a room or object.
- Linux runtime renders the material-backed content.
- Runtime package smoke includes the material metadata and compiled shader binaries.
- Web package/smoke verifies the Web shader variant path.

### Phase F: Build real old-project fixture coverage

Goal: move compatibility claims from synthetic confidence to real evidence.

This is now one of the highest-value migration tasks. The current code has strong synthetic/golden coverage, but broad compatibility claims require realistic old projects.

Fixture strategy:

1. Add a fixture manifest format.
   - fixture name;
   - source type: synthetic, reduced, private, legacy package, source project;
   - expected support level;
   - known unsupported features;
   - expected entrypoint;
   - playback spec paths;
   - optional screenshot/readback baselines.

2. Support private fixtures ignored by git.
   - Local developers can place real old projects under an ignored fixture directory.
   - The runner should discover them without requiring checked-in assets.

3. Commit reduced redistributable fixtures.
   - Minimal old-compatible fixtures covering room, action, dialogue, cutscene, map, save/load, inventory, text log, package import, and shader/material export.

4. Add playback specs.
   - Start project.
   - Navigate rooms.
   - Select dialogue options.
   - Run actions.
   - Move objects/inventory.
   - Continue cutscenes.
   - Save/load/autosave.
   - Assert logs/properties/current room/mode/diagnostics.

5. Add optional visual fixtures.
   - RmlUi readback tests where stable.
   - ActiveText visual snapshots after direct rendering exists.
   - MapView snapshots after real geometry exists.

Acceptance criteria:

- At least one realistic old project or reduced old-style fixture runs through import, runtime start, navigation/dialogue/cutscene/action flow, save/load, playback, and package export.
- Unsupported behavior is explicitly recorded in fixture metadata.
- CI covers synthetic/reduced fixtures.
- Private fixtures can be run locally without polluting git.

### Phase G: Implement platform-specific save persistence and runtime save/load UI

Goal: turn the existing backend-neutral save-slot abstraction into player-facing runtime behavior.

Current state:

- Save documents exist.
- Runtime save snapshots exist.
- Save slot abstraction exists.
- Memory save slot store exists.
- Lua can call save/load/autosave through the active runtime host when a store is bound.

Remaining work:

1. Desktop save slot store.
   - Store under an application/project profile path.
   - Preserve old slot naming where intended.
   - Add migration/import behavior for old `.ntsav` files if required.

2. Web save slot store.
   - Prefer IndexedDB or an Emscripten filesystem strategy.
   - Ensure save/load works in browser smoke tests.

3. Android save slot store.
   - Use app-private storage.
   - Verify through emulator or Gradle/device smoke where practical.

4. Runtime RmlUi save/load screens.
   - Slot list.
   - Save/load/delete actions.
   - Autosave indicator.
   - Error diagnostics.

5. Profile behavior decision.
   - Preserve old profile semantics only where useful.
   - Avoid over-porting old desktop profile UI if the new runtime/editor model wants a simpler approach.

Acceptance criteria:

- Desktop runtime can save and reload after process restart.
- Web runtime can save and reload after page reload.
- Android runtime can save and reload through app-private storage.
- Save/load UI uses `RuntimeInput` or a clearly documented runtime service boundary.

### Phase H: Expand editor material/shader and typed project workflows

Goal: move from raw entity editing and command-line shader/export operations to usable editor workflows.

Current state:

- Electron/TanStack workspace can call `noveltea-editor-tool` for project load/import, validation, raw entity edits, playback tests, package export, and preview controls.
- Shader compiler service and export APIs exist.
- Runtime preview boundary exists.

Remaining work:

1. Typed entity editors.
   - Room editor.
   - Object editor.
   - Verb/action editor.
   - Dialogue editor.
   - Cutscene editor.
   - Map editor.
   - Script editor.

2. Shader/material editor.
   - Shader records.
   - Material records.
   - Uniform controls.
   - Texture slot picker.
   - Compile target selection.
   - Compile diagnostics.
   - Preview reload.

3. Hot reload path.
   - Desktop/editor preview only.
   - Keep previous valid program alive after failed compile.
   - Surface diagnostics without crashing preview.

4. Fixture/test UI.
   - Run playback specs.
   - Show diagnostics and output timeline.
   - Export package and inspect manifest/shader entries.

Acceptance criteria:

- A designer can edit a material value and see preview changes.
- Invalid shader source reports diagnostics without crashing runtime preview.
- Typed editors no longer require raw JSON editing for common project workflows.

## Cross-Cutting Technical Work

### Diagnostics cleanup

As rendering and runtime features become real, diagnostics should become more structured and less stderr-oriented.

Targets:

- RmlUi material bridge diagnostics should flow through a NovelTea diagnostic/logging boundary where practical.
- Shader/material failures should include material id, shader id, role, active variant, source asset, package path, and fallback used.
- Runtime fixture failures should report project/entity/script context.
- Avoid frame-spam diagnostics.

### Asset decoding consistency

The RmlUi texture path uses bimg decode through the NovelTea adapter. Engine 2D material texture paths still have some limited/demo-oriented texture-loading behavior in places. Align these paths so room/object materials can use real project textures consistently across Linux/Web/Android.

### Web and Android verification

Linux is the fastest development gate, but the migration target is Linux/Web/Android. Any changes touching renderer, assets, packages, shaders, RmlUi, platform storage, or CMake should include Web and/or Android checks where practical.

Suggested gates:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
pnpm run web:smoke:debug

cd android
./gradlew --no-daemon :app:assembleDebug
```

### Documentation synchronization

Keep these docs aligned as phases land:

- `docs/migration/STATUS.md`: current state, active gaps, verification commands.
- `docs/migration/PLAN.md`: active long-range migration plan.
- `docs/migration/COMPATIBILITY.md`: compatibility contract and known limits.
- `docs/rendering/RENDERING_STACK.md`: renderer ownership and integration boundary.
- `docs/rendering/NOVELTEA_SHADER_MATERIAL_PLAN.md`: shader/material pipeline.
- `docs/ui/RMLUI_RUNTIME_UI.md`: runtime UI templates, binder, component slots, and event routing.
- `docs/ui/RMLUI_CUSTOM_COMPONENTS.md`: ActiveText/MapView/TextLog component status.
- `docs/runtime/STATE_AND_PLAYBACK.md`: runtime input/output, save policy, playback.
- `docs/runtime/LUA_RUNTIME.md`: Lua execution and binding policy.
- `docs/runtime/PACKAGE_EXPORT.md`: runtime package contents and shader/material export policy.

## Suggested Immediate Task List

Recommended order:

1. Resolve `noveltea_rmlui_feature_fixtures_verify` against the updated local `rmlui-bgfx`.
2. Push/pin the updated `rmlui-bgfx` dependency in `nt` once green.
3. Implement the first direct ActiveText renderer slice using the existing engine text stack.
4. Add MapView Lua visibility evaluation at the engine/script boundary.
5. Integrate material ids into real room/object presentation through engine 2D quads.
6. Add a real/reduced old-project fixture runner and first fixture manifest.
7. Add platform save persistence and runtime save/load UI.
8. Expand editor typed/material/shader workflows.

## Definition of Done For The Next Migration Milestone

A practical next milestone would be:

- `nt` builds and tests green against a pinned stable `rmlui-bgfx` revision.
- A sample or reduced old-style project runs through runtime start, room navigation, dialogue/cutscene continuation, object/action interaction, Lua script execution, save/load, and package export.
- ActiveText uses renderer-backed text presentation for at least basic styled/revealed text.
- MapView evaluates Lua visibility scripts outside `noveltea_core` and updates click targets deterministically.
- At least one room/object visual uses a project-authored material in runtime and package export.
- Linux and Web smoke paths pass for that project.
- Remaining incompatibilities are explicitly recorded in fixture metadata and docs.
