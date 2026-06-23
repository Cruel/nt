#pragma once

#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_planning.hpp"

namespace noveltea::ui::rmlui {

using rmlui_bgfx::apply_color_matrix;
using rmlui_bgfx::BasePresentationMode;
using rmlui_bgfx::BasePresentationPolicy;
using rmlui_bgfx::choose_base_presentation_policy;
using rmlui_bgfx::choose_stencil_plan;
using rmlui_bgfx::ClipOperationPlan;
using rmlui_bgfx::ColorOnlyFilterPlan;
using rmlui_bgfx::FilterKind;
using rmlui_bgfx::FilterRecord;
using rmlui_bgfx::fullscreen_triangle;
using rmlui_bgfx::FullscreenVertex;
using rmlui_bgfx::gaussian_kernel;
using rmlui_bgfx::GaussianKernel;
using rmlui_bgfx::GradientKind;
using rmlui_bgfx::GradientRecord;
using rmlui_bgfx::GradientStop;
using rmlui_bgfx::is_identity_color_matrix;
using rmlui_bgfx::is_noop_filter;
using rmlui_bgfx::LayerPoolPlan;
using rmlui_bgfx::make_brightness_filter;
using rmlui_bgfx::make_contrast_filter;
using rmlui_bgfx::make_grayscale_filter;
using rmlui_bgfx::make_hue_rotate_filter;
using rmlui_bgfx::make_invalid_gradient;
using rmlui_bgfx::make_invert_filter;
using rmlui_bgfx::make_opacity_filter;
using rmlui_bgfx::make_saturate_filter;
using rmlui_bgfx::make_sepia_filter;
using rmlui_bgfx::mask_filter_owns_saved_texture;
using rmlui_bgfx::multiply_color_matrices;
using rmlui_bgfx::plan_color_only_filter_chain;
using rmlui_bgfx::plan_stencil_clip_operation;
using rmlui_bgfx::PostprocessPoolPlan;
using rmlui_bgfx::PostprocessTargetKind;
using rmlui_bgfx::simplify_filter_chain;
using rmlui_bgfx::StencilClipPlan;
using rmlui_bgfx::StencilPlan;
using rmlui_bgfx::texture_ownership_releases_handle;
using rmlui_bgfx::TextureOwnership;

} // namespace noveltea::ui::rmlui
