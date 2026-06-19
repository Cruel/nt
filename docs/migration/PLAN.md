# NovelTea Core Engine Migration Plan

**Completion status: [█████████░░] 9/11 phases fully done — Phase 10 editor preview/tooling APIs next**

See [`STATUS.md`](STATUS.md) for detailed completion tracking, verification results, and next-prompt recommendations. This file tracks phase-level scope only.

Migration begins from the current portable `nt` framework, not from a direct transplant of the old engine. The old `refs/NovelTea/` tree is read-only reference material and must not be added as a production include path, CMake subdirectory, or linked target.

The target architecture keeps old NovelTea project compatibility while splitting the old monolithic `Context`/`Game`/SFML state stack into backend-neutral core models, backend-neutral runtime controllers, and explicit SDL3/bgfx/RmlUi adapters.

## Migration Principles

- Keep `noveltea_core` free of SDL3, bgfx, RmlUi, ImGui, Lua, sol2, Duktape, SFML, Qt, Android, Emscripten, and editor dependencies.
- Preserve legacy wire compatibility at the project/save/package boundary, then expose typed APIs internally.
- Do not port old Qt editor code. Editor-facing APIs should target the future Electron/TanStack/Vite editor.
- Do not directly translate old SFML drawables or state classes. Port their data, sequencing, and semantics first.
- Treat old Duktape/dukglue bindings as a reference for legacy behavior only. Current `nt` uses Lua 5.5 plus sol2/sol3-style bindings; Duktape must not be implemented or reintroduced as a runtime dependency.
- Keep every slice buildable on Linux and Web; run Android verification when CMake, platform, shader, packaging, or JNI/Gradle behavior changes.

## Current Foundation

The first backend-neutral core slices are in place:

- `noveltea_core` owns project key constants, `EntityType`, selected-entity `EntityRef`, `ProjectDocument`, and `nlohmann::json` project APIs.
- `legacy::ProjectImporter` imports old `game` JSON text while preserving legacy shapes where required.
- `legacy::ProjectPackageReader` reads old ZIP project packages and extracts `game`, `image`, `fonts/*`, `textures/*`, and safe project-relative auxiliary assets without exposing ZIP library types.

This foundation deliberately excludes old `Game`, `Context`, `SaveData`, runtime scripting, SFML, Qt, renderer/UI state classes, and gameplay runtime behavior.

## [x] Phase 1: Legacy Wire Schemas

Goal: make every old project/save shape explicit before building behavior on top of it.

- Inventory and test all old project collections: `actions`, `cutscenes`, `dialogues`, `maps`, `objects`, `rooms`, `scripts`, `verbs`, `fonts`, `textures`, and `shaders`.
- Add typed parsers or views for old entity array records while preserving original JSON for lossless import/export.
- Cover selected-entity refs, including `CustomScript` inline content.
- Capture old script hooks and defaults from `ProjectData::newProject()`.
- Add golden fixtures for representative old projects, including non-empty asset maps and unknown extension keys.
- Keep validation structural: reject malformed shapes, but do not require referenced entities to exist until the project validation layer.

## [x] Phase 2: Backend-Neutral Domain Models

Goal: introduce typed models that can be used by runtime, editor preview, and validation without renderer dependencies.

- Add entity identifiers, entity stores, inheritance metadata, project properties, and typed collections.
- Model `Object`, `Script`, `Action`, `Verb`, `Room`, `Map`, `Dialogue`, `DialogueSegment`, `Cutscene`, and `CutsceneSegment` as backend-neutral values.
- Preserve parent-chain behavior and project/save property override rules without running scripts yet.
- Add explicit graph validation for room paths, map rooms/connections, dialogue links, cutscene next-entity refs, and action verb/object references.
- Keep conversion boundaries clear: legacy JSON import -> `ProjectDocument` -> typed project view/model.

## [x] Phase 3: Save, Settings, and Profiles

Goal: port old persistence formats without recreating the old service locator.

- Add `SaveDocument` and `SettingsDocument` for old `.ntsav` and `settings.conf` JSON shapes.
- Preserve save fields: play time, text log, properties, object locations, visited rooms, room descriptions, navigation/map flags, current entity, and metadata required for state restoration.
- Add profile and slot abstractions that can operate on a backend-neutral filesystem/path interface.
- Separate save import/export from autosave policy and runtime session mutation.
- Add tests for legacy save fixtures, profile naming, slot discovery, and malformed save diagnostics.

## [x] Phase 4: Runtime Core Facade

Goal: replace old `Context`/`Subsystem` macros with explicit runtime ownership.

- Add a backend-neutral `GameSession` or `RuntimeContext` driven by `Engine::tick()`.
- Own project model, save model, runtime flags, current room/map/entity queue, play time, object inventory state, and property overrides.
- Add a typed event bus for old events: game loaded/saving/saved, timer completed, notification, text logged, and runtime mode changes.
- Add a timer scheduler that is independent of script engine and renderer.
- Add runtime services through constructor injection or small interfaces, not global `GGame`/`GSave`/`ScriptMan` macros.
- Keep renderer/UI output as commands or events consumed by adapters.

## [x] Phase 5: Scripting Compatibility Layer

Goal: preserve old script-facing behavior on top of the current Lua runtime.

- Define the compatibility API for old globals: `Game`, `Save`, `Script`, `Log`, `Timer`, entity constructors, entity loading/existence checks, and property access.
- Support old text expression evaluation using `{{ expression }}` with a deterministic failure policy.
- Preserve old script hook order: project before/after save/load hooks, room before/after enter/leave hooks, action default/conditional scripts, autorun scripts, cutscene script segments, and dialogue condition/script nodes.
- Implement or document a migration strategy for old JavaScript script bodies that targets Lua. Acceptable paths are project-level script migration tooling, a restricted source translator, compatibility shims in Lua, or clear unsupported-script diagnostics. Do not add Duktape, dukglue, or any JavaScript runtime to the new engine.
- Add fixtures around old `core.js` semantics such as seeded random, `thisEntity`, `prop`, `setProp`, `toast`, and object/action helpers.

## [x] Phase 6: Runtime Controllers

Goal: port old gameplay sequencing without old SFML state classes.

- Add a mode/state controller for room, dialogue, cutscene, script/custom-script, and idle states.
- Port entity queue behavior, entrypoint startup, save-state restoration, and next-entity transitions.
- Add room navigation and path selection using selected-entity refs.
- Add action resolution for verb/object combinations, including parent fallback and default action scripts.
- Add dialogue graph traversal, conditional visibility/enabled state, show-once behavior, log modes, autosave flags, and text/name parsing.
- Add cutscene timeline expansion from page segments into text/page-break/script segments.
- Emit UI-neutral commands for messages, notifications, text log entries, room text changes, dialogue options, cutscene pages, and navigation availability.

## [x] Phase 7: Text Semantics

Goal: port old text behavior into the existing modern text stack in layers.

- Port `TextTypes` enums and BBCode parsing semantics into backend-neutral rich-text runs.
- Preserve object spans, page breaks, style tags, color/font/size/border/x/y-offset tags, animation tags, and old text effects.
- Recreate room-description diff semantics with a small internal algorithm or a deliberately chosen dependency.
- Add a pagination and timeline model for cutscene/dialogue text separate from rendering.
- Integrate with the existing engine-owned HarfBuzz/FreeType text layout after semantics are proven.

## [x] Phase 8: Runtime UI and Rendering Adapters

Goal: connect controllers to the new SDL3/bgfx/RmlUi runtime without porting old GUI widgets.

- Current slices: added a backend-neutral `RuntimeUIViewAdapter` that consumes `RuntimeController` command streams into view state; added `RuntimeSessionHost` to own `GameSession`, `RuntimeController`, and the UI adapter together; added a RmlUi document updater and sandbox runtime-game RML/RCSS assets for room text, navigation choices, dialogue options, cutscene text/page-break prompts, notifications, text log rendering, room objects, inventory objects, and verb action controls; added RmlUi click delegation hooks for dialogue options, navigation choices, active dialogue/cutscene continuation, object selection, and room action submission; and wired `Engine`/sandbox loading through `--runtime-project` so a real project asset can drive the runtime UI each frame.
- Build RmlUi-backed runtime views for room text, navigation choices, dialogue options, inventory/object interaction, notifications, text log, profiles, settings, and save/load slots.
- Build bgfx or RmlUi adapters for map visualization and rich text effects only after backend-neutral data is stable.
- Keep Dear ImGui limited to diagnostics and developer tooling.
- Keep platform/input concerns in SDL3-facing layers and renderer resource ownership in bgfx-facing layers.
- Add Web and Android checks whenever UI/resource loading behavior changes.

## [x] Phase 9: Asset and Package Integration

Goal: make imported old projects usable by runtime sessions.

- Current slices: added a read-only bridge from `legacy::ProjectPackageReader` output into `AssetManager` memory mounts, exposing `game`, cover `image`, `fonts/*`, `textures/*`, and safe project-relative auxiliary assets such as `scripts/*`, `text(s)/*`, `shaders/*`, `audio/*`, `sounds/*`, `music/*`, `data/*`, and `resources/*` as project logical assets; updated `--runtime-project` loading to accept normalized JSON first, then fall back to importing legacy ZIP package bytes and mounting package assets before loading the imported project document; added a generated deterministic legacy package smoke asset and CTest sandbox smoke so Linux/Web asset staging can exercise the package path without committing a binary ZIP.
- Map remaining legacy package entries into the existing logical `AssetManager` mounts where old projects require them.
- Resolve fonts, textures, shaders, cover `image`, and project-relative script/text assets without exposing old package internals.
- Decide when to add write support for old or new project packages; read-only compatibility is enough until runtime/editor workflows require saving packages.
- Add deterministic package fixtures and asset lookup tests for Linux and Web.

## [ ] Phase 10: Editor Preview and Tooling APIs

Goal: expose stable backend-neutral APIs for the future editor.

- Provide project load/import/validate/save APIs.
- Provide runtime preview controls: start, stop, reset, set entrypoint, step/tick, inspect state, inject choices, and capture emitted UI commands.
- Provide entity editing and validation APIs without requiring the old Qt editor model.
- Add migration diagnostics that can explain legacy compatibility issues to editor users.

## [ ] Phase 11: Compatibility Completion

Goal: prove old projects survive migration with known limits.

- Build a fixture suite from real old projects and reduced synthetic projects.
- Add project/save/package round-trip checks where lossless behavior is promised.
- Add scripted runtime golden tests for room entry, actions, dialogue, cutscene, timers, text log, save/load, autosave, and object inventory.
- Add user-visible compatibility notes for unsupported old behaviors.
- Only after this phase consider deleting temporary compatibility shims.

## Verification Strategy

- Core/domain slices: `cmake --preset linux-debug`, `cmake --build --preset linux-debug`, `ctest --test-dir build/linux-debug --output-on-failure`, `cmake --preset web-debug`, `cmake --build --preset web-debug`.
- Runtime/controller slices: add focused unit tests plus sandbox frame smoke when `Engine::tick()` integration changes.
- Renderer/UI slices: add readback/screenshot tests where possible, run sandbox smoke, and include Web verification.
- Android-impacting slices: run `cd android && ./gradlew :app:assembleDebug` when platform, CMake, shaders, assets, or JNI/Gradle paths are touched.

## Immediate Next Slices

1. Start Phase 10 by adding backend-neutral project load/import/validate APIs for editor use.
2. Add runtime preview controls for start, stop, reset, entrypoint override, tick/step, state inspection, injected choices, and captured UI commands.
3. Render rich-text runs as structured RmlUi spans or hand off to a bgfx rich-text renderer after effect semantics are stable.
4. Add profile/settings/save/load persistence flows once Phase 10 preview APIs define the ownership boundary.
5. Wire `RuntimeController` `ScriptDeferred` commands to the Lua compatibility runtime with deterministic success/failure policy.
