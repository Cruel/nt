# Local Rendering Reference Map

Files inspected: `refs/RmlUi/Backends/*`, `refs/rmlui-bgfx/src/*`, `refs/rmlui-bgfx/data/shaders/*`, `refs/bgfx/examples/common/font/*`, `refs/bgfx/examples/common/imgui/*`, `refs/bgfx/examples/common/nanovg/*`, `refs/bgfx/examples/common/bgfx_utils.*`, `refs/bgfx/examples/common/packrect.h`.

Key findings:

- Official RmlUi backends separate platform input/system handling from render implementations. The SDL backends are useful for event translation patterns, but they target renderer-specific paths rather than bgfx.
- `refs/rmlui-bgfx` demonstrates a small bgfx RmlUi renderer and shader pair, but wraps the app/window lifecycle in APIs too broad for `nt`; only concepts should be adapted.
- bgfx `examples/common/font` provides SDF font rendering, buffers, metrics, and shader variants. It is useful reference material but too large to copy blindly in bootstrap.
- bgfx `examples/common/imgui` validates the current direction: ImGui is a debug/dev overlay with its own shader path.
- bgfx `examples/common/nanovg` is a heavier immediate-mode canvas option. It remains deferred unless later UI/text needs justify it.
- `bgfx_utils` and bimg texture helpers are practical references for future asset loading, but the first slice uses a procedural texture proof to avoid introducing larger copied utilities.
- Current pass re-checked `refs/bgfx/examples/common/bgfx_utils.*`: texture loading reads file bytes, calls `bimg::imageParse`, creates the appropriate bgfx texture kind, and frees the `bimg::ImageContainer` through a bgfx release callback. This remains the right pattern for the next real image-loading slice.
- Current pass re-checked `refs/rmlui-bgfx/src/ui/rmlui/CRenderInterface.cpp`: useful pieces are transient/non-compiled geometry submission, compiled geometry ownership maps, scissor region state, RmlUi texture callbacks, and orthographic projection setup. It should still be adapted rather than copied because it brings Eigen, stb image, and its own wrapper assumptions.

Recommended next action: implement `nt`-owned RmlUi/bgfx render/system/file interfaces using the current renderer view IDs and asset layer, then replace the current RuntimeUI scaffold with a minimal document demo.
