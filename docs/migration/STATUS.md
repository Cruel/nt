# Migration Status

Last updated: 2026-06-19.

## Completed Foundation

- Portable SDL3/bgfx runtime baseline for Linux, Web, and Android.
- RmlUi runtime UI integration and Dear ImGui developer/debug separation.
- Backend-neutral core migration for legacy project data, typed domain models, validation, save/settings/profile documents, runtime sessions/controllers, runtime view-state adapter, editor preview/tooling APIs, and reduced compatibility fixtures.
- Legacy `game` JSON import and read-only legacy package import.
- Backend-neutral rich-text semantics and engine-owned Unicode text implementation.
- Lua runtime foundation. Lua is the only runtime scripting target.

## Active Gaps

- Runtime controller `ScriptDeferred` commands still need complete Lua execution wiring and user-facing diagnostics.
- Invalid imported legacy script text should fail as Lua; no JavaScript, Duktape, dukglue, or JS compatibility layer will be added.
- Runtime save-slot mutation, autosave policy, and persisted object placement are incomplete.
- RmlUi runtime game UI needs production components for complex widgets such as ActiveText, MapView, TextLog, and similar custom behavior.
- Rich-text visual rendering parity, ActiveText effects, map rendering, and text-log rendering remain active.
- Editor preview/test playback needs hardening around real workflows.
- Packaging/export workflows and real old-project fixture coverage remain incomplete.
- Web browser and Android emulator runtime smoke coverage should be expanded where practical.

## Current Verification Commands

Use the smallest relevant subset for a docs-only or narrow code change:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

Run the sandbox when runtime loop, UI, input, or rendering behavior changes:

```sh
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Run Android when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For documentation-only cleanup, a targeted `rg` check for stale active-doc instructions is sufficient.

## Next Planning Task

Replace `docs/migration/PLAN.md` with the next detailed plan covering runtime state/playback, Lua execution, RmlUi runtime components, ActiveText/map/text-log rendering, editor preview/testing, save/autosave/object placement, packaging/export, and real project fixtures.
