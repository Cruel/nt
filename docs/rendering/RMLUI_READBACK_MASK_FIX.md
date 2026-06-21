## Why

The readback test is a correctness gate for the current renderer output. The masked panel at
`(524, 64)` is the one that exposed the regression while the renderer was being refactored toward
bounded layers and postprocess targets.

The earlier temporary fix relaxed child-layer bounds selection back to full-frame fallback for the
affected path. That made the readback gallery pass, but it gave up the Phase 2 bounded-child-layer
behavior and hid the real coordinate issue.

The bounded path is now restored:

- `compute_child_layer_bounds()` passes the active framebuffer scissor rectangle into the pure
  bounds helper when scissor is enabled.
- `unbounded_layer_fallbacks` is recorded only when there is no usable scissor or when the active
  transform requires a full-frame layer.
- `mask-image` UVs are computed from the postprocess work bounds being shaded and the saved mask's
  global bounds, then adjusted at the bgfx shader boundary for texture-origin differences.
- `SaveLayerAsMaskImage()` copies the bounded layer into an owned saved texture. The previous
  borrowed attachment optimization is not used for this path because RmlUi can apply the mask after
  the source/work layer has changed, making the borrowed lifetime unsafe.

The readback gallery's `(524, 64)` saved-mask pixel now passes without forcing the child layer to
full-frame bounds.
