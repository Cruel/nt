# Asset Architecture Update - 2026-06-16

The runtime now resolves assets by logical IDs through `noveltea::assets::AssetManager`.
Generic asset code returns source-neutral blobs or stream readers; native filesystem
paths are optional metadata and are not required by shader, text, texture, or RmlUi
consumers.

## Logical namespaces

- `system:/` is for engine/runtime assets such as compiled built-in shaders.
- `project:/` is for demo/game/project assets such as UI documents, fonts, images,
  audio, and future package entries.
- `cache:/` is a writable cache/user-data location and is kept separate from
  packaged read-only resources.

Paths are normalized and reject absolute paths, `..`, empty components,
backslashes, malformed namespaces, and namespace confusion.

## Sources

- `DirectoryAssetSource` reads actual host directories and can be marked writable.
- `SdlPackagedAssetSource` reads bundled assets with SDL3 IO APIs, which lets
  Android APK assets be opened by bare asset-root paths such as
  `shaders/bgfx/essl-300/triangle.vs.bin`.
- `MemoryAssetSource` supports tests, editor-generated data, shader outputs, and
  future package extraction without requiring native paths.
- `ZipAssetSource` is present as the read-only package boundary, but decompression
  is deferred until a ZIP dependency is selected for `nt`.

## Runtime staging

Builds stage one runtime asset tree at:

```text
build/<preset>/runtime-assets/
  shaders/bgfx/<variant>/
  rmlui/
  ...
```

Desktop development mounts that tree for both `system:/` and the sandbox
`project:/`. Packaged desktop builds prefer `<SDL_GetBasePath()>/assets` and can
still be overridden by run configuration. Web preloads the staged tree once at
`/assets`. Android Gradle is the sole owner of APK asset staging and writes the
final `app/build/generated/runtime-assets/noveltea/` tree from project assets
plus generated or prebuilt `essl-300` shaders.

## Shaders

Shader metadata is centralized in `cmake/NovelTeaShaderManifest.cmake`.
`cmake/NovelTeaShaders.cmake` provides reusable CMake functions for variant
lookup, output collection, host tool discovery, and incremental shader targets.
`cmake/CompileNovelTeaShaders.cmake` is the only shader compiler implementation
and also supports verification-only mode without `shaderc`.

The bgfx loader selects variants from the active renderer:

- OpenGL -> `glsl-120`
- OpenGLES on Web -> `essl-100`
- OpenGLES on Android -> `essl-300`

Metal, Direct3D11, and Vulkan currently return unsupported-renderer errors
instead of advertising unbuilt `metal`, `hlsl-50`, or `spirv` variants.

Built-in shaders use `SystemShader` constants. Project shaders can use logical
string IDs through `load_project_program("effects/name")`; callers do not supply
the active platform variant.

## CI

GitHub Actions now has a dedicated `shader-assets` job. It installs
`bgfx[tools]:x64-linux`, locates host `shaderc` and `bgfx_shader.sh`, compiles
`glsl-120`, `essl-100`, and `essl-300`, verifies the tree through CMake
script-mode verification, and uploads the uncommitted shader tree as an artifact.
Linux, web, Android, and editor jobs consume that artifact with
`NOVELTEA_COMPILE_SHADERS=OFF`.

## Tests

Native tests use Catch2 v3 and CTest behind `BUILD_TESTING`. Current Linux tests
cover logical path parsing, memory and directory sources, AssetManager
diagnostics and precedence, AssetReader seek/tell/size behavior, shader variant
selection, RmlUi file IO, shader verification-only mode, and the absence of
committed generated shader headers.

## RmlUi

RmlUi now uses `AssetRmlFileInterface`, backed by `AssetManager`, installed before
`Rml::Initialise()`. Fonts and documents load as logical paths such as:

```text
project:/rmlui/LiberationSans.ttf
project:/rmlui/demo.rml
```

Relative RmlUi resources currently resolve first under `project:/rmlui/`, then
under `project:/`.

## Verification

Verified on 2026-06-16:

- `cmake --preset linux-debug`
- `cmake --build --preset linux-debug`
- `ctest --test-dir build/linux-debug --output-on-failure`
- `cmake --preset web-debug`
- `cmake --build --preset web-debug`
- Linux sandbox smoke from the build tree and from a copied packaged layout.

Android APK verification is pending. The Gradle build reached shader staging and
native ABI compilation, but the x86_64 FetchContent Freetype download failed with
HTTP 502 from `download.savannah.gnu.org`. Emulator smoke was not implemented or
run in this pass.
