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

1. Generic `shader(<string>)` decorators are not supported yet. `CompileShader()` only accepts the built-in gradient shader names. The intended path is now defined in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md): resolve the string as a NovelTea material reference, not as runtime shader source.
2. Custom application/plugin filter names are not supported. `CompileFilter()` returns zero for unknown names. Custom filter materials are deferred until after the base material system and RmlUi decorator-material bridge are stable.
3. `backdrop-filter` is not covered by a focused fixture. It may work if RmlUi lowers it through the same layer/filter calls, but we should not mark it verified without a fixture.
4. CSS `box-shadow` is not covered by a focused fixture. The building blocks exist through layers, filters, render textures, and drop-shadow code, but the property itself should be tested.
5. Perspective/3D transforms are not covered by a focused fixture. The shader path accepts a full `Matrix4f`, and bounds code handles homogeneous output conservatively, but visual coverage is focused on 2D affine transforms.
6. Lifecycle verification is incomplete for `ReleaseGeometry()`, `ReleaseTexture()`, `ReleaseShader()`, and exact `PopLayer()` parent-state restoration.
7. Blur quality is intentionally conservative/approximate. The current shader uses a limited tap set; full GL3-style large-sigma/downsample behavior is not implemented.

## Method Coverage

| RmlUi method | Implementation status | Verification status | Notes |
| --- | --- | --- | --- |
| `CompileGeometry()` | Implemented | Verified for bounds and readback paths | Computes indexed local AABB, rejects empty/invalid/non-finite geometry, uploads bgfx vertex/index buffers. |
| `RenderGeometry()` | Implemented | Verified by readback gallery | Renders immediately on materialized layers or records commands for virtual child layers. Uses captured geometry bounds for later materialization. |
| `ReleaseGeometry()` | Implemented | Needs lifecycle test | Destroys bgfx buffers and erases the handle. Add targeted double-release/stale-release coverage. |
| `LoadTexture()` | Implemented | Verified by asset/readback paths | Uses the renderer `TextureLoader` provider and creates premultiplied RGBA8 bgfx textures. |
| `GenerateTexture()` | Implemented | Verified indirectly by font loading | Creates generated premultiplied RGBA8 textures, used by RmlUi font atlases. Add explicit generated-texture orientation fixture if texture-origin bugs recur. |
| `ReleaseTexture()` | Implemented | Needs lifecycle test | Releases owned bgfx textures according to `TextureOwnership`. Saved-mask ownership is covered, general texture lifecycle is not. |
| `EnableScissorRegion()` | Implemented | Verified by readback paths | Updates active scissor state. Scissor is intentionally independent of active transforms, matching RmlUi requirements. |
| `SetScissorRegion()` | Implemented | Verified by bounds/readback paths | Converts logical/window coordinates to framebuffer coordinates and clamps to the current surface. |
| `EnableClipMask()` | Implemented | Verified for current fixtures | Updates active layer clip-mask state. Clip mask is implemented through stencil-aware layer state. |
| `RenderToClipMask()` | Implemented | Verified for current fixtures and helper tests | Supports `Set`, `SetInverse`, and `Intersect`, records commands for virtual layers, and applies captured scissor/transform state. More visual fixtures for nested inverse clips would be useful. |
| `SetTransform()` | Implemented | Verified for 2D affine transforms | Stores RmlUi's `Matrix4f`; shader applies projection * transform * translated vertex. Bounds tests cover translation-before-transform, scale, negative scale, rotation, non-integer DPR, invalid/non-finite input, and zero W. Perspective/3D visual coverage is still missing. |
| `PushLayer()` | Implemented | Verified by current bounded renderer shape | Creates virtual child layers, captures provisional parent/scissor/transform state, and defers target allocation until materialization. |
| `CompositeLayers()` | Implemented | Verified by readback gallery | Materializes source/destination as needed, applies filters in order, handles same-layer composition through scratch copy when needed, supports `Blend` and `Replace`, and preserves scissor during final composition. Add a focused `Replace` fixture. |
| `PopLayer()` | Implemented | Needs targeted parent-state test | Pops the active layer and restores parent. Need explicit tests for nested layers with scissor/transform/clip parent-state restoration. |
| `SaveLayerAsTexture()` | Implemented | Verified for current saved texture/mask paths | Materializes current layer and copies bounded layer/scissor region, storing texture dimensions and global bounds. Add direct saved-texture fixture separate from mask-image. |
| `SaveLayerAsMaskImage()` | Implemented | Verified | Copies valid content bounds when tighter than layer bounds, stores mask metadata, and returns a mask-image filter handle. |
| `CompileFilter()` | Implemented for built-ins | Verified for representative built-ins | Supports opacity, blur, drop-shadow, brightness, contrast, invert, grayscale, sepia, hue-rotate, saturate, and saved mask-image filters. Unsupported custom filter names return zero. |
| `ReleaseFilter()` | Implemented | Verified for saved mask ownership | Erases filter records and destroys owned saved-mask textures exactly once. Add broader filter lifecycle coverage if custom filters are introduced. |
| `CompileShader()` | Implemented for gradients only | Verified for gradients | Supports linear, radial, conic, and repeating variants. Generic `shader(<string>)` custom decorators are planned as NovelTea material references in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md). |
| `RenderShader()` | Implemented for gradients only | Verified for gradient fixtures | Records/renders gradient shader geometry using the same geometry bounds as ordinary geometry. Texture parameter is currently irrelevant for gradient shaders. Future material shader handles should route through the material provider described in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md). |
| `ReleaseShader()` | Implemented | Needs lifecycle test | Erases shader records. Add targeted release/stale-handle test. |

## Feature Coverage By RmlUi Documentation Category

| Feature category | Required by RmlUi properties | Current state | Gap / action |
| --- | --- | --- | --- |
| Basic rendering | Always required | Implemented and verified for current runtime/readback usage | Add explicit generated-texture origin fixture only if needed. |
| Scissor region | `overflow`, ordinary rectangular clipping | Implemented and verified | No immediate action. |
| Clip mask | transformed clipping, rounded borders with overflow hidden/none, `box-shadow` | Implemented and verified for current rounded/clip fixtures | Add nested inverse-clip visual fixture and CSS `box-shadow` fixture. |
| Transforms | `transform`, `perspective` | Implemented for full matrix path; verified for affine 2D | Add perspective/3D fixture before marking `perspective` fully verified. |
| Layers | `filter`, `backdrop-filter`, `mask-image`, `box-shadow` | Implemented and performant for representative filter/mask layers | Add focused `backdrop-filter` and CSS `box-shadow` fixtures. |
| Render textures | `box-shadow` | Implemented through `SaveLayerAsTexture()` | Add direct CSS `box-shadow` fixture. |
| Mask images | `mask-image` | Implemented and verified | Add image-file mask fixture in addition to gradient-generated mask if needed. |
| Filters | `filter`, `backdrop-filter`, blurred `box-shadow` | Built-in filter set implemented; color-only folding and bounded blur/drop-shadow paths exist | Add `backdrop-filter` fixture; define blur-quality expectations. |
| Shaders | `shader`, linear/radial/conic gradients and repeating variants | Built-in gradients implemented; generic `shader(<string>)` unsupported but planned | Implement the material-provider bridge from [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md), resolving `shader(<string>)` as a NovelTea material id/path. |

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

- Generic `shader(<string>)` decorator. Current `CompileShader()` rejects `name == "shader"` and any non-gradient shader name. The planned fix is the RmlUi decorator-material bridge in [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).
- Custom filter names from application/plugin filters. Current `CompileFilter()` only recognizes RmlUi built-ins and saved mask-image filters. Custom filter materials are a later phase of [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md).

### Implemented But Not Fully Verified

- `backdrop-filter` property.
- CSS `box-shadow` property, including blurred shadows driven by RmlUi's render-texture path.
- Perspective/3D transform visual correctness and clipping bounds.
- `BlendMode::Replace` through a focused visual fixture.
- Exact nested layer parent-state restoration after `PopLayer()` with active scissor, transform, and clip mask.
- General `ReleaseGeometry()`, `ReleaseTexture()`, and `ReleaseShader()` lifecycle edge cases.

### Quality/Compatibility Limitations

- Blur is bounded and functional for current fixtures, but not GL3-equivalent for large sigma. The shader uses a limited tap set and lacks a downsample/upsample large-radius strategy.
- Gradient color stops are capped at 16 stops. This is acceptable for current fixtures but should be documented as a renderer limit.
- Gradient interpolation currently uses the renderer shader's stop-mixing implementation. Keep comparing future visual changes against an approved upstream renderer/reference before changing gradient math.

## Recommended Follow-Up Work

1. Keep the optimization plan focused on regression gates and feature coverage, not emergency Web performance rescue.
2. Add a Web release/profile smoke path so debug WebGL validation cannot again be mistaken for renderer runtime cost.
3. Add focused RML fixtures for `backdrop-filter`, CSS `box-shadow`, perspective/3D transforms, generic `shader(<string>)` through the material bridge, and a `BlendMode::Replace` case if RmlUi exposes it through a property fixture.
4. Add lifecycle tests for `ReleaseGeometry()`, `ReleaseTexture()`, `ReleaseShader()`, and nested `PopLayer()` restoration.
5. Implement [`NOVELTEA_SHADER_MATERIAL_PLAN.md`](NOVELTEA_SHADER_MATERIAL_PLAN.md) before treating generic RmlUi shader support as complete. Custom filters/custom shader decorators should use provider hooks in the reusable renderer core rather than baking NovelTea-specific behavior into `rmlui_bgfx::RenderInterface`.
6. Defer blur quality/downsample work until the UI feature surface is locked and fixtures can detect visual regressions.
