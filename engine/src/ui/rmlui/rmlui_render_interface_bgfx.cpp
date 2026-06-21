#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "ui/rmlui/rmlui_file_interface.hpp"
#include "ui/rmlui/rmlui_render_planning.hpp"
#include "ui/rmlui/rmlui_render_pass_scheduler.hpp"
#include "ui/rmlui/rmlui_render_bounds.hpp"

#include <RmlUi/Core/Dictionary.h>
#include <RmlUi/Core/DecorationTypes.h>
#include <RmlUi/Core/Types.h>
#include <RmlUi/Core/Unit.h>
#include <RmlUi/Core/Variant.h>
#include <bimg/decode.h>
#include <bx/allocator.h>
#include <bx/math.h>
#include <bx/timer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <optional>
#include <unordered_map>
#include <vector>

namespace noveltea::ui::rmlui {

namespace {

constexpr uint64_t kRmlTextureFlags = BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
constexpr uint64_t kRmlBlendState =
    BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A |
    BGFX_STATE_BLEND_FUNC_SEPARATE(BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA,
                                   BGFX_STATE_BLEND_ONE, BGFX_STATE_BLEND_INV_SRC_ALPHA);
constexpr uint32_t kGradientStopLimit = 16;

struct RmlVertex {
    float px;
    float py;
    uint32_t rgba;
    float u;
    float v;
};

struct GeometryRecord {
    bgfx::VertexBufferHandle vb = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle ib = BGFX_INVALID_HANDLE;
    uint32_t index_count = 0;
};

struct TextureRecord {
    bgfx::TextureHandle handle = BGFX_INVALID_HANDLE;
    Rml::Vector2i dimensions;
    RenderBounds bounds;
    TextureOwnership ownership = TextureOwnership::External;
};

struct LayerRecord {
    bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle color = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle depth_stencil = BGFX_INVALID_HANDLE;
    RenderBounds bounds;
    int texture_width = 0;
    int texture_height = 0;
    bool clip_mask_enabled = false;
    uint8_t stencil_ref = 1;
    std::vector<size_t> clip_commands;
    float projection[16]{};
};

struct RenderTargetRecord {
    bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle color = BGFX_INVALID_HANDLE;
    FbRect bounds;
    int texture_width = 0;
    int texture_height = 0;
    PostprocessTargetKind kind = PostprocessTargetKind::Primary;
};

struct ShaderRecord {
    GradientRecord gradient;
};

struct ScissorState {
    bool enabled = false;
    Rml::Rectanglei region = Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
};

struct CompositeOp {
    bgfx::TextureHandle source = BGFX_INVALID_HANDLE;
    bgfx::FrameBufferHandle destination = BGFX_INVALID_HANDLE;

    FbRect source_rect;
    FbRect destination_rect;
    int source_texture_width = 0;
    int source_texture_height = 0;

    Rml::BlendMode blend_mode = Rml::BlendMode::Blend;
    ScissorState scissor;
    bool apply_destination_stencil = false;
    uint8_t stencil_ref = 1;
    RmlUiPassKind kind = RmlUiPassKind::LayerComposite;
    const char* name = "RmlUi.Composite";
};

struct FilterApplyResult {
    bgfx::TextureHandle texture = BGFX_INVALID_HANDLE;
    RenderBounds output_bounds;
    FbRect valid_rect_in_texture;
    int texture_width = 0;
    int texture_height = 0;
};

RmlUiPassRequest make_pass_request(RmlUiPassKind kind, int x, int y, bool clears_color,
                                   bool clears_stencil, int width, int height, const char* name)
{
    return RmlUiPassRequest{kind,
                            0,
                            std::numeric_limits<uint16_t>::max(),
                            clears_color,
                            clears_stencil,
                            x,
                            y,
                            width,
                            height,
                            name};
}

CompositeOp make_composite_op(bgfx::TextureHandle source, bgfx::FrameBufferHandle destination,
                              Rml::BlendMode blend_mode, ScissorState scissor,
                              bool apply_destination_stencil, uint8_t stencil_ref,
                              RmlUiPassKind kind, const char* name, FbRect source_rect = {},
                              FbRect destination_rect = {}, int source_texture_width = 0,
                              int source_texture_height = 0)
{
    CompositeOp op;
    op.source = source;
    op.destination = destination;
    op.source_rect = source_rect;
    op.destination_rect = destination_rect;
    op.source_texture_width = source_texture_width;
    op.source_texture_height = source_texture_height;
    op.blend_mode = blend_mode;
    op.scissor = scissor;
    op.apply_destination_stencil = apply_destination_stencil;
    op.stencil_ref = stencil_ref;
    op.kind = kind;
    op.name = name;
    return op;
}

bool is_full_frame_rect(FbRect rect, int width, int height)
{
    return !is_empty(rect) && rect.x == 0 && rect.y == 0 && rect.w >= width && rect.h >= height;
}

Rml::Rectanglei clamp_scissor_local(Rml::Rectanglei global_scissor, const FbRect& layer_fb_bounds);

FbRect active_scissor_bounds(const ScissorState& scissor, const FbRect& layer_bounds)
{
    if (!scissor.enabled)
        return {};
    const Rml::Rectanglei local = clamp_scissor_local(scissor.region, layer_bounds);
    return {local.Left(), local.Top(), local.Width(), local.Height()};
}

FbRect clip_work_bounds(const LayerRecord* layer, const ScissorState& scissor)
{
    if (!layer)
        return {};
    const FbRect layer_bounds = layer->bounds.framebuffer;
    if (is_empty(layer_bounds))
        return {};
    const FbRect scissor_bounds = active_scissor_bounds(scissor, layer_bounds);
    if (is_empty(scissor_bounds))
        return layer_bounds;
    return intersect(layer_bounds, scissor_bounds);
}

struct ClipCommand {
    Rml::ClipMaskOperation operation = Rml::ClipMaskOperation::Set;
    Rml::CompiledGeometryHandle geometry = 0;
    Rml::Vector2f translation;
    ScissorState scissor;
    bool transform_valid = false;
    std::array<float, 16> transform{};
    uint8_t previous_ref = 1;
    uint8_t next_ref = 1;
};

uint32_t pack_abgr(Rml::ColourbPremultiplied colour)
{
    return (uint32_t(colour.alpha) << 24u) | (uint32_t(colour.blue) << 16u) |
           (uint32_t(colour.green) << 8u) | uint32_t(colour.red);
}

void premultiply_rgba(std::vector<uint8_t>& rgba)
{
    for (size_t i = 0; i + 3 < rgba.size(); i += 4) {
        const uint32_t alpha = rgba[i + 3];
        rgba[i + 0] = static_cast<uint8_t>((uint32_t(rgba[i + 0]) * alpha + 127u) / 255u);
        rgba[i + 1] = static_cast<uint8_t>((uint32_t(rgba[i + 1]) * alpha + 127u) / 255u);
        rgba[i + 2] = static_cast<uint8_t>((uint32_t(rgba[i + 2]) * alpha + 127u) / 255u);
    }
}

Rml::Rectanglei clamp_scissor(Rml::Rectanglei region, int width, int height)
{
    const int left = std::clamp(region.Left(), 0, std::max(width, 0));
    const int top = std::clamp(region.Top(), 0, std::max(height, 0));
    const int right = std::clamp(region.Right(), 0, std::max(width, 0));
    const int bottom = std::clamp(region.Bottom(), 0, std::max(height, 0));
    if (right <= left || bottom <= top) {
        return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
    }
    return Rml::Rectanglei::FromPositionSize({left, top}, {right - left, bottom - top});
}

Rml::Rectanglei clamp_scissor_local(Rml::Rectanglei global_scissor, const FbRect& layer_fb_bounds)
{
    const int left =
        std::clamp(global_scissor.Left() - layer_fb_bounds.x, 0, std::max(layer_fb_bounds.w, 0));
    const int top =
        std::clamp(global_scissor.Top() - layer_fb_bounds.y, 0, std::max(layer_fb_bounds.h, 0));
    const int right =
        std::clamp(global_scissor.Right() - layer_fb_bounds.x, 0, std::max(layer_fb_bounds.w, 0));
    const int bottom =
        std::clamp(global_scissor.Bottom() - layer_fb_bounds.y, 0, std::max(layer_fb_bounds.h, 0));
    if (right <= left || bottom <= top) {
        return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
    }
    return Rml::Rectanglei::FromPositionSize({left, top}, {right - left, bottom - top});
}

ScissorState scissor_local_to_layer(ScissorState scissor, const RenderBounds& layer_bounds)
{
    if (!scissor.enabled)
        return scissor;
    return ScissorState{true, clamp_scissor_local(scissor.region, layer_bounds.framebuffer)};
}

Rml::Rectanglei logical_scissor_to_framebuffer(Rml::Rectanglei region,
                                               const SurfaceMetrics& surface)
{
    const Rect logical{
        static_cast<float>(region.Left()),
        static_cast<float>(region.Top()),
        static_cast<float>(region.Width()),
        static_cast<float>(region.Height()),
    };
    const Rect physical = logical_to_framebuffer(logical, surface);
    return Rml::Rectanglei::FromPositionSize(
        {static_cast<int>(std::floor(physical.x)), static_cast<int>(std::floor(physical.y))},
        {static_cast<int>(std::ceil(physical.width)),
         static_cast<int>(std::ceil(physical.height))});
}

float gradient_kind_code(GradientKind kind)
{
    switch (kind) {
    case GradientKind::Linear:
        return 1.0f;
    case GradientKind::RepeatingLinear:
        return 2.0f;
    case GradientKind::Radial:
        return 3.0f;
    case GradientKind::RepeatingRadial:
        return 4.0f;
    case GradientKind::Conic:
        return 5.0f;
    case GradientKind::RepeatingConic:
        return 6.0f;
    case GradientKind::Invalid:
        return 0.0f;
    }
    return 0.0f;
}

std::array<float, 4> color_to_float(Rml::ColourbPremultiplied color)
{
    return {float(color.red) / 255.0f, float(color.green) / 255.0f, float(color.blue) / 255.0f,
            float(color.alpha) / 255.0f};
}

bool apply_color_stops(GradientRecord& gradient, const Rml::Dictionary& parameters)
{
    auto it = parameters.find("color_stop_list");
    if (it == parameters.end() || it->second.GetType() != Rml::Variant::COLORSTOPLIST)
        return false;
    const Rml::ColorStopList& stops = it->second.GetReference<Rml::ColorStopList>();
    gradient.stop_count = std::min<uint32_t>(uint32_t(stops.size()), kGradientStopLimit);
    for (uint32_t i = 0; i < gradient.stop_count; ++i) {
        gradient.stops[i].position = stops[i].position.number;
        gradient.stops[i].color = color_to_float(stops[i].color);
    }
    return gradient.stop_count > 0;
}

bool populate_gradient(GradientRecord& gradient, const Rml::String& name,
                       const Rml::Dictionary& parameters)
{
    const bool repeating = Rml::Get(parameters, "repeating", false);
    if (name == "linear-gradient") {
        gradient.kind = repeating ? GradientKind::RepeatingLinear : GradientKind::Linear;
        const Rml::Vector2f p0 = Rml::Get(parameters, "p0", Rml::Vector2f(0.0f));
        const Rml::Vector2f p1 = Rml::Get(parameters, "p1", Rml::Vector2f(0.0f));
        gradient.p_v = {p0.x, p0.y, p1.x - p0.x, p1.y - p0.y};
    } else if (name == "radial-gradient") {
        gradient.kind = repeating ? GradientKind::RepeatingRadial : GradientKind::Radial;
        const Rml::Vector2f center = Rml::Get(parameters, "center", Rml::Vector2f(0.0f));
        const Rml::Vector2f radius = Rml::Get(parameters, "radius", Rml::Vector2f(1.0f));
        gradient.p_v = {center.x, center.y, 1.0f / std::max(radius.x, 0.000001f),
                        1.0f / std::max(radius.y, 0.000001f)};
    } else if (name == "conic-gradient") {
        gradient.kind = repeating ? GradientKind::RepeatingConic : GradientKind::Conic;
        const Rml::Vector2f center = Rml::Get(parameters, "center", Rml::Vector2f(0.0f));
        const float angle = Rml::Get(parameters, "angle", 0.0f);
        gradient.p_v = {center.x, center.y, std::cos(angle), std::sin(angle)};
    } else {
        return false;
    }
    return apply_color_stops(gradient, parameters);
}

ClipOperationPlan clip_operation_plan(Rml::ClipMaskOperation operation)
{
    switch (operation) {
    case Rml::ClipMaskOperation::Set:
        return ClipOperationPlan::Set;
    case Rml::ClipMaskOperation::SetInverse:
        return ClipOperationPlan::SetInverse;
    case Rml::ClipMaskOperation::Intersect:
        return ClipOperationPlan::Intersect;
    }
    return ClipOperationPlan::Set;
}

struct PerfCounters {
#ifdef NOVELTEA_ENABLE_RENDER_PERF
    uint32_t pass_count = 0;
    uint32_t geometry_draws = 0;
    uint32_t geometry_indices = 0;
    uint32_t clip_mask_draws = 0;
    uint32_t gradient_draws = 0;
    uint32_t clear_passes = 0;
    uint32_t copy_passes = 0;
    uint32_t composite_passes = 0;
    uint32_t postprocess_passes = 0;
    uint32_t blur_passes = 0;
    uint32_t dropshadow_passes = 0;
    uint32_t mask_passes = 0;
    uint32_t layer_pushes = 0;
    uint32_t layer_clears = 0;
    uint32_t full_frame_layers = 0;
    uint32_t bounded_layers = 0;
    uint32_t unbounded_layer_fallbacks = 0;
    uint32_t full_frame_passes = 0;
    uint32_t bounded_passes = 0;
    uint32_t full_frame_postprocess_targets = 0;
    uint32_t bounded_postprocess_targets = 0;
    uint32_t layer_allocations = 0;
    uint32_t layer_destroys = 0;
    uint32_t postprocess_allocations = 0;
    uint32_t postprocess_destroys = 0;
    uint64_t geometry_estimated_pixels = 0;
    uint64_t clip_estimated_pixels = 0;
    uint64_t clear_pixels = 0;
    uint64_t copy_pixels = 0;
    uint64_t composite_pixels = 0;
    uint64_t postprocess_pixels = 0;
    uint32_t max_layer_width = 0;
    uint32_t max_layer_height = 0;
    uint32_t max_postprocess_width = 0;
    uint32_t max_postprocess_height = 0;

    void reset() { *this = PerfCounters{}; }

    void add_pass() { pass_count++; }
    void add_geometry(uint64_t px, uint32_t indices)
    {
        geometry_draws++;
        geometry_indices += indices;
        geometry_estimated_pixels += px;
    }
    void add_clip_mask(uint64_t px)
    {
        clip_mask_draws++;
        clip_estimated_pixels += px;
    }
    void add_gradient() { gradient_draws++; }
    void add_clear(uint64_t px, bool full_frame)
    {
        clear_passes++;
        clear_pixels += px;
        if (full_frame) {
            full_frame_passes++;
        } else {
            bounded_passes++;
        }
    }
    void add_copy() { copy_passes++; }
    void add_copy_pixels(uint64_t px) { copy_pixels += px; }
    void add_composite(uint64_t px, bool full_frame)
    {
        composite_passes++;
        composite_pixels += px;
        if (full_frame) {
            full_frame_passes++;
        } else {
            bounded_passes++;
        }
    }
    void add_postprocess(uint64_t px, bool full_frame)
    {
        postprocess_passes++;
        postprocess_pixels += px;
        if (full_frame) {
            full_frame_passes++;
        } else {
            bounded_passes++;
        }
    }
    void add_blur() { blur_passes++; }
    void add_dropshadow() { dropshadow_passes++; }
    void add_mask(uint64_t px, bool full_frame)
    {
        mask_passes++;
        postprocess_pixels += px;
        if (full_frame) {
            full_frame_passes++;
        } else {
            bounded_passes++;
        }
    }
    void add_layer_push() { layer_pushes++; }
    void add_layer_clear() { layer_clears++; }
    void add_full_frame_layer() { full_frame_layers++; }
    void add_bounded_layer() { bounded_layers++; }
    void add_unbounded_layer_fallback() { unbounded_layer_fallbacks++; }
    void add_full_frame_pp_target() { full_frame_postprocess_targets++; }
    void add_bounded_pp_target() { bounded_postprocess_targets++; }
    void add_layer_alloc(uint32_t w, uint32_t h) { layer_allocations++; }
    void update_layer_max(uint32_t w, uint32_t h)
    {
        max_layer_width = std::max(max_layer_width, w);
        max_layer_height = std::max(max_layer_height, h);
    }
    void add_layer_destroy() { layer_destroys++; }
    void add_pp_alloc(uint32_t w, uint32_t h) { postprocess_allocations++; }
    void update_pp_max(uint32_t w, uint32_t h)
    {
        max_postprocess_width = std::max(max_postprocess_width, w);
        max_postprocess_height = std::max(max_postprocess_height, h);
    }
    void add_pp_destroy() { postprocess_destroys++; }
#else
    void reset() {}
    void add_pass() {}
    void add_geometry(uint64_t, uint32_t) {}
    void add_clip_mask(uint64_t) {}
    void add_gradient() {}
    void add_clear(uint64_t, bool) {}
    void add_copy() {}
    void add_copy_pixels(uint64_t) {}
    void add_composite(uint64_t, bool) {}
    void add_postprocess(uint64_t, bool) {}
    void add_blur() {}
    void add_dropshadow() {}
    void add_mask(uint64_t, bool) {}
    void add_layer_push() {}
    void add_layer_clear() {}
    void add_full_frame_layer() {}
    void add_bounded_layer() {}
    void add_unbounded_layer_fallback() {}
    void add_full_frame_pp_target() {}
    void add_bounded_pp_target() {}
    void add_layer_alloc(uint32_t, uint32_t) {}
    void update_layer_max(uint32_t, uint32_t) {}
    void add_layer_destroy() {}
    void add_pp_alloc(uint32_t, uint32_t) {}
    void update_pp_max(uint32_t, uint32_t) {}
    void add_pp_destroy() {}
#endif
};

} // namespace

struct BgfxRenderInterface::Impl {
    explicit Impl(const SurfaceMetrics& initial_surface, const assets::AssetManager& asset_manager)
        : assets(asset_manager)
    {
        layout.begin()
            .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Uint8, true)
            .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
            .end();
        fullscreen_layout.begin()
            .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
            .end();

        program =
            bgfx_backend::BgfxShaderLoader(assets).load_program(bgfx_backend::SystemShader::RmlUi);
        composite_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiComposite);
        copy_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiCopy);
        opacity_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiOpacity);
        color_matrix_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiColorMatrix);
        mask_multiply_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiMaskMultiply);
        blur_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiBlur);
        drop_shadow_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiDropShadow);
        gradient_program = bgfx_backend::BgfxShaderLoader(assets).load_program(
            bgfx_backend::SystemShader::RmlUiGradient);
        sampler = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler);
        mask_sampler = bgfx::createUniform("s_mask", bgfx::UniformType::Sampler);
        mask_texcoord_transform_uniform =
            bgfx::createUniform("u_maskTexCoordTransform", bgfx::UniformType::Vec4);
        projection_uniform = bgfx::createUniform("u_projection", bgfx::UniformType::Mat4);
        transform_uniform = bgfx::createUniform("u_transform", bgfx::UniformType::Mat4);
        translate_uniform = bgfx::createUniform("u_translate", bgfx::UniformType::Vec4);
        color_matrix_uniform = bgfx::createUniform("u_colorMatrix", bgfx::UniformType::Mat4);
        opacity_uniform = bgfx::createUniform("u_opacity", bgfx::UniformType::Vec4);
        gradient_params_uniform =
            bgfx::createUniform("u_gradientParams", bgfx::UniformType::Vec4, 2);
        gradient_stops_uniform =
            bgfx::createUniform("u_gradientStops", bgfx::UniformType::Vec4, kGradientStopLimit);
        gradient_stop_meta_uniform =
            bgfx::createUniform("u_gradientStopMeta", bgfx::UniformType::Vec4, 4);
        blur_params_uniform = bgfx::createUniform("u_blurParams", bgfx::UniformType::Vec4);
        blur_weights_uniform = bgfx::createUniform("u_blurWeights", bgfx::UniformType::Vec4);
        texcoord_bounds_uniform = bgfx::createUniform("u_texCoordBounds", bgfx::UniformType::Vec4);
        shadow_color_uniform = bgfx::createUniform("u_shadowColor", bgfx::UniformType::Vec4);
        shadow_offset_uniform = bgfx::createUniform("u_shadowOffset", bgfx::UniformType::Vec4);

        const uint8_t white[] = {255, 255, 255, 255};
        white_texture = bgfx::createTexture2D(1, 1, false, 1, bgfx::TextureFormat::RGBA8,
                                              kRmlTextureFlags, bgfx::copy(white, sizeof(white)));
        resize(initial_surface);
    }

    ~Impl()
    {
        for (auto& [_, geometry] : geometries) {
            destroy_geometry(geometry);
        }
        for (auto& [_, texture] : textures) {
            if ((texture.ownership == TextureOwnership::External ||
                 texture.ownership == TextureOwnership::SavedLayer) &&
                bgfx::isValid(texture.handle)) {
                bgfx::destroy(texture.handle);
            }
        }
        destroy_layers();
        destroy_postprocess_targets();
        destroy_fullscreen_geometry();
        if (bgfx::isValid(white_texture))
            bgfx::destroy(white_texture);
        if (bgfx::isValid(program))
            bgfx::destroy(program);
        if (bgfx::isValid(composite_program))
            bgfx::destroy(composite_program);
        if (bgfx::isValid(copy_program))
            bgfx::destroy(copy_program);
        if (bgfx::isValid(opacity_program))
            bgfx::destroy(opacity_program);
        if (bgfx::isValid(color_matrix_program))
            bgfx::destroy(color_matrix_program);
        if (bgfx::isValid(mask_multiply_program))
            bgfx::destroy(mask_multiply_program);
        if (bgfx::isValid(blur_program))
            bgfx::destroy(blur_program);
        if (bgfx::isValid(drop_shadow_program))
            bgfx::destroy(drop_shadow_program);
        if (bgfx::isValid(gradient_program))
            bgfx::destroy(gradient_program);
        if (bgfx::isValid(sampler))
            bgfx::destroy(sampler);
        if (bgfx::isValid(mask_sampler))
            bgfx::destroy(mask_sampler);
        if (bgfx::isValid(projection_uniform))
            bgfx::destroy(projection_uniform);
        if (bgfx::isValid(transform_uniform))
            bgfx::destroy(transform_uniform);
        if (bgfx::isValid(translate_uniform))
            bgfx::destroy(translate_uniform);
        if (bgfx::isValid(color_matrix_uniform))
            bgfx::destroy(color_matrix_uniform);
        if (bgfx::isValid(opacity_uniform))
            bgfx::destroy(opacity_uniform);
        if (bgfx::isValid(gradient_params_uniform))
            bgfx::destroy(gradient_params_uniform);
        if (bgfx::isValid(gradient_stops_uniform))
            bgfx::destroy(gradient_stops_uniform);
        if (bgfx::isValid(gradient_stop_meta_uniform))
            bgfx::destroy(gradient_stop_meta_uniform);
        if (bgfx::isValid(blur_params_uniform))
            bgfx::destroy(blur_params_uniform);
        if (bgfx::isValid(blur_weights_uniform))
            bgfx::destroy(blur_weights_uniform);
        if (bgfx::isValid(texcoord_bounds_uniform))
            bgfx::destroy(texcoord_bounds_uniform);
        if (bgfx::isValid(mask_texcoord_transform_uniform))
            bgfx::destroy(mask_texcoord_transform_uniform);
        if (bgfx::isValid(shadow_color_uniform))
            bgfx::destroy(shadow_color_uniform);
        if (bgfx::isValid(shadow_offset_uniform))
            bgfx::destroy(shadow_offset_uniform);
    }

    void resize(const SurfaceMetrics& new_surface)
    {
        surface = sanitize_surface_metrics(new_surface);
        width = surface.framebuffer_width;
        height = surface.framebuffer_height;
        logical_width = surface.logical_width;
        logical_height = surface.logical_height;
        bx::mtxOrtho(projection, 0.0f, float(logical_width), float(logical_height), 0.0f, -10000.0f,
                     10000.0f, 0.0f, bgfx::getCaps()->homogeneousDepth);
        destroy_layers();
        destroy_postprocess_targets();
    }

    static void destroy_geometry(GeometryRecord& geometry)
    {
        if (bgfx::isValid(geometry.vb))
            bgfx::destroy(geometry.vb);
        if (bgfx::isValid(geometry.ib))
            bgfx::destroy(geometry.ib);
        geometry = {};
    }

    void destroy_fullscreen_geometry()
    {
        if (bgfx::isValid(fullscreen_vb))
            bgfx::destroy(fullscreen_vb);
        fullscreen_vb = BGFX_INVALID_HANDLE;
    }

    Rml::TextureHandle create_texture_from_rgba(std::vector<uint8_t> rgba, int tex_width,
                                                int tex_height, bool already_premultiplied)
    {
        if (tex_width <= 0 || tex_height <= 0 || tex_width > UINT16_MAX ||
            tex_height > UINT16_MAX) {
            return 0;
        }
        const bgfx::Caps* caps = bgfx::getCaps();
        if (caps && (uint32_t(tex_width) > caps->limits.maxTextureSize ||
                     uint32_t(tex_height) > caps->limits.maxTextureSize)) {
            std::fprintf(stderr, "[rmlui] texture too large: %dx%d max=%u\n", tex_width, tex_height,
                         caps->limits.maxTextureSize);
            return 0;
        }
        const size_t expected_size = size_t(tex_width) * size_t(tex_height) * 4u;
        if (rgba.size() != expected_size || expected_size > std::numeric_limits<uint32_t>::max()) {
            return 0;
        }
        if (!already_premultiplied) {
            premultiply_rgba(rgba);
        }
        bgfx::TextureHandle texture = bgfx::createTexture2D(
            uint16_t(tex_width), uint16_t(tex_height), false, 1, bgfx::TextureFormat::RGBA8,
            kRmlTextureFlags, bgfx::copy(rgba.data(), uint32_t(rgba.size())));
        if (!bgfx::isValid(texture)) {
            return 0;
        }
        const Rml::TextureHandle handle = ++texture_counter;
        textures.emplace(
            handle, TextureRecord{texture,
                                  {tex_width, tex_height},
                                  RenderBounds{{0.0f, 0.0f, float(tex_width), float(tex_height)},
                                               {0, 0, tex_width, tex_height}},
                                  TextureOwnership::External});
        return handle;
    }

    static uintptr_t framebuffer_key(bgfx::FrameBufferHandle framebuffer)
    {
        return bgfx::isValid(framebuffer) ? uintptr_t(framebuffer.idx) + 1u : 0u;
    }

    static bgfx::FrameBufferHandle framebuffer_from_request(const RmlUiPassRequest& request)
    {
        if (request.bgfx_framebuffer_idx == std::numeric_limits<uint16_t>::max()) {
            return BGFX_INVALID_HANDLE;
        }
        return bgfx::FrameBufferHandle{request.bgfx_framebuffer_idx};
    }

    bgfx::TextureFormat::Enum depth_stencil_format() const
    {
        // Probe once and cache. WebGL's getInternalformatParameter is slow and
        // generates console spam when called repeatedly.
        if (!stencil_cached) {
            stencil_cached = true;
            const bool d24s8 = bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::D24S8,
                                                    BGFX_TEXTURE_RT_WRITE_ONLY);
            const bool d0s8 = bgfx::isTextureValid(0, false, 1, bgfx::TextureFormat::D0S8,
                                                   BGFX_TEXTURE_RT_WRITE_ONLY);
            switch (choose_stencil_plan(d24s8, d0s8)) {
            case StencilPlan::D24S8:
            case StencilPlan::StencilAttachment:
                cached_stencil_format = bgfx::TextureFormat::D24S8;
                break;
            case StencilPlan::D0S8:
                cached_stencil_format = bgfx::TextureFormat::D0S8;
                break;
            case StencilPlan::Unsupported:
                cached_stencil_format = bgfx::TextureFormat::Unknown;
                break;
            }
        }
        return cached_stencil_format;
    }

    void destroy_layer(LayerRecord& layer)
    {
        if (bgfx::isValid(layer.framebuffer)) {
            bgfx::destroy(layer.framebuffer);
            perf.add_layer_destroy();
        }
        layer = {};
    }

    void destroy_render_target(RenderTargetRecord& target)
    {
        if (bgfx::isValid(target.framebuffer)) {
            bgfx::destroy(target.framebuffer);
            perf.add_pp_destroy();
        }
        target = {};
    }

    Rml::Rectanglei current_save_bounds()
    {
        LayerRecord* layer = current_layer();
        if (!layer || !bgfx::isValid(layer->color)) {
            return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
        }

        const Rml::Rectanglei layer_bounds = Rml::Rectanglei::FromPositionSize(
            {layer->bounds.framebuffer.x, layer->bounds.framebuffer.y},
            {layer->bounds.framebuffer.w, layer->bounds.framebuffer.h});
        if (!scissor_enabled) {
            return layer_bounds;
        }

        const Rml::Rectanglei clipped = clamp_scissor(scissor_region, width, height);
        if (clipped.Width() <= 0 || clipped.Height() <= 0) {
            return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
        }

        const int left = std::max(clipped.Left(), layer_bounds.Left());
        const int top = std::max(clipped.Top(), layer_bounds.Top());
        const int right = std::min(clipped.Right(), layer_bounds.Right());
        const int bottom = std::min(clipped.Bottom(), layer_bounds.Bottom());
        if (right <= left || bottom <= top) {
            return Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
        }
        return Rml::Rectanglei::FromPositionSize({left, top}, {right - left, bottom - top});
    }

    void destroy_layers()
    {
        for (LayerRecord& layer : layers) {
            destroy_layer(layer);
        }
        layers.clear();
        layer_stack.clear();
        active_layer = 0;
        layer_pool.reset_resources();
    }

    void destroy_postprocess_targets()
    {
        for (RenderTargetRecord& target : postprocess_targets) {
            destroy_render_target(target);
        }
        postprocess_pool.reset_resources();
    }

    RenderBounds compute_child_layer_bounds(Rml::LayerHandle parent_handle) const
    {
        const RenderBounds* parent_ptr = nullptr;
        if (size_t(parent_handle) < layers.size()) {
            parent_ptr = &layers[size_t(parent_handle)].bounds;
        }

        const FbRect* scissor_ptr = nullptr;
        FbRect scissor_fb{};
        if (scissor_enabled) {
            const Rml::Rectanglei clipped = clamp_scissor(scissor_region, width, height);
            if (clipped.Width() > 0 && clipped.Height() > 0) {
                scissor_fb = {clipped.Left(), clipped.Top(), clipped.Width(), clipped.Height()};
                scissor_ptr = &scissor_fb;
            }
        }
        if (!scissor_ptr || transform_valid) {
            const_cast<PerfCounters&>(perf).add_unbounded_layer_fallback();
        }

        return noveltea::ui::rmlui::compute_child_layer_bounds(surface, parent_ptr, scissor_ptr,
                                                               transform_valid);
    }

    bool ensure_layer(size_t index, const RenderBounds& bounds)
    {
        if (index >= layers.size())
            layers.resize(index + 1);
        LayerRecord& layer = layers[index];
        perf.update_layer_max(uint32_t(bounds.framebuffer.w), uint32_t(bounds.framebuffer.h));
        if (bgfx::isValid(layer.framebuffer) && layer.texture_width == bounds.framebuffer.w &&
            layer.texture_height == bounds.framebuffer.h) {
            layer.bounds = bounds;
            bx::mtxOrtho(layer.projection, bounds.logical.x, bounds.logical.x + bounds.logical.w,
                         bounds.logical.y + bounds.logical.h, bounds.logical.y, -10000.0f, 10000.0f,
                         0.0f, bgfx::getCaps()->homogeneousDepth);
            return true;
        }
        destroy_layer(layer);

        constexpr uint64_t color_flags =
            BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        const uint64_t depth_flags = BGFX_TEXTURE_RT_WRITE_ONLY;
        const bgfx::TextureFormat::Enum stencil_format = depth_stencil_format();
        if (stencil_format == bgfx::TextureFormat::Unknown) {
            std::fprintf(stderr, "[rmlui] advanced renderer requires a stencil-capable render "
                                 "target; D24S8 is unavailable\n");
            return false;
        }
        bgfx::TextureHandle color =
            bgfx::createTexture2D(uint16_t(bounds.framebuffer.w), uint16_t(bounds.framebuffer.h),
                                  false, 1, bgfx::TextureFormat::RGBA8, color_flags);
        bgfx::TextureHandle depth =
            bgfx::createTexture2D(uint16_t(bounds.framebuffer.w), uint16_t(bounds.framebuffer.h),
                                  false, 1, stencil_format, depth_flags);
        if (!bgfx::isValid(color) || !bgfx::isValid(depth)) {
            if (bgfx::isValid(color))
                bgfx::destroy(color);
            if (bgfx::isValid(depth))
                bgfx::destroy(depth);
            std::fprintf(stderr, "[rmlui] failed to create layer framebuffer attachments\n");
            return false;
        }

        std::array<bgfx::TextureHandle, 2> attachments{color, depth};
        bgfx::FrameBufferHandle framebuffer =
            bgfx::createFrameBuffer(uint8_t(attachments.size()), attachments.data(), true);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(color);
            bgfx::destroy(depth);
            std::fprintf(stderr, "[rmlui] failed to create layer framebuffer\n");
            return false;
        }

        layer.framebuffer = framebuffer;
        layer.color = color;
        layer.depth_stencil = depth;
        layer.bounds = bounds;
        layer.texture_width = bounds.framebuffer.w;
        layer.texture_height = bounds.framebuffer.h;
        layer.clip_mask_enabled = false;
        layer.stencil_ref = 1;
        layer.clip_commands.clear();
        bx::mtxOrtho(layer.projection, bounds.logical.x, bounds.logical.x + bounds.logical.w,
                     bounds.logical.y + bounds.logical.h, bounds.logical.y, -10000.0f, 10000.0f,
                     0.0f, bgfx::getCaps()->homogeneousDepth);
        layer_pool.note_allocated(uint32_t(index));
        perf.add_layer_alloc(uint32_t(bounds.framebuffer.w), uint32_t(bounds.framebuffer.h));
        return true;
    }

    LayerRecord* layer_for_handle(Rml::LayerHandle handle)
    {
        if (uint32_t(handle) == LayerPoolPlan::InvalidLayer)
            return nullptr;
        if (size_t(handle) >= layers.size() || !bgfx::isValid(layers[size_t(handle)].framebuffer))
            return nullptr;
        return &layers[size_t(handle)];
    }

    LayerRecord* current_layer() { return layer_for_handle(active_layer); }

    bool begin_base_layer()
    {
        perf.reset();
        RenderBounds base_bounds;
        base_bounds.logical = {0.0f, 0.0f, float(logical_width), float(logical_height)};
        base_bounds.framebuffer = {0, 0, width, height};
        if (!ensure_layer(0, base_bounds))
            return false;
        perf.add_full_frame_layer();
        layer_pool.begin_frame();
        layer_stack.clear();
        layer_stack.push_back(0);
        active_layer = 0;
        layers[0].clip_mask_enabled = false;
        layers[0].stencil_ref = 1;
        layers[0].clip_commands.clear();
        clip_commands.clear();
        frame_failed = false;
        return true;
    }

    void fail_frame(const char* message)
    {
        if (!frame_failed && message) {
            std::fprintf(stderr, "[rmlui] %s\n", message);
        }
        frame_failed = true;
    }

    void configure_pass(const RmlUiPass& pass)
    {
        const bgfx::ViewId view = pass.view;
        bgfx::setViewName(view, pass.request.name);
        bgfx::setViewMode(view, bgfx::ViewMode::Sequential);
        bgfx::setViewRect(view, static_cast<uint16_t>(std::max(pass.request.x, 0)),
                          static_cast<uint16_t>(std::max(pass.request.y, 0)),
                          static_cast<uint16_t>(std::max(pass.request.width, 1)),
                          static_cast<uint16_t>(std::max(pass.request.height, 1)));
        bgfx::setViewFrameBuffer(view, framebuffer_from_request(pass.request));
        bgfx::setViewClear(view, BGFX_CLEAR_NONE);
    }

    std::optional<RmlUiPass> acquire_pass(RmlUiPassRequest request,
                                          bgfx::FrameBufferHandle framebuffer = BGFX_INVALID_HANDLE)
    {
        if (request.width <= 0)
            request.width = width;
        if (request.height <= 0)
            request.height = height;
        request.framebuffer = framebuffer_key(framebuffer);
        request.bgfx_framebuffer_idx =
            bgfx::isValid(framebuffer) ? framebuffer.idx : std::numeric_limits<uint16_t>::max();
        auto pass = pass_scheduler.acquire(request);
        if (pass) {
            configure_pass(*pass);
            perf.add_pass();
        }
        return pass;
    }

    void submit(const GeometryRecord& geometry, Rml::Vector2f translation,
                Rml::TextureHandle texture)
    {
        if (frame_failed || !bgfx::isValid(program) || geometry.index_count == 0 ||
            pass_scheduler.exhausted()) {
            return;
        }
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        const int lw = layer->texture_width;
        const int lh = layer->texture_height;
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Geometry, 0, 0, false, false, lw,
                                                   lh, "RmlUi.Geometry"),
                                 layer->framebuffer);
        if (!pass)
            return;
        perf.add_geometry(uint64_t(lw) * uint64_t(lh), geometry.index_count);
        // Bgfx invariant: once per-draw state (setUniform/setTexture/setVertexBuffer) is
        // written, the path must submit or discard before returning. Validate scissor first.
        if (scissor_enabled) {
            const Rml::Rectanglei scissor =
                clamp_scissor_local(scissor_region, layer->bounds.framebuffer);
            if (scissor.Width() <= 0 || scissor.Height() <= 0) {
                return;
            }
            bgfx::setScissor(uint16_t(scissor.Left()), uint16_t(scissor.Top()),
                             uint16_t(scissor.Width()), uint16_t(scissor.Height()));
        }
        bgfx::setVertexBuffer(0, geometry.vb);
        bgfx::setIndexBuffer(geometry.ib, 0, geometry.index_count);
        bgfx::setUniform(projection_uniform, layer->projection);
        bgfx::setUniform(transform_uniform, transform_valid ? transform : identity);
        const float translate[4] = {translation.x, translation.y, 0.0f, 0.0f};
        bgfx::setUniform(translate_uniform, translate);
        bgfx::TextureHandle bgfx_texture = white_texture;
        if (auto it = textures.find(texture); it != textures.end()) {
            bgfx_texture = it->second.handle;
        }
        bgfx::setTexture(0, sampler, bgfx_texture);
        bgfx::setState(kRmlBlendState);
        if (layer->clip_mask_enabled) {
            bgfx::setStencil(stencil_test_state());
        }
        bgfx::submit(pass->view, program);
    }

    bool ensure_fullscreen_geometry()
    {
        if (bgfx::isValid(fullscreen_vb))
            return true;
        const bool origin_bottom_left = bgfx::getCaps() && bgfx::getCaps()->originBottomLeft;
        const auto vertices = fullscreen_triangle(origin_bottom_left);
        fullscreen_vb = bgfx::createVertexBuffer(
            bgfx::copy(vertices.data(), uint32_t(vertices.size() * sizeof(FullscreenVertex))),
            fullscreen_layout);
        return bgfx::isValid(fullscreen_vb);
    }

    // Returns true on success.  Returns false if the source texture is attached to the
    // destination framebuffer (WebGL feedback loop) or other validation fails.
    bool composite(const CompositeOp& op)
    {
        if (frame_failed || !ensure_fullscreen_geometry() || !bgfx::isValid(composite_program) ||
            !bgfx::isValid(op.source))
            return false;

        // WebGL forbids sampling from a texture while rendering into a framebuffer whose
        // color attachment is that same texture (GL_INVALID_OPERATION feedback loop).
        if (bgfx::isValid(op.destination) &&
            texture_attached_to_framebuffer(op.source, op.destination)) {
            fail_frame("composite feedback loop");
            return false;
        }

        const FbRect destination_rect =
            is_empty(op.destination_rect) ? FbRect{0, 0, width, height} : op.destination_rect;
        const FbRect source_rect = op.source_rect;
        const bool is_full_frame = (destination_rect.x == 0 && destination_rect.y == 0 &&
                                    destination_rect.w >= width && destination_rect.h >= height);
        auto pass =
            acquire_pass(make_pass_request(op.kind, destination_rect.x, destination_rect.y, false,
                                           false, destination_rect.w, destination_rect.h, op.name),
                         op.destination);
        if (!pass)
            return false;
        perf.add_composite(area(destination_rect), is_full_frame);

        // Bgfx invariant: once per-draw state is written, the path must submit or discard.
        if (op.scissor.enabled) {
            const Rml::Rectanglei scissor =
                clamp_scissor(op.scissor.region, destination_rect.w, destination_rect.h);
            if (scissor.Width() <= 0 || scissor.Height() <= 0)
                return false;
            bgfx::setScissor(uint16_t(scissor.Left()), uint16_t(scissor.Top()),
                             uint16_t(scissor.Width()), uint16_t(scissor.Height()));
        }
        bgfx::setVertexBuffer(0, fullscreen_vb);
        bgfx::setTexture(0, sampler, op.source);
        const float* uv_bounds = nullptr;
        std::array<float, 4> bounds{};
        if (op.source_texture_width > 0 && op.source_texture_height > 0 && !is_empty(source_rect)) {
            bounds = uv_rect_for_source_region(source_rect, op.source_texture_width,
                                               op.source_texture_height);
            uv_bounds = bounds.data();
        } else {
            bounds = {0.0f, 0.0f, 1.0f, 1.0f};
            uv_bounds = bounds.data();
        }
        bgfx::setUniform(texcoord_bounds_uniform, uv_bounds);
        const uint64_t state = op.blend_mode == Rml::BlendMode::Replace
                                   ? (BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A)
                                   : kRmlBlendState;
        bgfx::setState(state);
        if (op.apply_destination_stencil) {
            bgfx::setStencil(stencil_test_state_for_ref(op.stencil_ref));
        }
        bgfx::submit(pass->view, composite_program);
        return true;
    }

    bool copy_region_to_framebuffer(bgfx::TextureHandle source, bgfx::FrameBufferHandle destination,
                                    const Rml::Rectanglei& region, int source_width,
                                    int source_height, const char* name)
    {
        if (!ensure_fullscreen_geometry() || !bgfx::isValid(copy_program) ||
            !bgfx::isValid(source) || !bgfx::isValid(destination))
            return false;
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Copy, 0, 0, false, false,
                                                   region.Width(), region.Height(), name),
                                 destination);
        if (!pass)
            return false;
        perf.add_copy();
        perf.add_copy_pixels(uint64_t(region.Width()) * uint64_t(region.Height()));
        const float bounds[4] = {
            float(region.Left()) / float(std::max(source_width, 1)),
            float(region.Top()) / float(std::max(source_height, 1)),
            float(region.Right()) / float(std::max(source_width, 1)),
            float(region.Bottom()) / float(std::max(source_height, 1)),
        };
        bgfx::setVertexBuffer(0, fullscreen_vb);
        bgfx::setTexture(0, sampler, source);
        bgfx::setUniform(texcoord_bounds_uniform, bounds);
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
        bgfx::submit(pass->view, copy_program);
        return true;
    }

    bgfx::TextureHandle copy_region_to_texture(bgfx::TextureHandle source,
                                               const Rml::Rectanglei& region, int source_width,
                                               int source_height, const char* name)
    {
        if (region.Width() <= 0 || region.Height() <= 0 || !bgfx::isValid(source))
            return BGFX_INVALID_HANDLE;
        const bool can_blit =
            bgfx::getCaps() && (bgfx::getCaps()->supported & BGFX_CAPS_TEXTURE_BLIT) != 0;
        const uint64_t flags = (can_blit ? BGFX_TEXTURE_BLIT_DST : BGFX_TEXTURE_RT) |
                               BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        bgfx::TextureHandle texture =
            bgfx::createTexture2D(uint16_t(region.Width()), uint16_t(region.Height()), false, 1,
                                  bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(texture))
            return BGFX_INVALID_HANDLE;

        if (can_blit) {
            auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Copy, 0, 0, false, false,
                                                       region.Width(), region.Height(), name));
            if (!pass) {
                bgfx::destroy(texture);
                return BGFX_INVALID_HANDLE;
            }
            perf.add_copy();
            perf.add_copy_pixels(uint64_t(region.Width()) * uint64_t(region.Height()));
            bgfx::blit(pass->view, texture, 0, 0, source, uint16_t(region.Left()),
                       uint16_t(region.Top()), uint16_t(region.Width()), uint16_t(region.Height()));
            return texture;
        }

        bgfx::FrameBufferHandle framebuffer = bgfx::createFrameBuffer(1, &texture, false);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(texture);
            return BGFX_INVALID_HANDLE;
        }
        const bool copied = copy_region_to_framebuffer(source, framebuffer, region, source_width,
                                                       source_height, name);
        bgfx::destroy(framebuffer);
        if (!copied) {
            bgfx::destroy(texture);
            return BGFX_INVALID_HANDLE;
        }
        return texture;
    }

    // Bgfx invariant: per-draw state must lead to submit or discard.
    // Callers provide a callback that sets per-pass uniforms after pass acquisition
    // succeeds but before submit, so that a failed pass acquisition cannot leave
    // pending per-draw state.
    template<typename F>
    bool fullscreen_filter_pass(bgfx::TextureHandle source, const RenderTargetRecord& destination,
                                bgfx::ProgramHandle filter_program, const char* name,
                                F&& bind_uniforms)
    {
        if (frame_failed || !ensure_fullscreen_geometry() || !bgfx::isValid(source) ||
            !bgfx::isValid(destination.framebuffer) || !bgfx::isValid(filter_program))
            return false;
        // WebGL feedback check: the filter pipeline uses ping-pong between primary
        // and secondary targets, so the source texture should never be the color
        // attachment of the destination framebuffer under normal operation.
        if (texture_attached_to_framebuffer(source, destination.framebuffer)) {
            fail_frame("fullscreen_filter_pass feedback loop");
            return false;
        }
        const int pass_w = destination.texture_width;
        const int pass_h = destination.texture_height;
        const bool is_full = is_full_frame_rect(destination.bounds, width, height);
        auto pass = acquire_pass(
            make_pass_request(RmlUiPassKind::Postprocess, 0, 0, false, false, pass_w, pass_h, name),
            destination.framebuffer);
        if (!pass)
            return false;
        perf.add_postprocess(uint64_t(pass_w) * uint64_t(pass_h), is_full);
        bgfx::setVertexBuffer(0, fullscreen_vb);
        bgfx::setTexture(0, sampler, source);
        bind_uniforms();
        bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
        bgfx::submit(pass->view, filter_program);
        return true;
    }

    FilterApplyResult apply_filters(bgfx::TextureHandle source, const RenderBounds& source_bounds,
                                    Rml::Span<const Rml::CompiledFilterHandle> filter_handles)
    {
        FilterApplyResult result;
        result.texture = source;
        if (filter_handles.empty())
            return result;
        std::vector<FilterRecord> filter_chain;
        filter_chain.reserve(filter_handles.size());
        for (Rml::CompiledFilterHandle handle : filter_handles) {
            auto it = filters.find(handle);
            if (it == filters.end())
                return {};
            filter_chain.push_back(it->second);
        }
        filter_chain = simplify_filter_chain(filter_chain);
        if (filter_chain.empty())
            return result;
        FilterExpansion total_expansion{};
        for (const FilterRecord& filter : filter_chain) {
            switch (filter.kind) {
            case FilterKind::Blur:
                total_expansion = add_expansions(total_expansion, blur_expansion(filter.sigma));
                break;
            case FilterKind::DropShadow:
                total_expansion = add_expansions(
                    total_expansion,
                    drop_shadow_expansion(filter.sigma, filter.offset[0], filter.offset[1]));
                break;
            case FilterKind::MaskImage:
            case FilterKind::Opacity:
            case FilterKind::ColorMatrix:
            case FilterKind::Invalid:
                break;
            }
        }
        const FbRect expanded = expand_bounds(source_bounds.framebuffer, total_expansion);
        const FbRect clamped_work_bounds =
            clamp_to_surface(align_outward_for_render_target(expanded), surface);
        if (is_empty(clamped_work_bounds))
            return {};
        RenderTargetRecord* primary =
            ensure_postprocess_target(PostprocessTargetKind::Primary, clamped_work_bounds);
        RenderTargetRecord* secondary =
            ensure_postprocess_target(PostprocessTargetKind::Secondary, clamped_work_bounds);
        if (!primary || !secondary)
            return {};

        const FbRect source_rect = intersect(source_bounds.framebuffer, clamped_work_bounds);
        if (is_empty(source_rect))
            return {};
        const FbRect copy_destination{std::max(0, total_expansion.left),
                                      std::max(0, total_expansion.top), source_rect.w,
                                      source_rect.h};
        if (!composite(make_composite_op(source, primary->framebuffer, Rml::BlendMode::Replace,
                                         ScissorState{false, {}}, false, 1, RmlUiPassKind::Copy,
                                         "RmlUi.FilterCopy", source_rect, copy_destination,
                                         source_bounds.framebuffer.w, source_bounds.framebuffer.h)))
            return {};

        bgfx::TextureHandle current = primary->color;
        RenderTargetRecord* destination = secondary;
        FbRect current_valid_rect = copy_destination;
        for (const FilterRecord& filter : filter_chain) {
            bool ok = false;
            switch (filter.kind) {
            case FilterKind::Opacity: {
                const float opacity[4] = {filter.scalar, 0.0f, 0.0f, 0.0f};
                ok = fullscreen_filter_pass(current, *destination, opacity_program,
                                            "RmlUi.FilterOpacity",
                                            [&]() { bgfx::setUniform(opacity_uniform, opacity); });
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                break;
            }
            case FilterKind::ColorMatrix:
                ok = fullscreen_filter_pass(
                    current, *destination, color_matrix_program, "RmlUi.FilterColorMatrix",
                    [&]() { bgfx::setUniform(color_matrix_uniform, filter.matrix.data()); });
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                break;
            case FilterKind::MaskImage: {
                auto tex_it = textures.find(Rml::TextureHandle(filter.resource));
                if (tex_it == textures.end())
                    return {};
                if (!ensure_fullscreen_geometry() || !bgfx::isValid(mask_multiply_program))
                    return {};
                const bool is_full_mask = is_full_frame_rect(destination->bounds, width, height);
                auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Postprocess, 0, 0, false,
                                                           false, destination->texture_width,
                                                           destination->texture_height,
                                                           "RmlUi.FilterMaskImage"),
                                         destination->framebuffer);
                if (!pass)
                    return {};
                perf.add_mask(uint64_t(destination->texture_width) *
                                  uint64_t(destination->texture_height),
                              is_full_mask);
                bgfx::setVertexBuffer(0, fullscreen_vb);
                bgfx::setTexture(0, sampler, current);
                bgfx::setTexture(1, mask_sampler, tex_it->second.handle);
                if (texture_attached_to_framebuffer(tex_it->second.handle,
                                                    destination->framebuffer)) {
                    fail_frame("mask-image filter feedback loop");
                    return {};
                }
                const FbRect mask_bounds{filter.mask_bounds[0], filter.mask_bounds[1],
                                         filter.mask_bounds[2], filter.mask_bounds[3]};
                auto mask_transform = compute_mask_uv_transform(destination->bounds, mask_bounds);
                if (bgfx::getCaps() && bgfx::getCaps()->originBottomLeft) {
                    // The pure transform is expressed in top-left framebuffer coordinates.
                    // bgfx's fullscreen UVs are texture-origin adjusted, so OpenGL-style
                    // backends need the Y axis flipped at the shader boundary.
                    mask_transform[1] = -mask_transform[1];
                    mask_transform[3] +=
                        float(destination->bounds.h) / float(std::max(mask_bounds.h, 1));
                }
                bgfx::setUniform(mask_texcoord_transform_uniform, mask_transform.data());
                bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
                bgfx::submit(pass->view, mask_multiply_program);
                ok = true;
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                break;
            }
            case FilterKind::Blur: {
                const GaussianKernel kernel = gaussian_kernel(filter.sigma);
                const float w0 = kernel.weights.empty() ? 1.0f : kernel.weights[0];
                const float w1 = kernel.weights.size() > 1 ? kernel.weights[1] : 0.0f;
                const float w2 = kernel.weights.size() > 2 ? kernel.weights[2] : 0.0f;
                const float w3 = kernel.weights.size() > 3 ? kernel.weights[3] : 0.0f;
                const float renorm = std::max(w0 + 2.0f * (w1 + w2 + w3), 0.000001f);
                const float weights[4] = {w0 / renorm, w1 / renorm, w2 / renorm, w3 / renorm};
                const auto bounds = uv_rect_for_source_region(
                    current_valid_rect, primary->texture_width, primary->texture_height);
                float params[4] = {0.0f, 1.0f / float(std::max(destination->texture_height, 1)),
                                   0.0f, 0.0f};
                if (!fullscreen_filter_pass(
                        current, *destination, blur_program, "RmlUi.FilterBlurV", [&]() {
                            bgfx::setUniform(blur_params_uniform, params);
                            bgfx::setUniform(blur_weights_uniform, weights);
                            bgfx::setUniform(texcoord_bounds_uniform, bounds.data());
                        }))
                    return {};
                perf.add_blur();
                current = destination->color;
                destination = (destination == primary) ? secondary : primary;
                params[0] = 1.0f / float(std::max(destination->texture_width, 1));
                params[1] = 0.0f;
                if (!fullscreen_filter_pass(
                        current, *destination, blur_program, "RmlUi.FilterBlurH", [&]() {
                            bgfx::setUniform(blur_params_uniform, params);
                            bgfx::setUniform(blur_weights_uniform, weights);
                            bgfx::setUniform(texcoord_bounds_uniform, bounds.data());
                        }))
                    return {};
                perf.add_blur();
                ok = true;
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                break;
            }
            case FilterKind::DropShadow: {
                const bgfx::TextureHandle original = current;
                const float color[4] = {filter.color[0], filter.color[1], filter.color[2],
                                        filter.color[3]};
                const float offset[4] = {
                    filter.offset[0] / float(std::max(destination->texture_width, 1)),
                    filter.offset[1] / float(std::max(destination->texture_height, 1)), 0.0f, 0.0f};
                if (!fullscreen_filter_pass(current, *destination, drop_shadow_program,
                                            "RmlUi.FilterDropShadowExtract", [&]() {
                                                bgfx::setUniform(shadow_color_uniform, color);
                                                bgfx::setUniform(shadow_offset_uniform, offset);
                                            })) {
                    return {};
                }
                perf.add_dropshadow();
                current = destination->color;
                destination = (destination == primary) ? secondary : primary;
                if (filter.sigma >= 0.5f) {
                    const GaussianKernel kernel = gaussian_kernel(filter.sigma);
                    const float w0 = kernel.weights.empty() ? 1.0f : kernel.weights[0];
                    const float w1 = kernel.weights.size() > 1 ? kernel.weights[1] : 0.0f;
                    const float w2 = kernel.weights.size() > 2 ? kernel.weights[2] : 0.0f;
                    const float w3 = kernel.weights.size() > 3 ? kernel.weights[3] : 0.0f;
                    const float renorm = std::max(w0 + 2.0f * (w1 + w2 + w3), 0.000001f);
                    const float weights[4] = {w0 / renorm, w1 / renorm, w2 / renorm, w3 / renorm};
                    const auto bounds = uv_rect_for_source_region(
                        current_valid_rect, primary->texture_width, primary->texture_height);
                    float params[4] = {0.0f, 1.0f / float(std::max(destination->texture_height, 1)),
                                       0.0f, 0.0f};
                    if (!fullscreen_filter_pass(current, *destination, blur_program,
                                                "RmlUi.FilterDropShadowBlurV", [&]() {
                                                    bgfx::setUniform(blur_params_uniform, params);
                                                    bgfx::setUniform(blur_weights_uniform, weights);
                                                    bgfx::setUniform(texcoord_bounds_uniform,
                                                                     bounds.data());
                                                })) {
                        return {};
                    }
                    perf.add_blur();
                    current = destination->color;
                    destination = (destination == primary) ? secondary : primary;
                    params[0] = 1.0f / float(std::max(destination->texture_width, 1));
                    params[1] = 0.0f;
                    if (!fullscreen_filter_pass(current, *destination, blur_program,
                        "RmlUi.FilterDropShadowBlurH", [&]() {
                                                    bgfx::setUniform(blur_params_uniform, params);
                                                    bgfx::setUniform(blur_weights_uniform, weights);
                                                    bgfx::setUniform(texcoord_bounds_uniform,
                                                                     bounds.data());
                                                })) {
                        return {};
                    }
                    perf.add_blur();
                    current = destination->color;
                    destination = (destination == primary) ? secondary : primary;
                }
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                // Use safe_destination to avoid WebGL feedback loop: the composite reads
                // `original` texture, so destination framebuffer must not own it.
                destination = safe_destination(original, destination,
                                               (destination == primary) ? secondary : primary);
                if (!composite(make_composite_op(
                        original, destination->framebuffer, Rml::BlendMode::Blend,
                        ScissorState{false, {}}, false, 1, RmlUiPassKind::Postprocess,
                        "RmlUi.FilterDropShadowComposite",
                        FbRect{0, 0, destination->texture_width, destination->texture_height},
                        FbRect{0, 0, destination->texture_width, destination->texture_height},
                        destination->texture_width, destination->texture_height))) {
                    return {};
                }
                ok = true;
                current_valid_rect = {0, 0, destination->texture_width,
                                      destination->texture_height};
                break;
            }
            case FilterKind::Invalid:
                return {};
            }
            if (!ok)
                return {};
            current = destination->color;
            destination = (destination == primary) ? secondary : primary;
        }
        result.texture = current;
        result.output_bounds.logical = source_bounds.logical;
        result.output_bounds.framebuffer = clamped_work_bounds;
        result.valid_rect_in_texture = {0, 0, clamped_work_bounds.w, clamped_work_bounds.h};
        result.texture_width = clamped_work_bounds.w;
        result.texture_height = clamped_work_bounds.h;
        return result;
    }

    RenderTargetRecord* ensure_postprocess_target(PostprocessTargetKind kind, const FbRect& bounds)
    {
        const size_t index = size_t(kind);
        if (index >= postprocess_targets.size())
            return nullptr;
        const FbRect clamped_bounds =
            clamp_to_surface(align_outward_for_render_target(bounds), surface);
        if (is_empty(clamped_bounds))
            return nullptr;
        const int work_w = clamped_bounds.w;
        const int work_h = clamped_bounds.h;
        RenderTargetRecord& target = postprocess_targets[index];
        perf.update_pp_max(uint32_t(work_w), uint32_t(work_h));
        if (bgfx::isValid(target.framebuffer) && target.texture_width == work_w &&
            target.texture_height == work_h) {
            target.bounds = clamped_bounds;
            target.kind = kind;
            return &target;
        }
        destroy_render_target(target);

        uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        if (bgfx::getCaps() && (bgfx::getCaps()->supported & BGFX_CAPS_TEXTURE_BLIT) != 0) {
            flags |= BGFX_TEXTURE_BLIT_DST;
        }
        bgfx::TextureHandle color = bgfx::createTexture2D(uint16_t(work_w), uint16_t(work_h), false,
                                                          1, bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(color)) {
            std::fprintf(stderr, "[rmlui] failed to create postprocess target texture\n");
            return nullptr;
        }
        bgfx::FrameBufferHandle framebuffer = bgfx::createFrameBuffer(1, &color, true);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(color);
            std::fprintf(stderr, "[rmlui] failed to create postprocess framebuffer\n");
            return nullptr;
        }
        target = {framebuffer, color, clamped_bounds, work_w, work_h, kind};
        postprocess_pool.mark_allocated(kind);
        perf.add_pp_alloc(uint32_t(work_w), uint32_t(work_h));
        if (is_full_frame_rect(clamped_bounds, width, height)) {
            perf.add_full_frame_pp_target();
        } else {
            perf.add_bounded_pp_target();
        }
        return &target;
    }

    static uint32_t stencil_test_state_for_ref(uint8_t ref)
    {
        return BGFX_STENCIL_TEST_EQUAL | BGFX_STENCIL_FUNC_REF(uint32_t(ref)) |
               BGFX_STENCIL_FUNC_RMASK(0xff) | BGFX_STENCIL_OP_FAIL_S_KEEP |
               BGFX_STENCIL_OP_FAIL_Z_KEEP | BGFX_STENCIL_OP_PASS_Z_KEEP;
    }

    uint32_t stencil_test_state() const
    {
        const uint8_t ref =
            active_layer < layers.size() ? layers[size_t(active_layer)].stencil_ref : uint8_t(1);
        return stencil_test_state_for_ref(ref);
    }

    uint32_t stencil_replace_state(int value) const
    {
        return BGFX_STENCIL_TEST_ALWAYS | BGFX_STENCIL_FUNC_REF(uint32_t(value)) |
               BGFX_STENCIL_FUNC_RMASK(0xff) | BGFX_STENCIL_OP_FAIL_S_KEEP |
               BGFX_STENCIL_OP_FAIL_Z_KEEP | BGFX_STENCIL_OP_PASS_Z_REPLACE;
    }

    void clear_active_stencil(uint8_t value, const ScissorState& scissor)
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        const FbRect clear_bounds = clip_work_bounds(layer, scissor);
        if (is_empty(clear_bounds))
            return;
        const bool is_full = is_full_frame_rect(clear_bounds, width, height);
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Clear, 0, 0, false, true,
                                                   clear_bounds.w, clear_bounds.h,
                                                   "RmlUi.StencilClear"),
                                 layer->framebuffer);
        if (!pass)
            return;
        perf.add_clear(uint64_t(clear_bounds.w) * uint64_t(clear_bounds.h), is_full);
        bgfx::setViewRect(pass->view, uint16_t(clear_bounds.x), uint16_t(clear_bounds.y),
                          uint16_t(clear_bounds.w), uint16_t(clear_bounds.h));
        bgfx::setViewClear(pass->view, BGFX_CLEAR_STENCIL, 0x00000000u, 1.0f, value);
        bgfx::touch(pass->view);
    }

    uint32_t stencil_intersect_state(uint8_t previous_ref) const
    {
        return BGFX_STENCIL_TEST_EQUAL | BGFX_STENCIL_FUNC_REF(uint32_t(previous_ref)) |
               BGFX_STENCIL_FUNC_RMASK(0xff) | BGFX_STENCIL_OP_FAIL_S_KEEP |
               BGFX_STENCIL_OP_FAIL_Z_KEEP | BGFX_STENCIL_OP_PASS_Z_INCR;
    }

    uint32_t stencil_decrement_state(uint8_t ref) const
    {
        return BGFX_STENCIL_TEST_EQUAL | BGFX_STENCIL_FUNC_REF(uint32_t(ref)) |
               BGFX_STENCIL_FUNC_RMASK(0xff) | BGFX_STENCIL_OP_FAIL_S_KEEP |
               BGFX_STENCIL_OP_FAIL_Z_KEEP | BGFX_STENCIL_OP_PASS_Z_DECR;
    }

    bool decrement_stencil_ref(uint8_t ref)
    {
        if (ref <= 1)
            return true;
        if (frame_failed || !ensure_fullscreen_geometry() || !bgfx::isValid(composite_program) ||
            !bgfx::isValid(white_texture))
            return false;
        LayerRecord* layer = current_layer();
        if (!layer)
            return false;
        const FbRect work_bounds = clip_work_bounds(layer, ScissorState{scissor_enabled, scissor_region});
        if (is_empty(work_bounds))
            return true;
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Geometry, 0, 0, false, false,
                                                   work_bounds.w, work_bounds.h,
                                                   "RmlUi.StencilNormalize"),
                                 layer->framebuffer);
        if (!pass)
            return false;

        bgfx::setVertexBuffer(0, fullscreen_vb);
        bgfx::setTexture(0, sampler, white_texture);
        const float bounds[4] = {0.0f, 0.0f, 1.0f, 1.0f};
        bgfx::setUniform(texcoord_bounds_uniform, bounds);
        bgfx::setState(BGFX_STATE_NONE);
        bgfx::setStencil(stencil_decrement_state(ref));
        bgfx::submit(pass->view, composite_program);
        return true;
    }

    bool normalize_active_stencil_to_one()
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return false;
        for (uint8_t ref = layer->stencil_ref; ref > 1; --ref) {
            if (!decrement_stencil_ref(ref))
                return false;
        }
        layer->stencil_ref = 1;
        return true;
    }

    void submit_to_clip_mask(const GeometryRecord& geometry, Rml::Vector2f translation,
                             uint32_t stencil_state, const ScissorState& scissor,
                             bool command_transform_valid,
                             const std::array<float, 16>& command_transform)
    {
        if (frame_failed || !bgfx::isValid(program) || geometry.index_count == 0 ||
            pass_scheduler.exhausted())
            return;
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        const FbRect work_bounds = clip_work_bounds(layer, scissor);
        if (is_empty(work_bounds))
            return;
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Geometry, 0, 0, false, false,
                                                   work_bounds.w, work_bounds.h,
                                                   "RmlUi.ClipMask"),
                                 layer->framebuffer);
        if (!pass)
            return;
        perf.add_clip_mask(uint64_t(work_bounds.w) * uint64_t(work_bounds.h));

        // Bgfx invariant: once per-draw state is written, the path must submit or discard.
        if (scissor.enabled) {
            const Rml::Rectanglei clipped =
                clamp_scissor_local(scissor.region, layer->bounds.framebuffer);
            if (clipped.Width() <= 0 || clipped.Height() <= 0)
                return;
            bgfx::setScissor(uint16_t(clipped.Left()), uint16_t(clipped.Top()),
                             uint16_t(clipped.Width()), uint16_t(clipped.Height()));
        }
        bgfx::setVertexBuffer(0, geometry.vb);
        bgfx::setIndexBuffer(geometry.ib, 0, geometry.index_count);
        bgfx::setUniform(projection_uniform, layer->projection);
        bgfx::setUniform(transform_uniform,
                         command_transform_valid ? command_transform.data() : identity);
        const float translate[4] = {translation.x, translation.y, 0.0f, 0.0f};
        bgfx::setUniform(translate_uniform, translate);
        bgfx::setTexture(0, sampler, white_texture);
        bgfx::setState(BGFX_STATE_NONE);
        bgfx::setStencil(stencil_state);
        bgfx::submit(pass->view, program);
    }

    void apply_clip_command(const ClipCommand& command, bool record_on_layer)
    {
        auto it = geometries.find(command.geometry);
        if (it == geometries.end())
            return;
        switch (command.operation) {
        case Rml::ClipMaskOperation::Set:
            clear_active_stencil(0, command.scissor);
            submit_to_clip_mask(it->second, command.translation, stencil_replace_state(1),
                                command.scissor, command.transform_valid, command.transform);
            break;
        case Rml::ClipMaskOperation::SetInverse:
            clear_active_stencil(1, command.scissor);
            submit_to_clip_mask(it->second, command.translation, stencil_replace_state(0),
                                command.scissor, command.transform_valid, command.transform);
            break;
        case Rml::ClipMaskOperation::Intersect:
            if (LayerRecord* layer = current_layer();
                layer && layer->stencil_ref == 254 && command.previous_ref == 1) {
                if (!normalize_active_stencil_to_one()) {
                    fail_frame(
                        "failed to normalize stencil clip mask before overflow intersection");
                    return;
                }
            }
            submit_to_clip_mask(it->second, command.translation,
                                stencil_intersect_state(command.previous_ref), command.scissor,
                                command.transform_valid, command.transform);
            break;
        }
        if (LayerRecord* layer = current_layer()) {
            layer->stencil_ref = command.next_ref;
            if (record_on_layer) {
                const FbRect command_bounds = command.scissor.enabled
                                                  ? active_scissor_bounds(command.scissor,
                                                                          layer->bounds.framebuffer)
                                                  : layer->bounds.framebuffer;
                if (!is_empty(command_bounds)) {
                    layer->clip_commands.push_back(clip_commands.size());
                    clip_commands.push_back(command);
                }
            }
        }
    }

    void replay_clip_commands(Rml::LayerHandle layer_handle, const std::vector<size_t>& commands)
    {
        const Rml::LayerHandle saved_active = active_layer;
        const bool saved_scissor_enabled = scissor_enabled;
        const Rml::Rectanglei saved_scissor_region = scissor_region;
        active_layer = layer_handle;
        LayerRecord* layer = current_layer();
        for (size_t index : commands) {
            if (index < clip_commands.size()) {
                const ClipCommand& command = clip_commands[index];
                if (!layer)
                    continue;
                const FbRect command_bounds = command.scissor.enabled
                                                  ? active_scissor_bounds(command.scissor,
                                                                          layer->bounds.framebuffer)
                                                  : layer->bounds.framebuffer;
                if (is_empty(command_bounds))
                    continue;
                apply_clip_command(command, false);
            }
        }
        active_layer = saved_active;
        scissor_enabled = saved_scissor_enabled;
        scissor_region = saved_scissor_region;
    }

    void submit_gradient(const ShaderRecord& shader, const GeometryRecord& geometry,
                         Rml::Vector2f translation)
    {
        if (frame_failed || !bgfx::isValid(gradient_program) || geometry.index_count == 0 ||
            pass_scheduler.exhausted())
            return;
        LayerRecord* layer = current_layer();
        if (!layer || shader.gradient.kind == GradientKind::Invalid ||
            shader.gradient.stop_count == 0)
            return;
        const int lw = layer->texture_width;
        const int lh = layer->texture_height;
        auto pass = acquire_pass(make_pass_request(RmlUiPassKind::Geometry, 0, 0, false, false, lw,
                                                   lh, "RmlUi.Gradient"),
                                 layer->framebuffer);
        if (!pass)
            return;
        perf.add_gradient();

        std::array<float, 8> gradient_params{
            gradient_kind_code(shader.gradient.kind),
            float(shader.gradient.stop_count),
            shader.gradient.p_v[0],
            shader.gradient.p_v[1],
            shader.gradient.p_v[2],
            shader.gradient.p_v[3],
            0.0f,
            0.0f,
        };
        std::array<std::array<float, 4>, kGradientStopLimit> stop_colors{};
        std::array<std::array<float, 4>, 4> stop_positions{};
        for (uint32_t i = 0; i < shader.gradient.stop_count; ++i) {
            stop_colors[i] = shader.gradient.stops[i].color;
            stop_positions[i / 4][i % 4] = shader.gradient.stops[i].position;
        }

        // Bgfx invariant: once per-draw state is written, the path must submit or discard.
        if (scissor_enabled) {
            const Rml::Rectanglei scissor =
                clamp_scissor_local(scissor_region, layer->bounds.framebuffer);
            if (scissor.Width() <= 0 || scissor.Height() <= 0)
                return;
            bgfx::setScissor(uint16_t(scissor.Left()), uint16_t(scissor.Top()),
                             uint16_t(scissor.Width()), uint16_t(scissor.Height()));
        }
        bgfx::setVertexBuffer(0, geometry.vb);
        bgfx::setIndexBuffer(geometry.ib, 0, geometry.index_count);
        bgfx::setUniform(projection_uniform, layer->projection);
        bgfx::setUniform(transform_uniform, transform_valid ? transform : identity);
        const float translate[4] = {translation.x, translation.y, 0.0f, 0.0f};
        bgfx::setUniform(translate_uniform, translate);
        bgfx::setUniform(gradient_params_uniform, gradient_params.data(), 2);
        bgfx::setUniform(gradient_stops_uniform, stop_colors.data(), kGradientStopLimit);
        bgfx::setUniform(gradient_stop_meta_uniform, stop_positions.data(), 4);
        bgfx::setState(kRmlBlendState);
        if (layer->clip_mask_enabled) {
            bgfx::setStencil(stencil_test_state());
        }
        bgfx::submit(pass->view, gradient_program);
    }

    const assets::AssetManager& assets;
    bgfx::VertexLayout layout;
    bgfx::VertexLayout fullscreen_layout;
    bgfx::ProgramHandle program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle composite_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle copy_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle opacity_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle color_matrix_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle mask_multiply_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle blur_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle drop_shadow_program = BGFX_INVALID_HANDLE;
    bgfx::ProgramHandle gradient_program = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle white_texture = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle sampler = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle mask_sampler = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle projection_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle transform_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle translate_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle color_matrix_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle opacity_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle gradient_params_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle gradient_stops_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle gradient_stop_meta_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle blur_params_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle blur_weights_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle texcoord_bounds_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle mask_texcoord_transform_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle shadow_color_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle shadow_offset_uniform = BGFX_INVALID_HANDLE;
    std::unordered_map<Rml::CompiledGeometryHandle, GeometryRecord> geometries;
    std::unordered_map<Rml::TextureHandle, TextureRecord> textures;
    std::unordered_map<Rml::CompiledFilterHandle, FilterRecord> filters;
    std::unordered_map<Rml::CompiledShaderHandle, ShaderRecord> shaders;
    std::vector<LayerRecord> layers;
    std::vector<ClipCommand> clip_commands;
    std::array<RenderTargetRecord, PostprocessPoolPlan::TargetCount> postprocess_targets{};
    std::vector<Rml::LayerHandle> layer_stack;
    LayerPoolPlan layer_pool;
    PostprocessPoolPlan postprocess_pool;
    Rml::CompiledGeometryHandle geometry_counter = 0;
    bgfx::VertexBufferHandle fullscreen_vb = BGFX_INVALID_HANDLE;
    Rml::TextureHandle texture_counter = 0;
    Rml::CompiledFilterHandle filter_counter = 0;
    Rml::CompiledShaderHandle shader_counter = 0;
    Rml::LayerHandle active_layer = 0;
    RmlUiRenderPassScheduler pass_scheduler{bgfx_backend::ViewRuntimeUIBegin,
                                            bgfx_backend::ViewRuntimeUIEnd};
    int width = 1;
    int height = 1;
    int logical_width = 1;
    int logical_height = 1;
    SurfaceMetrics surface{};
    float projection[16]{};
    float identity[16]{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    float transform[16]{};
    bool transform_valid = false;
    bool scissor_enabled = false;
    Rml::Rectanglei scissor_region = Rml::Rectanglei::FromPositionSize({0, 0}, {0, 0});
    bool frame_failed = false;

    // Cached stencil format (probed once to avoid getInternalformatParameter spam).
    mutable bool stencil_cached = false;
    mutable bgfx::TextureFormat::Enum cached_stencil_format = bgfx::TextureFormat::Unknown;

    PerfCounters perf;
#ifdef NOVELTEA_ENABLE_RENDER_PERF
    bool perf_logging_enabled = false;
#endif

    // Check whether a texture is the color attachment of a framebuffer we own.
    // WebGL forbids sampling a texture while rendering into a framebuffer whose
    // color attachment is that same texture (GL_INVALID_OPERATION feedback loop).
    bool texture_attached_to_framebuffer(bgfx::TextureHandle texture,
                                         bgfx::FrameBufferHandle framebuffer) const
    {
        for (const RenderTargetRecord& target : postprocess_targets) {
            if (bgfx::isValid(target.framebuffer) && target.framebuffer.idx == framebuffer.idx &&
                bgfx::isValid(target.color) && target.color.idx == texture.idx) {
                return true;
            }
        }
        for (const LayerRecord& layer : layers) {
            if (bgfx::isValid(layer.framebuffer) && layer.framebuffer.idx == framebuffer.idx &&
                bgfx::isValid(layer.color) && layer.color.idx == texture.idx) {
                return true;
            }
        }
        return false;
    }

    // Pick a render target whose framebuffer does not own the given source texture,
    // avoiding WebGL feedback loops. Falls back to the other target if the current
    // one would cause a feedback loop.
    RenderTargetRecord* safe_destination(bgfx::TextureHandle source, RenderTargetRecord* current,
                                         RenderTargetRecord* other) const
    {
        if (bgfx::isValid(source) && bgfx::isValid(current->framebuffer) &&
            texture_attached_to_framebuffer(source, current->framebuffer)) {
            return other;
        }
        return current;
    }
};

BgfxRenderInterface::BgfxRenderInterface(const SurfaceMetrics& surface,
                                         const assets::AssetManager& assets)
    : m_impl(std::make_unique<Impl>(surface, assets))
{
}

BgfxRenderInterface::~BgfxRenderInterface() = default;

BgfxRenderInterface::operator bool() const
{
    return m_impl && bgfx::isValid(m_impl->program) && bgfx::isValid(m_impl->composite_program) &&
           bgfx::isValid(m_impl->copy_program) && bgfx::isValid(m_impl->opacity_program) &&
           bgfx::isValid(m_impl->color_matrix_program) &&
           bgfx::isValid(m_impl->mask_multiply_program) && bgfx::isValid(m_impl->blur_program) &&
           bgfx::isValid(m_impl->drop_shadow_program) && bgfx::isValid(m_impl->gradient_program);
}

void BgfxRenderInterface::resize(const SurfaceMetrics& surface) { m_impl->resize(surface); }

void BgfxRenderInterface::begin_frame()
{
    m_impl->pass_scheduler.reset();
    m_impl->transform_valid = false;
    m_impl->scissor_enabled = false;
    m_impl->scissor_region =
        Rml::Rectanglei::FromPositionSize({0, 0}, {m_impl->width, m_impl->height});
    if (!m_impl->begin_base_layer())
        return;
    LayerRecord* base = m_impl->current_layer();
    if (!base)
        return;
    auto pass =
        m_impl->acquire_pass(make_pass_request(RmlUiPassKind::Clear, 0, 0, true, true,
                                               m_impl->width, m_impl->height, "RmlUi.BaseClear"),
                             base->framebuffer);
    if (pass) {
        m_impl->perf.add_clear(uint64_t(m_impl->width) * uint64_t(m_impl->height), true);
        bgfx::setViewClear(pass->view, BGFX_CLEAR_COLOR | BGFX_CLEAR_STENCIL, 0x00000000u, 1.0f, 0);
        bgfx::touch(pass->view);
    }
}

void BgfxRenderInterface::end_frame()
{
    if (m_impl->frame_failed) {
        m_impl->layer_stack.clear();
        m_impl->layer_stack.push_back(0);
        m_impl->active_layer = 0;
        return;
    }
    if (m_impl->layer_stack.size() != 1) {
        std::fprintf(stderr, "[rmlui] unbalanced layer stack at frame end: %zu\n",
                     m_impl->layer_stack.size());
        m_impl->layer_stack.resize(1);
        m_impl->active_layer = 0;
    }
    if (LayerRecord* base = m_impl->layer_for_handle(0)) {
        if (!m_impl->composite(make_composite_op(
                base->color, BGFX_INVALID_HANDLE, Rml::BlendMode::Blend, ScissorState{false, {}},
                false, 1, RmlUiPassKind::FinalComposite, "RmlUi.FinalComposite",
                FbRect{0, 0, base->texture_width, base->texture_height},
                FbRect{0, 0, m_impl->width, m_impl->height}, base->texture_width,
                base->texture_height))) {
            m_impl->fail_frame("end_frame final composite failed");
        }
    }

    // Per-frame performance logging (~1 Hz, gated by runtime flag).
    {
#ifdef NOVELTEA_ENABLE_RENDER_PERF
        static double last_log_time = 0.0;
        static int frame_count = 0;
        frame_count++;
        const int64_t now_ticks = bx::getHPCounter();
        const double now = double(now_ticks) / double(bx::getHPFrequency());
        if (m_impl->perf_logging_enabled && now - last_log_time >= 1.0) {
            const auto& p = m_impl->perf;
            std::fprintf(
                stderr,
                "[perf] fps=%.0f passes=%u geom=%u clip=%u gradients=%u "
                "layers=%u full_layers=%u bounded_layers=%u "
                "unbounded_layer_fallbacks=%u "
                "filters=%u blur=%u shadow=%u mask=%u "
                "clear_px=%llu copy_px=%llu composite_px=%llu post_px=%llu "
                "full_frame_passes=%u bounded_passes=%u "
                "rt_alloc=%u rt_destroy=%u layer_alloc=%u layer_destroy=%u "
                "max_layer=%ux%u max_rt=%ux%u fb=%dx%d\n",
                double(frame_count) / (now - last_log_time), p.pass_count, p.geometry_draws,
                p.clip_mask_draws, p.gradient_draws, p.layer_pushes, p.full_frame_layers,
                p.bounded_layers, p.unbounded_layer_fallbacks, p.postprocess_passes, p.blur_passes,
                p.dropshadow_passes, p.mask_passes, (unsigned long long)p.clear_pixels,
                (unsigned long long)p.copy_pixels, (unsigned long long)p.composite_pixels,
                (unsigned long long)p.postprocess_pixels, p.full_frame_passes, p.bounded_passes,
                p.postprocess_allocations, p.postprocess_destroys, p.layer_allocations,
                p.layer_destroys, p.max_layer_width, p.max_layer_height, p.max_postprocess_width,
                p.max_postprocess_height, m_impl->width, m_impl->height);
            frame_count = 0;
            last_log_time = now;
        }
#endif
    }
}

Rml::CompiledGeometryHandle
BgfxRenderInterface::CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                     Rml::Span<const int> indices)
{
    if (vertices.empty() || indices.empty() ||
        vertices.size() > std::numeric_limits<uint32_t>::max() ||
        indices.size() > std::numeric_limits<uint32_t>::max()) {
        return 0;
    }
    std::vector<RmlVertex> converted;
    converted.reserve(vertices.size());
    for (const Rml::Vertex& vertex : vertices) {
        converted.push_back({vertex.position.x, vertex.position.y, pack_abgr(vertex.colour),
                             vertex.tex_coord.x, vertex.tex_coord.y});
    }
    std::vector<uint32_t> converted_indices;
    converted_indices.reserve(indices.size());
    for (int index : indices) {
        if (index < 0 || size_t(index) >= vertices.size()) {
            return 0;
        }
        converted_indices.push_back(uint32_t(index));
    }
    auto vb = bgfx::createVertexBuffer(
        bgfx::copy(converted.data(), uint32_t(converted.size() * sizeof(RmlVertex))),
        m_impl->layout);
    auto ib = bgfx::createIndexBuffer(
        bgfx::copy(converted_indices.data(), uint32_t(converted_indices.size() * sizeof(uint32_t))),
        BGFX_BUFFER_INDEX32);
    if (!bgfx::isValid(vb) || !bgfx::isValid(ib)) {
        if (bgfx::isValid(vb))
            bgfx::destroy(vb);
        if (bgfx::isValid(ib))
            bgfx::destroy(ib);
        return 0;
    }
    const Rml::CompiledGeometryHandle handle = ++m_impl->geometry_counter;
    m_impl->geometries.emplace(handle, GeometryRecord{vb, ib, uint32_t(converted_indices.size())});
    return handle;
}

FbRect rect_in_destination_layer(const FbRect& source_bounds, const LayerRecord& destination)
{
    return {source_bounds.x - destination.bounds.framebuffer.x,
            source_bounds.y - destination.bounds.framebuffer.y, source_bounds.w, source_bounds.h};
}

void BgfxRenderInterface::RenderGeometry(Rml::CompiledGeometryHandle geometry,
                                         Rml::Vector2f translation, Rml::TextureHandle texture)
{
    if (auto it = m_impl->geometries.find(geometry); it != m_impl->geometries.end()) {
        m_impl->submit(it->second, translation, texture);
    }
}

void BgfxRenderInterface::ReleaseGeometry(Rml::CompiledGeometryHandle geometry)
{
    if (auto it = m_impl->geometries.find(geometry); it != m_impl->geometries.end()) {
        Impl::destroy_geometry(it->second);
        m_impl->geometries.erase(it);
    }
}

Rml::TextureHandle BgfxRenderInterface::LoadTexture(Rml::Vector2i& texture_dimensions,
                                                    const Rml::String& source)
{
    texture_dimensions = {};
    const std::string logical = resolve_asset_path(m_impl->assets, source.c_str());
    auto bytes = m_impl->assets.read_binary(logical);
    if (!bytes || bytes.value->bytes.empty()) {
        std::fprintf(stderr, "[rmlui] texture read failed: %s (%s)\n", logical.c_str(),
                     bytes.error.c_str());
        return 0;
    }
    bx::DefaultAllocator allocator;
    bimg::ImageContainer* image =
        bimg::imageParse(&allocator, bytes.value->bytes.data(), uint32_t(bytes.value->bytes.size()),
                         bimg::TextureFormat::RGBA8);
    if (!image || image->m_width <= 0 || image->m_height <= 0 || !image->m_data ||
        image->m_format != bimg::TextureFormat::RGBA8 || image->m_numLayers != 1 ||
        image->m_depth != 1 || image->m_numMips != 1 ||
        image->m_size != image->m_width * image->m_height * 4u) {
        if (image)
            bimg::imageFree(image);
        std::fprintf(stderr, "[rmlui] image decode failed: %s\n", logical.c_str());
        return 0;
    }
    std::vector<uint8_t> rgba(static_cast<const uint8_t*>(image->m_data),
                              static_cast<const uint8_t*>(image->m_data) + image->m_size);
    const int width = int(image->m_width);
    const int height = int(image->m_height);
    bimg::imageFree(image);
    Rml::TextureHandle handle =
        m_impl->create_texture_from_rgba(std::move(rgba), width, height, false);
    if (handle != 0) {
        texture_dimensions = {width, height};
    }
    return handle;
}

Rml::TextureHandle BgfxRenderInterface::GenerateTexture(Rml::Span<const Rml::byte> source,
                                                        Rml::Vector2i source_dimensions)
{
    if (source.empty()) {
        return 0;
    }
    std::vector<uint8_t> rgba(source.begin(), source.end());
    return m_impl->create_texture_from_rgba(std::move(rgba), source_dimensions.x,
                                            source_dimensions.y, true);
}

void BgfxRenderInterface::ReleaseTexture(Rml::TextureHandle texture)
{
    if (auto it = m_impl->textures.find(texture); it != m_impl->textures.end()) {
        if ((it->second.ownership == TextureOwnership::External ||
             it->second.ownership == TextureOwnership::SavedLayer) &&
            bgfx::isValid(it->second.handle)) {
            bgfx::destroy(it->second.handle);
        }
        m_impl->textures.erase(it);
    }
}

void BgfxRenderInterface::EnableScissorRegion(bool enable) { m_impl->scissor_enabled = enable; }
void BgfxRenderInterface::SetScissorRegion(Rml::Rectanglei region)
{
    m_impl->scissor_region = clamp_scissor(logical_scissor_to_framebuffer(region, m_impl->surface),
                                           m_impl->width, m_impl->height);
}

void BgfxRenderInterface::SetTransform(const Rml::Matrix4f* transform)
{
    if (transform) {
        m_impl->transform_valid = true;
        std::memcpy(m_impl->transform, transform->data(), sizeof(m_impl->transform));
    } else {
        m_impl->transform_valid = false;
    }
}

void BgfxRenderInterface::EnableClipMask(bool enable)
{
    if (LayerRecord* layer = m_impl->current_layer()) {
        layer->clip_mask_enabled = enable;
    }
}

void BgfxRenderInterface::RenderToClipMask(Rml::ClipMaskOperation operation,
                                           Rml::CompiledGeometryHandle geometry,
                                           Rml::Vector2f translation)
{
    if (m_impl->geometries.find(geometry) == m_impl->geometries.end())
        return;
    LayerRecord* layer = m_impl->current_layer();
    if (!layer)
        return;

    ClipCommand command;
    command.operation = operation;
    command.geometry = geometry;
    command.translation = translation;
    command.scissor = ScissorState{m_impl->scissor_enabled, m_impl->scissor_region};
    command.transform_valid = m_impl->transform_valid;
    if (command.transform_valid) {
        std::memcpy(command.transform.data(), m_impl->transform, sizeof(m_impl->transform));
    }
    const StencilClipPlan clip_plan =
        plan_stencil_clip_operation(layer->stencil_ref, clip_operation_plan(operation));
    command.previous_ref = clip_plan.previous_ref;
    command.next_ref = clip_plan.next_ref;
    m_impl->apply_clip_command(command, true);
}

Rml::LayerHandle BgfxRenderInterface::PushLayer()
{
    m_impl->perf.add_layer_push();
    const Rml::LayerHandle parent = m_impl->active_layer;
    const Rml::LayerHandle handle = Rml::LayerHandle(m_impl->layer_pool.push());

    // Compute bounded layer allocation: use scissor region if available, clamped to parent.
    const RenderBounds child_bounds = m_impl->compute_child_layer_bounds(parent);
    const bool is_bounded =
        (child_bounds.framebuffer.w < m_impl->width || child_bounds.framebuffer.h < m_impl->height);
    if (!m_impl->ensure_layer(size_t(handle), child_bounds)) {
        m_impl->fail_frame("PushLayer failed while creating layer resources");
        return Rml::LayerHandle(LayerPoolPlan::InvalidLayer);
    }
    if (is_bounded) {
        m_impl->perf.add_bounded_layer();
    } else {
        m_impl->perf.add_full_frame_layer();
    }
    if (size_t(parent) < m_impl->layers.size()) {
        m_impl->layers[size_t(handle)].clip_mask_enabled =
            m_impl->layers[size_t(parent)].clip_mask_enabled;
        m_impl->layers[size_t(handle)].stencil_ref = m_impl->layers[size_t(parent)].stencil_ref;
        m_impl->layers[size_t(handle)].clip_commands = m_impl->layers[size_t(parent)].clip_commands;
    }
    m_impl->layer_stack.push_back(handle);
    m_impl->active_layer = handle;
    const LayerRecord& layer_rec = m_impl->layers[size_t(handle)];
    const int lw = layer_rec.texture_width;
    const int lh = layer_rec.texture_height;
    auto pass = m_impl->acquire_pass(
        make_pass_request(RmlUiPassKind::Clear, 0, 0, true, true, lw, lh, "RmlUi.LayerClear"),
        layer_rec.framebuffer);
    if (pass) {
        m_impl->perf.add_layer_clear();
        // For a bounded layer, clear the whole bounded texture.
        m_impl->perf.add_clear(uint64_t(lw) * uint64_t(lh), !is_bounded);
        bgfx::setViewClear(pass->view, BGFX_CLEAR_COLOR | BGFX_CLEAR_STENCIL, 0x00000000u, 1.0f, 0);
        bgfx::touch(pass->view);
    }
    if (size_t(parent) < m_impl->layers.size() &&
        !m_impl->layers[size_t(handle)].clip_commands.empty()) {
        m_impl->replay_clip_commands(handle, m_impl->layers[size_t(handle)].clip_commands);
    }
    return handle;
}

void BgfxRenderInterface::CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                                          Rml::BlendMode blend_mode,
                                          Rml::Span<const Rml::CompiledFilterHandle> filters)
{
    LayerRecord* source_layer = m_impl->layer_for_handle(source);
    LayerRecord* destination_layer = m_impl->layer_for_handle(destination);
    if (!source_layer || !destination_layer) {
        m_impl->fail_frame("CompositeLayers received invalid layer handles");
        return;
    }
    const ScissorState scissor_state{m_impl->scissor_enabled, m_impl->scissor_region};

    if (scissor_state.enabled) {
        const Rml::Rectanglei scissor =
            clamp_scissor(scissor_state.region, m_impl->width, m_impl->height);
        if (scissor.Width() <= 0 || scissor.Height() <= 0) {
            return;
        }
    }

    const bool destination_clip = destination_layer->clip_mask_enabled;
    const uint8_t destination_stencil_ref = destination_layer->stencil_ref;
    const ScissorState destination_scissor =
        scissor_local_to_layer(scissor_state, destination_layer->bounds);
    if (source == destination) {
        const FbRect scratch_bounds{0, 0, source_layer->texture_width,
                                    source_layer->texture_height};
        RenderTargetRecord* scratch =
            m_impl->ensure_postprocess_target(PostprocessTargetKind::Scratch, scratch_bounds);
        if (!scratch) {
            m_impl->fail_frame("CompositeLayers failed to create scratch target");
            return;
        }
        source_layer = m_impl->layer_for_handle(source);
        destination_layer = m_impl->layer_for_handle(destination);
        if (!source_layer || !destination_layer)
            return;
        if (!m_impl->composite(make_composite_op(
                source_layer->color, scratch->framebuffer, Rml::BlendMode::Replace,
                ScissorState{false, {}}, false, 1, RmlUiPassKind::Copy, "RmlUi.LayerScratchCopy",
                scratch_bounds, scratch_bounds, source_layer->texture_width,
                source_layer->texture_height))) {
            m_impl->fail_frame("CompositeLayers scratch copy failed");
            return;
        }
        const FilterApplyResult filtered =
            m_impl->apply_filters(scratch->color, source_layer->bounds, filters);
        if (!bgfx::isValid(filtered.texture))
            return;
        const FbRect destination_bounds =
            rect_in_destination_layer(filtered.output_bounds.framebuffer, *destination_layer);
        if (!m_impl->composite(make_composite_op(
                filtered.texture, destination_layer->framebuffer, blend_mode, destination_scissor,
                destination_clip, destination_stencil_ref, RmlUiPassKind::LayerComposite,
                "RmlUi.LayerComposite", filtered.valid_rect_in_texture, destination_bounds,
                filtered.texture_width, filtered.texture_height))) {
            m_impl->fail_frame("CompositeLayers composite failed");
            return;
        }
        return;
    }
    const FilterApplyResult filtered =
        m_impl->apply_filters(source_layer->color, source_layer->bounds, filters);
    if (!bgfx::isValid(filtered.texture))
        return;
    const FbRect destination_bounds =
        rect_in_destination_layer(filtered.output_bounds.framebuffer, *destination_layer);
    if (!m_impl->composite(make_composite_op(
            filtered.texture, destination_layer->framebuffer, blend_mode, destination_scissor,
            destination_clip, destination_stencil_ref, RmlUiPassKind::LayerComposite,
            "RmlUi.LayerComposite", filtered.valid_rect_in_texture, destination_bounds,
            filtered.texture_width, filtered.texture_height))) {
        m_impl->fail_frame("CompositeLayers composite failed");
    }
}

void BgfxRenderInterface::PopLayer()
{
    if (m_impl->layer_stack.size() <= 1) {
        std::fprintf(stderr, "[rmlui] attempted to pop the base RmlUi layer\n");
        return;
    }
    m_impl->layer_stack.pop_back();
    m_impl->active_layer = m_impl->layer_stack.back();
}

Rml::TextureHandle BgfxRenderInterface::SaveLayerAsTexture()
{
    if (m_impl->frame_failed)
        return 0;
    LayerRecord* layer = m_impl->current_layer();
    if (!layer || !bgfx::isValid(layer->color))
        return 0;

    const Rml::Rectanglei bounds = m_impl->current_save_bounds();
    if (bounds.Width() <= 0 || bounds.Height() <= 0)
        return 0;

    bgfx::TextureHandle texture =
        m_impl->copy_region_to_texture(layer->color, bounds, layer->texture_width,
                                       layer->texture_height, "RmlUi.SaveLayerAsTexture");
    if (!bgfx::isValid(texture)) {
        m_impl->fail_frame("SaveLayerAsTexture failed to copy layer contents");
        return 0;
    }

    const Rml::TextureHandle handle = ++m_impl->texture_counter;
    m_impl->textures.emplace(
        handle,
        TextureRecord{texture,
                      {bounds.Width(), bounds.Height()},
                      RenderBounds{{float(bounds.Left()), float(bounds.Top()),
                                    float(bounds.Width()), float(bounds.Height())},
                                   {bounds.Left(), bounds.Top(), bounds.Width(), bounds.Height()}},
                      TextureOwnership::SavedLayer});
    return handle;
}

Rml::CompiledFilterHandle BgfxRenderInterface::SaveLayerAsMaskImage()
{
    if (m_impl->frame_failed)
        return 0;
    LayerRecord* layer = m_impl->current_layer();
    if (!layer || !bgfx::isValid(layer->color))
        return 0;

    const Rml::Rectanglei local_bounds =
        Rml::Rectanglei::FromPositionSize({0, 0}, {layer->texture_width, layer->texture_height});
    bgfx::TextureHandle mask_texture =
        m_impl->copy_region_to_texture(layer->color, local_bounds, layer->texture_width,
                                       layer->texture_height, "RmlUi.SaveLayerAsMaskImage");
    if (!bgfx::isValid(mask_texture)) {
        m_impl->fail_frame("SaveLayerAsMaskImage failed to copy layer contents");
        return 0;
    }

    const Rml::TextureHandle texture = ++m_impl->texture_counter;
    m_impl->textures.emplace(
        texture, TextureRecord{mask_texture,
                               {layer->texture_width, layer->texture_height},
                               RenderBounds{{layer->bounds.logical.x, layer->bounds.logical.y,
                                             layer->bounds.logical.w, layer->bounds.logical.h},
                                            layer->bounds.framebuffer},
                               TextureOwnership::SavedLayer});

    FilterRecord filter;
    filter.kind = FilterKind::MaskImage;
    filter.resource = texture;
    filter.mask_bounds = {layer->bounds.framebuffer.x, layer->bounds.framebuffer.y,
                          layer->bounds.framebuffer.w, layer->bounds.framebuffer.h};
    const Rml::CompiledFilterHandle handle = ++m_impl->filter_counter;
    m_impl->filters.emplace(handle, filter);
    return handle;
}

Rml::CompiledFilterHandle BgfxRenderInterface::CompileFilter(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    FilterRecord filter;
    if (name == "opacity") {
        filter = make_opacity_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "blur") {
        filter.kind = FilterKind::Blur;
        filter.sigma = Rml::Get(parameters, "sigma", 1.0f);
    } else if (name == "drop-shadow") {
        filter.kind = FilterKind::DropShadow;
        filter.sigma = Rml::Get(parameters, "sigma", 0.0f);
        const Rml::Vector2f offset = Rml::Get(parameters, "offset", Rml::Vector2f(0.0f));
        const Rml::ColourbPremultiplied color =
            Rml::Get(parameters, "color", Rml::Colourb()).ToPremultiplied();
        filter.offset = {offset.x, offset.y};
        filter.color = {float(color.red) / 255.0f, float(color.green) / 255.0f,
                        float(color.blue) / 255.0f, float(color.alpha) / 255.0f};
    } else if (name == "brightness") {
        filter = make_brightness_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "contrast") {
        filter = make_contrast_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "invert") {
        filter = make_invert_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "grayscale") {
        filter = make_grayscale_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "sepia") {
        filter = make_sepia_filter(Rml::Get(parameters, "value", 1.0f));
    } else if (name == "hue-rotate") {
        filter = make_hue_rotate_filter(Rml::Get(parameters, "value", 0.0f));
    } else if (name == "saturate") {
        filter = make_saturate_filter(Rml::Get(parameters, "value", 1.0f));
    }
    if (filter.kind == FilterKind::Invalid) {
        std::fprintf(stderr, "[rmlui] unsupported filter '%s'\n", name.c_str());
        return 0;
    }
    if (is_noop_filter(filter))
        return 0;
    const Rml::CompiledFilterHandle handle = ++m_impl->filter_counter;
    m_impl->filters.emplace(handle, filter);
    return handle;
}

void BgfxRenderInterface::ReleaseFilter(Rml::CompiledFilterHandle filter)
{
    auto filter_it = m_impl->filters.find(filter);
    if (filter_it == m_impl->filters.end())
        return;
    if (filter_it->second.kind == FilterKind::MaskImage && filter_it->second.resource != 0) {
        const Rml::TextureHandle texture = Rml::TextureHandle(filter_it->second.resource);
        auto texture_it = m_impl->textures.find(texture);
        if (texture_it != m_impl->textures.end()) {
            if (texture_it->second.ownership == TextureOwnership::SavedLayer &&
                bgfx::isValid(texture_it->second.handle)) {
                bgfx::destroy(texture_it->second.handle);
            }
            m_impl->textures.erase(texture_it);
        }
        filter_it->second.resource = 0;
    }
    m_impl->filters.erase(filter_it);
}

Rml::CompiledShaderHandle BgfxRenderInterface::CompileShader(const Rml::String& name,
                                                             const Rml::Dictionary& parameters)
{
    GradientRecord gradient = make_invalid_gradient();
    if (!populate_gradient(gradient, name, parameters)) {
        std::fprintf(stderr, "[rmlui] shader '%s' is not supported by the bgfx renderer\n",
                     name.c_str());
        return 0;
    }

    const Rml::CompiledShaderHandle handle = ++m_impl->shader_counter;
    m_impl->shaders.emplace(handle, ShaderRecord{gradient});
    return handle;
}

void BgfxRenderInterface::RenderShader(Rml::CompiledShaderHandle shader,
                                       Rml::CompiledGeometryHandle geometry,
                                       Rml::Vector2f translation, Rml::TextureHandle texture)
{
    (void)texture;
    auto shader_it = m_impl->shaders.find(shader);
    auto geometry_it = m_impl->geometries.find(geometry);
    if (shader_it == m_impl->shaders.end() || geometry_it == m_impl->geometries.end())
        return;
    m_impl->submit_gradient(shader_it->second, geometry_it->second, translation);
}

void BgfxRenderInterface::ReleaseShader(Rml::CompiledShaderHandle shader)
{
    m_impl->shaders.erase(shader);
}

void BgfxRenderInterface::set_perf_logging_enabled(bool enabled)
{
#ifdef NOVELTEA_ENABLE_RENDER_PERF
    m_impl->perf_logging_enabled = enabled;
#else
    (void)enabled;
#endif
}

} // namespace noveltea::ui::rmlui
