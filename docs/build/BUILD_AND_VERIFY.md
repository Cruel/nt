# Build and Verify

## Purpose

Collect the supported local build, test, smoke, and packaging verification commands for NovelTea.

## Prerequisites

The `noveltea_engine` target requires bgfx, RmlUi (with Lua plugin), Lua 5.5 + sol2,
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
cmake --build --preset linux-debug --target public-header-probes module-dependency-inventory
ctest --test-dir build/linux-debug --output-on-failure
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
cmake --build --preset web-debug --target public-header-probes module-dependency-inventory
pnpm run web:smoke:debug
cmake --preset web-profile
cmake --build --preset web-profile
pnpm run web:smoke:profile
```

## Compile a Project Without the Editor

Compile a saved project into canonical CompiledProject V1 gameplay JSON from the repository root:

```sh
pnpm project:compile -- \
  --project path/to/project.json \
  --output path/to/compiled-project.json
```

The editor-local equivalent is:

```sh
cd editor
pnpm project:compile -- \
  --project path/to/project.json \
  --output path/to/compiled-project.json
```

This is a Node-only test/CI command. It uses the same `publishCompiledArtifact` boundary as editor
preview and runtime export, writes exact canonical bytes atomically, and does not create a runtime
package or platform application. Add `--json` for a machine-readable report. Exit codes `2`, `3`,
`4`, and `5` distinguish argument, input, compiler, and output failures respectively.

Export a saved editor project through the headless platform-export path with `pnpm project:export`.
Use `pnpm android:export-config -- --output <file>` to generate the Android exporter local-toolchain
configuration from `ANDROID_SDK_ROOT`/`ANDROID_HOME`, `JAVA_HOME`, `SHADERC`/`NOVELTEA_SHADERC`, and
`BGFX_SHADER_INCLUDE_DIR`/`BGFX_SHADER_INCLUDE`/`NOVELTEA_BGFX_SHADER_INCLUDE_DIR`.
For repository-local Android development, `scripts/run-android.sh` builds the native player with the
checked-in `android/` Gradle project, compiles the selected NovelTea project into generated Android
inputs under `build/run-android/generated`, and invokes the same Gradle project again in prebuilt-
native packaging mode. It does not create or install a player-template archive. The script uses the
shared Android acceptance fixture by default, installs the resulting APK, and starts logcat. Pass
`--project path/to/project.json` to use another saved project and optionally `--profile <id>` to
select its Android profile. Official editor exports and release certification continue to exercise
immutable packaged player templates.
Android CI invokes `pnpm android:fixture` and `pnpm project:export` directly for both fixture
revisions so the public command path, rather than a private test-only entrypoint, is certified.

For repository-local Web export testing, `scripts/run-web.sh` configures the host editor tool and
canonical release Web player template, exports the selected project (or the shared acceptance
fixture), and serves the result. Pass `--project` and optionally `--export-profile` to select a saved
project. `--readback-gallery` serves the sandbox gallery instead; the legacy `--release` and
`--profile` modes imply that gallery path so they continue to select their matching Web presets.

## Electron Editor

Install and operate the editor from the `editor/` directory:

```sh
corepack enable
cd editor
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

For development and distribution validation:

```sh
cd editor
pnpm dev
pnpm dev:skip-preview
pnpm stage
pnpm package
pnpm package:smoke
pnpm artifact
```

The default development command builds the `web-release` sandbox preview. Staging and packaging
also require a host `noveltea-editor-tool`; build the matching release preset or set
`NOVELTEA_EDITOR_TOOL_PATH`. Native distributables must be produced on their target host: Linux x64
for AppImage/DEB/RPM, Windows x64 for NSIS, and macOS arm64 for DMG/ZIP. See
[Editor Build and Distribution](../editor/BUILD_AND_DISTRIBUTION.md) for stage layout, manifest,
ASAR/native-module policy, fuse verification, package smoke, release collection, and signing inputs.

Android template packaging must follow a successful ABI/flavor Gradle build. The template packager
captures the merged `libnoveltea-player.so`/`libSDL3.so` closure and staged system assets from that
build. Subsequent editor exports use those prebuilt files and require Java plus the Android SDK/build
tools, but not the repository source tree, CMake, or the Android NDK.

`cxx-policy` is mandatory for any change touching C++, CMake, dependency wiring, runtime templates, or
platform build graphs. It combines the first-party source scanner, JSON-boundary scanner, six-module
include/link boundary checker, positive/negative checker fixtures, compiler feature assertions,
dependency compile-command inspection, and the Linux runtime-link audit. Run
`cmake --build --preset linux-debug --target json-boundary-policy` to diagnose JSON boundary failures
alone, or `cmake --build --preset linux-debug --target module-boundary-policy` to diagnose module graph
failures. See [JSON Boundary Policy](../architecture/JSON_BOUNDARY_POLICY.md) and
[Module Boundary Policy](../architecture/MODULE_BOUNDARY_POLICY.md) for the machine-validated
exception formats.

`public-header-probes` verifies every dependency-clean module consumer surface, fake runtime ports
without Lua/backends, presentation without host backends, the private Lua adapter boundary, and a
consumer including only the Engine facade. `module-dependency-inventory` is report-only and writes
the configured source/link/include/definition graph to
`build/<preset>/reports/module-dependency-inventory.txt`.

For host/backend lifetime changes, also validate the devtools-disabled sanitizer configuration so
the stub and real debug paths both compile and lifecycle tests run under ASan/UBSan:

```sh
cmake --preset linux-sanitize -DNOVELTEA_ENABLE_DEVTOOLS=OFF
cmake --build --preset linux-sanitize --target \
  noveltea_host_tests noveltea_ui_tests noveltea_ui_backend_tests public-header-probes
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a build/linux-sanitize/tests/noveltea_host_tests
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a build/linux-sanitize/tests/noveltea_ui_tests
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a build/linux-sanitize/tests/noveltea_ui_backend_tests
```

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

The main CI workflow keeps separate `ccache` namespaces for Linux debug, Linux sanitizer,
Emscripten, Android NDK, and Windows MSVC compilation. Cache keys include the toolchain identity where
one is explicitly versioned and the current commit, with platform/configuration-scoped restore keys
for reuse by later commits. Do not share compiler-output cache prefixes between these configurations:
their flags, object formats, and instrumentation are intentionally incompatible. CI prints cache
statistics for the sanitizer and Windows jobs so cache effectiveness remains visible in job logs.

The checked-in Android project is the immutable player-template source. It builds
`noveltea-player`, not the sandbox, and requires one ABI per invocation:

```sh
./gradlew :app:assembleDebug -PnovelteaAbi=x86_64
./gradlew :app:assembleRelease -PnovelteaAbi=arm64-v8a
```

Android template packaging requires certified `essl-300` shader assets from a matching native build
or `build/prebuilt-shader-assets`, plus the pinned bundletool JAR. Release CI separately uses the
builder NDK's `llvm-readelf` to assert that the packaged native libraries retain at least 16 KiB
`LOAD` alignment:

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

- Dear ImGui (`NOVELTEA_ENABLE_DEVTOOLS`): dev/debug overlay. Default `ON`.
- Shader compilation (`NOVELTEA_COMPILE_SHADERS`): set `OFF` to use prebuilt shaders. Default `ON`.
