#include "noveltea/renderer.hpp"

#include "bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include <SDL3/SDL_log.h>
#include <bgfx/bgfx.h>

#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <vector>

namespace noveltea {

using namespace bgfx_backend;

namespace {

void make_pixel_ortho(float* out, float width, float height)
{
    std::memset(out, 0, sizeof(float) * 16);
    out[0] = 2.0f / width;
    out[5] = -2.0f / height;
    out[10] = 1.0f;
    out[12] = -1.0f;
    out[13] = 1.0f;
    out[15] = 1.0f;
}

struct QuadVertex {
    float x, y;
    float u, v;
    float r, g, b, a;
};

bgfx::ViewId game_layer_view_id(GameLayer layer)
{
    switch (layer) {
    case GameLayer::Background:
        return ViewGameLayerBackground;
    case GameLayer::Main:
        return ViewGameLayerMain;
    case GameLayer::Foreground:
        return ViewGameLayerForeground;
    case GameLayer::UIOverlay:
        return ViewGameLayerUIOverlay;
    default:
        return ViewGameLayerMain;
    }
}

bool set_quad_buffers(const QuadCommand& command)
{
    constexpr uint16_t indices[] = {0, 1, 2, 0, 2, 3};
    const float x = command.rect.x;
    const float y = command.rect.y;
    const float w = command.rect.width;
    const float h = command.rect.height;
    const float u0 = command.uv.x;
    const float v0 = command.uv.y;
    const float u1 = command.uv.x + command.uv.width;
    const float v1 = command.uv.y + command.uv.height;
    const Color color = command.color;
    QuadVertex vertices[] = {
        {x, y, u0, v0, color.r, color.g, color.b, color.a},
        {x + w, y, u1, v0, color.r, color.g, color.b, color.a},
        {x + w, y + h, u1, v1, color.r, color.g, color.b, color.a},
        {x, y + h, u0, v1, color.r, color.g, color.b, color.a},
    };
    if (command.rotation_degrees != 0.0f) {
        constexpr float degrees_to_radians = 0.017453292519943295769f;
        const float radians = command.rotation_degrees * degrees_to_radians;
        const float sine = std::sin(radians);
        const float cosine = std::cos(radians);
        for (auto& vertex : vertices) {
            const float local_x = vertex.x - command.rotation_origin.x;
            const float local_y = vertex.y - command.rotation_origin.y;
            vertex.x = command.rotation_origin.x + local_x * cosine - local_y * sine;
            vertex.y = command.rotation_origin.y + local_x * sine + local_y * cosine;
        }
    }

    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();

    bgfx::TransientVertexBuffer tvb;
    bgfx::TransientIndexBuffer tib;
    if (!bgfx::allocTransientBuffers(&tvb, layout, 4, &tib, 6)) {
        return false;
    }
    std::memcpy(tvb.data, vertices, sizeof(vertices));
    std::memcpy(tib.data, indices, sizeof(indices));

    bgfx::setVertexBuffer(0, &tvb);
    bgfx::setIndexBuffer(&tib);
    return true;
}

bool transition_mode_uses_pass(WorldTransitionSceneMode mode, WorldCompositionPass pass)
{
    if (pass == WorldCompositionPass::Source)
        return mode != WorldTransitionSceneMode::TargetOnly;
    if (pass == WorldCompositionPass::Target)
        return mode != WorldTransitionSceneMode::SourceOnly;
    return false;
}

std::size_t transition_world_target_index(WorldCompositionPass pass)
{
    return pass == WorldCompositionPass::Source ? 0u : 1u;
}

std::size_t transition_scene_target_index(WorldTransitionSceneMode mode, WorldCompositionPass pass)
{
    if (mode == WorldTransitionSceneMode::Dual && pass == WorldCompositionPass::Target)
        return 1u;
    return 0u;
}

bgfx::ViewId transition_scene_composite_view(WorldCompositionPass pass)
{
    return pass == WorldCompositionPass::Source ? ViewWorldSourceSceneComposite
                                                : ViewWorldTargetSceneComposite;
}

const char* transition_scene_mode_name(WorldTransitionSceneMode mode)
{
    switch (mode) {
    case WorldTransitionSceneMode::SourceOnly:
        return "source-only";
    case WorldTransitionSceneMode::TargetOnly:
        return "target-only";
    case WorldTransitionSceneMode::Dual:
        return "dual";
    }
    return "unknown";
}

} // namespace

void Renderer::draw_2d(const QuadBatch& batch)
{
    if (!m_initialized || !bgfx::isValid(bgfx::ProgramHandle{m_quad_program})) {
        return;
    }

    for (const QuadCommand& command : batch.commands()) {
        submit_quad(command);
    }
}

void Renderer::draw_world_2d(const QuadBatch& batch, WorldCompositionPass pass, float opacity)
{
    if (!m_initialized || !bgfx::isValid(bgfx::ProgramHandle{m_quad_program}))
        return;
    opacity = std::clamp(opacity, 0.0f, 1.0f);
    for (const QuadCommand& command : batch.commands()) {
        bgfx::ViewId view = ViewWorldTargetContent;
        switch (pass) {
        case WorldCompositionPass::Ordinary:
            if (command.layer == GameLayer::Background)
                view = ViewWorldTargetBackground;
            else if (command.layer == GameLayer::Foreground)
                view = ViewWorldNativeOverlay;
            else
                view = ViewWorldTargetContent;
            break;
        case WorldCompositionPass::Source:
            view = command.layer == GameLayer::Background ? ViewWorldSourceBackground
                                                          : ViewWorldSourceContent;
            break;
        case WorldCompositionPass::Target:
            view = command.layer == GameLayer::Background ? ViewWorldTargetBackground
                                                          : ViewWorldTargetContent;
            break;
        case WorldCompositionPass::GameUiUnderlay:
            view = ViewGameUiUnderlay;
            break;
        }
        submit_quad(command, view, opacity);
    }
}

bool Renderer::prepare_ordinary_world_surface()
{
    if (!m_initialized)
        return false;
    const auto width = static_cast<std::uint16_t>(std::max(world_raster().size.width, 1));
    const auto height = static_cast<std::uint16_t>(std::max(world_raster().size.height, 1));
    const bool valid = bgfx::isValid(bgfx::TextureHandle{m_world_color_texture}) &&
                       bgfx::isValid(bgfx::FrameBufferHandle{m_world_color_framebuffer}) &&
                       m_world_color_width == width && m_world_color_height == height &&
                       m_world_color_policy == world_raster().policy;
    if (!valid) {
        destroy_ordinary_world_surface();
        const std::uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        const auto texture =
            bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(texture))
            return false;
        const auto framebuffer = bgfx::createFrameBuffer(1, &texture, false);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(texture);
            return false;
        }
        m_world_color_texture = texture.idx;
        m_world_color_framebuffer = framebuffer.idx;
        m_world_color_width = width;
        m_world_color_height = height;
        m_world_color_policy = world_raster().policy;
        SDL_Log("[renderer] allocated world color target %ux%u policy=%s", width, height,
                m_world_color_policy == WorldRasterPolicy::Capped ? "capped" : "native");
    }
    configure_ordinary_world_surface();
    return true;
}

void Renderer::configure_ordinary_world_surface()
{
    if (!bgfx::isValid(bgfx::FrameBufferHandle{m_world_color_framebuffer}))
        return;
    const auto framebuffer = bgfx::FrameBufferHandle{m_world_color_framebuffer};
    for (const auto view : {ViewWorldTargetBackground, ViewWorldTargetContent}) {
        bgfx::setViewFrameBuffer(view, framebuffer);
        bgfx::setViewRect(view, 0, 0, m_world_color_width, m_world_color_height);
    }
    bgfx::setViewClear(ViewWorldTargetBackground, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff,
                       1.0f, 0);
    bgfx::touch(ViewWorldTargetBackground);
    bgfx::touch(ViewWorldTargetContent);
}

void Renderer::composite_ordinary_world_surface()
{
    if (!m_initialized || !bgfx::isValid(bgfx::TextureHandle{m_world_color_texture}))
        return;
    QuadCommand command;
    command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                    static_cast<float>(reference_height())};
    command.texture = Texture{m_world_color_texture};
    command.texture_sampler = MaterialTextureSampler::ClampLinear;
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    command.color = {1.0f, 1.0f, 1.0f, 1.0f};
    submit_default_quad(command, ViewWorldOrdinaryComposite);
}

void Renderer::set_postprocess_material(std::optional<MaterialId> material)
{
    if (m_postprocess_material == material)
        return;
    m_postprocess_material = std::move(material);
    m_active_postprocess_scope.reset();
    if (!m_postprocess_material)
        destroy_postprocess_surface();
}

void Renderer::set_runtime_postprocess_stack(std::vector<RuntimePostprocessPass> passes)
{
    if (m_runtime_postprocess_stack == passes)
        return;
    m_runtime_postprocess_stack = std::move(passes);
    std::erase_if(m_postprocess_epochs, [&](const auto& entry) {
        return std::none_of(m_runtime_postprocess_stack.begin(), m_runtime_postprocess_stack.end(),
                            [&](const RuntimePostprocessPass& pass) {
                                return entry.first.starts_with(pass.stable_identity + "/");
                            });
    });
    m_active_postprocess_scope.reset();
    if (m_runtime_postprocess_stack.empty() && !m_postprocess_material)
        destroy_postprocess_surface();
}

void Renderer::set_runtime_material_times(float gameplay_seconds, float unscaled_seconds,
                                          float camera_zoom) noexcept
{
    m_runtime_gameplay_seconds = std::max(gameplay_seconds, 0.0f);
    m_runtime_unscaled_seconds = std::max(unscaled_seconds, 0.0f);
    m_runtime_camera_zoom = std::isfinite(camera_zoom) && camera_zoom > 0.0f ? camera_zoom : 1.0f;
}

bool Renderer::prepare_postprocess_surface(bool full_world_transition)
{
    m_active_postprocess_scope.reset();
    if (m_runtime_postprocess_stack.empty() && !m_postprocess_material) {
        destroy_postprocess_surface();
        return true;
    }
    if (!m_initialized || !m_shader_materials || !m_material_binder)
        return false;

    std::vector<RuntimePostprocessPass> tooling_pass;
    const std::vector<RuntimePostprocessPass>* passes = &m_runtime_postprocess_stack;
    if (passes->empty() && m_postprocess_material) {
        const MaterialDefinition* material =
            find_material(*m_shader_materials, *m_postprocess_material);
        if (material == nullptr || material->role != ShaderRole::Postprocess) {
            SDL_LogError(
                SDL_LOG_CATEGORY_APPLICATION,
                "[renderer] active postprocess material '%s' is missing or not postprocess",
                m_postprocess_material->string().c_str());
            destroy_postprocess_surface();
            return false;
        }
        tooling_pass.push_back(RuntimePostprocessPass{
            "tooling", *m_postprocess_material, material->postprocess_scope, {}});
        passes = &tooling_pass;
    }

    std::size_t world_count = 0;
    std::size_t full_count = 0;
    for (const auto& pass : *passes) {
        const MaterialDefinition* material = find_material(*m_shader_materials, pass.material);
        if (material == nullptr || material->role != ShaderRole::Postprocess ||
            material->postprocess_scope != pass.scope) {
            SDL_LogError(
                SDL_LOG_CATEGORY_APPLICATION,
                "[renderer] runtime postprocess material '%s' is missing or has incompatible scope",
                pass.material.string().c_str());
            destroy_postprocess_surface();
            return false;
        }
        if (pass.scope == PostprocessScope::World)
            ++world_count;
        else
            ++full_count;
    }
    if (world_count > 4 || full_count > 4) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[renderer] postprocess stack exceeds four effects per scope");
        destroy_postprocess_surface();
        return false;
    }

    const auto width = static_cast<std::uint16_t>(std::max(ui_raster_width(), 1));
    const auto height = static_cast<std::uint16_t>(std::max(ui_raster_height(), 1));
    const auto valid_target = [](const RenderTargetHandles& target) {
        return bgfx::isValid(bgfx::TextureHandle{target.texture}) &&
               bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
    };
    const bool needs_pingpong = std::max(world_count, full_count) > 1;
    const bool valid = m_postprocess_scene_width == width && m_postprocess_scene_height == height &&
                       (!world_count || valid_target(m_postprocess_scene_targets[0])) &&
                       (!full_count || valid_target(m_postprocess_scene_targets[1])) &&
                       (!needs_pingpong || (valid_target(m_postprocess_pingpong_targets[0]) &&
                                            valid_target(m_postprocess_pingpong_targets[1])));
    if (!valid) {
        destroy_postprocess_surface();
        const std::uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        const auto create_target = [&](RenderTargetHandles& target) {
            const auto texture =
                bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::RGBA8, flags);
            if (!bgfx::isValid(texture))
                return false;
            const auto framebuffer = bgfx::createFrameBuffer(1, &texture, false);
            if (!bgfx::isValid(framebuffer)) {
                bgfx::destroy(texture);
                return false;
            }
            target = {.texture = texture.idx, .framebuffer = framebuffer.idx};
            return true;
        };
        if ((world_count && !create_target(m_postprocess_scene_targets[0])) ||
            (full_count && !create_target(m_postprocess_scene_targets[1])) ||
            (needs_pingpong && (!create_target(m_postprocess_pingpong_targets[0]) ||
                                !create_target(m_postprocess_pingpong_targets[1])))) {
            destroy_postprocess_surface();
            return false;
        }
        m_postprocess_scene_width = width;
        m_postprocess_scene_height = height;
        ++m_postprocess_surface_diagnostics.allocations;
        SDL_Log("[renderer] allocated postprocess stack targets %ux%u world=%zu full=%zu", width,
                height, world_count, full_count);
    } else {
        ++m_postprocess_surface_diagnostics.reuses;
    }

    const auto capture_target =
        world_count ? m_postprocess_scene_targets[0] : m_postprocess_scene_targets[1];
    const auto framebuffer = bgfx::FrameBufferHandle{capture_target.framebuffer};
    bgfx::setViewFrameBuffer(ViewPostprocessSceneClear, framebuffer);
    bgfx::setViewRect(ViewPostprocessSceneClear, 0, 0, width, height);
    bgfx::setViewClear(ViewPostprocessSceneClear, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff,
                       1.0f, 0);
    bgfx::touch(ViewPostprocessSceneClear);

    const auto route_to_capture = [&](bgfx::ViewId view) {
        bgfx::setViewFrameBuffer(view, framebuffer);
        bgfx::setViewRect(view, 0, 0, width, height);
    };
    if (full_world_transition) {
        route_to_capture(ViewWorldTransitionSourceComposite);
        route_to_capture(ViewWorldTransitionTargetComposite);
        route_to_capture(ViewGameTransition);
    } else {
        route_to_capture(ViewWorldOrdinaryComposite);
        route_to_capture(ViewWorldNativeOverlay);
    }

    if (full_count) {
        const auto full_framebuffer =
            bgfx::FrameBufferHandle{m_postprocess_scene_targets[1].framebuffer};
        for (const auto view : {ViewGameUiUnderlay, ViewActiveText}) {
            bgfx::setViewFrameBuffer(view, full_framebuffer);
            bgfx::setViewRect(view, 0, 0, width, height);
        }
    }

    m_active_postprocess_scope =
        full_count ? PostprocessScope::FullGameViewport : PostprocessScope::World;
    m_postprocess_surface_diagnostics.active = true;
    return true;
}

void Renderer::composite_postprocess_surface(PostprocessScope scope)
{
    if (!m_initialized || !m_active_postprocess_scope)
        return;

    std::vector<RuntimePostprocessPass> tooling_pass;
    const std::vector<RuntimePostprocessPass>* all_passes = &m_runtime_postprocess_stack;
    if (all_passes->empty() && m_postprocess_material && m_shader_materials) {
        const auto* material = find_material(*m_shader_materials, *m_postprocess_material);
        if (!material)
            return;
        tooling_pass.push_back(RuntimePostprocessPass{
            "tooling", *m_postprocess_material, material->postprocess_scope, {}});
        all_passes = &tooling_pass;
    }
    std::vector<const RuntimePostprocessPass*> passes;
    for (const auto& pass : *all_passes)
        if (pass.scope == scope)
            passes.push_back(&pass);
    if (passes.empty())
        return;

    const std::size_t scope_index = scope == PostprocessScope::World ? 0u : 1u;
    if (!bgfx::isValid(bgfx::TextureHandle{m_postprocess_scene_targets[scope_index].texture}))
        return;
    const bool full_scope_present =
        std::any_of(all_passes->begin(), all_passes->end(), [](const RuntimePostprocessPass& pass) {
            return pass.scope == PostprocessScope::FullGameViewport;
        });
    std::uint16_t input_texture = m_postprocess_scene_targets[scope_index].texture;
    const auto final_framebuffer =
        m_active_screenshot_capture ? bgfx::FrameBufferHandle{m_screenshot_scene_target.framebuffer}
                                    : bgfx::FrameBufferHandle{UINT16_MAX};
    const bgfx::ViewId first_view =
        scope == PostprocessScope::World ? ViewWorldPostprocessBegin : ViewFullGamePostprocessBegin;
    for (std::size_t index = 0; index < passes.size(); ++index) {
        const auto& pass = *passes[index];
        QuadCommand command;
        command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                        static_cast<float>(reference_height())};
        command.texture = Texture{input_texture};
        command.texture_sampler = MaterialTextureSampler::ClampLinear;
        command.material = pass.material;
        if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
            command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
        command.color = {1.0f, 1.0f, 1.0f, 1.0f};
        for (const auto& parameter : pass.uniforms) {
            std::optional<ShaderUniformValue> value = parameter.value;
            if (!value && parameter.facet) {
                float resolved = 0.0f;
                switch (*parameter.facet) {
                case RuntimeMaterialFacet::OccurrenceTime: {
                    const float now = parameter.clock == RuntimeMaterialClock::Gameplay
                                          ? m_runtime_gameplay_seconds
                                          : m_runtime_unscaled_seconds;
                    const std::string key = pass.stable_identity + "/" + parameter.name + "/" +
                                            std::to_string(static_cast<unsigned>(parameter.clock));
                    const auto [epoch, _] = m_postprocess_epochs.try_emplace(key, now);
                    resolved = std::max(0.0f, now - epoch->second);
                    break;
                }
                case RuntimeMaterialFacet::PaintWidth:
                    resolved = command.rect.width;
                    break;
                case RuntimeMaterialFacet::PaintHeight:
                    resolved = command.rect.height;
                    break;
                case RuntimeMaterialFacet::ViewportWidth:
                    resolved = m_shader_standard_inputs.viewport_pixel_dimensions.x;
                    break;
                case RuntimeMaterialFacet::ViewportHeight:
                    resolved = m_shader_standard_inputs.viewport_pixel_dimensions.y;
                    break;
                case RuntimeMaterialFacet::CameraZoom:
                    resolved = m_runtime_camera_zoom;
                    break;
                }
                value = ShaderUniformValue{resolved};
            }
            if (value)
                command.material_uniform_overrides.push_back(
                    MaterialUniformOverride{parameter.name, std::move(*value)});
        }

        const bool last = index + 1 == passes.size();
        bgfx::FrameBufferHandle output = BGFX_INVALID_HANDLE;
        std::uint16_t output_texture = UINT16_MAX;
        bool local_output = false;
        if (!last) {
            const auto& target = m_postprocess_pingpong_targets[index % 2];
            output = bgfx::FrameBufferHandle{target.framebuffer};
            output_texture = target.texture;
            local_output = true;
        } else if (scope == PostprocessScope::World && full_scope_present) {
            const auto& target = m_postprocess_scene_targets[1];
            output = bgfx::FrameBufferHandle{target.framebuffer};
            local_output = true;
        } else {
            output = final_framebuffer;
        }
        const auto view = static_cast<bgfx::ViewId>(first_view + index);
        bgfx::setViewFrameBuffer(view, output);
        if (local_output)
            bgfx::setViewRect(view, 0, 0, m_postprocess_scene_width, m_postprocess_scene_height);
        if (!submit_postprocess_quad(command, view))
            submit_default_quad(command, view);
        if (!last)
            input_texture = output_texture;
    }
}

void Renderer::composite_postprocess_surface()
{
    if (m_active_postprocess_scope)
        composite_postprocess_surface(*m_active_postprocess_scope);
}

void Renderer::destroy_postprocess_surface()
{
    bool retired = false;
    const auto destroy_target = [&](RenderTargetHandles& target) {
        const bool valid_framebuffer = bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
        const bool valid_texture = bgfx::isValid(bgfx::TextureHandle{target.texture});
        if (valid_framebuffer)
            bgfx::destroy(bgfx::FrameBufferHandle{target.framebuffer});
        if (valid_texture)
            bgfx::destroy(bgfx::TextureHandle{target.texture});
        retired = retired || valid_framebuffer || valid_texture;
        target = {};
    };
    for (auto& target : m_postprocess_scene_targets)
        destroy_target(target);
    for (auto& target : m_postprocess_pingpong_targets)
        destroy_target(target);
    if (retired)
        ++m_postprocess_surface_diagnostics.retirements;
    m_postprocess_scene_width = 0;
    m_postprocess_scene_height = 0;
    m_active_postprocess_scope.reset();
    m_postprocess_surface_diagnostics.active = false;
}

void Renderer::retire_postprocess_surface() { destroy_postprocess_surface(); }

bool Renderer::prepare_screenshot_capture_surfaces(const RendererScreenshotRequest& request)
{
    if (!m_initialized || !screenshot_rgba8_byte_size(request.width, request.height))
        return false;
    const auto* caps = bgfx::getCaps();
    if (caps == nullptr || (caps->supported & BGFX_CAPS_TEXTURE_BLIT) == 0 ||
        (caps->supported & BGFX_CAPS_TEXTURE_READ_BACK) == 0 ||
        request.width > caps->limits.maxTextureSize || request.height > caps->limits.maxTextureSize)
        return false;

    const auto scene_width_value = static_cast<std::uint32_t>(std::max(ui_raster_width(), 1));
    const auto scene_height_value = static_cast<std::uint32_t>(std::max(ui_raster_height(), 1));
    if (!screenshot_rgba8_byte_size(scene_width_value, scene_height_value) ||
        scene_width_value > caps->limits.maxTextureSize ||
        scene_height_value > caps->limits.maxTextureSize)
        return false;

    const auto scene_width = static_cast<std::uint16_t>(scene_width_value);
    const auto scene_height = static_cast<std::uint16_t>(scene_height_value);
    const auto output_width = static_cast<std::uint16_t>(request.width);
    const auto output_height = static_cast<std::uint16_t>(request.height);
    const auto valid_target = [](const RenderTargetHandles& target) {
        return bgfx::isValid(bgfx::TextureHandle{target.texture}) &&
               bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
    };
    const bool reusable =
        valid_target(m_screenshot_scene_target) && valid_target(m_screenshot_output_target) &&
        bgfx::isValid(bgfx::TextureHandle{m_screenshot_readback_texture}) &&
        m_screenshot_scene_width == scene_width && m_screenshot_scene_height == scene_height &&
        m_screenshot_output_width == output_width && m_screenshot_output_height == output_height;
    if (reusable)
        return true;

    destroy_screenshot_capture_surfaces();
    const auto create_target = [](RenderTargetHandles& target, std::uint16_t width,
                                  std::uint16_t height) {
        const std::uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        const auto texture =
            bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(texture))
            return false;
        const auto framebuffer = bgfx::createFrameBuffer(1, &texture, false);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(texture);
            return false;
        }
        target = {.texture = texture.idx, .framebuffer = framebuffer.idx};
        return true;
    };
    if (!create_target(m_screenshot_scene_target, scene_width, scene_height) ||
        !create_target(m_screenshot_output_target, output_width, output_height)) {
        destroy_screenshot_capture_surfaces();
        return false;
    }
    const auto readback =
        bgfx::createTexture2D(output_width, output_height, false, 1, bgfx::TextureFormat::RGBA8,
                              BGFX_TEXTURE_BLIT_DST | BGFX_TEXTURE_READ_BACK);
    if (!bgfx::isValid(readback)) {
        destroy_screenshot_capture_surfaces();
        return false;
    }
    m_screenshot_readback_texture = readback.idx;
    m_screenshot_scene_width = scene_width;
    m_screenshot_scene_height = scene_height;
    m_screenshot_output_width = output_width;
    m_screenshot_output_height = output_height;
    return true;
}

void Renderer::destroy_screenshot_capture_surfaces()
{
    const auto destroy_target = [](RenderTargetHandles& target) {
        if (bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer}))
            bgfx::destroy(bgfx::FrameBufferHandle{target.framebuffer});
        if (bgfx::isValid(bgfx::TextureHandle{target.texture}))
            bgfx::destroy(bgfx::TextureHandle{target.texture});
        target = {};
    };
    destroy_target(m_screenshot_scene_target);
    destroy_target(m_screenshot_output_target);
    if (bgfx::isValid(bgfx::TextureHandle{m_screenshot_readback_texture}))
        bgfx::destroy(bgfx::TextureHandle{m_screenshot_readback_texture});
    m_screenshot_readback_texture = UINT16_MAX;
    m_screenshot_readback_pixels.clear();
    m_screenshot_readback_ready_frame = 0;
    m_screenshot_scene_width = 0;
    m_screenshot_scene_height = 0;
    m_screenshot_output_width = 0;
    m_screenshot_output_height = 0;
}

void Renderer::finalize_screenshot_capture()
{
    if (!m_active_screenshot_capture)
        return;
    const auto request = *m_active_screenshot_capture;
    const bool valid_scene =
        bgfx::isValid(bgfx::TextureHandle{m_screenshot_scene_target.texture}) &&
        bgfx::isValid(bgfx::FrameBufferHandle{m_screenshot_scene_target.framebuffer});
    const bool valid_output =
        bgfx::isValid(bgfx::TextureHandle{m_screenshot_output_target.texture}) &&
        bgfx::isValid(bgfx::FrameBufferHandle{m_screenshot_output_target.framebuffer});
    const bool valid_readback = bgfx::isValid(bgfx::TextureHandle{m_screenshot_readback_texture});
    if (!valid_scene || !valid_output || !valid_readback) {
        m_active_screenshot_capture.reset();
        return;
    }

    const auto& host = m_presentation.host;
    const auto& viewport = m_presentation.viewport.host_framebuffer_rect;
    const auto present_view = static_cast<bgfx::ViewId>(ViewScreenshotPresent);
    bgfx::setViewFrameBuffer(present_view, BGFX_INVALID_HANDLE);
    bgfx::setViewMode(present_view, bgfx::ViewMode::Sequential);
    bgfx::setViewRect(present_view, 0, 0, static_cast<std::uint16_t>(host.framebuffer_size.width),
                      static_cast<std::uint16_t>(host.framebuffer_size.height));
    bgfx::setViewClear(present_view, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, m_bar_color_rgba, 1.0f,
                       0);
    float present_ortho[16];
    make_pixel_ortho(present_ortho, static_cast<float>(host.framebuffer_size.width),
                     static_cast<float>(host.framebuffer_size.height));
    bgfx::setViewTransform(present_view, nullptr, present_ortho);
    bgfx::touch(present_view);

    QuadCommand present;
    present.rect = {static_cast<float>(viewport.x), static_cast<float>(viewport.y),
                    static_cast<float>(viewport.width), static_cast<float>(viewport.height)};
    present.texture = Texture{m_screenshot_scene_target.texture};
    present.texture_sampler = MaterialTextureSampler::ClampLinear;
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        present.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    present.color = {1.0f, 1.0f, 1.0f, 1.0f};
    submit_copy_quad(present, present_view);

    const auto capture_view = static_cast<bgfx::ViewId>(ViewScreenshotResize);
    bgfx::setViewFrameBuffer(capture_view,
                             bgfx::FrameBufferHandle{m_screenshot_output_target.framebuffer});
    bgfx::setViewMode(capture_view, bgfx::ViewMode::Sequential);
    bgfx::setViewRect(capture_view, 0, 0, m_screenshot_output_width, m_screenshot_output_height);
    bgfx::setViewClear(capture_view, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x000000ff, 1.0f, 0);
    float capture_ortho[16];
    make_pixel_ortho(capture_ortho, static_cast<float>(m_screenshot_output_width),
                     static_cast<float>(m_screenshot_output_height));
    bgfx::setViewTransform(capture_view, nullptr, capture_ortho);
    bgfx::touch(capture_view);

    QuadCommand capture;
    capture.rect = {0.0f, 0.0f, static_cast<float>(m_screenshot_output_width),
                    static_cast<float>(m_screenshot_output_height)};
    capture.texture = Texture{m_screenshot_scene_target.texture};
    capture.texture_sampler = MaterialTextureSampler::ClampLinear;
    capture.uv = request.source_uv;
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft) {
        capture.uv.y = 1.0f - request.source_uv.y;
        capture.uv.height = -request.source_uv.height;
    }
    capture.color = {1.0f, 1.0f, 1.0f, 1.0f};
    submit_copy_quad(capture, capture_view);

    const auto readback_texture = bgfx::TextureHandle{m_screenshot_readback_texture};
    const auto output_texture = bgfx::TextureHandle{m_screenshot_output_target.texture};
    bgfx::blit(static_cast<bgfx::ViewId>(ViewScreenshotReadback), readback_texture, 0, 0,
               output_texture, 0, 0, m_screenshot_output_width, m_screenshot_output_height);
    const auto readback_bytes =
        screenshot_rgba8_byte_size(m_screenshot_output_width, m_screenshot_output_height);
    if (!readback_bytes) {
        m_active_screenshot_capture.reset();
        return;
    }
    m_screenshot_readback_pixels.resize(*readback_bytes);
    m_screenshot_readback_ready_frame =
        bgfx::readTexture(readback_texture, m_screenshot_readback_pixels.data());
    m_outstanding_screenshot_capture = request.request_id;
    m_active_screenshot_capture.reset();
}

std::optional<PostprocessScope> Renderer::active_postprocess_scope() const noexcept
{
    return m_active_postprocess_scope;
}

std::uint16_t Renderer::postprocess_framebuffer() const noexcept
{
    return m_active_postprocess_scope ? postprocess_framebuffer(*m_active_postprocess_scope)
                                      : UINT16_MAX;
}

std::uint16_t Renderer::postprocess_framebuffer(PostprocessScope scope) const noexcept
{
    bool active =
        std::any_of(m_runtime_postprocess_stack.begin(), m_runtime_postprocess_stack.end(),
                    [&](const RuntimePostprocessPass& pass) { return pass.scope == scope; });
    if (!active && m_runtime_postprocess_stack.empty() && m_postprocess_material &&
        m_shader_materials) {
        const auto* material = find_material(*m_shader_materials, *m_postprocess_material);
        active = material != nullptr && material->role == ShaderRole::Postprocess &&
                 material->postprocess_scope == scope;
    }
    const std::size_t index = scope == PostprocessScope::World ? 0u : 1u;
    return active ? m_postprocess_scene_targets[index].framebuffer : UINT16_MAX;
}

bool Renderer::prepare_world_transition_surfaces(WorldTransitionSceneMode mode)
{
    if (!m_initialized)
        return false;
    const auto world_width = static_cast<std::uint16_t>(std::max(world_raster().size.width, 1));
    const auto world_height = static_cast<std::uint16_t>(std::max(world_raster().size.height, 1));
    const auto scene_width = static_cast<std::uint16_t>(std::max(ui_raster_width(), 1));
    const auto scene_height = static_cast<std::uint16_t>(std::max(ui_raster_height(), 1));
    const std::uint8_t required_scene_count = mode == WorldTransitionSceneMode::Dual ? 2u : 1u;
    const auto valid_target = [](const RenderTargetHandles& target) {
        return bgfx::isValid(bgfx::TextureHandle{target.texture}) &&
               bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
    };
    const auto destroy_target = [](RenderTargetHandles& target, std::uint64_t& retirements) {
        const bool valid_framebuffer = bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
        const bool valid_texture = bgfx::isValid(bgfx::TextureHandle{target.texture});
        if (valid_framebuffer)
            bgfx::destroy(bgfx::FrameBufferHandle{target.framebuffer});
        if (valid_texture)
            bgfx::destroy(bgfx::TextureHandle{target.texture});
        if (valid_framebuffer || valid_texture)
            ++retirements;
        target = {};
    };
    const auto make_target = [](RenderTargetHandles& target, std::uint16_t width,
                                std::uint16_t height) {
        const std::uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP;
        const auto texture =
            bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::RGBA8, flags);
        if (!bgfx::isValid(texture))
            return false;
        const auto framebuffer = bgfx::createFrameBuffer(1, &texture, false);
        if (!bgfx::isValid(framebuffer)) {
            bgfx::destroy(texture);
            return false;
        }
        target = {.texture = texture.idx, .framebuffer = framebuffer.idx};
        return true;
    };

    const bool world_dimensions_changed = m_world_transition_world_width != world_width ||
                                          m_world_transition_world_height != world_height ||
                                          m_world_transition_world_policy != world_raster().policy;
    if (world_dimensions_changed) {
        for (auto& target : m_world_transition_world_targets)
            destroy_target(target, m_world_transition_surface_diagnostics.world_target_retirements);
        m_world_transition_world_width = 0;
        m_world_transition_world_height = 0;
    }

    const bool scene_dimensions_changed = m_world_transition_scene_width != scene_width ||
                                          m_world_transition_scene_height != scene_height;
    if (scene_dimensions_changed) {
        for (auto& target : m_world_transition_scene_targets)
            destroy_target(target,
                           m_world_transition_surface_diagnostics.native_scene_target_retirements);
        m_world_transition_scene_count = 0;
        m_world_transition_scene_width = 0;
        m_world_transition_scene_height = 0;
    }

    for (auto& target : m_world_transition_world_targets) {
        if (valid_target(target)) {
            ++m_world_transition_surface_diagnostics.world_target_reuses;
            continue;
        }
        if (!make_target(target, world_width, world_height)) {
            destroy_world_transition_surfaces();
            return false;
        }
        ++m_world_transition_surface_diagnostics.world_target_allocations;
    }
    m_world_transition_world_width = world_width;
    m_world_transition_world_height = world_height;
    m_world_transition_world_policy = world_raster().policy;

    for (std::size_t index = 0; index < required_scene_count; ++index) {
        auto& target = m_world_transition_scene_targets[index];
        if (valid_target(target)) {
            ++m_world_transition_surface_diagnostics.native_scene_target_reuses;
            continue;
        }
        if (!make_target(target, scene_width, scene_height)) {
            destroy_world_transition_surfaces();
            return false;
        }
        ++m_world_transition_surface_diagnostics.native_scene_target_allocations;
    }
    for (std::size_t index = required_scene_count; index < m_world_transition_scene_targets.size();
         ++index) {
        destroy_target(m_world_transition_scene_targets[index],
                       m_world_transition_surface_diagnostics.native_scene_target_retirements);
    }
    m_world_transition_scene_width = scene_width;
    m_world_transition_scene_height = scene_height;
    m_world_transition_scene_count = required_scene_count;
    m_world_transition_scene_mode = mode;
    m_world_transition_surface_diagnostics.active_world_targets = 2;
    m_world_transition_surface_diagnostics.active_native_scene_targets = required_scene_count;
    m_world_transition_surface_diagnostics.peak_native_scene_targets =
        std::max(m_world_transition_surface_diagnostics.peak_native_scene_targets,
                 static_cast<std::uint32_t>(required_scene_count));

    const auto configure_world = [&](bgfx::ViewId background, bgfx::ViewId content,
                                     const RenderTargetHandles& target) {
        const auto framebuffer = bgfx::FrameBufferHandle{target.framebuffer};
        bgfx::setViewFrameBuffer(background, framebuffer);
        bgfx::setViewFrameBuffer(content, framebuffer);
        bgfx::setViewRect(background, 0, 0, world_width, world_height);
        bgfx::setViewRect(content, 0, 0, world_width, world_height);
        bgfx::setViewClear(background, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff, 1.0f, 0);
        bgfx::touch(background);
        bgfx::touch(content);
    };
    configure_world(ViewWorldSourceBackground, ViewWorldSourceContent,
                    m_world_transition_world_targets[0]);
    configure_world(ViewWorldTargetBackground, ViewWorldTargetContent,
                    m_world_transition_world_targets[1]);

    const auto configure_scene = [&](WorldCompositionPass pass) {
        if (!transition_mode_uses_pass(mode, pass))
            return;
        const auto target_index = transition_scene_target_index(mode, pass);
        const auto view = transition_scene_composite_view(pass);
        bgfx::setViewFrameBuffer(
            view,
            bgfx::FrameBufferHandle{m_world_transition_scene_targets[target_index].framebuffer});
        bgfx::setViewRect(view, 0, 0, scene_width, scene_height);
        bgfx::setViewClear(view, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff, 1.0f, 0);
        bgfx::touch(view);
    };
    configure_scene(WorldCompositionPass::Source);
    configure_scene(WorldCompositionPass::Target);

    SDL_LogDebug(
        SDL_LOG_CATEGORY_APPLICATION,
        "[renderer] transition surfaces mode=%s world=%ux%u x2 native=%ux%u x%u "
        "alloc=%llu/%llu reuse=%llu/%llu retire=%llu/%llu peak-native=%u",
        transition_scene_mode_name(mode), world_width, world_height, scene_width, scene_height,
        required_scene_count,
        static_cast<unsigned long long>(
            m_world_transition_surface_diagnostics.world_target_allocations),
        static_cast<unsigned long long>(
            m_world_transition_surface_diagnostics.native_scene_target_allocations),
        static_cast<unsigned long long>(m_world_transition_surface_diagnostics.world_target_reuses),
        static_cast<unsigned long long>(
            m_world_transition_surface_diagnostics.native_scene_target_reuses),
        static_cast<unsigned long long>(
            m_world_transition_surface_diagnostics.world_target_retirements),
        static_cast<unsigned long long>(
            m_world_transition_surface_diagnostics.native_scene_target_retirements),
        m_world_transition_surface_diagnostics.peak_native_scene_targets);
    return true;
}

void Renderer::composite_world_surface_to_transition_scene(WorldCompositionPass pass)
{
    if (!m_initialized || !transition_mode_uses_pass(m_world_transition_scene_mode, pass))
        return;
    const auto world_index = transition_world_target_index(pass);
    const std::uint16_t texture = m_world_transition_world_targets[world_index].texture;
    if (!bgfx::isValid(bgfx::TextureHandle{texture}))
        return;
    QuadCommand command;
    command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                    static_cast<float>(reference_height())};
    command.texture = Texture{texture};
    command.texture_sampler = MaterialTextureSampler::ClampLinear;
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    command.color = {1.0f, 1.0f, 1.0f, 1.0f};
    submit_default_quad(command, transition_scene_composite_view(pass));
}

void Renderer::composite_world_transition_scene(WorldCompositionPass pass, float opacity)
{
    if (!m_initialized || !transition_mode_uses_pass(m_world_transition_scene_mode, pass))
        return;
    const auto scene_index = transition_scene_target_index(m_world_transition_scene_mode, pass);
    const std::uint16_t texture = m_world_transition_scene_targets[scene_index].texture;
    if (!bgfx::isValid(bgfx::TextureHandle{texture}))
        return;
    QuadCommand command;
    command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                    static_cast<float>(reference_height())};
    command.texture = Texture{texture};
    command.texture_sampler = MaterialTextureSampler::ClampLinear;
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    command.color = {1.0f, 1.0f, 1.0f, std::clamp(opacity, 0.0f, 1.0f)};
    submit_default_quad(command, pass == WorldCompositionPass::Source
                                     ? ViewWorldTransitionSourceComposite
                                     : ViewWorldTransitionTargetComposite);
}

std::uint16_t Renderer::world_transition_framebuffer(WorldCompositionPass pass) const
{
    if (!transition_mode_uses_pass(m_world_transition_scene_mode, pass))
        return UINT16_MAX;
    const auto scene_index = transition_scene_target_index(m_world_transition_scene_mode, pass);
    if (scene_index >= m_world_transition_scene_count)
        return UINT16_MAX;
    return m_world_transition_scene_targets[scene_index].framebuffer;
}

void Renderer::draw_fullscreen_color(Color color)
{
    if (!m_initialized || !bgfx::isValid(bgfx::ProgramHandle{m_quad_program})) {
        return;
    }

    QuadCommand command;
    command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                    static_cast<float>(reference_height())};
    command.color = color;
    if (!set_quad_buffers(command)) {
        return;
    }

    const float use_texture_uniform[] = {0.0f, 0.0f, 0.0f, 0.0f};
    bgfx::setUniform(bgfx::UniformHandle{m_use_texture_uniform}, use_texture_uniform);
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);
    bgfx::setScissor(UINT16_MAX);
    bgfx::submit(ViewGameTransition, bgfx::ProgramHandle{m_quad_program});
}

void Renderer::create_2d()
{
    if (!m_assets) {
        SDL_Log("[renderer] no AssetManager for quad shader");
        return;
    }

    const BgfxShaderLoader shader_loader(*m_assets);
    m_quad_program = shader_loader.load_program(SystemShader::Quad).idx;
    m_hotspot_alpha_program = shader_loader.load_program(SystemShader::HotspotAlpha).idx;
    m_hotspot_custom_program = shader_loader.load_program(SystemShader::HotspotCustom).idx;
    if (!bgfx::isValid(bgfx::ProgramHandle{m_hotspot_alpha_program}) ||
        !bgfx::isValid(bgfx::ProgramHandle{m_hotspot_custom_program})) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[renderer] built-in hotspot overlay programs are unavailable");
    }
    if (!bgfx::isValid(bgfx::ProgramHandle{m_quad_program})) {
        return;
    }
    m_sampler = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler).idx;
    m_use_texture_uniform = bgfx::createUniform("u_useTexture", bgfx::UniformType::Vec4).idx;

    constexpr uint32_t pixels[16] = {
        0xffffffff, 0xff3b82f6, 0xffffffff, 0xff3b82f6, 0xff3b82f6, 0xffffffff,
        0xff3b82f6, 0xffffffff, 0xffffffff, 0xff3b82f6, 0xffffffff, 0xff3b82f6,
        0xff3b82f6, 0xffffffff, 0xff3b82f6, 0xffffffff,
    };
    m_checker_texture = bgfx::createTexture2D(4, 4, false, 1, bgfx::TextureFormat::RGBA8,
                                              BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
                                              bgfx::copy(pixels, sizeof(pixels)))
                            .idx;

    m_texture_status = "procedural checker";

    m_shader_program_cache = std::make_unique<BgfxShaderProgramCache>(*m_assets);
    m_typed_asset_loader =
        std::make_unique<BgfxTypedAssetLoader>(*m_assets, *m_shader_program_cache);
    m_typed_asset_loader->set_fallback_texture(bgfx::TextureHandle{m_checker_texture});
    m_typed_asset_loader->set_shader_material_project(m_shader_materials);
    m_assets->bind_texture_loader(m_typed_asset_loader.get());
    m_assets->bind_hotspot_mask_loader(m_typed_asset_loader.get());
    m_assets->bind_shader_program_loader(m_typed_asset_loader.get());
    m_assets->bind_material_loader(m_typed_asset_loader.get());
    m_material_binder = std::make_unique<BgfxMaterialBinder>(
        *m_assets, *m_shader_program_cache, bgfx::TextureHandle{m_checker_texture});
}

void Renderer::destroy_2d()
{
    if (m_assets) {
        m_assets->bind_texture_loader(nullptr);
        m_assets->bind_hotspot_mask_loader(nullptr);
        m_assets->bind_shader_program_loader(nullptr);
        m_assets->bind_material_loader(nullptr);
    }
    m_material_binder.reset();
    m_typed_asset_loader.reset();
    m_shader_program_cache.reset();
    if (bgfx::isValid(bgfx::TextureHandle{m_checker_texture}))
        bgfx::destroy(bgfx::TextureHandle{m_checker_texture});
    if (bgfx::isValid(bgfx::UniformHandle{m_use_texture_uniform}))
        bgfx::destroy(bgfx::UniformHandle{m_use_texture_uniform});
    if (bgfx::isValid(bgfx::UniformHandle{m_sampler}))
        bgfx::destroy(bgfx::UniformHandle{m_sampler});
    if (bgfx::isValid(bgfx::ProgramHandle{m_quad_program}))
        bgfx::destroy(bgfx::ProgramHandle{m_quad_program});
    if (bgfx::isValid(bgfx::ProgramHandle{m_hotspot_alpha_program}))
        bgfx::destroy(bgfx::ProgramHandle{m_hotspot_alpha_program});
    if (bgfx::isValid(bgfx::ProgramHandle{m_hotspot_custom_program}))
        bgfx::destroy(bgfx::ProgramHandle{m_hotspot_custom_program});
    m_checker_texture = UINT16_MAX;
    m_use_texture_uniform = UINT16_MAX;
    m_sampler = UINT16_MAX;
    m_quad_program = UINT16_MAX;
    m_hotspot_alpha_program = UINT16_MAX;
    m_hotspot_custom_program = UINT16_MAX;
}

void Renderer::destroy_ordinary_world_surface()
{
    if (bgfx::isValid(bgfx::FrameBufferHandle{m_world_color_framebuffer}))
        bgfx::destroy(bgfx::FrameBufferHandle{m_world_color_framebuffer});
    if (bgfx::isValid(bgfx::TextureHandle{m_world_color_texture}))
        bgfx::destroy(bgfx::TextureHandle{m_world_color_texture});
    m_world_color_texture = UINT16_MAX;
    m_world_color_framebuffer = UINT16_MAX;
    m_world_color_width = 0;
    m_world_color_height = 0;
    m_world_color_policy = WorldRasterPolicy::Capped;
}

void Renderer::destroy_world_transition_surfaces()
{
    std::uint32_t retired_world = 0;
    std::uint32_t retired_scene = 0;
    const auto destroy_target = [](RenderTargetHandles& target) {
        const bool valid_framebuffer = bgfx::isValid(bgfx::FrameBufferHandle{target.framebuffer});
        const bool valid_texture = bgfx::isValid(bgfx::TextureHandle{target.texture});
        if (valid_framebuffer)
            bgfx::destroy(bgfx::FrameBufferHandle{target.framebuffer});
        if (valid_texture)
            bgfx::destroy(bgfx::TextureHandle{target.texture});
        target = {};
        return valid_framebuffer || valid_texture;
    };
    for (auto& target : m_world_transition_world_targets) {
        if (destroy_target(target))
            ++retired_world;
    }
    for (auto& target : m_world_transition_scene_targets) {
        if (destroy_target(target))
            ++retired_scene;
    }
    m_world_transition_surface_diagnostics.world_target_retirements += retired_world;
    m_world_transition_surface_diagnostics.native_scene_target_retirements += retired_scene;
    m_world_transition_surface_diagnostics.active_world_targets = 0;
    m_world_transition_surface_diagnostics.active_native_scene_targets = 0;
    m_world_transition_world_width = 0;
    m_world_transition_world_height = 0;
    m_world_transition_scene_width = 0;
    m_world_transition_scene_height = 0;
    m_world_transition_world_policy = WorldRasterPolicy::Capped;
    m_world_transition_scene_count = 0;
    m_world_transition_scene_mode = WorldTransitionSceneMode::SourceOnly;
    if (retired_world != 0 || retired_scene != 0) {
        SDL_Log("[renderer] retired transition targets world=%u native=%u cumulative=%llu/%llu",
                retired_world, retired_scene,
                static_cast<unsigned long long>(
                    m_world_transition_surface_diagnostics.world_target_retirements),
                static_cast<unsigned long long>(
                    m_world_transition_surface_diagnostics.native_scene_target_retirements));
    }
}

void Renderer::retire_world_transition_surfaces() { destroy_world_transition_surfaces(); }

void Renderer::submit_quad(const QuadCommand& command)
{
    submit_quad(command, game_layer_view_id(command.layer), 1.0f);
}

void Renderer::submit_quad(const QuadCommand& command, std::uint16_t view, float opacity)
{
    QuadCommand adjusted = command;
    adjusted.color.a *= opacity;
    if (adjusted.material.valid() && submit_material_quad(adjusted, view)) {
        return;
    }
    submit_default_quad(adjusted, view);
}

bool Renderer::submit_material_quad(const QuadCommand& command)
{
    return submit_material_quad(command, game_layer_view_id(command.layer));
}

bool Renderer::submit_material_quad(const QuadCommand& command, std::uint16_t view)
{
    if (!m_material_binder)
        return false;

    std::vector<ShaderProgramDiagnostic> diagnostics;
    auto inputs = m_shader_standard_inputs;
    inputs.paint_dimensions = {command.rect.width, command.rect.height};
    if (command.time_seconds)
        inputs.time_seconds = *command.time_seconds;
    inputs.hotspot_bounds = {command.hotspot_bounds.x, command.hotspot_bounds.y,
                             command.hotspot_bounds.width, command.hotspot_bounds.height};
    inputs.hotspot_hovered = command.hotspot_hovered;
    inputs.hotspot_pressed = command.hotspot_pressed;
    inputs.hotspot_image_dimensions = {command.hotspot_image_dimensions.width,
                                       command.hotspot_image_dimensions.height};
    inputs.hotspot_mask_dimensions = {command.hotspot_mask_dimensions.width,
                                      command.hotspot_mask_dimensions.height};
    const bool hotspot_overlay = command.hotspot_image_dimensions.width > 0.0f &&
                                 command.hotspot_image_dimensions.height > 0.0f;
    bgfx::TextureHandle hotspot_image = BGFX_INVALID_HANDLE;
    if (hotspot_overlay && command.texture.valid())
        hotspot_image = bgfx::TextureHandle{command.texture.handle};
    bgfx::TextureHandle hotspot_mask = BGFX_INVALID_HANDLE;
    if (command.hotspot_mask && command.hotspot_mask->valid())
        hotspot_mask = bgfx::TextureHandle{command.hotspot_mask->handle};
    const BgfxMaterialBindInputs bind_inputs{
        .role = hotspot_overlay ? ShaderRole::HotspotOverlay : ShaderRole::Engine2D,
        .quad_command = &command,
        .standard_inputs = inputs,
        .hotspot_image = hotspot_image,
        .hotspot_image_sampler = command.texture_sampler,
        .hotspot_mask = hotspot_mask,
    };

    BgfxMaterialBindResult bound;
    const auto& material_id = command.material.string();
    if (material_id == builtin_hotspot_alpha_material_id ||
        material_id == builtin_hotspot_custom_material_id) {
        const auto interface = material_id == builtin_hotspot_alpha_material_id
                                   ? HotspotMaterialInterface::Alpha
                                   : HotspotMaterialInterface::Custom;
        bound = m_material_binder->bind_system_material(
            m_builtin_hotspot_materials, command.material,
            bgfx::ProgramHandle{builtin_hotspot_program(interface)}, bind_inputs, &diagnostics);
    } else {
        if (!m_shader_materials)
            return false;
        bound = m_material_binder->bind_material(*m_shader_materials, command.material, bind_inputs,
                                                 &diagnostics);
    }
    for (const auto& diagnostic : diagnostics) {
        SDL_Log("[renderer] material diagnostic: %s: %s", diagnostic.context.c_str(),
                diagnostic.message.c_str());
    }
    if (!bound.ok || !bgfx::isValid(bound.program))
        return false;

    (void)command.depth;
    if (!set_quad_buffers(command))
        return false;

    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);

    const auto scissor = current_scissor();
    if (scissor.active) {
        const RasterScissor raster_scissor = current_ui_raster_scissor();
        bgfx::setScissor(static_cast<std::uint16_t>(raster_scissor.x),
                         static_cast<std::uint16_t>(raster_scissor.y),
                         static_cast<std::uint16_t>(raster_scissor.width),
                         static_cast<std::uint16_t>(raster_scissor.height));
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

    bgfx::submit(view, bound.program);
    return true;
}

bool Renderer::submit_postprocess_quad(const QuadCommand& command, std::uint16_t view)
{
    if (!m_shader_materials || !m_material_binder)
        return false;

    std::vector<ShaderProgramDiagnostic> diagnostics;
    auto inputs = m_shader_standard_inputs;
    inputs.paint_dimensions = {command.rect.width, command.rect.height};
    const auto bound = m_material_binder->bind_material(*m_shader_materials, command.material,
                                                        BgfxMaterialBindInputs{
                                                            .role = ShaderRole::Postprocess,
                                                            .quad_command = &command,
                                                            .standard_inputs = inputs,
                                                        },
                                                        &diagnostics);
    for (const auto& diagnostic : diagnostics) {
        SDL_Log("[renderer] postprocess material diagnostic: %s: %s", diagnostic.context.c_str(),
                diagnostic.message.c_str());
    }
    if (!bound.ok || !bgfx::isValid(bound.program) || !set_quad_buffers(command))
        return false;

    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
    bgfx::setScissor(UINT16_MAX);
    bgfx::submit(view, bound.program);
    return true;
}

void Renderer::submit_default_quad(const QuadCommand& command)
{
    submit_default_quad(command, game_layer_view_id(command.layer));
}

void Renderer::submit_default_quad(const QuadCommand& command, std::uint16_t view)
{
    (void)command.depth;
    if (!set_quad_buffers(command))
        return;

    const uint16_t texture = command.texture.handle;
    const bool use_texture = texture != UINT16_MAX && bgfx::isValid(bgfx::TextureHandle{texture});
    const float use_texture_uniform[] = {use_texture ? 1.0f : 0.0f, 0.0f, 0.0f, 0.0f};
    bgfx::setUniform(bgfx::UniformHandle{m_use_texture_uniform}, use_texture_uniform);
    if (use_texture) {
        bgfx::setTexture(0, bgfx::UniformHandle{m_sampler}, bgfx::TextureHandle{texture},
                         bgfx_backend::bgfx_sampler_flags(command.texture_sampler));
    }
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);

    // Per-draw-call scissor from the current stack top.
    const auto scissor = current_scissor();
    if (scissor.active) {
        const RasterScissor raster_scissor = current_ui_raster_scissor();
        bgfx::setScissor(static_cast<std::uint16_t>(raster_scissor.x),
                         static_cast<std::uint16_t>(raster_scissor.y),
                         static_cast<std::uint16_t>(raster_scissor.width),
                         static_cast<std::uint16_t>(raster_scissor.height));
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

    bgfx::submit(view, bgfx::ProgramHandle{m_quad_program});
}

void Renderer::submit_copy_quad(const QuadCommand& command, std::uint16_t view)
{
    if (!set_quad_buffers(command))
        return;

    const uint16_t texture = command.texture.handle;
    const bool use_texture = texture != UINT16_MAX && bgfx::isValid(bgfx::TextureHandle{texture});
    if (!use_texture)
        return;

    const float use_texture_uniform[] = {1.0f, 0.0f, 0.0f, 0.0f};
    bgfx::setUniform(bgfx::UniformHandle{m_use_texture_uniform}, use_texture_uniform);
    bgfx::setTexture(0, bgfx::UniformHandle{m_sampler}, bgfx::TextureHandle{texture},
                     bgfx_backend::bgfx_sampler_flags(command.texture_sampler));
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A);
    bgfx::setScissor(UINT16_MAX);
    bgfx::submit(view, bgfx::ProgramHandle{m_quad_program});
}

RasterScissor Renderer::current_ui_raster_scissor() const
{
    const ScissorRect scissor = current_scissor();
    const Rect transformed{
        static_cast<float>(scissor.x) * reference_to_ui_raster_scale_x(),
        static_cast<float>(scissor.y) * reference_to_ui_raster_scale_y(),
        static_cast<float>(scissor.w) * reference_to_ui_raster_scale_x(),
        static_cast<float>(scissor.h) * reference_to_ui_raster_scale_y(),
    };
    return RasterizationPolicy::clip_scissor(
        RasterizationPolicy::contain_transformed_scissor(transformed), ui_raster_width(),
        ui_raster_height());
}

} // namespace noveltea
