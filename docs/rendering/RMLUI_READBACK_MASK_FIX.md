## Why

The readback test is a correctness gate for the current renderer output. The masked panel at
`(524, 64)` is the one that exposed the regression while the renderer was being refactored toward
bounded layers and postprocess targets.

The working temporary fix was to relax the child-layer bounds selection back to full-frame fallback
for the affected path. In code, that meant the child layer bounds helper stopped applying the
active scissor rectangle:

```cpp
const FbRect* scissor_ptr = nullptr;
const_cast<PerfCounters&>(perf).add_unbounded_layer_fallback();

return noveltea::ui::rmlui::compute_child_layer_bounds(surface, parent_ptr, scissor_ptr,
                                                       transform_valid);
```

That made the readback gallery pass again, because the `saved_mask` subtree no longer depended on
the still-incomplete bounded mask-image path. The downside is that it temporarily gives up the
Phase 2 bounded-child-layer behavior for this case, so it is a correctness fallback, not the final
optimization state.

The test comment stays in place to mark the pixel check as tracking unfinished bounded
mask-image work in the RmlUi bgfx optimization plan.