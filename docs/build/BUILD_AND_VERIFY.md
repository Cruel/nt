# Build and Verify

## Purpose

Collect the supported local build, test, smoke, and packaging verification commands for NovelTea.

## Prerequisites

The `engine` target requires bgfx, RmlUi (with Lua plugin), Lua 5.5 + sol2,
FreeType, HarfBuzz, SheenBidi, and libunibreak. Desktop builds satisfy these
through [vcpkg](https://github.com/microsoft/vcpkg) via the manifest in
[`vcpkg.json`](../../vcpkg.json). Web/Android builds use FetchContent.

See [docs/build/CMAKE_OPTIONS.md](CMAKE_OPTIONS.md) for the full list of
supported CMake variables.

## Initial Command Set

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
cmake --build --preset linux-debug --target cxx-policy
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
pnpm run web:smoke:debug
cmake --preset web-profile
cmake --build --preset web-profile
pnpm run web:smoke:profile
```

`cxx-policy` is mandatory for any change touching C++, CMake, dependency wiring, runtime templates, or
platform build graphs. It combines the first-party source scanner, negative policy fixtures, compiler
feature assertions, dependency compile-command inspection, and the Linux runtime-link audit.

Shipped C++ targets always compile without C++ exceptions and compiler RTTI. There is no supported
exception-enabled or RTTI-enabled build mode. Desktop target dependencies use NovelTea policy triplets;
build-host executables such as `shaderc` remain on the ordinary host triplet and must not enter player
link or package graphs.

The default `pnpm run web:smoke` command remains an alias for the debug structural Web smoke. Use `web-profile` plus `pnpm run web:smoke:profile` for optimized RmlUi/bgfx perf-counter measurement; that path compiles render perf counters in, enables them at runtime with `renderPerf=1`, disables ImGui with `noImgui=1`, and treats FPS as informational only.

Run Android verification when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

Run the native robustness configuration after parser, filesystem, callback-boundary, or ownership
changes. It enables ASan, UBSan, and deterministic smoke runs for the JSON, rich-text, package, and
runtime-project fuzz harnesses:

```sh
cmake --preset linux-sanitize
cmake --build --preset linux-sanitize
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a ctest --test-dir build/linux-sanitize --output-on-failure \
  -E 'noveltea_(rmlui_readback_capture|rmlui_feature_fixtures_capture|rmlui_resize_readback_capture|presentation_readback_capture|sandbox_runtime_.*_smoke)'
```

The GPU/sandbox smoke executables should also run under ASan/UBSan, but Mesa/EGL may retain
driver-owned allocations until process exit. Run those tests separately with
`ASAN_OPTIONS=detect_leaks=0:halt_on_error=1`; do not disable leak detection for the engine and parser
test suites.

For sustained fuzzing with Clang/libFuzzer, configure a separate build with
`NOVELTEA_BUILD_FUZZERS=ON` and `NOVELTEA_USE_LIBFUZZER=ON`, then run the desired
`noveltea_fuzz_*` executable with a corpus directory.


After Android configuration, run `cmake/VerifyDependencyCompilerPolicy.cmake` against the active
`android/app/.cxx/.../<abi>` build directory. CI performs this automatically together with the
repository source-policy checks.

Windows policy validation uses the `windows-release` preset and
`x64-windows-static-noveltea`. macOS arm64 uses `arm64-osx-noveltea`. These validations require native
runners; Linux cannot establish their ABI or linker correctness.

The checked-in Android project is the immutable player-template source. It builds
`noveltea-player`, not the sandbox, and requires one ABI per invocation:

```sh
./gradlew :app:assembleDebug -PnovelteaAbi=x86_64
./gradlew :app:assembleRelease -PnovelteaAbi=arm64-v8a
```

Android template packaging requires certified `essl-300` shader assets from a matching native build
or `build/prebuilt-shader-assets`, plus the pinned bundletool JAR:

```sh
cmake -DNOVELTEA_RELEASE_TAG=local -DNOVELTEA_ANDROID_ABI=arm64-v8a \
  -DNOVELTEA_ANDROID_FLAVOR=release -DNOVELTEA_BUNDLETOOL_JAR=/path/to/bundletool-all-1.18.1.jar \
  -P cmake/PackageNovelTeaAndroidPlayerTemplate.cmake
```

Build an orientation-specific APK with one of:

```sh
./gradlew :app:assembleDebug -PnovelteaOrientation=landscape
./gradlew :app:assembleDebug -PnovelteaOrientation=portrait
```

These values generate `sensorLandscape` and `sensorPortrait`. Any other value fails Gradle
configuration so package policy cannot silently diverge from the exported project profile.

Desktop sandbox launch accepts `--display-orientation landscape|portrait`, selecting an
orientation-appropriate initial window shape. Web shell exports use `?orientation=landscape` or
`?orientation=portrait`; browser orientation locking is best-effort, while engine viewport fitting
remains authoritative for correctness.

For local device/emulator release-smoke testing, use the helper script:

```sh
./scripts/run-android.sh --release
```

That helper asks Gradle to sign the release build with the debug keystore only for local installation. Publishing/release packaging should use real release signing properties (`novelteaReleaseStoreFile`, `novelteaReleaseStorePassword`, `novelteaReleaseKeyAlias`, and `novelteaReleaseKeyPassword`) or leave the artifact unsigned for later signing.

## Optional Components

- twink (`NOVELTEA_ENABLE_TWINK`): when `OFF`, tweens resolve as immediate value changes. Default `ON`.
- Dear ImGui (`NOVELTEA_ENABLE_DEVTOOLS`): dev/debug overlay. Default `ON`.
- Shader compilation (`NOVELTEA_COMPILE_SHADERS`): set `OFF` to use prebuilt shaders. Default `ON`.
