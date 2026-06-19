# RmlUi/bgfx Runtime UI Integration Report

## Files Inspected

| File | Role |
|---|---|
| `refs/RmlUi/Include/RmlUi/Core/RenderInterface.h` | Pure virtual API that `BgfxRenderInterface` implements |
| `refs/RmlUi/Include/RmlUi/Core/Vertex.h` | `Rml::Vertex` layout (position 2f, colour 4ub, tex_coord 2f = 20 bytes) |
| `refs/RmlUi/Include/RmlUi/Core/SystemInterface.h` | System API; only `GetElapsedTime` required |
| `refs/RmlUi/Include/RmlUi/Core/Core.h` | `CreateContext`, `RemoveContext`, `LoadFontFace`, `Initialise`, `Shutdown` |
| `refs/RmlUi/Backends/RmlUi_Platform_SDL.h/.cpp` | SDL3 event translation patterns, key conversion, modifier state |
| `refs/RmlUi/Backends/RmlUi_Renderer_GL3.h/.cpp` | Full-featured GL3 renderer (scissor flip, layer stack concepts) |
| `refs/RmlUi/Backends/RmlUi_Backend_SDL_GL3.cpp` | Context creation flow, SDL_GL init pattern |
| `refs/rmlui-bgfx/src/ui/rmlui/CRenderInterface.h/.cpp` | bgfx vertex layout, texture handling, shader structure, ortho projection |
| `refs/rmlui-bgfx/data/shaders/vert.sc` / `frag.sc` | bgfx shader source for geometry * texture * color modulation |
| `refs/bgfx/examples/common/bgfx_utils.h/.cpp` | Texture loading patterns (deferred for next slice) |
| `engine/shaders/bgfx/varying.def.sc` | Shared vertex attribute definitions used by all bgfx shaders |
| `engine/shaders/bgfx/vs_quad.sc` / `fs_quad.sc` | Existing shader pattern to follow for new RmlUi shaders |
| `engine/src/renderer_bgfx.cpp` | Existing view ID management, `ViewRuntimeUI = 1` |
| `engine/src/engine.cpp` | Event dispatch, render loop, shutdown order |
| `engine/include/noveltea/ui_runtime.hpp` | Header updated with opaque `State* m_state` |

## External Reference Ideas Adapted

1. **RmlUi Official Backends (MIT)**: Event translation pattern (mouse, keyboard, text input → RmlUi context methods), key conversion switch, modifier state. Written as free functions in `ui_runtime_rmlui.cpp` rather than the fully abstracted `RmlSDL::InputEventHandler`.
2. **RmlUi Backends SDL3 window resize / context dimension handling**: `context->SetDimensions()` on pixel-size-changed, used in `RuntimeUI::resize()`.
3. **rmlui-bgfx reference**: bgfx vertex layout (position 2f, color0 4ub, texcoord0 2f = stride 20), orthographic projection via `bx::mtxOrtho` with homogeneous depth, 1×1 white fallback texture, `Uint8` color attribute type with bgfx auto-normalization, per-draw-call scissor via `bgfx::setScissor`, `bgfx::setUniform` for per-geometry translation, separate projection/transform/translate uniforms.
4. **rmlui-bgfx shaders**: Vertex shader: `gl_Position = u_projection * u_transform * vec4(a_position + u_translate.xy, 0.0, 1.0)`. Fragment shader: `gl_FragColor = v_color0 * texture2D(s_texColor, v_texcoord0)`. Used our existing `varying.def.sc` (vec4 a_color0, not uint4 a_color0) so no division by 255 in shader.

## Code Origin and License Notes

- **RmlUi** is MIT-licensed. The key conversion switch and modifier state function are adapted from `refs/RmlUi/Backends/RmlUi_Platform_SDL.cpp`. This constitutes a derived work of MIT-licensed code; the MIT license requires preservation of the copyright notice in distributions.
- **rmlui-bgfx** repository is referenced for ideas (shader structure, vertex layout, uniform approach) but no code was copied verbatim. The shader structure (projection × transform × translate pipeline) is a standard rendering pattern.
- **bgfx/bx** are BSD-2 licensed. `bx::mtxOrtho` and `bx::mtxIdentity` are used as-is.
- All new code (`engine/src/ui_runtime_rmlui.cpp`, `engine/shaders/bgfx/vs_rmlui.sc`, `engine/shaders/bgfx/fs_rmlui.sc`) is original to this project.

## What RmlUi Features Work

- **RmlUi initialization / shutdown**: Complete lifecycle with `Rml::Initialise` → `CreateContext` → document loading → per-frame `Update` / `Render` → `RemoveContext` → `Shutdown`.
- **Compiled geometry path**: `CompileGeometry` creates bgfx vertex+index buffers with 32-bit indices; `RenderGeometry` submits to view 1 with proper translation, texture, and scissor state.
- **Texture generation (font glyphs)**: `GenerateTexture` creates bgfx RGBA8 textures from raw pixel data. Font rendering works correctly — text glyphs are rendered as font atlas textures generated through this path.
- **Scissor region**: `EnableScissorRegion` / `SetScissorRegion` are implemented via `bgfx::setScissor`.
- **Transform support**: `SetTransform` stores the current element transform matrix and applies it as a uniform.
- **Orthographic projection**: Proper Y-down coordinate system via `bx::mtxOrtho` matching RmlUi's pixel-space conventions.
- **SDL3 event translation**: Mouse motion/button/wheel, keyboard key down/up, text input, and modifier state all translate correctly.
- **Window resize**: Propagates to RmlUi context dimensions and render interface projection.
- **Font loading**: `Rml::LoadFontFace` loads LiberationSans.ttf from the assets directory.
- **Document/stylesheet loading**: Demo `.rml` and `.rcss` files load from `apps/sandbox/assets/rmlui/`.
- **Button click**: `onclick` event handler changes button text — input translation is correct enough for UI interaction.
- **Multiple demo modes**: `--demo rmlui` and `--demo all` both work with clean shutdown.

## What Is Deferred

- **`LoadTexture` (file → image)**: Returns 0. The font engine generates glyph textures via `GenerateTexture`, so text renders, but `<img>` tags or `background-image` decorator images from files will not display. Needs `bimg::imageParse` or stb_image integration.
- **RmlUi Debugger**: Not integrated. The Debugger requires an additional library target and adds complexity not needed for the initial slice.
- **Clip mask layers**: `RenderToClipMask`, `PushLayer`, `PopLayer`, `CompositeLayers` use default (no-op) implementations. RmlUi will not render with clip masks or layer compositing.
- **Filters and shaders**: `CompileFilter`, `ReleaseFilter`, `RenderShader` etc. use default (no-op) implementations.
- **Touch input**: `SDL_EVENT_FINGER_DOWN/MOTION/UP` are not translated. Touch-based interaction is deferred.
- **Text IME**: `TextInputMethodEditor` is not implemented. Text composition (e.g., CJK IME) may not work correctly.
- **Cursor management**: The `BgfxSystemInterface` does not override `SetMouseCursor` — cursors remain the SDL default.
- **Clipboard**: `SetClipboardText` / `GetClipboardText` use RmlUi's default (no-op) implementations.
- **High-DPI / pixel density**: Mouse coordinates are passed without pixel-density scaling. Works correctly at 1× scale.
- **Web/Android RmlUi linkage**: RmlUi is not linked on Emscripten or Android (platform restriction in `CMakeLists.txt`). Both platforms compile the scaffold path cleanly.

## Linux Verification Results

| Command | Result |
|---|---|
| `cmake --preset linux-debug` | Passed |
| `cmake --build --preset linux-debug` | Passed |
| `./build/linux-debug/…/noveltea-sandbox --demo rmlui --frames 180` | Passed — RmlUi initializes, loads font, loads demo document, renders 180 frames, clean shutdown |
| `./build/linux-debug/…/noveltea-sandbox --demo all --frames 180` | Passed — combined Render2D + RmlUi + debug overlay |

## Web Verification Results

| Command | Result |
|---|---|
| `cmake --preset web-debug` | Passed |
| `cmake --build --preset web-debug` | Passed (no RmlUi, scaffold path only) |

## Android Verification Results

| Command | Result |
|---|---|
| `cd android && ./gradlew :app:assembleDebug` | Passed (no RmlUi, scaffold path only) |

## Next Recommended Step

Add `bimg::imageParse`-based texture loading to `BgfxRenderInterface::LoadTexture` so RmlUi can load PNG/JPEG images from `<img>` tags and CSS `background-image` decorators. For NovelTea text, build the remaining BBCode/style-run/per-glyph animation semantics on top of the engine-owned `TextLayout` data rather than reviving the old text-lab scaffold.
