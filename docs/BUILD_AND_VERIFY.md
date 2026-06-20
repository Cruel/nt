# Build and Verify

## Purpose

Collect the supported local build, test, smoke, and packaging verification commands for NovelTea.

## Prerequisites

The `engine` target requires bgfx, RmlUi (with Lua plugin), Lua 5.5 + sol2,
FreeType, HarfBuzz, SheenBidi, and libunibreak. Desktop builds satisfy these
through [vcpkg](https://github.com/microsoft/vcpkg) via the manifest in
[`vcpkg.json`](../vcpkg.json). Web/Android builds use FetchContent.

See [docs/build/CMAKE_OPTIONS.md](CMAKE_OPTIONS.md) for the full list of
supported CMake variables.

## Initial Command Set

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
```

Run Android verification when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

## Optional Components

- twink (`NOVELTEA_ENABLE_TWINK`): when `OFF`, tweens resolve as immediate value changes. Default `ON`.
- Dear ImGui (`NOVELTEA_ENABLE_DEVTOOLS`): dev/debug overlay. Default `ON`.
- Shader compilation (`NOVELTEA_COMPILE_SHADERS`): set `OFF` to use prebuilt shaders. Default `ON`.
