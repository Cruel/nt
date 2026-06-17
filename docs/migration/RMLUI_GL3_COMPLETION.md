# RmlUi GL3 Parity Completion State

Status values: NOT STARTED, IMPLEMENTED, NOT VERIFIED, VERIFIED.

## RenderInterface 6.2 Method Coverage

| Method | Status | Notes |
| --- | --- | --- |
| CompileGeometry | IMPLEMENTED, NOT VERIFIED | bgfx vertex/index buffers. |
| RenderGeometry | IMPLEMENTED, NOT VERIFIED | Basic textured/color geometry. |
| ReleaseGeometry | IMPLEMENTED, NOT VERIFIED | Destroys bgfx buffers. |
| LoadTexture | IMPLEMENTED, NOT VERIFIED | Uses bimg decode and premultiplies source. |
| GenerateTexture | IMPLEMENTED, NOT VERIFIED | Accepts premultiplied RGBA. |
| ReleaseTexture | IMPLEMENTED, NOT VERIFIED | Releases owned handles. |
| EnableScissorRegion | IMPLEMENTED, NOT VERIFIED | Tracks state. |
| SetScissorRegion | IMPLEMENTED, NOT VERIFIED | Clamps to target bounds. |
| EnableClipMask | IMPLEMENTED, NOT VERIFIED | Tracks current-layer stencil enable only. |
| RenderToClipMask | IMPLEMENTED, NOT VERIFIED | Stencil operations need inheritance and overflow verification. |
| SetTransform | IMPLEMENTED, NOT VERIFIED | Uploads RmlUi matrix to shader. |
| PushLayer | IMPLEMENTED, NOT VERIFIED | Needs failure-state and mask inheritance completion. |
| CompositeLayers | IMPLEMENTED, NOT VERIFIED | Needs filter execution and same-layer verification. |
| PopLayer | IMPLEMENTED, NOT VERIFIED | Needs exact parent state restoration verification. |
| SaveLayerAsTexture | IMPLEMENTED, NOT VERIFIED | Captures active scissor via bgfx blit when capability is present; copy-shader fallback pending. |
| SaveLayerAsMaskImage | IMPLEMENTED, NOT VERIFIED | Creates typed mask-image filter backed by saved texture; GPU mask multiplication pending. |
| CompileFilter | IMPLEMENTED, NOT VERIFIED | Parser support partial; GPU execution missing. |
| ReleaseFilter | IMPLEMENTED, NOT VERIFIED | Erases records. |
| CompileShader | IMPLEMENTED, NOT VERIFIED | Creates typed gradient shader records; parameter packing pending. |
| RenderShader | IMPLEMENTED, NOT VERIFIED | Dispatch fallback exists; real gradient program pending. |
| ReleaseShader | IMPLEMENTED, NOT VERIFIED | Erases shader records. |

## Acceptance Gates

| Gate | Status | Notes |
| --- | --- | --- |
| Current git diff inspected | VERIFIED | Initial diff contained only untracked refs/ and pingdotgg/. |
| RmlUi bgfx files inspected | VERIFIED | Implementation and planning files read. |
| RuntimeUI facade inspected | VERIFIED | Current demo-only facade read. |
| bgfx views/shader pipeline inspected | IMPLEMENTED, NOT VERIFIED | Initial rg complete; detailed edits pending. |
| RmlUi tests/assets/CI inspected | IMPLEMENTED, NOT VERIFIED | Initial rg complete; detailed edits pending. |
| Official GL3 and SDL backends inspected | IMPLEMENTED, NOT VERIFIED | GL3 advanced filter/shader/layer sections inspected; SDL backend still needs full pass. |
| Baseline linux configure/build/ctest recorded | VERIFIED | `cmake --preset linux-debug`, build, and ctest passed before edits. |
| Render-target orientation verified by readback | NOT STARTED | Needs asymmetric GPU fixture. |
| Premultiplied color matrix CPU tests | VERIFIED | Covers identity, brightness, contrast, invert, grayscale, sepia, hue-rotate, and saturate with translucent premultiplied input; ctest passed. |
| Premultiplied color matrix GPU readback | NOT STARTED | Needs fixture. |
| Capability-aware blit/copy texture flags | IMPLEMENTED, NOT VERIFIED | Postprocess and saved textures only request BLIT_DST when using blit paths; copy fallback pending. |
| Production stencil planner used by layer creation | VERIFIED | Layer creation now uses tested planner and selects D24S8 or D0S8. |
| Frame failure propagation | NOT STARTED | Explicit frame state required. |
| Expanded view budget or safe allocator | VERIFIED | Runtime UI range expanded from 32 views to 192 views and scheduler tests pass. |
| Clip-mask inheritance semantics | NOT STARTED | Real shared stencil or replay strategy required. |
| Layer semantics and resource namespaces | NOT STARTED | Must verify failure, reuse, resize, shutdown. |
| Copy/resolve/MSAA abstraction | NOT STARTED | Capability-aware blit/fallback and resolve. |
| SaveLayerAsTexture | IMPLEMENTED, NOT VERIFIED | Needs visual/readback and no-blit fallback verification. |
| SaveLayerAsMaskImage | IMPLEMENTED, NOT VERIFIED | Needs mask-image GPU path verification. |
| Standard filters GPU execution | IMPLEMENTED, NOT VERIFIED | Opacity, blur, drop-shadow, color matrices, and saved mask image have bgfx pass paths; visual readback still required. |
| Shader gradients | IMPLEMENTED, NOT VERIFIED | Linear/radial/conic including repeating parse and submit to gradient program; visual readback still required. |
| Shader manifest/loader/staging/packaging | IMPLEMENTED, NOT VERIFIED | Distinct shader programs are in manifest/loader and compile for glsl-120, essl-100, and essl-300; Web/Android packaging still pending. |
| RuntimeUI public facade | IMPLEMENTED, NOT VERIFIED | Documents, elements, listeners, data models, reload, density, and focus/input queries are exposed; integration tests pending. |
| Feature-gallery document | NOT STARTED | Deterministic advanced coverage. |
| Linux visual readback integration test | NOT STARTED | Must detect blank/flips/masks/filters/gradients. |
| Web build and browser smoke | NOT STARTED | Explicit ready, input, visuals, no console errors. |
| Android build and packaged assets | NOT STARTED | Emulator CI where feasible. |
| Placeholder scan clean | VERIFIED | Required rg command returned no matches after edits. |
| STATUS.md final rewrite | NOT STARTED | One accurate current-status section. |
