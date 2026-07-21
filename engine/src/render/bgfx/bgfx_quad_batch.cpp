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
    if (const auto* caps = bgfx::getCaps(); caps && caps->originBottomLeft)
        command.uv = {0.0f, 1.0f, 1.0f, -1.0f};
    command.color = {1.0f, 1.0f, 1.0f, 1.0f};
    submit_default_quad(command, ViewWorldOrdinaryComposite);
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
