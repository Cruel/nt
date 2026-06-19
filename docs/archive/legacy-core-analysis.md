# Historical: Legacy Core Analysis

This document is historical archive material from the completed backend-neutral core migration. It may mention old constraints, risks, or migration options that are no longer current direction. Current guidance lives in `AGENTS.md`, `README.md`, `docs/migration/STATUS.md`, `docs/migration/PLAN.md`, and `docs/migration/COMPATIBILITY.md`.

---

Date: 2026-06-18

This report summarizes the old `Cruel/NovelTea` core engine as migration input for the new `nt` runtime. It is a planning document only; the old tree remains read-only reference material.

## Files Reviewed

- `ProjectDataIdentifiers.hpp`, `ProjectData.hpp`, `ProjectData.cpp`
- `Entity.hpp`, `Entity.cpp`
- `Game.hpp`, `Game.cpp`
- `Context.hpp`, `Context.cpp`, `Subsystem.hpp`
- `SaveData.hpp`, `SaveData.cpp`
- `Settings.hpp`, `Settings.cpp`
- `ScriptManager.hpp`, `ScriptManager.cpp`, `core.js`
- `Event.hpp`, `Event.cpp`
- `Timer.hpp`, `Timer.cpp`
- `TextLog.hpp`, `TextLog.cpp`
- `ObjectList.hpp`, `ObjectList.cpp`
- `PropertyList.hpp`, `PropertyList.cpp`
- `Action`, `Verb`, `Object`, `Script`, `Room`, `Map`, `Dialogue`, `DialogueSegment`, `Cutscene`, and cutscene segment classes
- `BBCodeParser`, `TextTypes`, `ActiveText`, `ActiveTextSegment`
- `AssetLoader`, `AssetManager`, `Zip`, `json`
- old state/UI/renderer classes for dependency and behavior boundaries

## Old Architecture Summary

The old engine is centered on `Context`, a service locator that creates and exposes subsystems through global macros such as `GGame`, `GSave`, `ProjData`, and `ScriptMan`. `Game` owns high-level session state and coordinates project data, save data, script hooks, entity queues, room/map flags, object locations, autosave, and messages.

Runtime flow is split across `Game`, `StateEventManager`, script callbacks, and SFML-backed state/UI classes. This makes direct porting risky: much of the old behavior is backend-neutral in intent, but the implementation is entangled with global subsystem lookup, Duktape values, SFML drawables, and state classes.

The migration should therefore preserve formats and semantics while replacing ownership and integration patterns.

## Project Data

Old `ProjectData` stores a `game` JSON document plus packaged assets. `newProject()` establishes the default keys, old collection names, default script hook strings, entrypoint metadata, and asset placeholders.

Important compatibility details:

- Selected entity refs use `[type, id]`.
- `CustomScript` is a selected-entity pseudo-type; its `id` slot is inline script content, not a project collection key.
- Legacy `fonts` and `textures` can be empty array placeholders or object maps after assets are added.
- The new `ProjectDocument::new_project()` is intentionally a normalized in-memory model with old-compatible key names; legacy imports preserve the wire JSON shape.

## Entity Schemas

Old entity records are JSON arrays with base fields `[id, parentId, properties, ...]`.

Known entity shapes:

- `Object`: `[id, parentId, properties, name, caseSensitive]`
- `Script`: `[id, parentId, properties, autorun, content]`
- `Action`: `[id, parentId, properties, verbId, script, objectIds, positionDependent]`
- `Verb`: `[id, parentId, properties, name, objectCount, scriptDefault, scriptConditional, actionStructure]`
- `Room`: `[id, parentId, properties, descriptionRaw, scriptBeforeEnter, scriptAfterEnter, scriptBeforeLeave, scriptAfterLeave, objects, paths, name]`
- `Map`: `[id, parentId, properties, defaultRoomScript, defaultPathScript, rooms, connections]`
- `Dialogue`: `[id, parentId, properties, defaultName, nextEntity, rootIndex, enableDisabledOptions, showDisabledOptions, logMode, segments]`
- `Cutscene`: `[id, parentId, properties, fullScreen, canFastForward, speedFactor, nextEntity, segments]`

Nested records:

- Room object entries are `[objectId, placeInRoom]`.
- Room paths are eight direction entries, each `[enabled, selectedEntity]`.
- Map rooms contain bounds, room ids, visibility script, and style.
- Map connections contain start/end room ids, endpoints, visibility script, and style.
- Dialogue segments have ids, link/type fields, condition flags, scripts, text, show-once/log/autosave flags, and child links.
- Cutscene segments include text, page-break, generated page, and script segment variants with timing, transition, skip, and condition fields.

Migration direction:

- Add typed views/parsers with structural diagnostics.
- Preserve raw JSON for round-trip compatibility where promised.
- Add semantic validators only after import succeeds.

## Save, Settings, and Profiles

Old `SaveData` writes `.ntsav` JSON in profile/slot directories. It tracks play time, navigation/map flags, text log, properties, object locations, visited rooms, room descriptions, current state metadata, and related runtime values.

Old `Settings` writes `settings.conf` with size factor, profile list, and active profile.

Migration direction:

- Add `SaveDocument` and `SettingsDocument` before runtime behavior.
- Keep profile and slot filesystem operations backend-neutral.
- Separate persistence from runtime autosave/load policy.
- Preserve old object-location and property override behavior for later runtime integration.

## Runtime Flow

Old `StateEventManager` is the best behavioral reference for the game loop. It handles active modes, entrypoint startup, save restoration, message callback, room text updates, dialogue state, cutscene transitions, script/custom-script execution, and entity queue popping.

Old `Game` handles:

- Project initialization and reset.
- Save/load/autosave and sync-to-save.
- Room/map navigation flags.
- Object locations and project/save property merging.
- Script hook dispatch around save/load.
- Text log and message handling.

Migration direction:

- Replace `Context`/`Subsystem` macros with explicit `GameSession` or `RuntimeContext` ownership.
- Add an event bus, timer scheduler, entity resolver, entity queue, and state controller as backend-neutral services.
- Make controllers emit commands/events rather than driving renderer or UI classes directly.

## Scripting

Old scripting uses Duktape/dukglue and exposes globals:

- `Game`
- `Save`
- `Script`
- `Log`
- `Timer`

It also exposes entity constructors/loaders, properties, methods, and old `core.js` helpers such as `console.log`, seeded `Math.random`, `_jsonGet`, `_propGet`, `toast`, `thisEntity`, `prop`, and `setProp`.

The current `nt` runtime already uses Lua 5.5 plus sol2/sol3-style bindings. Duktape is reference material only and must not be implemented or reintroduced as a runtime dependency.

Migration direction:

- Specify a Lua compatibility API that mirrors old script-visible behavior.
- Decide separately how to migrate old JavaScript script bodies into Lua: project-level migration tooling, a restricted source translator, Lua compatibility shims, or clear unsupported-script diagnostics.
- Keep all script-engine decisions out of `noveltea_core`.

## Text and UI

Old `BBCodeParser` and `TextTypes` contain the durable text semantics: styles, object links, page breaks, color/font/size/border offsets, diff spans, and effects such as fade, glow, nod, shake, tremble, and pop.

Old `ActiveText`, renderers, GUI widgets, and state classes are SFML-heavy and should not be directly ported.

Migration direction:

- Port BBCode and text effect semantics into backend-neutral rich-text runs and timelines.
- Integrate those runs with the current engine-owned HarfBuzz/FreeType text layout and bgfx rendering after semantic tests pass.
- Build RmlUi runtime views and bgfx adapters around controller outputs, not old widget classes.

## Asset and Package Behavior

Old project packages contain:

- `game`
- `image`
- `fonts/*`
- `textures/*`

The new package reader already covers read-only extraction for those entries. Runtime integration remains future work.

Migration direction:

- Map extracted package entries into logical `AssetManager` mounts.
- Resolve old font/texture/shader references through backend-neutral asset ids.
- Defer write support until the editor/runtime requires it.

## Core Migration Risks

- Script compatibility is the largest behavioral risk because old projects contain JavaScript while the new runtime uses Lua and will not embed Duktape.
- Entity arrays are compact and weakly typed; import validation must be strict about structure but tolerant of unknown extension keys.
- Save restoration crosses project data, runtime controller state, dialogue/cutscene state, object locations, and script state.
- Old rich text mixes parsing, layout, animation, and SFML rendering; splitting these layers is necessary to avoid renderer coupling.
- The old service locator hides dependencies; new runtime APIs need explicit ownership to stay testable.

## Recommended Migration Order

1. Finish legacy entity schema views and structural validators.
2. Add save/settings/profile document import and tests.
3. Add project graph validation independent of import.
4. Add runtime event bus and timer scheduler.
5. Add a `GameSession` skeleton with project/save ownership and entity queue.
6. Add scripting compatibility API design and the first Lua bindings for non-script-body behavior.
7. Add room/action/dialogue/cutscene controllers.
8. Add BBCode/text semantics and integrate with the modern text stack.
9. Add RmlUi/bgfx runtime adapters.
10. Add editor preview/tooling APIs.

## Verification Expectations

Each slice should add focused tests before broader runtime integration. Linux and Web configure/build/test remain the default verification set for core work. Android builds are required when CMake, platform, shader, asset packaging, or JNI/Gradle paths change.
