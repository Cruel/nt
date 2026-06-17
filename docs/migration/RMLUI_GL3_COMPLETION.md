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
| EnableClipMask | IMPLEMENTED, NOT VERIFIED | Tracks per-layer stencil enable and is inherited by pushed layers. |
| RenderToClipMask | IMPLEMENTED, NOT VERIFIED | Set, SetInverse, Intersect, scissored stencil clear/write, and inherited replay paths exist; visual/readback verification pending. |
| SetTransform | IMPLEMENTED, NOT VERIFIED | Uploads RmlUi matrix to shader. |
| PushLayer | IMPLEMENTED, NOT VERIFIED | Propagates frame failure and replays inherited clip-mask contents into child layer stencils; visual/readback verification pending. |
| CompositeLayers | IMPLEMENTED, NOT VERIFIED | Needs filter execution and same-layer verification. |
| PopLayer | IMPLEMENTED, NOT VERIFIED | Needs exact parent state restoration verification. |
| SaveLayerAsTexture | IMPLEMENTED, NOT VERIFIED | Captures active scissor via bgfx blit or shader-copy fallback. |
| SaveLayerAsMaskImage | IMPLEMENTED, NOT VERIFIED | Creates typed mask-image filter backed by saved texture and mask multiplication GPU pass. |
| CompileFilter | IMPLEMENTED, NOT VERIFIED | Standard filter records compile; GPU execution exists, visual/readback verification pending. |
| ReleaseFilter | IMPLEMENTED, NOT VERIFIED | Erases records. |
| CompileShader | IMPLEMENTED, NOT VERIFIED | Creates typed gradient shader records with packed parameters and stops. |
| RenderShader | IMPLEMENTED, NOT VERIFIED | Submits supported gradients through the gradient program; visual/readback verification pending. |
| ReleaseShader | IMPLEMENTED, NOT VERIFIED | Erases shader records. |

## Acceptance Gates

| Gate | Status | Notes |
| --- | --- | --- |
| Current git diff inspected | VERIFIED | Initial diff contained only untracked refs/ and pingdotgg/. |
| RmlUi bgfx files inspected | VERIFIED | Implementation and planning files read. |
| RuntimeUI facade inspected | VERIFIED | Current demo-only facade read. |
| bgfx views/shader pipeline inspected | IMPLEMENTED, NOT VERIFIED | Initial rg complete; detailed edits pending. |
| RmlUi tests/assets/CI inspected | VERIFIED | Added and ran asset coverage test for the advanced gallery; full ctest passes. |
| Official GL3 and SDL backends inspected | IMPLEMENTED, NOT VERIFIED | GL3 advanced filter/shader/layer sections inspected; SDL backend still needs full pass. |
| Baseline linux configure/build/ctest recorded | VERIFIED | `cmake --preset linux-debug`, build, and ctest passed before edits. |
| Render-target orientation verified by readback | VERIFIED | CTest screenshot verifier checks asymmetric top-left/top-right/bottom-left/bottom-right color regions. |
| Premultiplied color matrix CPU tests | VERIFIED | Covers identity, brightness, contrast, invert, grayscale, sepia, hue-rotate, and saturate with translucent premultiplied input; ctest passed. |
| Premultiplied color matrix GPU readback | IMPLEMENTED, NOT VERIFIED | GPU color-matrix pass is exercised by readback; premultiplied numeric parity still needs a dedicated translucent fixture. |
| Capability-aware blit/copy texture flags | IMPLEMENTED, NOT VERIFIED | Postprocess and saved textures only request BLIT_DST for blit paths; shader-copy fallback exists. |
| Production stencil planner used by layer creation | VERIFIED | Layer creation now uses tested planner and selects D24S8 or D0S8. |
| Frame failure propagation | IMPLEMENTED, NOT VERIFIED | Frame failure flag suppresses later submissions and final composite; targeted failure tests pending. |
| Expanded view budget or safe allocator | VERIFIED | Runtime UI range expanded from 32 views to 192 views and scheduler tests pass. |
| Clip-mask inheritance semantics | IMPLEMENTED, NOT VERIFIED | Pushed layers replay parent clip commands into their own stencil and preserve parent state on pop; visual/readback tests pending. |
| Layer semantics and resource namespaces | IMPLEMENTED, NOT VERIFIED | Frame failure, layer reuse, resize destruction, and postprocess namespaces exist; targeted lifecycle tests pending. |
| Copy/resolve/MSAA abstraction | IMPLEMENTED, NOT VERIFIED | Shared region-copy path uses texture blit when supported and render-to-texture shader copy otherwise; MSAA resolve not separately exercised. |
| SaveLayerAsTexture | IMPLEMENTED, NOT VERIFIED | Needs visual/readback and no-blit fallback verification. |
| SaveLayerAsMaskImage | VERIFIED | Readback verifier checks center output and transparent edge from saved mask image GPU path. |
| Standard filters GPU execution | VERIFIED | Readback verifier covers opacity, color matrix, blur, drop-shadow, and saved mask image output. |
| Shader gradients | VERIFIED | Readback verifier covers linear, radial, and conic gradient output; repeating variants are covered by gallery asset test. |
| Shader manifest/loader/staging/packaging | VERIFIED | Distinct shader programs are in manifest/loader; Linux tests, Web build, and Android assemble compile and stage shader assets. |
| RuntimeUI public facade | IMPLEMENTED, NOT VERIFIED | Documents, elements, listeners, data models, reload, density, and focus/input queries are exposed; integration tests pending. |
| Feature-gallery document | VERIFIED | `advanced_gallery.rml/.rcss` covers orientation, masks, saved mask image, filters, and gradient variants; ctest and frame-limited sandbox smoke pass. |
| Linux visual readback integration test | VERIFIED | `noveltea_rmlui_readback_capture` and `noveltea_rmlui_readback_verify` pass under ctest and detect flips, blanks, masks, filters, and gradients. |
| Web build and browser smoke | IMPLEMENTED, NOT VERIFIED | Web build passes with advanced gallery assets staged; browser smoke still pending. |
| Android build and packaged assets | VERIFIED | `./gradlew :app:assembleDebug` passed and staged compiled shader/runtime assets. |
| Placeholder scan clean | VERIFIED | Required rg command returned no matches after edits. |
| STATUS.md final rewrite | NOT STARTED | One accurate current-status section. |
