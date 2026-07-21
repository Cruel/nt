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

bool Renderer::prepare_world_transition_surfaces()
{
    if (!m_initialized)
        return false;
    const auto width = static_cast<std::uint16_t>(std::max(ui_raster_width(), 1));
    const auto height = static_cast<std::uint16_t>(std::max(ui_raster_height(), 1));
    const bool valid = bgfx::isValid(bgfx::TextureHandle{m_world_source_texture}) &&
                       bgfx::isValid(bgfx::FrameBufferHandle{m_world_source_framebuffer}) &&
                       bgfx::isValid(bgfx::TextureHandle{m_world_target_texture}) &&
                       bgfx::isValid(bgfx::FrameBufferHandle{m_world_target_framebuffer}) &&
                       m_world_surface_width == width && m_world_surface_height == height;
    if (!valid) {
        destroy_world_transition_surfaces();
        const std::uint64_t flags = BGFX_TEXTURE_RT | BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP |
                                    BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT;
        const auto make_surface = [&](std::uint16_t& texture_index,
                                      std::uint16_t& framebuffer_index) {
            const auto texture =
                bgfx::createTexture2D(width, height, false, 1, bgfx::TextureFormat::RGBA8, flags);
            if (!bgfx::isValid(texture))
                return false;
            const auto framebuffer = bgfx::createFrameBuffer(1, &texture, false);
            if (!bgfx::isValid(framebuffer)) {
                bgfx::destroy(texture);
                return false;
            }
            texture_index = texture.idx;
            framebuffer_index = framebuffer.idx;
            return true;
        };
        if (!make_surface(m_world_source_texture, m_world_source_framebuffer) ||
            !make_surface(m_world_target_texture, m_world_target_framebuffer)) {
            destroy_world_transition_surfaces();
            return false;
        }
        m_world_surface_width = width;
        m_world_surface_height = height;
    }

    const auto configure = [&](bgfx::ViewId background, bgfx::ViewId content,
                               bgfx::FrameBufferHandle framebuffer) {
        bgfx::setViewFrameBuffer(background, framebuffer);
        bgfx::setViewFrameBuffer(content, framebuffer);
        bgfx::setViewRect(background, 0, 0, width, height);
        bgfx::setViewRect(content, 0, 0, width, height);
        bgfx::setViewClear(background, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff, 1.0f, 0);
        bgfx::touch(background);
        bgfx::touch(content);
    };
    configure(ViewWorldSourceBackground, ViewWorldSourceContent,
              bgfx::FrameBufferHandle{m_world_source_framebuffer});
    configure(ViewWorldTargetBackground, ViewWorldTargetContent,
              bgfx::FrameBufferHandle{m_world_target_framebuffer});
    return true;
}

void Renderer::composite_world_surface(WorldCompositionPass pass, float opacity)
{
    if (!m_initialized || pass == WorldCompositionPass::GameUiUnderlay)
        return;
    const std::uint16_t texture =
        pass == WorldCompositionPass::Source ? m_world_source_texture : m_world_target_texture;
    if (!bgfx::isValid(bgfx::TextureHandle{texture}))
        return;
    QuadCommand command;
    command.rect = {0.0f, 0.0f, static_cast<float>(reference_width()),
                    static_cast<float>(reference_height())};
    command.texture = Texture{texture};
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    command.color = {1.0f, 1.0f, 1.0f, std::clamp(opacity, 0.0f, 1.0f)};
    submit_default_quad(command, pass == WorldCompositionPass::Source
                                     ? ViewWorldTransitionSourceComposite
                                     : ViewWorldTransitionTargetComposite);
}

std::uint16_t Renderer::world_transition_framebuffer(WorldCompositionPass pass) const
{
    if (pass == WorldCompositionPass::Source)
        return m_world_source_framebuffer;
    if (pass == WorldCompositionPass::Target)
        return m_world_target_framebuffer;
    return UINT16_MAX;
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

    m_quad_program = BgfxShaderLoader(*m_assets).load_program(SystemShader::Quad).idx;
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
    m_assets->bind_shader_program_loader(m_typed_asset_loader.get());
    m_assets->bind_material_loader(m_typed_asset_loader.get());
    m_material_binder = std::make_unique<BgfxMaterialBinder>(
        *m_assets, *m_shader_program_cache, bgfx::TextureHandle{m_checker_texture});
}

void Renderer::destroy_2d()
{
    if (m_assets) {
        m_assets->bind_texture_loader(nullptr);
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
    m_checker_texture = UINT16_MAX;
    m_use_texture_uniform = UINT16_MAX;
    m_sampler = UINT16_MAX;
    m_quad_program = UINT16_MAX;
}

void Renderer::destroy_world_transition_surfaces()
{
    if (bgfx::isValid(bgfx::FrameBufferHandle{m_world_source_framebuffer}))
        bgfx::destroy(bgfx::FrameBufferHandle{m_world_source_framebuffer});
    if (bgfx::isValid(bgfx::FrameBufferHandle{m_world_target_framebuffer}))
        bgfx::destroy(bgfx::FrameBufferHandle{m_world_target_framebuffer});
    if (bgfx::isValid(bgfx::TextureHandle{m_world_source_texture}))
        bgfx::destroy(bgfx::TextureHandle{m_world_source_texture});
    if (bgfx::isValid(bgfx::TextureHandle{m_world_target_texture}))
        bgfx::destroy(bgfx::TextureHandle{m_world_target_texture});
    m_world_source_texture = UINT16_MAX;
    m_world_source_framebuffer = UINT16_MAX;
    m_world_target_texture = UINT16_MAX;
    m_world_target_framebuffer = UINT16_MAX;
    m_world_surface_width = 0;
    m_world_surface_height = 0;
}

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
    if (!m_shader_materials || !m_material_binder)
        return false;

    std::vector<ShaderProgramDiagnostic> diagnostics;
    auto inputs = m_shader_standard_inputs;
    inputs.paint_dimensions = {command.rect.width, command.rect.height};
    if (command.time_seconds)
        inputs.time_seconds = *command.time_seconds;
    const auto bound = m_material_binder->bind_material(
        *m_shader_materials, command.material,
        BgfxMaterialBindInputs{
            .role = ShaderRole::Engine2D, .quad_command = &command, .standard_inputs = inputs},
        &diagnostics);
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
        const auto fb_x =
            static_cast<int16_t>(std::round(scissor.x * reference_to_ui_raster_scale_x()));
        const auto fb_y =
            static_cast<int16_t>(std::round(scissor.y * reference_to_ui_raster_scale_y()));
        const auto fb_w =
            static_cast<uint16_t>(std::round(scissor.w * reference_to_ui_raster_scale_x()));
        const auto fb_h =
            static_cast<uint16_t>(std::round(scissor.h * reference_to_ui_raster_scale_y()));
        bgfx::setScissor(fb_x, fb_y, fb_w, fb_h);
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

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
        bgfx::setTexture(0, bgfx::UniformHandle{m_sampler}, bgfx::TextureHandle{texture});
    }
    bgfx::setState(BGFX_STATE_WRITE_RGB | BGFX_STATE_WRITE_A | BGFX_STATE_BLEND_ALPHA);

    // Per-draw-call scissor from the current stack top.
    const auto scissor = current_scissor();
    if (scissor.active) {
        // Convert reference coordinates to the native UI raster domain.
        const auto fb_x =
            static_cast<int16_t>(std::round(scissor.x * reference_to_ui_raster_scale_x()));
        const auto fb_y =
            static_cast<int16_t>(std::round(scissor.y * reference_to_ui_raster_scale_y()));
        const auto fb_w =
            static_cast<uint16_t>(std::round(scissor.w * reference_to_ui_raster_scale_x()));
        const auto fb_h =
            static_cast<uint16_t>(std::round(scissor.h * reference_to_ui_raster_scale_y()));
        bgfx::setScissor(fb_x, fb_y, fb_w, fb_h);
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

    bgfx::submit(view, bgfx::ProgramHandle{m_quad_program});
}

} // namespace noveltea
