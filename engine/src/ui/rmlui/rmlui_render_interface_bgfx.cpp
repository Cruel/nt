#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_render_interface.hpp"

#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_bounds.hpp"
#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_pass_scheduler.hpp"
#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_planning.hpp"
#include "ui/rmlui/bgfx_renderer/rmlui_bgfx_types.hpp"

#include <RmlUi/Core/Dictionary.h>
#include <RmlUi/Core/DecorationTypes.h>
#include <RmlUi/Core/Types.h>
#include <RmlUi/Core/Unit.h>
#include <RmlUi/Core/Variant.h>
#include <bx/math.h>
#include <bx/timer.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <cstring>
#include <limits>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

namespace rmlui_bgfx {

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

TextureRegion texture_region(bgfx::TextureHandle texture, GlobalFbRect global_bounds,
                             LocalFbRect local_rect, int texture_width, int texture_height)
{
    return TextureRegion{texture, global_bounds, local_rect, texture_width, texture_height};
}

CompositeOp make_composite_op(TextureRegion source, bgfx::FrameBufferHandle destination,
                              Rml::BlendMode blend_mode, ScissorState scissor,
                              bool apply_destination_stencil, uint8_t stencil_ref,
                              RmlUiPassKind kind, const char* name,
                              LocalFbRect destination_rect = {})
{
    CompositeOp op;
    op.source = source;
    op.destination = destination;
    op.destination_rect = destination_rect;
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
    const FbRect layer_local{0, 0, layer->texture_width, layer->texture_height};
    if (is_empty(layer_local))
        return {};
    const FbRect scissor_bounds = active_scissor_bounds(scissor, layer_bounds);
    if (is_empty(scissor_bounds))
        return layer_local;
    return intersect(layer_local, scissor_bounds);
}

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

Rml::Rectanglei logical_scissor_to_framebuffer(Rml::Rectanglei region,
                                               const SurfaceMetrics& surface)
{
    const LogicalRect logical{static_cast<float>(region.Left()), static_cast<float>(region.Top()),
                              static_cast<float>(region.Width()),
                              static_cast<float>(region.Height())};
    const FbRect physical = logical_to_framebuffer(logical, surface);
    return Rml::Rectanglei::FromPositionSize({physical.x, physical.y}, {physical.w, physical.h});
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

} // namespace

struct RenderInterface::Impl {
    explicit Impl(const RendererConfig& config)
        : shader_provider(config.shaders), textures_provider(config.textures),
          diagnostics(config.diagnostics), perf_logger(config.perf_logger),
          pass_scheduler(config.views.begin, config.views.end),
          perf_logging_enabled(config.enable_perf_logging)
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

        program = load_system_program(SystemProgram::RmlUi);
        composite_program = load_system_program(SystemProgram::Composite);
        copy_program = load_system_program(SystemProgram::Copy);
        opacity_program = load_system_program(SystemProgram::Opacity);
        color_matrix_program = load_system_program(SystemProgram::ColorMatrix);
        mask_multiply_program = load_system_program(SystemProgram::MaskMultiply);
        blur_program = load_system_program(SystemProgram::Blur);
        drop_shadow_program = load_system_program(SystemProgram::DropShadow);
        gradient_program = load_system_program(SystemProgram::Gradient);
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
        resize(config.surface);
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

    bgfx::ProgramHandle load_system_program(SystemProgram requested_program)
    {
        if (!shader_provider) {
            log_error("shader provider is not configured");
            return BGFX_INVALID_HANDLE;
        }
        return shader_provider->load_program(requested_program);
    }

    void log_warning(std::string_view message) const
    {
        if (diagnostics) {
            diagnostics->warning(message);
            return;
        }
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void log_error(std::string_view message) const
    {
        if (diagnostics) {
            diagnostics->error(message);
            return;
        }
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }

    void log_perf_line(std::string_view message) const
    {
        if (perf_logger) {
            perf_logger->log_perf_line(message);
            return;
        }
        std::fprintf(stderr, "%.*s\n", int(message.size()), message.data());
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
        postprocess_targets.clear();
        postprocess_pool.reset_resources();
    }

    RenderBounds compute_child_layer_bounds(Rml::LayerHandle parent_handle,
                                            const ScissorState& captured_scissor,
                                            bool captured_transform_valid,
                                            bool count_fallbacks = true) const
    {
        const RenderBounds* parent_ptr = nullptr;
        if (size_t(parent_handle) < layers.size()) {
            parent_ptr = &layers[size_t(parent_handle)].bounds;
        }

        const FbRect* scissor_ptr = nullptr;
        FbRect scissor_fb{};
        if (captured_scissor.enabled) {
            const Rml::Rectanglei clipped = clamp_scissor(captured_scissor.region, width, height);
            if (clipped.Width() > 0 && clipped.Height() > 0) {
                scissor_fb = {clipped.Left(), clipped.Top(), clipped.Width(), clipped.Height()};
                scissor_ptr = &scissor_fb;
            }
        }
        if (count_fallbacks && (!scissor_ptr || captured_transform_valid)) {
            const_cast<rmlui_bgfx::PerfCounters&>(perf).add_unbounded_layer_fallback(
                !scissor_ptr, captured_transform_valid);
        }

        return rmlui_bgfx::compute_child_layer_bounds(surface, parent_ptr, scissor_ptr,
                                                      captured_transform_valid);
    }

    RenderBounds compute_child_layer_bounds(Rml::LayerHandle parent_handle) const
    {
        return compute_child_layer_bounds(
            parent_handle, ScissorState{scissor_enabled, scissor_region}, transform_valid);
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
            layer.materialized = true;
            bx::mtxOrtho(layer.projection, bounds.logical.x, bounds.logical.x + bounds.logical.w,
                         bounds.logical.y + bounds.logical.h, bounds.logical.y, -10000.0f, 10000.0f,
                         0.0f, bgfx::getCaps()->homogeneousDepth);
            return true;
        }

        const LayerKind saved_kind = layer.kind;
        const Rml::LayerHandle saved_parent_layer = layer.parent_layer;
        const ScissorState saved_push_scissor = layer.push_scissor;
        const bool saved_push_transform_valid = layer.push_transform_valid;
        const bool saved_recording = layer.recording;
        const bool saved_clear_pending = layer.clear_pending;
        const FbRect saved_valid_content_bounds = layer.valid_content_bounds;
        const bool saved_has_valid_content_bounds = layer.has_valid_content_bounds;
        const ConservativeMaskBounds saved_conservative_mask_bounds =
            layer.conservative_mask_bounds;
        const bool saved_content_bounds_transform_fallback =
            layer.content_bounds_transform_fallback;
        const bool saved_content_bounds_inverse_mask_fallback =
            layer.content_bounds_inverse_mask_fallback;
        const bool saved_clip_mask_enabled = layer.clip_mask_enabled;
        const uint8_t saved_stencil_ref = layer.stencil_ref;
        const size_t saved_inherited_clip_command_count = layer.inherited_clip_command_count;
        std::vector<size_t> saved_clip_commands = std::move(layer.clip_commands);
        std::vector<RecordedDrawCommand> saved_commands = std::move(layer.commands);
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
        layer.valid_content_bounds = saved_valid_content_bounds;
        layer.has_valid_content_bounds = saved_has_valid_content_bounds;
        layer.conservative_mask_bounds = saved_conservative_mask_bounds;
        layer.content_bounds_transform_fallback = saved_content_bounds_transform_fallback;
        layer.content_bounds_inverse_mask_fallback = saved_content_bounds_inverse_mask_fallback;
        layer.texture_width = bounds.framebuffer.w;
        layer.texture_height = bounds.framebuffer.h;
        layer.clip_mask_enabled = saved_clip_mask_enabled;
        layer.stencil_ref = saved_stencil_ref;
        layer.clip_commands = std::move(saved_clip_commands);
        layer.inherited_clip_command_count = saved_inherited_clip_command_count;
        layer.kind = saved_kind;
        layer.parent_layer = saved_parent_layer;
        layer.push_scissor = saved_push_scissor;
        layer.push_transform_valid = saved_push_transform_valid;
        layer.recording = saved_recording;
        layer.materialized = true;
        layer.clear_pending = saved_clear_pending;
        layer.commands = std::move(saved_commands);
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
        if (size_t(handle) >= layers.size())
            return nullptr;
        return &layers[size_t(handle)];
    }

    LayerRecord* materialized_layer_for_handle(Rml::LayerHandle handle)
    {
        LayerRecord* layer = layer_for_handle(handle);
        if (!layer)
            return nullptr;
        if (size_t(handle) == 0 && direct_base_requested)
            return layer;
        if (!bgfx::isValid(layer->framebuffer))
            return nullptr;
        return layer;
    }

    LayerRecord* current_layer() { return layer_for_handle(active_layer); }

    bool active_layer_is_recording() const
    {
        if (uint32_t(active_layer) == LayerPoolPlan::InvalidLayer ||
            size_t(active_layer) >= layers.size()) {
            return false;
        }
        const LayerRecord& layer = layers[size_t(active_layer)];
        return layer.kind == LayerKind::VirtualChild && layer.recording && !layer.materialized;
    }

    FbRect scissor_fb_bounds(const ScissorState& state) const
    {
        if (!state.enabled)
            return {};
        const Rml::Rectanglei region = clamp_scissor(state.region, width, height);
        if (region.Width() <= 0 || region.Height() <= 0)
            return {};
        return {region.Left(), region.Top(), region.Width(), region.Height()};
    }

    FbRect layer_limit_bounds(const LayerRecord& layer) const
    {
        FbRect bounds{0, 0, width, height};
        if (size_t(layer.parent_layer) < layers.size()) {
            const FbRect parent_bounds = layers[size_t(layer.parent_layer)].bounds.framebuffer;
            if (!is_empty(parent_bounds))
                bounds = intersect(bounds, parent_bounds);
        }
        if (layer.push_scissor.enabled) {
            const FbRect scissor_bounds = scissor_fb_bounds(layer.push_scissor);
            if (!is_empty(scissor_bounds))
                bounds = intersect(bounds, scissor_bounds);
        }
        if (!is_empty(layer.bounds.framebuffer))
            bounds = intersect(bounds, layer.bounds.framebuffer);
        return bounds;
    }

    RenderBounds bounds_from_framebuffer_rect(FbRect framebuffer_bounds) const
    {
        RenderBounds bounds;
        bounds.framebuffer =
            clamp_to_surface(align_outward_for_render_target(framebuffer_bounds), surface);
        if (is_empty(bounds.framebuffer)) {
            bounds.framebuffer = {0, 0, 1, 1};
        }
        bounds.logical = framebuffer_to_logical(bounds.framebuffer, surface);
        return bounds;
    }

    FbRect layer_recorded_content_bounds(const LayerRecord& layer) const
    {
        FbRect content = layer.has_valid_content_bounds ? layer.valid_content_bounds : FbRect{};
        const FbRect limit = layer_limit_bounds(layer);
        if (layer.content_bounds_transform_fallback || layer.content_bounds_inverse_mask_fallback) {
            content = limit;
        } else if (!is_empty(content) && !is_empty(limit)) {
            content = intersect(content, limit);
        }
        return clamp_to_surface(align_outward_for_render_target(content), surface);
    }

    RenderBounds choose_materialized_layer_bounds(const LayerRecord& layer,
                                                  std::optional<FbRect> required_bounds) const
    {
        FbRect selected = layer_recorded_content_bounds(layer);
        if (required_bounds && !is_empty(*required_bounds)) {
            const FbRect required =
                clamp_to_surface(align_outward_for_render_target(*required_bounds), surface);
            selected = is_empty(selected) ? required : union_rects(selected, required);
        }

        const FbRect limit = layer_limit_bounds(layer);
        if (!is_empty(limit) && !is_empty(selected)) {
            selected = intersect(selected, limit);
        }
        selected = clamp_to_surface(align_outward_for_render_target(selected), surface);
        if (is_empty(selected)) {
            FbRect fallback = !is_empty(limit) ? limit : FbRect{0, 0, width, height};
            fallback = clamp_to_surface(fallback, surface);
            const int x = std::clamp(fallback.x, 0, std::max(width - 1, 0));
            const int y = std::clamp(fallback.y, 0, std::max(height - 1, 0));
            selected = {x, y, 1, 1};
        }
        return bounds_from_framebuffer_rect(selected);
    }

    std::vector<FilterRecord>
    resolved_filter_chain(Rml::Span<const Rml::CompiledFilterHandle> filter_handles) const
    {
        std::vector<FilterRecord> filter_chain;
        filter_chain.reserve(filter_handles.size());
        for (Rml::CompiledFilterHandle handle : filter_handles) {
            auto it = filters.find(handle);
            if (it == filters.end())
                return {};
            filter_chain.push_back(it->second);
        }
        return simplify_filter_chain(filter_chain);
    }

    FilterExpansion
    filter_expansion_for(Rml::Span<const Rml::CompiledFilterHandle> filter_handles) const
    {
        FilterExpansion total_expansion{};
        for (const FilterRecord& filter : resolved_filter_chain(filter_handles)) {
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
        return total_expansion;
    }

    std::optional<FbRect> command_fb_bounds(Rml::CompiledGeometryHandle geometry,
                                            Rml::Vector2f translation, const ScissorState& state,
                                            bool command_transform_valid,
                                            const std::array<float, 16>& command_transform) const
    {
        auto it = geometries.find(geometry);
        if (it == geometries.end())
            return std::nullopt;

        Rml::Matrix4f transform_matrix;
        const Rml::Matrix4f* transform_ptr = nullptr;
        if (command_transform_valid) {
            std::memcpy(transform_matrix.data(), command_transform.data(), sizeof(float) * 16);
            transform_ptr = &transform_matrix;
        }

        const GeometryBoundsResult geometry_bounds = compute_transformed_geometry_bounds(
            it->second.local_bounds, translation, transform_ptr, surface);
        if (geometry_bounds.status == GeometryBoundsStatus::EmptyGeometry)
            return FbRect{};
        if (geometry_bounds.status != GeometryBoundsStatus::Valid)
            return std::nullopt;

        FbRect bounds = geometry_bounds.framebuffer;
        if (state.enabled) {
            const FbRect state_bounds = scissor_fb_bounds(state);
            if (is_empty(state_bounds))
                return FbRect{};
            bounds = intersect(bounds, state_bounds);
        }
        return bounds;
    }

    void add_recorded_region(LayerRecord& layer, const RecordedDrawCommand& command)
    {
        const auto maybe_bounds =
            command_fb_bounds(command.geometry, command.translation, command.scissor,
                              command.transform_valid, command.transform);
        if (!maybe_bounds) {
            if (command.transform_valid)
                layer.content_bounds_transform_fallback = true;
            return;
        }
        FbRect bounds = *maybe_bounds;
        const FbRect container = layer_limit_bounds(layer);
        if (!is_empty(container))
            bounds = intersect(bounds, container);
        if (command.clip_mask_enabled)
            bounds = apply_mask_constraints(bounds, nullptr, &layer.conservative_mask_bounds);
        if (is_empty(bounds))
            return;
        layer.valid_content_bounds = layer.has_valid_content_bounds
                                         ? union_rects(layer.valid_content_bounds, bounds)
                                         : bounds;
        layer.has_valid_content_bounds = true;
    }

    void update_layer_mask_region(LayerRecord& layer, const ClipCommand& command)
    {
        const auto maybe_bounds =
            command_fb_bounds(command.geometry, command.translation, command.scissor,
                              command.transform_valid, command.transform);
        if (!maybe_bounds) {
            if (command.transform_valid)
                layer.content_bounds_transform_fallback = true;
            return;
        }
        FbRect fallback_bounds = layer_limit_bounds(layer);
        if (command.scissor.enabled) {
            const FbRect scissor_bounds = scissor_fb_bounds(command.scissor);
            if (!is_empty(scissor_bounds))
                fallback_bounds = intersect(fallback_bounds, scissor_bounds);
        }
        layer.conservative_mask_bounds = update_conservative_mask_bounds(
            layer.conservative_mask_bounds, command.operation, *maybe_bounds, fallback_bounds);
        if (command.operation == Rml::ClipMaskOperation::SetInverse &&
            layer.conservative_mask_bounds.inverse_fallback)
            layer.content_bounds_inverse_mask_fallback = true;
    }

    void record_geometry_command(Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation,
                                 Rml::TextureHandle texture)
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        RecordedDrawCommand command;
        command.kind = RecordedCommandKind::Geometry;
        command.geometry = geometry;
        command.texture = texture;
        command.translation = translation;
        command.scissor = ScissorState{scissor_enabled, scissor_region};
        command.transform_valid = transform_valid;
        if (command.transform_valid) {
            std::memcpy(command.transform.data(), transform, sizeof(transform));
        }
        command.clip_mask_enabled = layer->clip_mask_enabled;
        command.stencil_ref = layer->stencil_ref;
        layer->commands.push_back(command);
        add_recorded_region(*layer, command);
    }

    void record_shader_command(Rml::CompiledShaderHandle shader,
                               Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation,
                               Rml::TextureHandle texture)
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        RecordedDrawCommand command;
        command.kind = RecordedCommandKind::Shader;
        command.shader = shader;
        command.geometry = geometry;
        command.texture = texture;
        command.translation = translation;
        command.scissor = ScissorState{scissor_enabled, scissor_region};
        command.transform_valid = transform_valid;
        if (command.transform_valid) {
            std::memcpy(command.transform.data(), transform, sizeof(transform));
        }
        command.clip_mask_enabled = layer->clip_mask_enabled;
        command.stencil_ref = layer->stencil_ref;
        layer->commands.push_back(command);
        add_recorded_region(*layer, command);
    }

    void record_clip_mask_command(const ClipCommand& clip_command)
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        RecordedDrawCommand command;
        command.kind = RecordedCommandKind::ClipMask;
        command.geometry = clip_command.geometry;
        command.translation = clip_command.translation;
        command.scissor = clip_command.scissor;
        command.transform_valid = clip_command.transform_valid;
        command.transform = clip_command.transform;
        command.clip_mask_enabled = layer->clip_mask_enabled;
        command.stencil_ref = clip_command.previous_ref;
        command.clip_operation = clip_command.operation;
        command.previous_ref = clip_command.previous_ref;
        command.next_ref = clip_command.next_ref;
        layer->commands.push_back(command);
        update_layer_mask_region(*layer, clip_command);
        layer->stencil_ref = clip_command.next_ref;
        layer->clip_commands.push_back(clip_commands.size());
        clip_commands.push_back(clip_command);
    }

    bool clear_materialized_layer(Rml::LayerHandle handle, bool is_bounded)
    {
        LayerRecord* layer = materialized_layer_for_handle(handle);
        if (!layer)
            return false;
        const int lw = layer->texture_width;
        const int lh = layer->texture_height;
        auto pass = acquire_pass(
            make_pass_request(RmlUiPassKind::Clear, 0, 0, true, true, lw, lh, "RmlUi.LayerClear"),
            layer->framebuffer);
        if (!pass)
            return false;
        perf.add_layer_clear();
        perf.add_clear(uint64_t(lw) * uint64_t(lh), !is_bounded);
        bgfx::setViewClear(pass->view, BGFX_CLEAR_COLOR | BGFX_CLEAR_STENCIL, 0x00000000u, 1.0f, 0);
        bgfx::touch(pass->view);
        return true;
    }

    bool replay_recorded_commands(Rml::LayerHandle handle)
    {
        LayerRecord* layer = materialized_layer_for_handle(handle);
        if (!layer)
            return false;
        const std::vector<RecordedDrawCommand> commands = layer->commands;
        const bool final_clip_mask_enabled = layer->clip_mask_enabled;
        const uint8_t final_stencil_ref = layer->stencil_ref;
        const Rml::LayerHandle saved_active = active_layer;
        const bool saved_scissor_enabled = scissor_enabled;
        const Rml::Rectanglei saved_scissor_region = scissor_region;
        const bool saved_transform_valid = transform_valid;
        const std::array<float, 16> saved_transform = [&] {
            std::array<float, 16> copy{};
            std::memcpy(copy.data(), transform, sizeof(transform));
            return copy;
        }();

        active_layer = handle;
        for (const RecordedDrawCommand& command : commands) {
            LayerRecord* replay_layer = materialized_layer_for_handle(handle);
            if (!replay_layer)
                break;
            scissor_enabled = command.scissor.enabled;
            scissor_region = command.scissor.region;
            transform_valid = command.transform_valid;
            if (transform_valid) {
                std::memcpy(transform, command.transform.data(), sizeof(transform));
            }
            replay_layer->clip_mask_enabled = command.clip_mask_enabled;
            replay_layer->stencil_ref = command.stencil_ref;

            switch (command.kind) {
            case RecordedCommandKind::Geometry: {
                auto geometry_it = geometries.find(command.geometry);
                if (geometry_it != geometries.end()) {
                    submit(geometry_it->second, command.translation, command.texture);
                }
                break;
            }
            case RecordedCommandKind::Shader: {
                auto shader_it = shaders.find(command.shader);
                auto geometry_it = geometries.find(command.geometry);
                if (shader_it != shaders.end() && geometry_it != geometries.end()) {
                    submit_gradient(shader_it->second, geometry_it->second, command.translation);
                }
                break;
            }
            case RecordedCommandKind::ClipMask: {
                ClipCommand clip_command;
                clip_command.operation = command.clip_operation;
                clip_command.geometry = command.geometry;
                clip_command.translation = command.translation;
                clip_command.scissor = command.scissor;
                clip_command.transform_valid = command.transform_valid;
                clip_command.transform = command.transform;
                clip_command.previous_ref = command.previous_ref;
                clip_command.next_ref = command.next_ref;
                apply_clip_command(clip_command, false);
                break;
            }
            }
        }

        if (LayerRecord* final_layer = materialized_layer_for_handle(handle)) {
            final_layer->clip_mask_enabled = final_clip_mask_enabled;
            final_layer->stencil_ref = final_stencil_ref;
        }
        active_layer = saved_active;
        scissor_enabled = saved_scissor_enabled;
        scissor_region = saved_scissor_region;
        transform_valid = saved_transform_valid;
        std::memcpy(transform, saved_transform.data(), sizeof(transform));
        return !frame_failed;
    }

    bool materialize_layer(Rml::LayerHandle handle,
                           std::optional<FbRect> required_bounds = std::nullopt)
    {
        LayerRecord* layer = layer_for_handle(handle);
        if (!layer)
            return false;
        if (layer->kind == LayerKind::Root || layer->materialized)
            return true;

        const RenderBounds child_bounds = choose_materialized_layer_bounds(*layer, required_bounds);
        const bool is_bounded =
            (child_bounds.framebuffer.w < width || child_bounds.framebuffer.h < height);
        if (!ensure_layer(size_t(handle), child_bounds)) {
            fail_frame("failed to materialize virtual RmlUi layer");
            return false;
        }
        layer = layer_for_handle(handle);
        if (!layer)
            return false;
        layer->recording = false;
        layer->materialized = true;
        perf.update_child_layer_max(uint32_t(layer->texture_width),
                                    uint32_t(layer->texture_height));
        if (is_bounded) {
            perf.add_bounded_child_layer();
        } else {
            perf.add_full_frame_child_layer();
        }

        const bool final_clip_mask_enabled = layer->clip_mask_enabled;
        const uint8_t final_stencil_ref = layer->stencil_ref;
        if (layer->clear_pending) {
            if (!clear_materialized_layer(handle, is_bounded)) {
                fail_frame("failed to clear materialized RmlUi layer");
                return false;
            }
            layer = layer_for_handle(handle);
            if (!layer)
                return false;
            layer->clear_pending = false;
        }
        if (layer->inherited_clip_command_count > 0) {
            const size_t count =
                std::min(layer->inherited_clip_command_count, layer->clip_commands.size());
            std::vector<size_t> inherited_commands(layer->clip_commands.begin(),
                                                   layer->clip_commands.begin() + count);
            replay_clip_commands(handle, inherited_commands);
            layer = layer_for_handle(handle);
            if (!layer)
                return false;
            layer->clip_mask_enabled = final_clip_mask_enabled;
            layer->stencil_ref = final_stencil_ref;
        }
        return replay_recorded_commands(handle);
    }

    bool begin_base_layer()
    {
        perf.reset();
        direct_base_presented = false;
        direct_base_fallback_reason = nullptr;
        const bgfx::Caps* caps = bgfx::getCaps();
        const bool direct_mode_capable =
            caps != nullptr && caps->rendererType != bgfx::RendererType::Noop;
        const bool stencil_capable = depth_stencil_format() != bgfx::TextureFormat::Unknown;
        const bool webgl_feedback_sensitive =
#if defined(__EMSCRIPTEN__)
            true;
#else
            false;
#endif
        const auto policy = choose_base_presentation_policy(
            !base_direct_compatibility_enabled, direct_mode_capable, root_requires_preservation,
            stencil_capable, webgl_feedback_sensitive);
        direct_base_requested = policy.mode == BasePresentationMode::DirectToBackbuffer;
        direct_base_fallback_reason = policy.fallback_reason;
        if (direct_base_requested) {
            perf.add_direct_base_presentation();
        } else {
            perf.add_offscreen_base_presentation();
            perf.add_direct_base_fallback();
            if (direct_base_fallback_reason &&
                logged_base_fallback_reason != direct_base_fallback_reason) {
                std::fprintf(stderr, "[rmlui] base presentation fallback: %s\n",
                             direct_base_fallback_reason);
                logged_base_fallback_reason = direct_base_fallback_reason;
            }
        }
        RenderBounds base_bounds;
        base_bounds.logical = {0.0f, 0.0f, float(logical_width), float(logical_height)};
        base_bounds.framebuffer = {0, 0, width, height};
        if (direct_base_requested) {
            if (layers.size() < 1)
                layers.resize(1);
            LayerRecord& base = layers[0];
            destroy_layer(base);
            base.bounds = base_bounds;
            base.texture_width = width;
            base.texture_height = height;
            base.clip_mask_enabled = false;
            base.stencil_ref = 1;
            base.clip_commands.clear();
            bx::mtxOrtho(base.projection, base_bounds.logical.x,
                         base_bounds.logical.x + base_bounds.logical.w,
                         base_bounds.logical.y + base_bounds.logical.h, base_bounds.logical.y,
                         -10000.0f, 10000.0f, 0.0f, caps ? caps->homogeneousDepth : false);
        } else {
            if (!ensure_layer(0, base_bounds))
                return false;
            perf.add_full_frame_layer();
        }
        layer_pool.begin_frame();
        layer_stack.clear();
        layer_stack.push_back(0);
        active_layer = 0;
        layers[0].kind = LayerKind::Root;
        layers[0].parent_layer = 0;
        layers[0].recording = false;
        layers[0].materialized = true;
        layers[0].clear_pending = false;
        layers[0].commands.clear();
        layers[0].valid_content_bounds = {};
        layers[0].has_valid_content_bounds = false;
        layers[0].conservative_mask_bounds = {};
        layers[0].content_bounds_transform_fallback = false;
        layers[0].content_bounds_inverse_mask_fallback = false;
        layers[0].clip_mask_enabled = false;
        layers[0].stencil_ref = 1;
        layers[0].clip_commands.clear();
        layers[0].inherited_clip_command_count = 0;
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
            !bgfx::isValid(op.source.texture))
            return false;

        // WebGL forbids sampling from a texture while rendering into a framebuffer whose
        // color attachment is that same texture (GL_INVALID_OPERATION feedback loop).
        if (bgfx::isValid(op.destination) &&
            texture_attached_to_framebuffer(op.source.texture, op.destination)) {
            fail_frame("composite feedback loop");
            return false;
        }

        const FbRect destination_rect =
            is_empty(op.destination_rect) ? FbRect{0, 0, width, height} : op.destination_rect;
        const LocalFbRect source_rect = op.source.local_rect;
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
            const FbRect target_scissor{op.scissor.region.Left(), op.scissor.region.Top(),
                                        op.scissor.region.Width(), op.scissor.region.Height()};
            const FbRect clipped_scissor = intersect(target_scissor, destination_rect);
            if (is_empty(clipped_scissor))
                return false;
            bgfx::setScissor(uint16_t(clipped_scissor.x), uint16_t(clipped_scissor.y),
                             uint16_t(clipped_scissor.w), uint16_t(clipped_scissor.h));
        }
        bgfx::setVertexBuffer(0, fullscreen_vb);
        bgfx::setTexture(0, sampler, op.source.texture);
        const float* uv_bounds = nullptr;
        std::array<float, 4> bounds{};
        if (op.source.texture_width > 0 && op.source.texture_height > 0 && !is_empty(source_rect)) {
            bounds = uv_rect_for_source_region(source_rect, op.source.texture_width,
                                               op.source.texture_height);
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

    FilterApplyResult apply_filters(TextureRegion source, const RenderBounds& source_bounds,
                                    Rml::Span<const Rml::CompiledFilterHandle> filter_handles)
    {
        FilterApplyResult result;
        const GlobalFbRect source_valid_global_bounds =
            intersect(source.global_bounds, source_bounds.framebuffer);
        if (is_empty(source_valid_global_bounds) || !bgfx::isValid(source.texture))
            return {};

        source.global_bounds = source_valid_global_bounds;
        source.local_rect = {source_valid_global_bounds.x - source_bounds.framebuffer.x,
                             source_valid_global_bounds.y - source_bounds.framebuffer.y,
                             source_valid_global_bounds.w, source_valid_global_bounds.h};
        result.output = source;
        result.output_bounds.framebuffer = source_valid_global_bounds;
        result.output_bounds.logical = framebuffer_to_logical(source_valid_global_bounds, surface);
        if (filter_handles.empty())
            return result;

        std::vector<FilterRecord> filter_chain = resolved_filter_chain(filter_handles);
        if (filter_chain.empty())
            return result;

        const FilterExpansion total_expansion = filter_expansion_for(filter_handles);
        const FbRect expanded = expand_bounds(source_valid_global_bounds, total_expansion);
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

        const FbRect source_copy_global = intersect(source_bounds.framebuffer, clamped_work_bounds);
        if (is_empty(source_copy_global))
            return {};
        const FbRect source_copy_local{source_copy_global.x - source_bounds.framebuffer.x,
                                       source_copy_global.y - source_bounds.framebuffer.y,
                                       source_copy_global.w, source_copy_global.h};
        const FbRect copy_destination{source_copy_global.x - clamped_work_bounds.x,
                                      source_copy_global.y - clamped_work_bounds.y,
                                      source_copy_global.w, source_copy_global.h};
        if (!composite(make_composite_op(
                texture_region(source.texture, source_copy_global, source_copy_local,
                               source.texture_width, source.texture_height),
                primary->framebuffer, Rml::BlendMode::Replace, ScissorState{false, {}}, false, 1,
                RmlUiPassKind::Copy, "RmlUi.FilterCopy", copy_destination)))
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
                        texture_region(original, destination->bounds,
                                       LocalFbRect{0, 0, destination->texture_width,
                                                   destination->texture_height},
                                       destination->texture_width, destination->texture_height),
                        destination->framebuffer, Rml::BlendMode::Blend, ScissorState{false, {}},
                        false, 1, RmlUiPassKind::Postprocess, "RmlUi.FilterDropShadowComposite",
                        LocalFbRect{0, 0, destination->texture_width,
                                    destination->texture_height}))) {
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
        result.output =
            texture_region(current, clamped_work_bounds,
                           LocalFbRect{0, 0, clamped_work_bounds.w, clamped_work_bounds.h},
                           clamped_work_bounds.w, clamped_work_bounds.h);
        result.output_bounds.logical = source_bounds.logical;
        result.output_bounds.framebuffer = clamped_work_bounds;
        return result;
    }

    RenderTargetRecord* ensure_postprocess_target(PostprocessTargetKind kind, const FbRect& bounds)
    {
        const FbRect clamped_bounds =
            clamp_to_surface(align_outward_for_render_target(bounds), surface);
        if (is_empty(clamped_bounds))
            return nullptr;
        const int work_w = clamped_bounds.w;
        const int work_h = clamped_bounds.h;
        const bool target_is_full_frame = is_full_frame_rect(clamped_bounds, width, height);
        perf.add_postprocess_target_use(uint32_t(work_w), uint32_t(work_h), target_is_full_frame);
        for (RenderTargetRecord& target : postprocess_targets) {
            if (target.kind == kind && bgfx::isValid(target.framebuffer) &&
                target.texture_width == work_w && target.texture_height == work_h) {
                target.bounds = clamped_bounds;
                return &target;
            }
        }

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
        postprocess_targets.push_back({framebuffer, color, clamped_bounds, work_w, work_h, kind});
        RenderTargetRecord& target = postprocess_targets.back();
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

    void clear_active_stencil(uint8_t value, const ScissorState& scissor,
                              std::optional<FbRect> global_clear_bounds = std::nullopt)
    {
        LayerRecord* layer = current_layer();
        if (!layer)
            return;
        FbRect clear_bounds = clip_work_bounds(layer, scissor);
        if (global_clear_bounds) {
            clear_bounds =
                intersect(clear_bounds, local_rect_for_layer(*global_clear_bounds, *layer));
        }
        if (is_empty(clear_bounds))
            return;
        const bool is_full = is_full_frame_rect(clear_bounds, width, height);
        auto pass =
            acquire_pass(make_pass_request(RmlUiPassKind::Clear, 0, 0, false, true, clear_bounds.w,
                                           clear_bounds.h, "RmlUi.StencilClear"),
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
        const FbRect work_bounds =
            clip_work_bounds(layer, ScissorState{scissor_enabled, scissor_region});
        if (is_empty(work_bounds))
            return true;
        auto pass =
            acquire_pass(make_pass_request(RmlUiPassKind::Geometry, 0, 0, false, false,
                                           work_bounds.w, work_bounds.h, "RmlUi.StencilNormalize"),
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
                                                   work_bounds.w, work_bounds.h, "RmlUi.ClipMask"),
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
        LayerRecord* active = current_layer();
        std::optional<FbRect> command_bounds =
            command_fb_bounds(command.geometry, command.translation, command.scissor,
                              command.transform_valid, command.transform);
        std::optional<FbRect> set_clear_bounds = command_bounds;
        if (record_on_layer && active && active->conservative_mask_bounds.active &&
            set_clear_bounds) {
            set_clear_bounds =
                union_rects(*set_clear_bounds, active->conservative_mask_bounds.bounds);
        }
        switch (command.operation) {
        case Rml::ClipMaskOperation::Set:
            clear_active_stencil(0, command.scissor, set_clear_bounds);
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
                FbRect fallback_bounds = layer_limit_bounds(*layer);
                if (command.scissor.enabled) {
                    const FbRect scissor_bounds = scissor_fb_bounds(command.scissor);
                    if (!is_empty(scissor_bounds))
                        fallback_bounds = intersect(fallback_bounds, scissor_bounds);
                }
                if (command_bounds) {
                    layer->conservative_mask_bounds = update_conservative_mask_bounds(
                        layer->conservative_mask_bounds, command.operation, *command_bounds,
                        fallback_bounds);
                }
                const FbRect recorded_bounds =
                    command.scissor.enabled
                        ? active_scissor_bounds(command.scissor, layer->bounds.framebuffer)
                        : full_local_rect(*layer);
                if (!is_empty(recorded_bounds)) {
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
                const FbRect command_bounds =
                    command.scissor.enabled
                        ? active_scissor_bounds(command.scissor, layer->bounds.framebuffer)
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

    ShaderProvider* shader_provider = nullptr;
    TextureLoader* textures_provider = nullptr;
    Diagnostics* diagnostics = nullptr;
    PerfLogger* perf_logger = nullptr;
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
    std::deque<RenderTargetRecord> postprocess_targets;
    std::vector<Rml::LayerHandle> layer_stack;
    LayerPoolPlan layer_pool;
    PostprocessPoolPlan postprocess_pool;
    Rml::CompiledGeometryHandle geometry_counter = 0;
    bgfx::VertexBufferHandle fullscreen_vb = BGFX_INVALID_HANDLE;
    Rml::TextureHandle texture_counter = 0;
    Rml::CompiledFilterHandle filter_counter = 0;
    Rml::CompiledShaderHandle shader_counter = 0;
    Rml::LayerHandle active_layer = 0;
    RmlUiRenderPassScheduler pass_scheduler;
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
    bool direct_base_requested = false;
    bool direct_base_presented = false;
    bool root_requires_preservation = false;
    const char* direct_base_fallback_reason = nullptr;
    const char* logged_base_fallback_reason = nullptr;
    bool base_direct_compatibility_enabled = false;

    // Cached stencil format (probed once to avoid getInternalformatParameter spam).
    mutable bool stencil_cached = false;
    mutable bgfx::TextureFormat::Enum cached_stencil_format = bgfx::TextureFormat::Unknown;

    rmlui_bgfx::PerfCounters perf;
    bool perf_logging_enabled = false;

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

RenderInterface::RenderInterface(RendererConfig config) : m_impl(std::make_unique<Impl>(config)) {}

RenderInterface::~RenderInterface() = default;

RenderInterface::operator bool() const
{
    return m_impl && bgfx::isValid(m_impl->program) && bgfx::isValid(m_impl->composite_program) &&
           bgfx::isValid(m_impl->copy_program) && bgfx::isValid(m_impl->opacity_program) &&
           bgfx::isValid(m_impl->color_matrix_program) &&
           bgfx::isValid(m_impl->mask_multiply_program) && bgfx::isValid(m_impl->blur_program) &&
           bgfx::isValid(m_impl->drop_shadow_program) && bgfx::isValid(m_impl->gradient_program);
}

void RenderInterface::resize(const SurfaceMetrics& surface) { m_impl->resize(surface); }

void RenderInterface::begin_frame()
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

void RenderInterface::end_frame()
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
    if (!m_impl->direct_base_requested) {
        if (LayerRecord* base = m_impl->layer_for_handle(0)) {
            if (!m_impl->composite(make_composite_op(
                    texture_region(base->color, base->bounds.framebuffer, full_local_rect(*base),
                                   base->texture_width, base->texture_height),
                    BGFX_INVALID_HANDLE, Rml::BlendMode::Blend, ScissorState{false, {}}, false, 1,
                    RmlUiPassKind::FinalComposite, "RmlUi.FinalComposite",
                    LocalFbRect{0, 0, m_impl->width, m_impl->height}))) {
                m_impl->fail_frame("end_frame final composite failed");
            }
        }
    } else {
        m_impl->direct_base_presented = true;
        if (m_impl->direct_base_fallback_reason) {
            std::fprintf(stderr, "[rmlui] direct base presentation: %s\n",
                         m_impl->direct_base_fallback_reason);
        }
    }

    // Per-frame performance logging (~1 Hz, gated by runtime flag).
    {
#ifdef RMLUI_BGFX_ENABLE_RENDER_PERF
        static double last_log_time = 0.0;
        static int frame_count = 0;
        frame_count++;
        const int64_t now_ticks = bx::getHPCounter();
        const double now = double(now_ticks) / double(bx::getHPFrequency());
        if (m_impl->perf_logging_enabled && now - last_log_time >= 1.0) {
            const auto& p = m_impl->perf;
            char line[2048];
            std::snprintf(
                line, sizeof(line),
                "[perf] fps=%.0f passes=%u geom=%u clip=%u gradients=%u "
                "layers=%u full_layers=%u bounded_layers=%u "
                "full_frame_child_layers=%u bounded_child_layers=%u "
                "unbounded_layer_fallbacks=%u "
                "unbounded_no_scissor_fallbacks=%u "
                "unbounded_transform_fallbacks=%u "
                "unbounded_inverse_clip_fallbacks=%u "
                "filters=%u blur=%u shadow=%u mask=%u "
                "base_direct=%u base_offscreen=%u base_fallback=%u "
                "clear_px=%llu copy_px=%llu composite_px=%llu post_px=%llu "
                "full_frame_passes=%u bounded_passes=%u "
                "full_frame_clear_passes=%u bounded_clear_passes=%u "
                "full_frame_composite_passes=%u bounded_composite_passes=%u "
                "full_frame_postprocess_passes=%u bounded_postprocess_passes=%u "
                "full_frame_postprocess_target_uses=%u bounded_postprocess_target_uses=%u "
                "full_frame_postprocess_targets=%u bounded_postprocess_targets=%u "
                "rt_alloc=%u rt_destroy=%u layer_alloc=%u layer_destroy=%u "
                "max_layer=%ux%u max_child_layer=%ux%u max_child_rt=%ux%u "
                "max_rt=%ux%u fb=%dx%d",
                double(frame_count) / (now - last_log_time), p.pass_count, p.geometry_draws,
                p.clip_mask_draws, p.gradient_draws, p.layer_pushes, p.full_frame_layers,
                p.bounded_layers, p.full_frame_child_layers, p.bounded_child_layers,
                p.unbounded_layer_fallbacks, p.unbounded_no_scissor_fallbacks,
                p.unbounded_transform_fallbacks, p.unbounded_inverse_clip_fallbacks,
                p.postprocess_passes, p.blur_passes, p.dropshadow_passes, p.mask_passes,
                p.direct_base_presentations, p.offscreen_base_presentations,
                p.direct_base_fallbacks, (unsigned long long)p.clear_pixels,
                (unsigned long long)p.copy_pixels, (unsigned long long)p.composite_pixels,
                (unsigned long long)p.postprocess_pixels, p.full_frame_passes, p.bounded_passes,
                p.full_frame_clear_passes, p.bounded_clear_passes, p.full_frame_composite_passes,
                p.bounded_composite_passes, p.full_frame_postprocess_passes,
                p.bounded_postprocess_passes, p.full_frame_postprocess_target_uses,
                p.bounded_postprocess_target_uses, p.full_frame_postprocess_targets,
                p.bounded_postprocess_targets, p.postprocess_allocations, p.postprocess_destroys,
                p.layer_allocations, p.layer_destroys, p.max_layer_width, p.max_layer_height,
                p.max_child_layer_width, p.max_child_layer_height, p.max_child_layer_width,
                p.max_child_layer_height, p.max_postprocess_width, p.max_postprocess_height,
                m_impl->width, m_impl->height);
            m_impl->log_perf_line(line);
            frame_count = 0;
            last_log_time = now;
        }
#endif
    }
}

Rml::CompiledGeometryHandle RenderInterface::CompileGeometry(Rml::Span<const Rml::Vertex> vertices,
                                                             Rml::Span<const int> indices)
{
    if (vertices.empty() || indices.empty() ||
        vertices.size() > std::numeric_limits<uint32_t>::max() ||
        indices.size() > std::numeric_limits<uint32_t>::max()) {
        return 0;
    }
    const GeometryBoundsResult local_bounds = compute_indexed_geometry_bounds(vertices, indices);
    if (local_bounds.status != GeometryBoundsStatus::Valid) {
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
    m_impl->geometries.emplace(
        handle, GeometryRecord{vb, ib, uint32_t(converted_indices.size()), local_bounds.logical});
    return handle;
}

void RenderInterface::RenderGeometry(Rml::CompiledGeometryHandle geometry,
                                     Rml::Vector2f translation, Rml::TextureHandle texture)
{
    auto it = m_impl->geometries.find(geometry);
    if (it == m_impl->geometries.end())
        return;
    if (m_impl->active_layer_is_recording()) {
        m_impl->record_geometry_command(geometry, translation, texture);
        return;
    }
    m_impl->submit(it->second, translation, texture);
}

void RenderInterface::ReleaseGeometry(Rml::CompiledGeometryHandle geometry)
{
    if (auto it = m_impl->geometries.find(geometry); it != m_impl->geometries.end()) {
        Impl::destroy_geometry(it->second);
        m_impl->geometries.erase(it);
    }
}

Rml::TextureHandle RenderInterface::LoadTexture(Rml::Vector2i& texture_dimensions,
                                                const Rml::String& source)
{
    texture_dimensions = {};
    if (!m_impl->textures_provider) {
        m_impl->log_error("texture loader is not configured");
        return 0;
    }

    LoadedTexture loaded;
    std::string error_message;
    if (!m_impl->textures_provider->load_rgba8(source.c_str(), loaded, &error_message) ||
        loaded.width <= 0 || loaded.height <= 0 ||
        loaded.rgba8.size() != size_t(loaded.width) * size_t(loaded.height) * 4u) {
        std::string message = "texture load failed: ";
        message += source.c_str();
        if (!error_message.empty()) {
            message += " (";
            message += error_message;
            message += ")";
        }
        m_impl->log_error(message);
        return 0;
    }

    const int width = loaded.width;
    const int height = loaded.height;
    Rml::TextureHandle handle =
        m_impl->create_texture_from_rgba(std::move(loaded.rgba8), width, height, false);
    if (handle != 0) {
        texture_dimensions = {width, height};
    }
    return handle;
}

Rml::TextureHandle RenderInterface::GenerateTexture(Rml::Span<const Rml::byte> source,
                                                    Rml::Vector2i source_dimensions)
{
    if (source.empty()) {
        return 0;
    }
    std::vector<uint8_t> rgba(source.begin(), source.end());
    return m_impl->create_texture_from_rgba(std::move(rgba), source_dimensions.x,
                                            source_dimensions.y, true);
}

void RenderInterface::ReleaseTexture(Rml::TextureHandle texture)
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

void RenderInterface::EnableScissorRegion(bool enable) { m_impl->scissor_enabled = enable; }
void RenderInterface::SetScissorRegion(Rml::Rectanglei region)
{
    m_impl->scissor_region = clamp_scissor(logical_scissor_to_framebuffer(region, m_impl->surface),
                                           m_impl->width, m_impl->height);
}

void RenderInterface::SetTransform(const Rml::Matrix4f* transform)
{
    if (transform) {
        m_impl->transform_valid = true;
        std::memcpy(m_impl->transform, transform->data(), sizeof(m_impl->transform));
    } else {
        m_impl->transform_valid = false;
    }
}

void RenderInterface::EnableClipMask(bool enable)
{
    if (LayerRecord* layer = m_impl->current_layer()) {
        layer->clip_mask_enabled = enable;
    }
}

void RenderInterface::RenderToClipMask(Rml::ClipMaskOperation operation,
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
    if (m_impl->active_layer_is_recording()) {
        m_impl->record_clip_mask_command(command);
        return;
    }
    m_impl->apply_clip_command(command, true);
}

Rml::LayerHandle RenderInterface::PushLayer()
{
    m_impl->perf.add_layer_push();
    const Rml::LayerHandle parent = m_impl->active_layer;
    const Rml::LayerHandle handle = Rml::LayerHandle(m_impl->layer_pool.push());
    if (uint32_t(handle) == LayerPoolPlan::InvalidLayer)
        return handle;
    if (size_t(handle) >= m_impl->layers.size())
        m_impl->layers.resize(size_t(handle) + 1);

    LayerRecord preserved_resources;
    if (size_t(handle) < m_impl->layers.size()) {
        LayerRecord& previous = m_impl->layers[size_t(handle)];
        preserved_resources.framebuffer = previous.framebuffer;
        preserved_resources.color = previous.color;
        preserved_resources.depth_stencil = previous.depth_stencil;
        preserved_resources.texture_width = previous.texture_width;
        preserved_resources.texture_height = previous.texture_height;
        previous.framebuffer = BGFX_INVALID_HANDLE;
        previous.color = BGFX_INVALID_HANDLE;
        previous.depth_stencil = BGFX_INVALID_HANDLE;
        previous.texture_width = 0;
        previous.texture_height = 0;
    }

    const ScissorState push_scissor{m_impl->scissor_enabled, m_impl->scissor_region};
    const bool push_transform_valid = m_impl->transform_valid;
    const RenderBounds provisional_bounds =
        m_impl->compute_child_layer_bounds(parent, push_scissor, push_transform_valid, false);

    LayerRecord child;
    child.framebuffer = preserved_resources.framebuffer;
    child.color = preserved_resources.color;
    child.depth_stencil = preserved_resources.depth_stencil;
    child.texture_width = preserved_resources.texture_width;
    child.texture_height = preserved_resources.texture_height;
    child.kind = LayerKind::VirtualChild;
    child.parent_layer = parent;
    child.bounds = provisional_bounds;
    child.push_scissor = push_scissor;
    child.push_transform_valid = push_transform_valid;
    child.recording = true;
    child.materialized = false;
    child.clear_pending = true;

    if (size_t(parent) < m_impl->layers.size()) {
        const LayerRecord& parent_layer = m_impl->layers[size_t(parent)];
        child.clip_mask_enabled = parent_layer.clip_mask_enabled;
        child.stencil_ref = parent_layer.stencil_ref;
        child.conservative_mask_bounds = parent_layer.conservative_mask_bounds;
        child.clip_commands = parent_layer.clip_commands;
        child.inherited_clip_command_count = child.clip_commands.size();
    }

    m_impl->layers[size_t(handle)] = std::move(child);
    m_impl->layer_stack.push_back(handle);
    m_impl->active_layer = handle;
    return handle;
}

void RenderInterface::CompositeLayers(Rml::LayerHandle source, Rml::LayerHandle destination,
                                      Rml::BlendMode blend_mode,
                                      Rml::Span<const Rml::CompiledFilterHandle> filters)
{
    LayerRecord* source_layer = m_impl->layer_for_handle(source);
    LayerRecord* destination_layer = m_impl->layer_for_handle(destination);
    if (!source_layer || !destination_layer) {
        m_impl->fail_frame("CompositeLayers received invalid layer handles");
        return;
    }
    if (m_impl->direct_base_requested && size_t(destination) == 0 && !filters.empty()) {
        m_impl->root_requires_preservation = true;
        m_impl->fail_frame("CompositeLayers root filters require offscreen presentation");
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

    FbRect source_required = m_impl->layer_recorded_content_bounds(*source_layer);
    const FilterExpansion expansion = m_impl->filter_expansion_for(filters);
    if (!is_empty(source_required)) {
        source_required = clamp_to_surface(
            align_outward_for_render_target(expand_bounds(source_required, expansion)),
            m_impl->surface);
    }

    if (!m_impl->materialize_layer(source, source_required)) {
        m_impl->fail_frame("CompositeLayers failed to materialize source layer");
        return;
    }
    source_layer = m_impl->materialized_layer_for_handle(source);
    if (!source_layer) {
        m_impl->fail_frame("CompositeLayers received unmaterialized source layer");
        return;
    }

    const FbRect source_valid_global =
        source_layer->has_valid_content_bounds
            ? intersect(source_layer->valid_content_bounds, source_layer->bounds.framebuffer)
            : source_layer->bounds.framebuffer;

    if (source == destination) {
        const FbRect scratch_global_bounds = source_layer->bounds.framebuffer;
        RenderTargetRecord* scratch = m_impl->ensure_postprocess_target(
            PostprocessTargetKind::Scratch, scratch_global_bounds);
        if (!scratch) {
            m_impl->fail_frame("CompositeLayers failed to create scratch target");
            return;
        }
        source_layer = m_impl->materialized_layer_for_handle(source);
        destination_layer = m_impl->materialized_layer_for_handle(destination);
        if (!source_layer || !destination_layer)
            return;
        const FbRect scratch_local_bounds{0, 0, scratch->texture_width, scratch->texture_height};
        if (!m_impl->composite(make_composite_op(
                texture_region(source_layer->color, source_layer->bounds.framebuffer,
                               full_local_rect(*source_layer), source_layer->texture_width,
                               source_layer->texture_height),
                scratch->framebuffer, Rml::BlendMode::Replace, ScissorState{false, {}}, false, 1,
                RmlUiPassKind::Copy, "RmlUi.LayerScratchCopy", scratch_local_bounds))) {
            m_impl->fail_frame("CompositeLayers scratch copy failed");
            return;
        }
        const FilterApplyResult filtered = m_impl->apply_filters(
            texture_region(scratch->color, source_valid_global,
                           LocalFbRect{source_valid_global.x - source_layer->bounds.framebuffer.x,
                                       source_valid_global.y - source_layer->bounds.framebuffer.y,
                                       source_valid_global.w, source_valid_global.h},
                           scratch->texture_width, scratch->texture_height),
            source_layer->bounds, filters);
        if (!bgfx::isValid(filtered.output.texture))
            return;
        destination_layer = m_impl->materialized_layer_for_handle(destination);
        if (!destination_layer)
            return;
        const bool destination_clip = destination_layer->clip_mask_enabled;
        const uint8_t destination_stencil_ref = destination_layer->stencil_ref;
        const ScissorState destination_scissor =
            scissor_local_to_layer(scissor_state, destination_layer->bounds);
        const FbRect destination_bounds =
            local_rect_for_layer(filtered.output_bounds.framebuffer, *destination_layer);
        if (is_empty(destination_bounds))
            return;
        if (!m_impl->composite(make_composite_op(
                filtered.output, destination_layer->framebuffer, blend_mode, destination_scissor,
                destination_clip, destination_stencil_ref, RmlUiPassKind::LayerComposite,
                "RmlUi.LayerComposite", destination_bounds))) {
            m_impl->fail_frame("CompositeLayers composite failed");
            return;
        }
        return;
    }

    const FilterApplyResult filtered = m_impl->apply_filters(
        texture_region(source_layer->color, source_valid_global,
                       local_rect_for_layer(source_valid_global, *source_layer),
                       source_layer->texture_width, source_layer->texture_height),
        source_layer->bounds, filters);
    if (!bgfx::isValid(filtered.output.texture))
        return;

    if (!m_impl->materialize_layer(destination, filtered.output_bounds.framebuffer)) {
        m_impl->fail_frame("CompositeLayers failed to materialize destination layer");
        return;
    }
    destination_layer = m_impl->materialized_layer_for_handle(destination);
    if (!destination_layer) {
        m_impl->fail_frame("CompositeLayers received unmaterialized destination layer");
        return;
    }
    const bool destination_clip = destination_layer->clip_mask_enabled;
    const uint8_t destination_stencil_ref = destination_layer->stencil_ref;
    const ScissorState destination_scissor =
        scissor_local_to_layer(scissor_state, destination_layer->bounds);
    const FbRect destination_bounds =
        local_rect_for_layer(filtered.output_bounds.framebuffer, *destination_layer);
    if (is_empty(destination_bounds))
        return;
    if (!m_impl->composite(make_composite_op(filtered.output, destination_layer->framebuffer,
                                             blend_mode, destination_scissor, destination_clip,
                                             destination_stencil_ref, RmlUiPassKind::LayerComposite,
                                             "RmlUi.LayerComposite", destination_bounds))) {
        m_impl->fail_frame("CompositeLayers composite failed");
    }
}

void RenderInterface::PopLayer()
{
    if (m_impl->layer_stack.size() <= 1) {
        std::fprintf(stderr, "[rmlui] attempted to pop the base RmlUi layer\n");
        return;
    }
    m_impl->layer_stack.pop_back();
    m_impl->active_layer = m_impl->layer_stack.back();
}

Rml::TextureHandle RenderInterface::SaveLayerAsTexture()
{
    if (m_impl->frame_failed)
        return 0;
    if (m_impl->direct_base_requested && size_t(m_impl->active_layer) == 0) {
        m_impl->root_requires_preservation = true;
        m_impl->fail_frame("SaveLayerAsTexture requires offscreen root");
        return 0;
    }
    if (!m_impl->materialize_layer(m_impl->active_layer)) {
        m_impl->fail_frame("SaveLayerAsTexture failed to materialize layer");
        return 0;
    }
    LayerRecord* layer = m_impl->materialized_layer_for_handle(m_impl->active_layer);
    if (!layer || !bgfx::isValid(layer->color))
        return 0;

    const Rml::Rectanglei bounds = m_impl->current_save_bounds();
    if (bounds.Width() <= 0 || bounds.Height() <= 0)
        return 0;
    const FbRect global_bounds{bounds.Left(), bounds.Top(), bounds.Width(), bounds.Height()};
    const FbRect local_bounds = local_rect_for_layer(global_bounds, *layer);
    if (is_empty(local_bounds))
        return 0;

    bgfx::TextureHandle texture = m_impl->copy_region_to_texture(
        layer->color, rectangle_from_fb(local_bounds), layer->texture_width, layer->texture_height,
        "RmlUi.SaveLayerAsTexture");
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

Rml::CompiledFilterHandle RenderInterface::SaveLayerAsMaskImage()
{
    if (m_impl->frame_failed)
        return 0;
    if (m_impl->direct_base_requested && size_t(m_impl->active_layer) == 0) {
        m_impl->root_requires_preservation = true;
        m_impl->fail_frame("SaveLayerAsMaskImage requires offscreen root");
        return 0;
    }
    if (!m_impl->materialize_layer(m_impl->active_layer)) {
        m_impl->fail_frame("SaveLayerAsMaskImage failed to materialize layer");
        return 0;
    }
    LayerRecord* layer = m_impl->materialized_layer_for_handle(m_impl->active_layer);
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

Rml::CompiledFilterHandle RenderInterface::CompileFilter(const Rml::String& name,
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

void RenderInterface::ReleaseFilter(Rml::CompiledFilterHandle filter)
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

Rml::CompiledShaderHandle RenderInterface::CompileShader(const Rml::String& name,
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

void RenderInterface::RenderShader(Rml::CompiledShaderHandle shader,
                                   Rml::CompiledGeometryHandle geometry, Rml::Vector2f translation,
                                   Rml::TextureHandle texture)
{
    auto shader_it = m_impl->shaders.find(shader);
    auto geometry_it = m_impl->geometries.find(geometry);
    if (shader_it == m_impl->shaders.end() || geometry_it == m_impl->geometries.end())
        return;
    if (m_impl->active_layer_is_recording()) {
        m_impl->record_shader_command(shader, geometry, translation, texture);
        return;
    }
    m_impl->submit_gradient(shader_it->second, geometry_it->second, translation);
}

void RenderInterface::ReleaseShader(Rml::CompiledShaderHandle shader)
{
    m_impl->shaders.erase(shader);
}

void RenderInterface::set_perf_logging_enabled(bool enabled)
{
    m_impl->perf_logging_enabled = enabled;
}

void RenderInterface::set_base_direct_compatibility(bool enabled)
{
    m_impl->base_direct_compatibility_enabled = enabled;
}

} // namespace rmlui_bgfx
