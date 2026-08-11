# CMake Options

## Mandatory Dependencies

The following are always required for the `noveltea_engine` target. If any cannot be
provided, CMake emits a `FATAL_ERROR` with a clear message.

| Dependency | Purpose | Acquisition |
|---|---|---|
| bgfx | Cross-platform rendering backend. | Desktop: `bgfx` vcpkg package. Web/Android: `NOVELTEA_FETCH_BGFX=ON` (FetchContent). |
| RmlUi | Runtime UI framework (with Lua bindings and CSS math expressions). | Linux, Web, and Android use commit `c6744d15bda5e9df7ad9c1f8eae937157e7ed309` from Cruel/RmlUi's `feature-calc` line with the rebased presentation, font-raster, and Lua-listener patches through `NOVELTEA_FETCH_RMLUI=ON`. The final revision is `6c-feature-calc-lua-listener-state-1`. The vcpkg manifest contains no RmlUi dependency or override. An installed desktop package is accepted only when it reports that exact revision and exposes the complete NovelTea extension API. |
| rmlui-bgfx | Reusable RmlUi renderer package. | `find_package(rmlui_bgfx)` or `NOVELTEA_FETCH_RMLUI_BGFX=ON` (FetchContent). |
| RmlUi::Lua | Official RmlUi Lua plugin. | Bundled with RmlUi; the `lua` feature must be enabled. |
| Lua 5.5 + sol2 | Runtime scripting. | Desktop: `lua` 5.5 and `sol2` vcpkg packages. Web/Android: FetchContent. |
| FreeType, HarfBuzz, SheenBidi, libunibreak | Engine-owned text shaping/layout. | Desktop: vcpkg packages. Web/Android: FetchContent. |

The lower production modules remain backend-neutral. `noveltea_domain` has no third-party runtime
dependency. `noveltea_content` uses nlohmann-json and miniz headers privately at named external
boundaries. `noveltea_runtime` depends on domain/content; `noveltea_presentation` depends on
domain/runtime; and `noveltea_script_lua` depends on domain/runtime while keeping Lua/sol2 private.
SDL, bgfx, RmlUi, miniaudio, text backends, Twink, and optional ImGui belong to `noveltea_engine`.

## User-Facing Cache Variables

### Feature Toggles

| Variable | Default | Description |
|---|---|---|
| `NOVELTEA_BUILD_SANDBOX` | `ON` | Build the sandbox application. |
| `NOVELTEA_BUILD_PLAYER` | `ON` | Build the dedicated release-facing `noveltea-player` application. |
| `NOVELTEA_BUILD_HOST_TOOLS` | `ON` | Build native editor/host-tool targets, including the embedded shaderc tooling. Player-only builds can disable this to avoid compiling host tooling. |
| `NOVELTEA_BUILD_BENCHMARKS` | `OFF` | Build the reusable release microbenchmark executable for JSON and Lua regression measurements. |
| `NOVELTEA_ENABLE_DEVTOOLS` | `ON` | Include Dear ImGui dev/debug overlay. |
| `NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER` | `OFF` | Compile the editor-only asset memory and prefetch profiler. Enabled only by dedicated editor-profiler presets. |
| `NOVELTEA_COMPILE_SHADERS` | `ON` | Compile bgfx shader binaries through the host `noveltea` CLI's embedded shaderc. Set `OFF` to use prebuilt shaders from `NOVELTEA_PREBUILT_SHADER_ASSET_ROOT`. |
| `NOVELTEA_ENABLE_THREADS` | `ON` | Enable NovelTea's SDL job workers. Canonical native, Android, and Web presets enable this; explicit `*-no-threads` presets select cooperative execution. Threaded Web artifacts require `SharedArrayBuffer` and cross-origin isolation. |
| `NOVELTEA_JOB_WORKER_COUNT` | `0` | Number of NovelTea SDL job workers. `0` selects the native automatic policy (`clamp(logical CPU count - 1, 1, 4)`). Threaded Web presets must set an explicit count and currently use `1`; non-threaded builds require `0`. |

### Dependency Acquisition

| Variable | Default | Description |
|---|---|---|
| `NOVELTEA_FETCH_BGFX` | `ON` | Fetch and build bgfx via FetchContent (Web/Android). On desktop, bgfx is expected from vcpkg. |
| `NOVELTEA_FETCH_RMLUI` | `ON` | Fetch, verify, patch, and statically build the pinned Cruel/RmlUi `feature-calc` commit on every production platform. CSS mathematical expressions are enabled. Setting this `OFF` is a desktop-only fallback and configuration fails unless the installed package reports the exact current NovelTea patch revision and exposes the complete Context extension API. |
| `NOVELTEA_FETCH_RMLUI_BGFX` | `ON` | Fetch `rmlui-bgfx` from `NOVELTEA_RMLUI_BGFX_GIT_REPOSITORY` when `rmlui_bgfx::rmlui_bgfx` is not already available. |
| `NOVELTEA_USE_LOCAL_RMLUI_BGFX` | `OFF` | Use a local `rmlui-bgfx` checkout instead of an installed package or the remote FetchContent repository. Intended for tandem renderer/engine development. |
| `NOVELTEA_LOCAL_RMLUI_BGFX_DIR` | `${CMAKE_SOURCE_DIR}/rmlui-bgfx` | Local checkout path used when `NOVELTEA_USE_LOCAL_RMLUI_BGFX=ON`. |
| `NOVELTEA_RMLUI_BGFX_GIT_REPOSITORY` | `https://github.com/Cruel/rmlui-bgfx.git` | FetchContent repository for `rmlui-bgfx`. |
| `NOVELTEA_RMLUI_BGFX_GIT_TAG` | `master` | FetchContent ref for `rmlui-bgfx`; pin to a commit or release once the integration is stable. |
| `NOVELTEA_NLOHMANN_JSON_COMPILE_DEFINITIONS` | `JSON_NOEXCEPTION=1` | Semicolon-separated definitions applied only to direct nlohmann-json consumers. Keep the default unless the JSON boundary implementation and its failure-path coverage are updated together. |

For local tandem development with a checkout beside `nt`, use the dedicated preset or enable the explicit local dependency mode:

```sh
cmake --preset linux-debug-local-rmlui-bgfx
```

or:

```sh
cmake --preset linux-debug -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON
```

For a checkout elsewhere, also set the path:

```sh
cmake --preset linux-debug -DNOVELTEA_USE_LOCAL_RMLUI_BGFX=ON -DNOVELTEA_LOCAL_RMLUI_BGFX_DIR=/path/to/rmlui-bgfx
```

RmlUi dependency identity is written to `build/<preset>/reports/rmlui-dependency.txt`. The final
contract is Cruel/RmlUi commit `c6744d15bda5e9df7ad9c1f8eae937157e7ed309` from the
`feature-calc` line, base patch revision `6a-feature-calc-presentation-1` with SHA-256
`95c2fdee763da0b2d87cf13e0ee9aac690d09d13e62069ccf0b0ecf87732cbc8`, followed by font-raster
revision `6b-feature-calc-font-raster-1` with SHA-256
`2e259f79b14f78ff37c868f23fca0c59a33dac0d35744c4e0eba2c96e7ac4f50`, and final Lua-listener
revision `6c-feature-calc-lua-listener-state-1` with SHA-256
`b519e72f0dfe1666445dccfddedf9ebf884f48ecb61ecd2ce5cddeb71327ff27`. Linux, Web, and Android
configuration reports must agree on all values. Native Linux test builds expose the focused
`rmlui-patch-test` target, which validates the patch marker, media-query-dimension and context
text/font-raster-scale extensions, and Lua-listener creation-state teardown without enabling
RmlUi's upstream test suite. CTest also configures fake current and outdated installed packages to
exercise the `NOVELTEA_FETCH_RMLUI=OFF` revision and extension probe.

### Shader Tool Paths

| Variable | Default | Description |
|---|---|---|
| `NOVELTEA_CLI_EXECUTABLE` | `""` | Path to the host `noveltea` CLI used for build-time shader compilation. If unset, CMake checks `NOVELTEA_CLI`, `PATH`, then `build/cli/linux/noveltea`. |
| `NOVELTEA_SHADERC_EXECUTABLE` | `""` | Path to a standalone bgfx `shaderc`. This is the CI bootstrap provider for canonical precompiled shader assets; normal repository and export builds use `NOVELTEA_CLI_EXECUTABLE`. |
| `NOVELTEA_BGFX_SHADER_INCLUDE_DIR` | `""` | Directory containing `bgfx_shader.sh`. |
| `NOVELTEA_PREBUILT_SHADERC_ROOT` | `""` | Extracted `nt-tools` static shaderc closure. When set, host tooling imports its pinned shaderc archive, link closure, headers, and shader resources instead of fetching and compiling shaderc source. |
| `NOVELTEA_PREBUILT_SHADER_ASSET_ROOT` | `""` | Root directory for prebuilt shader binaries. Expected structure: `shaders/bgfx/<variant>/`. |
| `NOVELTEA_SHADER_VARIANTS` | `""` | Semicolon-separated shader variants to build/stage. Default varies by platform (e.g., `glsl-120` for desktop). |

### Runtime Asset Paths

| Variable | Default | Description |
|---|---|---|
| `NOVELTEA_RUNTIME_ASSET_ROOT` | `<binary-dir>/runtime-assets` | Staged runtime asset root. |
| `NOVELTEA_PROJECT_ASSET_SOURCE` | `apps/sandbox/assets` | Source directory for project/demo assets. |
| `NOVELTEA_GENERATED_ASSET_ROOT` | `<binary-dir>/generated-assets` | Generated asset output directory. |
| `NOVELTEA_CMAKE_STAGE_RUNTIME_ASSETS` | `ON` (desktop), `OFF` (Android) | Stage runtime assets during CMake build. |

CMake runtime-asset staging is owned by final applications rather than production libraries.
Building `noveltea-player` or `noveltea-sandbox` stages the system assets, generated shaders, and the
configured project/demo asset source they consume. Building the module libraries alone does not
stage shaders or sandbox assets. The render-backend test target depends only on generated shaders so
the standalone shader verification remains valid when both applications are disabled. Android keeps
using its Gradle-owned shader and runtime-asset staging pipeline.

### Test toggles

| Variable | Default | Description |
|---|---|---|
| `BUILD_TESTING` | `OFF` | Build and register CTest tests. Requires Catch2. |
| `NOVELTEA_ENABLE_SANITIZERS` | `OFF` | Enable native desktop ASan and UBSan instrumentation. Unsupported for Web and Android builds. |
| `NOVELTEA_BUILD_FUZZERS` | `OFF` | Build malformed-input harnesses for JSON/save import, rich text, ZIP packages, and typed runtime-project decoding. |
| `NOVELTEA_USE_LIBFUZZER` | `OFF` | Build fuzz harnesses with Clang libFuzzer instead of deterministic CTest smoke corpora. Requires `NOVELTEA_BUILD_FUZZERS=ON` and Clang. |

## Removed Options

The following were previously supported as `NOVELTEA_ENABLE_*` feature toggles
but have been removed. Their corresponding subsystems are now mandatory for the
`noveltea_engine` target:

- `NOVELTEA_ENABLE_BGFX` — bgfx is always required for `noveltea_engine`.
- `NOVELTEA_ENABLE_RMLUI` — RmlUi is always required for `noveltea_engine`.
- `NOVELTEA_ENABLE_RMLUI_LUA` — RmlUi Lua is always required; RmlUi and Lua are both mandatory.
- `NOVELTEA_ENABLE_LUA` — Lua is always required for `noveltea_engine`.
- `NOVELTEA_ENABLE_TEXT` / `NOVELTEA_ENABLE_TEXT_LAB` — text stack is always required for `noveltea_engine`.
- `NOVELTEA_ENABLE_RENDER2D` — the bgfx 2D substrate is core infrastructure, not optional.
- `NOVELTEA_USE_IMGUI` — deprecated alias for `NOVELTEA_ENABLE_DEVTOOLS`.

NovelTea intentionally does not provide `NOVELTEA_NO_EXCEPTIONS`, `NOVELTEA_NO_RTTI`, or inverse
feature toggles. Exceptions and compiler RTTI are disabled unconditionally for every shipped C++
target. Supporting an alternate implementation path would weaken policy enforcement and is not a
supported configuration.
