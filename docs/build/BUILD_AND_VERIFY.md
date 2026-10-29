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

Developer formatting uses `uv` as a tool launcher so the repository can pin an exact formatter
independently of the host distribution. Install `uv` on development hosts; the CMake `format` and
`format-check` targets use the same standalone formatter driver as CI and currently run
`clang-format` 18.1.8.

## Local Build Parallelism

The canonical local build limit is the existing `CMAKE_BUILD_PARALLEL_LEVEL` environment variable.
Normal `cmake --build --preset <preset>` commands inherit and honor it automatically.

Do not override that limit with bare or explicit `--parallel`, build-tool arguments such as `-j`,
direct `ninja` or `make` invocations, or scripts that replace it with a CPU-count-derived value.
Do not run multiple CMake builds concurrently: the limit applies separately to each build process,
so overlapping Linux, Web, Android, sanitizer, or policy builds can still create enough compiler
processes to exhaust RAM and swap. Run build presets and validation builds sequentially unless the
user explicitly requests concurrent execution.

CMake link job pools (`CMAKE_JOB_POOLS` / `CMAKE_JOB_POOL_LINK`) only constrain Ninja builds. Check
`CMAKE_GENERATOR` in the build directory's `CMakeCache.txt` before relying on them: Unix Makefiles
ignores those pools and can launch several memory-heavy executable links within the compile-job
limit. On memory-constrained Makefiles builds, build one executable target at a time with
`cmake --build --preset <preset> --target <target>`, waiting for each command to finish before the
next. Do not retry an unrestricted aggregate build after a link-memory failure.

For `scripts/run-tests.sh`, set `LINK_POOL_SIZE` to override the preset's Ninja link pool for that
configuration: a positive integer sets the pool size, and `0` removes the limit. For example,
`LINK_POOL_SIZE=2 ./scripts/run-tests.sh` or `LINK_POOL_SIZE=0 ./scripts/run-tests.sh`. This affects
only Ninja; `CMAKE_BUILD_PARALLEL_LEVEL` remains the separate overall build concurrency limit.

Build and test helper scripts should preserve an inherited value and may provide only a conservative
fallback when it is absent, for example:

```sh
export CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-12}"
```

## Native authoring schema certification

The certification-only host build, Node-free C++ build commands, generator freshness check, and
native/Zod differential test invocation are documented in
[Native Project schema contracts](../architecture/NATIVE_AUTHORING_CONTRACTS.md#verification).
It is separate from player/runtime verification and does not change production Project authority.

## Initial Command Set

Repository-local shader compilation uses the standalone `noveltea` host CLI. On the currently
admitted Linux x64 development host, build or refresh it before a CMake preset that has
`NOVELTEA_COMPILE_SHADERS=ON`:

```sh
pnpm -C editor run noveltea:build
```

```sh
cmake --preset linux-debug
cmake --build --preset linux-debug
cmake --build --preset linux-debug --target cxx-policy
cmake --build --preset linux-debug --target public-header-probes module-dependency-inventory
ctest --test-dir build/linux-debug --output-on-failure
ctest --test-dir build/linux-debug \
  -R noveltea_production_asset_path_policy --output-on-failure
cmake --preset linux-debug-no-threads
cmake --build --preset linux-debug-no-threads --target noveltea_asset_tests
cmake --preset web-debug
cmake --build --preset web-debug
cmake --build --preset web-debug --target cxx-policy
cmake --build --preset web-debug --target public-header-probes module-dependency-inventory
pnpm run web:smoke:debug
node tests/web/video_texture_tests.mjs --request-build-dir build/web-debug
# Prepared Feature Lab package with World Composition entrypoint, default HUD and neutral camera:
# Verify all three colors through the optimized player's actual raster output (GPU-backed WebGL):
cmake --preset web-release
cmake --build --preset web-release --target noveltea-player
NOVELTEA_WEB_SMOKE_ANGLE_BACKEND=gl node scripts/web-player-package-smoke.mjs \
  --build-dir build/web-release --video --start-via-title --package /path/to/video.ntpkg
# A devtools-enabled standalone player must render ImGui after F10 and hide it after a second F10:
node scripts/web-player-package-smoke.mjs \
  --build-dir build/web-release --imgui --package /path/to/feature-lab.ntpkg
# Debug builds can miss short color intervals if a directed browser seek takes longer than the
# interval; debug is for tracing seek/upload boundaries, not certifying the full color sequence.
cmake --preset web-debug-no-threads
cmake --build --preset web-debug-no-threads --target noveltea-player
cmake --preset web-release-no-threads
cmake --build --preset web-release-no-threads --target noveltea-player
cmake --preset web-profile
cmake --build --preset web-profile
pnpm run web:smoke:profile
# Standalone SDL3/bgfx/ImGui Web benchmark (optimized or Debug):
./scripts/run-benchmark-web.sh --no-browser --no-ui --smoke
./scripts/run-benchmark-web.sh --debug --no-browser --no-ui --smoke
# Real Chromium/Firefox rendering, JSON download, and dashboard lifecycle smoke:
xvfb-run -a env NOVELTEA_BENCHMARK_FIREFOX_HEADFUL=1 \
  node scripts/benchmark-web-smoke.mjs build/web-benchmark-release/apps/benchmark
```

For C/C++ formatting, use the CMake targets rather than invoking `clang-format` directly:

```sh
cmake --build --preset linux-debug --target format-check
cmake --build --preset linux-debug --target format
```

CI runs the same repository formatter driver as an early gate before shader compilation and the
platform build fan-out.

Release CI publishes optimized production (`-release`, devtools off) and developer
(`-devtools`, devtools on) player variants for desktop, threaded/non-threaded Web, and Android
ARM64. Both use the `release` export build flavor and its packaging/signing rules. Export profiles
select `playerVariant: standard | devtools` independently of `buildFlavor: release | debug`;
old profiles default to `standard`. The developer variants use `*-release-devtools` CMake
presets instead of Debug optimization settings. Android x86_64 retains its separately published
true Debug/emulator template. Each variant has its own certification evidence.

The `web-editor-preview` preset is intentionally different from a production Web build: it enables
`NOVELTEA_ENABLE_DEVTOOLS` so the editor can request the shared Devtools Snapshot and versioned
capability set, but its engine composition uses the debug-UI stub and does not compile or render Dear
ImGui. Production/devtools-off builds omit the Devtools Snapshot transport and link ordinary RmlUi
through Core without the Debugger component.

After native developer and production players are built, the artifact-level composition checks are:

```sh
bash scripts/check-native-devtools-symbols.sh build/linux-debug/apps/sandbox/noveltea-sandbox on
bash scripts/check-native-devtools-symbols.sh build/linux-debug/apps/player/noveltea-player on
bash scripts/check-native-devtools-symbols.sh build/linux-release/apps/player/noveltea-player off
```

These inspect the linked binaries for RmlUi Debugger and Dear ImGui rather than merely checking CMake
option text. CI runs the enabled checks in the Linux developer build and the disabled check against
the Linux production player. See `docs/runtime/DEVELOPER_DEBUGGING.md` for the full capability matrix.

## Informational coverage

See [Coverage](COVERAGE.md) for separate native GCC/gcovr and editor Vitest coverage commands,
report boundaries, CI summaries/artifacts, and fresh-counter procedures. Coverage has no global
numeric gate and is not evidence of behavioral correctness.

## Development tooling resources

When `NOVELTEA_NATIVE_TOOL_BRIDGE` selects a CMake-built tooling bridge, font-coverage validation
uses that build's configured `${NOVELTEA_RUNTIME_ASSET_ROOT}/system`, matching the native UI Test
runner. No assets need to be copied beside the development bridge, and Project fonts must not be
changed to compensate for missing engine resources. An explicit native font-coverage request
`systemRoot` overrides this root and must resolve successfully; failure does not silently retry a
different root. Standalone distributions continue to resolve `assets/system` beside their executable.
Fallback-font failures identify the logical font Asset and selected system root.

## Verify Native Project Compilation Without the Editor

The standalone native `noveltea` CLI compiles the current on-disk Project as part of Runtime Package
export. The old Node-only `project:compile` command and its `dist-build-tools` compiler are retired;
do not use them as CI verification or expect standalone compiled-project JSON from the public CLI.

```sh
noveltea --no-daemon --project path/to/project package export --output /tmp/game.ntpkg
unzip -t /tmp/game.ntpkg
```

The native cold-compilation differential certification, including the complete Compiled Project
wire, is described in `docs/runtime/certifications/NATIVE_COMPILED_PROJECT.md`. The Build workflow's
Electron job also checks native compilation and Runtime Package export against its minimal fixture.

Export a saved editor project through `noveltea platform export`. Install the immutable player
template first with `noveltea platform template install`, and generate local toolchain/signing
configuration with `noveltea platform config init` or the Android environment helper below.
Use `pnpm android:export-config -- --output <file>` to generate the Android exporter local-toolchain
configuration from `ANDROID_SDK_ROOT`/`ANDROID_HOME` and `JAVA_HOME`. Shader compilation is provided
by the standalone `noveltea` host CLI and no external `shaderc` executable is configured for export.
The standalone CLI is direct C++ on Linux x64, Windows x64 and macOS arm64. Build it with
`pnpm -C editor run noveltea:build`; the command configures the native authoring CMake
preset and stages the installed executable and UI Test runner under `build/cli/<platform>/`.
Windows CLI builds use the MinGW GNU ABI, separate from the MSVC-built desktop player/editor.
No ScriptC, QuickJS, Zig ScriptC target, or Node execution is required at runtime. The build
emits `native-production-build.json` binding the exact native executables by SHA-256;
`pnpm -C editor run noveltea:certify` checks the installed artifact and emitted editor bundles.
Platform player jobs still consume shader assets precompiled by the Linux shader-assets job
(`NOVELTEA_COMPILE_SHADERS=OFF`).

The Android player defers SDL/bgfx initialization while its Activity is asleep or
unfocused. When Android destroys/recreates the native surface on Home, lock/unlock,
or rotation, the Engine suspends its normal frame path and rebinds a freshly
acquired `ANativeWindow` to bgfx's main swap chain before rendering again.
This preserves the existing Engine/gameplay and GPU resources (no full Engine
restart). The pinned bgfx Android EGL source receives a guarded, idempotent
CMake patch (`cmake/patch-bgfx-android-surface-rebind.cmake`) so its context
actually uses the replacement window handle during reset. ADB launch while
locked should wait safely until foreground rather than initializing a stale
EGL window. Exercise initial lock-screen launch, Home/return, lock/unlock and
repeat surface recreation on a physical device; Android compilation alone does
not verify EGL lifecycle behavior. Before launching the player on either
emulator API, CI marks Android's one-time immersive-mode confirmation as
acknowledged. On API 35 that system overlay can otherwise steal Activity focus
indefinitely during an unattended smoke test. If startup fails, CI captures
Android window focus, power state, resumed Activity, and player logs without
relaxing the runtime graphics lifecycle gate.

For repository-local Android development, `scripts/run-android.sh` builds the native player with the
checked-in `android/` Gradle project, packages and installs an immutable player template in an
isolated registry under `build/run-android`, and exports the selected Project through `noveltea
platform export`. The script uses the shared Android acceptance fixture by default, installs the
exported APK, and starts logcat. Pass `--project path/to/project.json` to use another saved Project
and optionally `--profile <id>` to select its Android profile from `project.json`'s `export.profiles`.
Before any download or build, the script discovers online ADB targets (including network ADB).
One target is used automatically; multiple targets are listed for interactive numbered selection.
With no targets, it asks before launching `AVD_NAME` (default `noveltea_api35`); declining exits
without building. Offline/unauthorized targets are reported and never cause a silent emulator
fallback. Pass `--device SERIAL` to select a target explicitly, waiting up to three minutes for it
to connect. Prompts require a terminal; noninteractive ambiguous/empty selection fails with guidance.
All subsequent ADB commands are pinned to the selected serial. The target's ABI list determines
`arm64-v8a` or `x86_64`; an explicit `ANDROID_ABI` must be supported by that target.

For the in-tree Feature Lab on a connected phone or emulator, run:

```sh
./scripts/run-android.sh --project tests/projects/feature-lab/project.json
```

Its `android-arm64-debug` or `android-emulator-debug` profile is selected automatically according
to the selected device ABI. Android template packaging matches
AGP's current merged player library to the native CMake build by content, so retained `.cxx`
configuration caches do not select stale native binaries, license metadata, or symbols.
Local templates require the explicit
untrusted-template acknowledgement; release certification separately exercises immutable packaged
player templates. The script reuses the host CLI at `build/cli/linux/noveltea`, building it only
when missing; `NOVELTEA_CLI` selects an explicit existing executable. To refresh the CLI after
tooling changes, run `pnpm -C editor run noveltea:build` explicitly. The script uses the
bgfx shader includes from its `linux-authoring-release` dependency tree, or from
`NOVELTEA_PREBUILT_SHADERC_ROOT/resources` when that toolchain input is set. Set
`BGFX_SHADER_INCLUDE_DIR` explicitly to override either default; it must contain `bgfx_shader.sh`.
The script downloads and caches checksum-pinned bundletool 1.18.1 under `build/tools` for template
packaging. Set `NOVELTEA_BUNDLETOOL_JAR` to use an existing copy of that same pinned JAR; cached and
explicit copies are verified before use. The first uncached run requires `curl` and network access.
Android CI invokes `pnpm android:fixture` and `noveltea platform export` directly for both fixture
revisions so the public command path, rather than a private test-only entrypoint, is certified.

The opaque-video smoke takes a normally exported disposable copy of Feature Lab. In that copy,
set `project.json`'s entrypoint to `world-composition`, clear `settings.ui.systemLayouts` to use the
default fullscreen HUD, and set that Room's default camera to center `(1200, 675)`, zoom `1`,
rotation `0`. Keep source media, Animation, Materials, and bootstrap unchanged. Export through
`noveltea package export --allow-localization-warnings`, then pass the `.ntpkg` to the command
above. `--video` uses the debug-only `--smoke-run-runtime` player argument unless
`--start-via-title` is specified; the optimized release player uses the ordinary title-screen
start path. The browser checks paused native
media seeks and screenshot colors at the authored panel; this is platform realization coverage,
not a second gameplay-semantic suite. `NOVELTEA_WEB_VIDEO_SMOKE_CAPTURE` optionally names a
failure screenshot. `pnpm web:video:test` runs the smaller browser media-boundary checks plus the
WebAssembly request-contract test, using the configured Web-debug compiler. The browser checks
repeat independent directed seeks and cover the zero-time sample, exact endpoint, and queued decoder
progress in addition to cancellation and resource failure. Capture waits for seek completion, not
initial-frame `loadeddata`, before publishing a nonzero-time sample.

Run `node scripts/certify-video-package-scenarios.mjs --web --native` for #407's repeatable
real-package video matrix: ten disposable Feature Lab variants through the standalone Linux CLI,
authoritative sample timing and exact endpoint checks, PQ/HLG tone mapping, source/locale cache
identity, deterministic repeat export, and corrupt-input rejection. The Web leg uses the optimized
browser player and image-pixel checks; the native leg uses the Linux debug player and its real
software VP9 session. For GPU rendering, provide a working Linux display; the script does not
require a VA-API hardware decoder.

If the current display cannot initialize WebGL (for example an unavailable SSH-forwarded display),
run the package smoke under `xvfb-run -a node scripts/web-player-package-smoke.mjs ...`. Browser media
boundary tests alone do not prove bgfx raster rendering; retain the exported-package smoke as the
platform integration check.

For repository-local Web export testing, `scripts/run-web.sh` refreshes the repository `noveltea`
host CLI, configures the canonical release Web player template, exports the selected project (or the shared acceptance
fixture), and serves the result. Pass `--project` and optionally `--export-profile` to select a saved
project. The script selects canonical threaded `web-release` for a profile with
`web.threaded: true` and compatibility `web-release-no-threads` for a single-threaded profile. It
enables COOP/COEP only for the threaded artifact. For local runs, the script enables
`NOVELTEA_ENABLE_DEVTOOLS` and `NOVELTEA_ENABLE_RENDER_PERF` by default; disable them independently
with `--no-devtools` and `--no-render-perf`. The latter also controls the exported player's
`?renderPerf=1` startup argument (and the gallery's equivalent), so counters are actually logged
at runtime. Explicit `--devtools` and `--render-perf` re-enable either setting. These overrides
apply only to builds configured by this local runner, not ordinary release exports. The runner's
`local-run-web` template deliberately keeps the Project's `release` export-profile flavor while
using an instrumented player; this narrowly scoped local override cannot be used for published
release templates, which distinguish devtools-on `devtools` from devtools-off `standard` using
`playerVariant` while preserving `buildFlavor: release`. The local runner
allows localization-quality warnings for test projects, cleans both its previous export directory and
ZIP on reruns, and recovers `EMSDK` from an existing Web build's compiler when needed for packaging.
Devtools-enabled standalone Web player builds include the Dear ImGui debugger, toggled with F10;
web editor-preview builds retain instrumentation but omit ImGui entirely. Use browser developer tools
for JavaScript/Wasm CPU and rendering profiling.
`--readback-gallery` serves the sandbox gallery instead; the legacy `--release` and
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

The default development command builds the threaded `web-release` sandbox preview. Staging and
packaging build and bundle the standalone `noveltea` CLI under `resources/bin/noveltea`; Linux x64
and Windows x64 are release-admitted editor/CLI hosts. `NOVELTEA_CLI_PATH` may supply an already-built
CLI to distribution staging. macOS player builds remain supported, but a macOS editor/CLI release is
not part of the current exact release inventory. See
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

Asset-streaming or package-path changes must also run
`noveltea_production_asset_path_policy`. This permanent source audit rejects deleted synchronous
prepared `AssetManager` methods, public raw/path-based `AudioSystem` playback, synchronous prepared
fallbacks in the audited world/material/ActiveText/runtime-audio/preview-audio consumers, production
whole-package `MemoryAssetSource` materialization, `.ntpkg` writes to the Web virtual filesystem, and
the removed `NOVELTEA_WEB_THREADS` symbol. Validate both canonical threaded Linux and
`linux-debug-no-threads` cooperative asset builds when changing request, residency, or package-source
behavior.

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
exception-enabled or RTTI-enabled build mode. Desktop target dependencies use NovelTea policy triplets.
The standalone Linux and Windows `noveltea` CLIs embed the bgfx shader compiler and remain outside
player link/package graphs; build and export paths do not require a separate `shaderc` executable.

The default `pnpm run web:smoke` command remains an alias for the debug structural Web smoke. Use `web-profile` plus `pnpm run web:smoke:profile` for optimized RmlUi/bgfx perf-counter measurement; that path compiles render perf counters in, enables them at runtime with `renderPerf=1`, disables ImGui with `noImgui=1`, and treats FPS as informational only.

Run Android verification when platform, CMake, shader, asset packaging, JNI, or Gradle behavior changes:

```sh
cd android
./gradlew :app:assembleDebug
```

Run the native robustness configuration after parser, filesystem, callback-boundary, or ownership
changes. It enables ASan, UBSan, and deterministic smoke runs for the JSON, rich-text, package, and
runtime-project fuzz harnesses. The sanitizer preset keeps Debug assertions but compiles with
`-O1 -g1` to avoid multiplying JSON/schema traversal costs in unoptimized instrumented code.
Only explicitly labeled `asan-smoke` authoring tests and `fuzz-smoke` parser tests run in this
bounded CI lane; the ordinary native/coverage jobs retain exhaustive functional, Catch2 and
differential certification:

Native/Zod record differentials use `noveltea-project-session-certify --normalized-records
<project-root> [family ...]` to normalize every requested record with **one native process**.
The Node drivers still independently decode and compare each record against its Zod schema.
This replaces a process launch per record (237 launches for the Feature Lab corpus), which
was especially expensive under ASan/UBSan; targeted differential tests request only their
own record families. The single-record certification modes remain available for diagnosis.

```sh
cmake --preset linux-sanitize
cmake --build --preset linux-sanitize
ASAN_OPTIONS=detect_leaks=1:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a ctest --test-dir build/linux-sanitize --output-on-failure \
  -L '^(asan-smoke|fuzz-smoke)$' --parallel 2 --timeout 300
ASAN_OPTIONS=detect_leaks=0:halt_on_error=1 \
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1 \
xvfb-run -a ctest --test-dir build/linux-sanitize --output-on-failure \
  -R 'noveltea_(rmlui_(readback|feature_fixtures|resize_readback)_(capture|verify)|presentation_readback_(capture|verify)|world_(presentation|transition)_readback_(capture|verify)|(layout_scale|postprocess_scope|texture_sampling)_readback_(capture|verify)|sandbox_runtime_.*_smoke|native_video_texture_smoke)'
```

CI and local verification run GPU/sandbox smoke executables, including native video texture smoke,
in the separate ASan/UBSan pass above because Mesa/EGL may retain driver-owned allocations until
process exit. Keep the GPU test expression synchronized with the CI step. Never disable leak
detection for the parser and native authoring smoke tests. To investigate a specific failure under
ASan/UBSan beyond the bounded smoke lane, run its named CTest explicitly with `-R`.

The sanitizer configuration builds native host tooling as well as the player/runtime graph so the
shader compiler service and its embedded shaderc closure receive sanitizer coverage in the same
instrumented build. Shader binaries remain prebuilt CI artifacts; `NOVELTEA_COMPILE_SHADERS=OFF`
avoids regenerating them. Configurations with `NOVELTEA_BUILD_HOST_TOOLS=OFF` omit the shader compiler
tests while retaining the rest of `noveltea_content_tests`. The source-built shaderc closure applies
`cmake/patches/bgfx-shaderc-fcpp-value-stack.patch`, which prevents its bundled `fcpp` from reading
before an empty expression value stack while pushing operators that do not perform short-circuit
evaluation. The legacy Mesa AST implementation in `glsl-optimizer` retains AddressSanitizer but
disables UBSan because its arena-allocated nodes and bit-packed flags intentionally bypass the C++
object-lifetime and scalar-value rules assumed by those checks. NovelTea's shader compiler wrapper
and the remainder of the embedded closure retain both sanitizers.

For sustained fuzzing with Clang/libFuzzer, configure a separate build with
`NOVELTEA_BUILD_FUZZERS=ON` and `NOVELTEA_USE_LIBFUZZER=ON`, then run the desired
`noveltea_fuzz_*` executable with a corpus directory.


After Android configuration, run `cmake/VerifyDependencyCompilerPolicy.cmake` against the active
`android/app/.cxx/.../<abi>` build directory. CI performs this automatically together with the
repository source-policy checks.

Windows policy validation uses the `windows-release` preset and
`x64-windows-static-noveltea`. macOS arm64 uses `arm64-osx-noveltea`. These validations require native
runners; Linux cannot establish their ABI or linker correctness.

## Main CI Scheduling and Caches

The Build workflow runs Linux desktop, host CLI production, host CLI certification, and native
cooperative compilation as separate jobs. Web editor-preview production runs independently from the
canonical Web player, and Android cooperative compilation runs independently from APK/export coverage.
Electron waits only for the CLI and preview producers; Android APK/export waits only for shaders and
the CLI producer. CLI certification remains a required part of a successful workflow, but does not
block these consumers. Development snapshot publication still requires the entire Build to succeed.

CLI certification downloads both the executable and its bgfx shader headers from same-run artifacts.
The headers come from the CLI producer's installed dependency tree; certification must not depend on
an optional cache hit or bootstrap a full vcpkg checkout merely to recover those headers.

The main CI workflow keeps separate `ccache` namespaces for Linux debug coverage, release CLI, sanitizer,
and cooperative builds; Emscripten preview and release builds; Android threaded and cooperative
builds; and Windows MSVC. Keys include explicitly versioned toolchain identities and the current
commit. Compiler outputs are saved immediately after successful compilation, before later tests or
packaging can fail. Restore prefixes stay configuration-scoped, except for deliberate cooperative
fallbacks to the corresponding threaded build and Web fallbacks to the previous combined Emscripten
cache. ccache still validates compiler inputs and flags; these fallbacks do not make incompatible
objects reusable. Each cache is capped at 1 GiB. Linux, Web, Android, and Windows jobs report cache
statistics so warm-cache effectiveness is visible in CI logs.

Linux vcpkg SDK caching is separate from the binary-package cache. Each parallel Linux configuration
has its own binary-cache writer scope; keys include dependency/build-policy inputs and the commit, so
one job cannot win an immutable shared key and prevent another job from retaining newly built packages.
Compatible writers may seed from another binary-cache scope because they all cache the same filesystem
path. Installed-tree caches are different: they use their actual build-directory path and never fall
back across directories, because GitHub includes cached paths in its internal cache version. The native
cooperative job deliberately shares the `linux-debug` installed tree path while using its own
`linux-no-threads` binary writer. All jobs must regenerate dependencies on cache misses; caches are
acceleration, not required job-to-job inputs.

CI build and vcpkg concurrency is four. The sanitizer's bounded, non-GPU smoke set uses two CTest
workers; the GPU and comprehensive CTest lanes remain serial because some captures share an Xvfb
display and lack serialization properties. Local builds continue to honor the inherited limit
described above. Linux desktop,
CLI, and cooperative builds retain 120-minute timeout headroom; sanitizer, Web, and Android builds
retain 90 minutes, pending cold-cache measurements rather than assuming a warm cache.

When evaluating scheduling/cache changes, compare successful cold-cache and warm-cache runs at the
same revision: record end-to-end duration, critical-path jobs, aggregate runner-minutes, cache
restore/save time, and compiler hit rates. Reduce timeouts only after cold builds establish adequate
headroom. Static workflow contracts run with `node --test tests/ci/*.mjs`; use `actionlint
.github/workflows/build.yml` for workflow syntax and expression validation.

Normal Web CI builds the canonical threaded `web-release` player and packages its installable
template. Successful master Build runs publish the same-run Linux CLI and Web template as
[development toolchain snapshots](DEVELOPMENT_SNAPSHOTS.md), without a second release build.

Release CI builds and certifies one `noveltea` host CLI on Linux x64 and one on Windows x64. The
Linux CLI also produces the canonical `glsl-330`, `essl-300`, and `metal` shader trees consumed by
the player jobs; Web and Android share the `essl-300` tree. Android and Web reuse the certified Linux CLI for host-side export acceptance;
each Electron editor job embeds the exact certified CLI from its own host. Tagged releases publish
both standalone executables and the editor packages. Manual dispatch accepts a proposed tag and
commit for a non-publishing full-matrix qualification run; create the immutable tag only after that
run succeeds. A separate manual `Windows CLI Diagnostics` workflow
(`.github/workflows/windows-cli-diagnostics.yml`) reproduces CLI UI-runner failures under the
release GNU toolchain with page heap and debugger capture, without publishing anything.

### Re-certify previously built Release artifacts

Use **Actions → Re-certify Build Artifacts** (`.github/workflows/recertify-artifacts.yml`)
to rerun post-build checks without repeating the Release build. This workflow is
**manual-only** and read-only with respect to Release artifacts: it neither publishes a
release nor compiles the CLI/editor or rebuilds installer packages. Some CLI tests do
create disposable Project export fixtures as part of certification.

The default `latest` source resolves to the newest **completed** Release run containing
at least one unexpired downloadable artifact in the requested scope, including failed
Release runs. `sha` finds a Release run for a source commit (short or full hex SHA);
`run` selects a specific GitHub Actions run ID. A commit is not an artifact: if multiple
completed runs use the SHA, the newest run with matching available artifacts wins.
Select `cli`, `editor`, or `all`. The resolver rejects incomplete/non-Release runs
and cross-run/cross-SHA artifact metadata, then downloads from that run's immutable ID.
Expired/missing artifacts are reported as **skipped**, never silently rebuilt.

By default, the certification scripts come from the artifact-producing commit. The
optional `test_ref` checks out a different script revision; the summary records both
SHAs. The resolver and installer verifier run from the workflow revision so they also
work with historical releases that predate this workflow.

CLI re-certification reruns installed-binary native disk validation, command, Project
routing, lifecycle, transport/error, Tests, and runtime package differential checks on
Linux, Windows, and macOS. Editor re-certification checks the **downloaded final
installer set**, platform filenames, file signatures, and SHA-256 on those hosts.
This editor check is **not** equivalent to installing/launching the editor: packaged
application smoke, platform export, and editor/CLI cross-system authority checks
require installed applications or build-stage bundles that Release does not currently
retain as downloadable artifacts. These remain full Release checks and are explicitly
listed as excluded in the re-certification summaries. Runs that verify only some
available artifacts are **partial evidence**, not release acceptance.

Run `node --test scripts/recertify-release-artifacts.test.mjs` to test run selection,
expired/inconsistent metadata rejection, and installer signatures offline. For a live
resolver check use:

```sh
GH_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=Cruel/nt \
  node scripts/recertify-release-artifacts.mjs resolve \
  --source run --run-id 39698985373 --scope all
```

GitHub Actions requires the workflow file to exist on the default branch before
exposing its manual-dispatch button.

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

That helper builds the release player with Gradle's debug-signing option, then separately exports the Project through the CLI with `--sign` and the local Android debug keystore (`${ANDROID_USER_HOME:-$HOME/.android}/debug.keystore`). Pass `--release --devtools` for an optimized Release player **with** native NovelTea devtools compiled in, including the on-device ImGui Render panel's FPS reading. On the device, touch with two fingers within 200 ms, hold still for one second, then release to toggle the debugger. Normal `--release` keeps devtools compiled out, and Debug builds retain devtools by default. The instrumented Release build is much more representative of shipped performance than Debug, but the overlay and instrumentation still add some measurement overhead. The generated export-local configuration uses environment references for the standard debug-key passwords; the credentials are never stored in the Project. The helper verifies the **exported** APK signature before installing it, so an unsigned or invalid APK fails locally rather than at `adb install`. This is only for release-mode device testing. Ordinary CLI release exports remain unsigned unless explicitly signed with a configured production keystore.

## Optional Components

- Developer tooling (`NOVELTEA_ENABLE_DEVTOOLS`): shared Devtools Snapshot/Console/Trace
  instrumentation and debugger capabilities. Host composition may additionally include the native
  Dear ImGui frontend; optimized editor-preview builds intentionally do not. Default `ON`.
- Shader compilation (`NOVELTEA_COMPILE_SHADERS`): set `OFF` to use prebuilt shaders. Default `ON`.
