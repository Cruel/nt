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

void Renderer::draw_demo_2d(float time_seconds)
{
    if (!m_initialized || !bgfx::isValid(bgfx::ProgramHandle{m_quad_program})) {
        return;
    }

    const float pulse = 0.5f + 0.5f * std::sin(time_seconds * 2.0f);
    QuadBatch batch;
    batch.draw_colored_quad({72.0f, 96.0f, 220.0f, 132.0f}, {0.15f, 0.65f, 0.95f, 0.88f}, 0.1f,
                            GameLayer::Background);
    batch.draw_material_textured_quad(
        {330.0f, 116.0f, 160.0f, 160.0f}, MaterialId("demo/engine_2d_quad"),
        Texture{m_checker_texture},
        {0.0f, 0.0f, 1.0f, 1.0f}, {1.0f, 1.0f, 1.0f, 1.0f}, 0.2f, GameLayer::Main);
    batch.draw_colored_quad({120.0f + pulse * 80.0f, 270.0f, 180.0f, 48.0f},
                            {0.95f, 0.72f, 0.18f, 0.9f}, 0.3f, GameLayer::Foreground);
    draw_2d(batch);
}

void Renderer::draw_2d(const QuadBatch& batch)
{
    if (!m_initialized || !bgfx::isValid(bgfx::ProgramHandle{m_quad_program})) {
        return;
    }

    for (const QuadCommand& command : batch.commands()) {
        submit_quad(command);
    }
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

void Renderer::submit_quad(const QuadCommand& command)
{
    if (command.material.valid() && submit_material_quad(command)) {
        return;
    }
    submit_default_quad(command);
}

bool Renderer::submit_material_quad(const QuadCommand& command)
{
    if (!m_shader_materials || !m_material_binder)
        return false;

    std::vector<ShaderProgramDiagnostic> diagnostics;
    auto inputs = m_shader_standard_inputs;
    inputs.paint_dimensions = {command.rect.width, command.rect.height};
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
        const auto fb_x = static_cast<int16_t>(std::round(scissor.x * m_surface.scale_x));
        const auto fb_y = static_cast<int16_t>(std::round(scissor.y * m_surface.scale_y));
        const auto fb_w = static_cast<uint16_t>(std::round(scissor.w * m_surface.scale_x));
        const auto fb_h = static_cast<uint16_t>(std::round(scissor.h * m_surface.scale_y));
        bgfx::setScissor(fb_x, fb_y, fb_w, fb_h);
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

    const auto view = game_layer_view_id(command.layer);
    bgfx::submit(view, bound.program);
    return true;
}

void Renderer::submit_default_quad(const QuadCommand& command)
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
        // Convert logical coords to framebuffer pixels.
        const auto fb_x = static_cast<int16_t>(std::round(scissor.x * m_surface.scale_x));
        const auto fb_y = static_cast<int16_t>(std::round(scissor.y * m_surface.scale_y));
        const auto fb_w = static_cast<uint16_t>(std::round(scissor.w * m_surface.scale_x));
        const auto fb_h = static_cast<uint16_t>(std::round(scissor.h * m_surface.scale_y));
        bgfx::setScissor(fb_x, fb_y, fb_w, fb_h);
    } else {
        bgfx::setScissor(UINT16_MAX);
    }

    const auto view = game_layer_view_id(command.layer);
    bgfx::submit(view, bgfx::ProgramHandle{m_quad_program});
}

} // namespace noveltea
