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
pnpm run web:smoke:debug
cmake --preset web-profile
cmake --build --preset web-profile
pnpm run web:smoke:profile
```

The default `pnpm run web:smoke` command remains an alias for the debug structural Web smoke. Use `web-profile` plus `pnpm run web:smoke:profile` for optimized RmlUi/bgfx perf-counter measurement; that path compiles render perf counters in, enables them at runtime with `renderPerf=1`, disables ImGui with `noImgui=1`, and treats FPS as informational only.

Run Android verification when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

For local device/emulator release-smoke testing, use the helper script:

```sh
./scripts/run-android.sh --release
```

That helper asks Gradle to sign the release build with the debug keystore only for local installation. Publishing/release packaging should use real release signing properties (`novelteaReleaseStoreFile`, `novelteaReleaseStorePassword`, `novelteaReleaseKeyAlias`, and `novelteaReleaseKeyPassword`) or leave the artifact unsigned for later signing.

## Optional Components

- twink (`NOVELTEA_ENABLE_TWINK`): when `OFF`, tweens resolve as immediate value changes. Default `ON`.
- Dear ImGui (`NOVELTEA_ENABLE_DEVTOOLS`): dev/debug overlay. Default `ON`.
- Shader compilation (`NOVELTEA_COMPILE_SHADERS`): set `OFF` to use prebuilt shaders. Default `ON`.
