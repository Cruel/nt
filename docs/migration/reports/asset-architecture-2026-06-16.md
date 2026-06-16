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
`project:/`. Web preloads the same tree once at `/assets`. Android Gradle stages
the same tree directly as the APK asset root, without an extra nested `assets/`
directory.

## Shaders

Shader metadata is centralized in `engine/shaders/bgfx/shaders.json` and compiled
by `scripts/compile_bgfx_shaders.py`. The bgfx loader selects variants from the
active renderer:

- OpenGL -> `glsl-120`
- OpenGLES on Web -> `essl-100`
- OpenGLES on Android -> `essl-300`

Built-in shaders use `SystemShader` constants. Project shaders can use logical
string IDs rooted wherever the project/package supplies them.

## RmlUi

RmlUi now uses `AssetRmlFileInterface`, backed by `AssetManager`, installed before
`Rml::Initialise()`. Fonts and documents load as logical paths such as:

```text
project:/rmlui/LiberationSans.ttf
project:/rmlui/demo.rml
```

Relative RmlUi resources currently resolve first under `project:/rmlui/`, then
under `project:/`.
