# NovelTea Runtime

NovelTea is a C++20 runtime/framework for migrating and modernizing the old NovelTea engine on top of a portable SDL3/bgfx baseline.

## Required Stack for `engine`

- SDL3: platform, windowing, input, and lifecycle.
- bgfx: rendering across Linux desktop, Web/Emscripten, and Android.
- RmlUi (with Lua plugin): general runtime UI.
- Lua 5.5 + sol2: the only runtime scripting target.
- FreeType, HarfBuzz, SheenBidi, and libunibreak: engine-owned text shaping/layout support.

## Optional Components

- twink: animation backend for the tween service. If absent, tweens resolve as immediate value changes.
- Dear ImGui: developer/debug UI only (controlled by `NOVELTEA_ENABLE_DEVTOOLS`).

## Backend-Neutral Core

`noveltea_core` stays free of SDL3, bgfx, RmlUi, ImGui, Lua, Electron, Android, Emscripten, SFML, and Qt types.
It depends only on `nlohmann_json` and `miniz`.

## Supported Targets

- Linux desktop through CMake presets.
- Web through Emscripten and the `web-debug`/release presets.
- Android through the Gradle project in `android/`.

The sandbox app is the primary fast smoke target while the runtime and editor are being completed.

## Repository Layout

```text
engine/          Portable runtime framework and backend-neutral core.
apps/sandbox/    Smoke-test application and runtime fixtures.
android/         Android Gradle project.
cmake/           Toolchains, packaging, and build helpers.
editor/          Electron/TanStack/Vite editor direction.
docs/            Current architecture, runtime, UI, rendering, editor, migration, and archive docs.
refs/NovelTea/   Optional read-only legacy reference clone.
```

## Build and Verify

See [docs/build/CMAKE_OPTIONS.md](docs/build/CMAKE_OPTIONS.md) for the full list of supported CMake variables.

Linux:

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
./build/linux-debug/apps/sandbox/noveltea-sandbox
```

Web:

```sh
cmake --preset web-debug
cmake --build --preset web-debug
```

Android:

```sh
cd android
./gradlew :app:assembleDebug
```

Helper scripts are available for common smoke runs:

```sh
./scripts/run-desktop.sh
./scripts/run-web.sh
./scripts/run-android.sh
```

## Current Project State

The backend-neutral core migration is substantially complete. Current foundation includes legacy `game` JSON import, read-only legacy package import, save/settings/profile document handling, typed project/domain models, runtime sessions/controllers, rich-text semantics, editor preview/tooling APIs, and reduced compatibility fixtures.

Active work remains in runtime state/playback, Lua execution wiring, RmlUi runtime components, ActiveText/map/text-log rendering, editor preview and test playback, save/autosave/object placement behavior, packaging/export, and real project fixture coverage.

See [docs/migration/STATUS.md](docs/migration/STATUS.md) for the current status board and [docs/migration/COMPATIBILITY.md](docs/migration/COMPATIBILITY.md) for the compatibility contract.
