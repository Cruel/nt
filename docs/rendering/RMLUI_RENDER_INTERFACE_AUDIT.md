# RmlUi RenderInterface Audit

Date: 2026-06-23

Source contract: RmlUi `RenderInterface` documentation and the local RmlUi 6.2 `RmlUi/Core/RenderInterface.h` header. The interface is split into required basic rendering functions and optional advanced features. Basic geometry, textures, and scissor support are always required. Advanced support is grouped into clip masks, transforms, layers, render textures, mask images, filters, and shaders.

This audit is intentionally about feature coverage and verification, not just current readback-gallery performance. A feature can be implemented and still need a focused fixture before we call it fully verified.

## Summary

The bgfx renderer implements the full RmlUi 6.2 render interface method surface. The current representative Web release/profile run is performance-healthy and hits the browser/display cap at 120 FPS with the bounded renderer shape:

```text
[perf] fps=120 passes=89 views=43 view_reuses=46 geom=27 clip=15 gradients=8 pass_geom=27 pass_gradient=8 pass_clip=15 pass_stencil_norm=0 pass_base_clear=1 pass_layer_clear=13 pass_stencil_clear=2 pass_filter_copy=2 pass_filter_opacity=0 pass_filter_color=0 pass_filter_mask=1 pass_filter_blur=4 pass_filter_shadow=1 pass_filter_shadow_comp=1 color_filter_folds=9 pass_layer_scratch=0 pass_layer_comp=12 pass_final_comp=1 pass_save_texture=0 pass_save_mask=0 pass_other_copy=1 pass_other=0 layers=13 full_layers=1 bounded_layers=13 full_frame_child_layers=0 bounded_child_layers=13 unbounded_layer_fallbacks=0 unbounded_no_scissor_fallbacks=0 unbounded_transform_fallbacks=0 unbounded_inverse_clip_fallbacks=0 filters=5 blur=4 shadow=1 mask=1 base_direct=0 base_offscreen=1 base_fallback=1 clear_px=2909754 copy_px=14641 composite_px=2876667 post_px=31813 full_frame_passes=2 bounded_passes=36 full_frame_clear_passes=1 bounded_clear_passes=15 full_frame_composite_passes=1 bounded_composite_passes=15 full_frame_postprocess_passes=0 bounded_postprocess_passes=6 full_frame_postprocess_target_uses=0 bounded_postprocess_target_uses=6 full_frame_postprocess_targets=0 bounded_postprocess_targets=0 rt_alloc=0 rt_destroy=0 layer_alloc=0 layer_destroy=0 max_layer=1508x1869 max_child_layer=143x121 max_child_rt=143x121 max_rt=121x121 fb=1508x1869
```

The earlier 5-7 FPS Web measurements should be treated as debug/WebGL validation artifacts, not as the current renderer truth.

Feature-wise, the renderer is broadly complete for the advanced RmlUi effects currently used by NovelTea's fixtures: ordinary geometry, texture loading, generated font textures, scissor clipping, clip masks, transforms, layers, saved textures, saved mask images, built-in CSS filters, built-in gradient decorators, blend and replace compositing, premultiplied alpha, and WebGL feedback-loop protection.

The largest unsupported or under-verified areas are:

1. Generic `shader(<string>)` decorators are implemented through the NovelTea material bridge. The string resolves as a NovelTea project material id with `ShaderRole::RmlUiDecorator`; it is not runtime shader source. A focused `material_shader.rml` fixture exists, while broader readback-gallery coverage can still be expanded.
2. Custom application/plugin filter names are not supported. `CompileFilter()` returns zero for unknown names. Custom filter materials are deferred until after the base material system and RmlUi decorator-material bridge are stable.
3. `backdrop-filter` now has focused fixture/readback coverage in `feature_fixtures.rml`, using an invert filter over deterministic color bars.
4. CSS `box-shadow` now has a focused fixture, but visual shadow output is still not marked verified. The current readback fixture proves the base elements render, while colored outer/inset shadow pixels are tracked as a remaining limitation.
5. Perspective/3D transforms now have focused fixture/readback coverage using RmlUi's supported `rotateY(...) translateZ(...)` syntax.
6. Lifecycle verification now covers stale-handle release/no-op behavior for `ReleaseGeometry()`, `ReleaseTexture()`, `ReleaseFilter()`, and material-backed `ReleaseShader()` through a bgfx Noop harness. Nested `PopLayer()` parent-handle restoration is covered by a layer-system unit test and visual fixture coverage.
7. Blur quality is intentionally conservative/approximate. The current shader uses a limited tap set; full GL3-style large-sigma/downsample behavior is not implemented.

## Method Coverage

| RmlUi method | Implementation status | Verification status | Notes |
| --- | --- | --- | --- |
| `CompileGeometry()` | Implemented | Verified for bounds and readback paths | Computes indexed local AABB, rejects empty/invalid/non-finite geometry, uploads bgfx vertex/index buffers. |
| `RenderGeometry()` | Implemented | Verified by readback gallery | Renders immediately on materialized layers or records commands for virtual child layers. Uses captured geometry bounds for later materialization. |
| `ReleaseGeometry()` | Implemented | Verified by lifecycle test | Destroys bgfx buffers and erases the handle. Stale/double release and stale render calls are covered by the bgfx Noop lifecycle harness. |
| `LoadTexture()` | Implemented | Verified by asset/readback paths | Uses the renderer `TextureLoader` provider and creates premultiplied RGBA8 bgfx textures. |
| `GenerateTexture()` | Implemented | Verified indirectly by font loading | Creates generated premultiplied RGBA8 textures, used by RmlUi font atlases. Add explicit generated-texture orientation fixture if texture-origin bugs recur. |
| `ReleaseTexture()` | Implemented | Verified by lifecycle test | Releases owned bgfx textures according to `TextureOwnership`. Generated-texture stale/double release is covered by the bgfx Noop lifecycle harness, and saved-mask ownership remains covered by layer-system tests. |
| `EnableScissorRegion()` | Implemented | Verified by readback paths | Updates active scissor state. Scissor is intentionally independent of active transforms, matching RmlUi requirements. |
| `SetScissorRegion()` | Implemented | Verified by bounds/readback paths | Converts logical/window coordinates to framebuffer coordinates and clamps to the current surface. |
| `EnableClipMask()` | Implemented | Verified for current fixtures | Updates active layer clip-mask state. Clip mask is implemented through stencil-aware layer state. |
| `RenderToClipMask()` | Implemented | Verified for current fixtures and helper tests | Supports `Set`, `SetInverse`, and `Intersect`, records commands for virtual layers, and applies captured scissor/transform state. More visual fixtures for nested inverse clips would be useful. |
| `SetTransform()` | Implemented | Verified for 2D affine and focused 3D fixture | Stores RmlUi's `Matrix4f`; shader applies projection * transform * translated vertex. Bounds tests cover translation-before-transform, scale, negative scale, rotation, non-integer DPR, invalid/non-finite input, and zero W. `feature_fixtures.rml` adds focused perspective/3D readback coverage. |
| `PushLayer()` | Implemented | Verified by current bounded renderer shape | Creates virtual child layers, captures provisional parent/scissor/transform state, and defers target allocation until materialization. |
| `CompositeLayers()` | Implemented | Verified by readback gallery | Materializes source/destination as needed, applies filters in order, handles same-layer composition through scratch copy when needed, supports `Blend` and `Replace`, and preserves scissor during final composition. Add a focused `Replace` fixture. |
| `PopLayer()` | Implemented | Verified by targeted parent-state tests | Pops the active layer and restores parent. Layer-system tests cover exact nested parent-handle restoration with inherited scissor/transform/clip state, and `feature_fixtures.rml` covers later sibling drawing under the parent clip/transform. |
| `SaveLayerAsTexture()` | Implemented | Verified for current saved texture/mask paths | Materializes current layer and copies bounded layer/scissor region, storing texture dimensions and global bounds. Add direct saved-texture fixture separate from mask-image. |
| `SaveLayerAsMaskImage()` | Implemented | Verified | Copies valid content bounds when tighter than layer bounds, stores mask metadata, and returns a mask-image filter handle. |
| `CompileFilter()` | Implemented for built-ins | Verified for representative built-ins | Supports opacity, blur, drop-shadow, brightness, contrast, invert, grayscale, sepia, hue-rotate, saturate, and saved mask-image filters. Unsupported custom filter names return zero. |
| `ReleaseFilter()` | Implemented | Verified for saved mask ownership and stale-handle release | Erases filter records and destroys owned saved-mask textures exactly once. Built-in filter stale/double release is covered by the bgfx Noop lifecycle harness; add broader coverage if custom filters are introduced. |
| `CompileShader()` | Implemented for gradients and material decorators | Verified for gradients; material path smoke-tested | Supports linear, radial, conic, and repeating variants. Generic `shader(<string>)` decorators resolve the string as a NovelTea `ShaderRole::RmlUiDecorator` material id through the provider bridge in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md). |
| `RenderShader()` | Implemented for gradients and material decorators | Verified for gradients; material path smoke-tested | Records/renders shader geometry using the same geometry bounds as ordinary geometry. Gradient handles use the built-in gradient path; material handles submit through explicit provider draw state including transform, scissor, clip/stencil, optional texture, and paint dimensions. |
| `ReleaseShader()` | Implemented | Verified by lifecycle test | Erases shader records. Material-backed shader release is covered by a counting provider test that proves double release does not release the provider handle twice. |

## Feature Coverage By RmlUi Documentation Category

| Feature category | Required by RmlUi properties | Current state | Gap / action |
| --- | --- | --- | --- |
| Basic rendering | Always required | Implemented and verified for current runtime/readback usage | Add explicit generated-texture origin fixture only if needed. |
| Scissor region | `overflow`, ordinary rectangular clipping | Implemented and verified | No immediate action. |
| Clip mask | transformed clipping, rounded borders with overflow hidden/none, `box-shadow` | Implemented and verified for current rounded/clip fixtures plus nested layer fixture | Add nested inverse-clip visual fixture only if inverse clip regressions recur. CSS `box-shadow` remains not visually verified. |
| Transforms | `transform`, `perspective` | Implemented for full matrix path; verified for affine 2D and focused 3D fixture | No immediate action beyond keeping `feature_fixtures.rml` in the readback gate. |
| Layers | `filter`, `backdrop-filter`, `mask-image`, `box-shadow` | Implemented and performant for representative filter/mask layers; `backdrop-filter` has focused readback coverage | CSS `box-shadow` fixture exists, but colored outer/inset shadow output is still not visually verified. |
| Render textures | `box-shadow` | Implemented through `SaveLayerAsTexture()`; CSS fixture exists | Keep CSS `box-shadow` tracked as not fully verified until readback proves actual shadow pixels. |
| Mask images | `mask-image` | Implemented and verified | Add image-file mask fixture in addition to gradient-generated mask if needed. |
| Filters | `filter`, `backdrop-filter`, blurred `box-shadow` | Built-in filter set implemented; color-only folding and bounded blur/drop-shadow paths exist; `backdrop-filter` has focused readback coverage | Define blur-quality expectations separately; keep CSS `box-shadow` shadow pixels tracked as not fully verified. |
| Shaders | `shader`, linear/radial/conic gradients and repeating variants | Built-in gradients implemented; generic `shader(<string>)` material bridge implemented | Continue expanding fixture/readback coverage for project-authored RmlUi decorator materials. |

## Rendering Convention Audit

RmlUi's render contract assumes pixel coordinates from the top-left, counter-clockwise triangle indices, generated textures with OpenGL-style bottom-left origin, premultiplied-alpha colors/textures, vertex color multiplied by texture color, alpha blending, and transform application only to geometry-bearing render calls.

Current renderer alignment:

- Pixel coordinates: projection matrices are built from logical/document coordinates and framebuffer-sized targets; bounded child targets get local projections from their logical bounds.
- Translation and transform order: shader computes `projection * transform * vec4(position + translation, 0, 1)`, matching RmlUi's required order.
- Scissor independence from transform: scissor is stored separately and applied in framebuffer/window coordinates, not multiplied by the active transform.
- Premultiplied alpha: loaded textures are premultiplied on upload unless already generated by RmlUi, and blending uses `ONE, INV_SRC_ALPHA` for RGB and alpha.
- Vertex color times texture color: ordinary fragment shader multiplies sampled texture by vertex color.
- Layer compositing: `Blend` uses premultiplied alpha blend state; `Replace` writes RGB/A without alpha blending.
- WebGL feedback protection: same-source/destination paths use scratch targets or fail the frame rather than triggering feedback loops.

## Known Gaps To Track

### Unsupported

- Custom filter names from application/plugin filters. Current `CompileFilter()` only recognizes RmlUi built-ins and saved mask-image filters. Custom filter materials are a later phase of [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).

### Implemented But Not Fully Verified

- CSS `box-shadow` property shadow output, including blurred/inset shadows driven by RmlUi's render-texture path. A fixture exists, but colored shadow pixels are not yet accepted as verified.
- `BlendMode::Replace` through a focused visual fixture. Local RmlUi 6.2 markup/property paths found so far emit `Blend`, not `Replace`, so this may need to remain internal helper coverage unless a reachable property path is identified.

### Quality/Compatibility Limitations

- Blur is bounded and functional for current fixtures, but not GL3-equivalent for large sigma. The shader uses a limited tap set and lacks a downsample/upsample large-radius strategy.
- Gradient color stops are capped at 16 stops. This is acceptable for current fixtures but should be documented as a renderer limit.
- Gradient interpolation currently uses the renderer shader's stop-mixing implementation. Keep comparing future visual changes against an approved upstream renderer/reference before changing gradient math.

## Recommended Follow-Up Work

1. Keep the optimization plan focused on regression gates and feature coverage, not emergency Web performance rescue.
2. Keep the `web-profile` / `pnpm run web:smoke:profile` path healthy so debug WebGL validation cannot again be mistaken for renderer runtime cost.
3. Keep the focused `feature_fixtures.rml` readback gate healthy for `backdrop-filter`, perspective/3D transforms, and nested layer restoration.
4. Continue investigating CSS `box-shadow`; the fixture now exists, but actual shadow pixels are not yet accepted as verified output.
5. Expand RmlUi material-shader fixture coverage as custom UI materials become real project content. Custom filters should still use provider hooks in the reusable renderer core rather than baking NovelTea-specific behavior into `rmlui_bgfx::RenderInterface`.
6. Defer blur quality/downsample work until the UI feature surface is locked and fixtures can detect visual regressions.
