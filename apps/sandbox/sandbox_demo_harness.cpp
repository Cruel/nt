#include "sandbox_demo_harness.hpp"

#include "render/bgfx/bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"

#include <noveltea/engine.hpp>
#include <noveltea/engine_tooling.hpp>
#include <noveltea/math/geometry.hpp>
#include <noveltea/render/quad_batch.hpp>
#include <noveltea/renderer.hpp>
#include <noveltea/runtime_preview_controller.hpp>
#include <noveltea/text/font.hpp>
#include <noveltea/text/text.hpp>

#include <SDL3/SDL.h>
#include <bgfx/bgfx.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <utility>

namespace noveltea::sandbox {
namespace {

constexpr float kTriangleHalfWidth = 48.0f;
constexpr float kTriangleHalfHeight = 42.0f;

struct PosColorVertex {
    float x, y;
    float r, g, b, a;
};

constexpr PosColorVertex kTriangleVertices[3] = {
    {0.0f, -kTriangleHalfHeight, 1.0f, 0.0f, 0.0f, 1.0f},
    {-kTriangleHalfWidth, kTriangleHalfHeight, 0.0f, 1.0f, 0.0f, 1.0f},
    {kTriangleHalfWidth, kTriangleHalfHeight, 0.0f, 0.0f, 1.0f, 1.0f},
};

constexpr std::uint16_t kTriangleIndices[3] = {0, 1, 2};

bool demo_enabled(DemoMode selected, DemoMode queried)
{
    return selected == DemoMode::All || selected == queried;
}

float clamp_logical(float value, float minimum, float maximum)
{
    return std::clamp(value, minimum, maximum);
}

} // namespace

struct SandboxDemoHarness::Impl {
    Impl(Engine& owner, Renderer& renderer_owner, assets::AssetManager& assets_owner)
        : engine(owner), renderer(renderer_owner), assets(assets_owner)
    {
    }

    static bool SDLCALL event_watch(void* userdata, SDL_Event* event)
    {
        auto* self = static_cast<Impl*>(userdata);
        if (self && event)
            self->handle_event(*event);
        return true;
    }

    void create_triangle()
    {
        bgfx_backend::BgfxShaderLoader shaders(assets);
        const bgfx::ProgramHandle program =
            shaders.load_program(bgfx_backend::SystemShader::Triangle);
        if (!bgfx::isValid(program)) {
            std::fprintf(stderr, "[sandbox-demo] triangle shader load failed\n");
            return;
        }

        bgfx::VertexLayout layout;
        layout.begin()
            .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
            .end();
        triangle_program = program.idx;
        triangle_vb = bgfx::createVertexBuffer(
                          bgfx::copy(kTriangleVertices, sizeof(kTriangleVertices)), layout)
                          .idx;
        triangle_ib =
            bgfx::createIndexBuffer(bgfx::copy(kTriangleIndices, sizeof(kTriangleIndices))).idx;
        if (!bgfx::isValid(bgfx::VertexBufferHandle{triangle_vb}) ||
            !bgfx::isValid(bgfx::IndexBufferHandle{triangle_ib})) {
            destroy_triangle();
            std::fprintf(stderr, "[sandbox-demo] triangle buffer creation failed\n");
        }
    }

    void destroy_triangle()
    {
        if (bgfx::isValid(bgfx::ProgramHandle{triangle_program}))
            bgfx::destroy(bgfx::ProgramHandle{triangle_program});
        if (bgfx::isValid(bgfx::VertexBufferHandle{triangle_vb}))
            bgfx::destroy(bgfx::VertexBufferHandle{triangle_vb});
        if (bgfx::isValid(bgfx::IndexBufferHandle{triangle_ib}))
            bgfx::destroy(bgfx::IndexBufferHandle{triangle_ib});
        triangle_program = bgfx::kInvalidHandle;
        triangle_vb = bgfx::kInvalidHandle;
        triangle_ib = bgfx::kInvalidHandle;
    }

    void create_checker_texture()
    {
        constexpr std::uint32_t pixels[4] = {
            0xf4f4f4ffu,
            0x303030ffu,
            0x303030ffu,
            0xf4f4f4ffu,
        };
        const auto texture = bgfx::createTexture2D(2, 2, false, 1, bgfx::TextureFormat::RGBA8,
                                                   BGFX_SAMPLER_MIN_POINT | BGFX_SAMPLER_MAG_POINT |
                                                       BGFX_SAMPLER_U_CLAMP | BGFX_SAMPLER_V_CLAMP,
                                                   bgfx::copy(pixels, sizeof(pixels)));
        checker_texture = texture.idx;
    }

    void destroy_checker_texture()
    {
        if (bgfx::isValid(bgfx::TextureHandle{checker_texture}))
            bgfx::destroy(bgfx::TextureHandle{checker_texture});
        checker_texture = bgfx::kInvalidHandle;
    }

    void submit_triangle()
    {
        if (!renderer.is_initialized() || renderer.reference_width() <= 0 ||
            renderer.reference_height() <= 0 ||
            !bgfx::isValid(bgfx::VertexBufferHandle{triangle_vb}) ||
            !bgfx::isValid(bgfx::IndexBufferHandle{triangle_ib}) ||
            !bgfx::isValid(bgfx::ProgramHandle{triangle_program})) {
            return;
        }

        const float usable_width =
            static_cast<float>(renderer.reference_width()) - kTriangleHalfWidth * 2.0f;
        const float usable_height =
            static_cast<float>(renderer.reference_height()) - kTriangleHalfHeight * 2.0f;
        const float x =
            kTriangleHalfWidth + demo_position.x * (usable_width > 0.0f ? usable_width : 0.0f);
        const float y =
            kTriangleHalfHeight + demo_position.y * (usable_height > 0.0f ? usable_height : 0.0f);
        const float transform[16] = {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f, x,    y,    0.0f, 1.0f,
        };
        bgfx::setTransform(transform);
        bgfx::setVertexBuffer(0, bgfx::VertexBufferHandle{triangle_vb});
        bgfx::setIndexBuffer(bgfx::IndexBufferHandle{triangle_ib});
        bgfx::submit(bgfx_backend::ViewGameLayerUIOverlay, bgfx::ProgramHandle{triangle_program});
    }

    void submit_2d(float time_seconds)
    {
        const float pulse = 0.5f + 0.5f * std::sin(time_seconds * 2.0f);
        QuadBatch batch;
        batch.draw_colored_quad({72.0f, 96.0f, 220.0f, 132.0f}, {0.15f, 0.65f, 0.95f, 0.88f}, 0.1f,
                                GameLayer::Background);
        if (bgfx::isValid(bgfx::TextureHandle{checker_texture})) {
            batch.draw_textured_quad({330.0f, 116.0f, 160.0f, 160.0f}, Texture{checker_texture},
                                     {0.0f, 0.0f, 1.0f, 1.0f}, {1.0f, 1.0f, 1.0f, 1.0f}, 0.2f,
                                     GameLayer::Main);
        }
        batch.draw_colored_quad({120.0f + pulse * 80.0f, 270.0f, 180.0f, 48.0f},
                                {0.95f, 0.72f, 0.18f, 0.9f}, 0.3f, GameLayer::Foreground);
        renderer.draw_2d(batch);
    }

    void submit_text(float time_seconds)
    {
        if (!demo_font)
            return;
        const float title_box_height =
            clamp_logical(static_cast<float>(renderer.reference_height()) * 0.15f, 72.0f, 150.0f);
        const float title_size = clamp_logical(title_box_height * 0.55f, 28.0f, 72.0f);

        auto draw = [&](std::string value, Rect bounds, float size, Color color,
                        TextAlign align = TextAlign::Start, Transform2D transform = {}) {
            Text text;
            text.value = std::move(value);
            text.font = demo_font;
            text.bounds = bounds;
            text.style = TextStyle{size, color, 1.0f};
            text.align = align;
            text.direction = TextDirection::Auto;
            text.language = "en";
            text.transform = transform;
            renderer.draw_text(text);
        };

        draw("Proportional title/header", {64.0f, 24.0f, 620.0f, title_box_height}, title_size,
             Color::from_rgba8(255, 196, 87));
        draw("Grayscale text at 18 logical px", {64.0f, 126.0f, 420.0f, 30.0f}, 18.0f,
             Color::from_rgba8(245, 242, 232));
        draw("Grayscale text at 24 logical px", {64.0f, 164.0f, 420.0f, 36.0f}, 24.0f,
             Color::from_rgba8(245, 242, 232));
        draw("Grayscale text at 36 logical px", {64.0f, 212.0f, 500.0f, 52.0f}, 36.0f,
             Color::from_rgba8(255, 196, 87));
        draw("Wrapped English text uses a boxed Text primitive and keeps shaping/layout separate "
             "from RmlUi.",
             {64.0f, 200.0f, 360.0f, 92.0f}, 22.0f, Color::from_rgba8(212, 230, 255));
        draw("Combining marks: cafe\xCC\x81, A\xCC\x8A, n\xCC\x83", {64.0f, 320.0f, 520.0f, 42.0f},
             24.0f, Color::from_rgba8(176, 224, 188));
        draw("Bidi CPU tests pass; bundled demo font has no Hebrew glyphs",
             {64.0f, 374.0f, 720.0f, 48.0f}, 24.0f, Color::from_rgba8(250, 214, 160));
        draw("Centered boxed text", {500.0f, 64.0f, 300.0f, 44.0f}, 24.0f,
             Color::from_rgba8(160, 214, 250), TextAlign::Center);
        draw("End aligned", {500.0f, 118.0f, 300.0f, 44.0f}, 24.0f,
             Color::from_rgba8(160, 214, 250), TextAlign::End);
        draw("This height-constrained paragraph intentionally overflows after a couple of lines "
             "so clipping and overflow reporting can be exercised by the layout.",
             {500.0f, 186.0f, 320.0f, 58.0f}, 20.0f, Color::from_rgba8(235, 170, 170));

        Transform2D transform;
        transform.scale = {1.0f + 0.2f * std::sin(time_seconds * 2.0f),
                           1.0f + 0.2f * std::sin(time_seconds * 2.0f)};
        transform.rotation_radians = 0.08f;
        draw("Transformed Text", {500.0f, 330.0f, 360.0f, 60.0f}, 30.0f,
             Color::from_rgba8(190, 170, 245), TextAlign::Start, transform);
    }

    void handle_event(const SDL_Event& event)
    {
        if (event.type != SDL_EVENT_MOUSE_BUTTON_DOWN || event.button.button != SDL_BUTTON_LEFT ||
            config.mode == DemoMode::None) {
            return;
        }
        const auto viewport_point =
            host_to_viewport_logical({event.button.x, event.button.y}, engine.presentation());
        if (!viewport_point)
            return;
        const auto& presentation = engine.presentation();
        if (presentation.viewport.host_logical_rect.width <= 0 ||
            presentation.viewport.host_logical_rect.height <= 0)
            return;

        const float width = static_cast<float>(presentation.reference.size.width);
        const float height = static_cast<float>(presentation.reference.size.height);
        const Vec2 reference_point{
            viewport_point->x * width / presentation.viewport.host_logical_rect.width,
            viewport_point->y * height / presentation.viewport.host_logical_rect.height,
        };
        const float usable_width = width - kTriangleHalfWidth * 2.0f;
        const float usable_height = height - kTriangleHalfHeight * 2.0f;
        const float center_x =
            kTriangleHalfWidth + demo_position.x * (usable_width > 0.0f ? usable_width : 0.0f);
        const float center_y =
            kTriangleHalfHeight + demo_position.y * (usable_height > 0.0f ? usable_height : 0.0f);
        const Vec2 top{center_x, center_y - kTriangleHalfHeight};
        const Vec2 left{center_x - kTriangleHalfWidth, center_y + kTriangleHalfHeight};
        const Vec2 right{center_x + kTriangleHalfWidth, center_y + kTriangleHalfHeight};
        if (!point_in_triangle(reference_point, top, left, right))
            return;

        preview_bridge::emit_object_clicked(
            "demo-triangle", demo_position,
            {clamp01(reference_point.x / width), clamp01(reference_point.y / height)});
    }

    Engine& engine;
    Renderer& renderer;
    assets::AssetManager& assets;
    SandboxDemoConfig config;
    preview_bridge::NormalizedPosition demo_position{0.5f, 0.5f};
    std::uint16_t triangle_vb = bgfx::kInvalidHandle;
    std::uint16_t triangle_ib = bgfx::kInvalidHandle;
    std::uint16_t triangle_program = bgfx::kInvalidHandle;
    std::uint16_t checker_texture = bgfx::kInvalidHandle;
    FontHandle demo_font{};
    std::uint64_t start_counter = 0;
    bool event_watch_installed = false;
    bool initialized = false;
};

SandboxDemoHarness::SandboxDemoHarness(Engine& engine)
    : m_impl(std::make_unique<Impl>(engine, EngineTooling::renderer(engine),
                                    EngineTooling::assets(engine)))
{
}

SandboxDemoHarness::~SandboxDemoHarness() { shutdown(); }

bool SandboxDemoHarness::initialize(SandboxDemoConfig config)
{
    shutdown();
    m_impl->config = std::move(config);
    m_impl->start_counter = SDL_GetPerformanceCounter();
    if (m_impl->config.mode != DemoMode::None) {
        m_impl->create_triangle();
        m_impl->event_watch_installed = SDL_AddEventWatch(&Impl::event_watch, m_impl.get());
    }
    if (demo_enabled(m_impl->config.mode, DemoMode::Render2D))
        m_impl->create_checker_texture();
    if (demo_enabled(m_impl->config.mode, DemoMode::Text)) {
        m_impl->demo_font = m_impl->renderer.load_font({std::string(kSystemFontAsset)});
        if (!m_impl->demo_font)
            m_impl->demo_font = m_impl->renderer.load_font({std::string(kSystemFontProjectAsset)});
    }
    for (const auto& path : m_impl->config.audio_sfx_paths)
        (void)EngineTooling::preview(m_impl->engine).play_audio_sfx(path);
    for (const auto& spec : m_impl->config.audio_track_specs) {
        const auto equals = spec.find('=');
        if (equals == std::string::npos || equals == 0 || equals + 1 >= spec.size()) {
            std::fprintf(stderr, "[sandbox-demo] invalid --audio-track spec: %s\n", spec.c_str());
            continue;
        }
        (void)EngineTooling::preview(m_impl->engine)
            .play_audio_track(spec.substr(0, equals), spec.substr(equals + 1));
    }
    m_impl->initialized = true;
    preview_bridge::emit_ready(m_impl->demo_position,
                               EngineTooling::preview_running(m_impl->engine));
    return true;
}

void SandboxDemoHarness::shutdown()
{
    if (!m_impl || !m_impl->initialized)
        return;
    if (m_impl->event_watch_installed) {
        SDL_RemoveEventWatch(&Impl::event_watch, m_impl.get());
        m_impl->event_watch_installed = false;
    }
    m_impl->destroy_checker_texture();
    m_impl->destroy_triangle();
    EngineTooling::preview(m_impl->engine).stop_all_preview_audio();
    m_impl->demo_font = {};
    m_impl->initialized = false;
}

void SandboxDemoHarness::submit_frame()
{
    if (!m_impl->initialized || m_impl->config.mode == DemoMode::None)
        return;
    const std::uint64_t frequency = SDL_GetPerformanceFrequency();
    const float time_seconds =
        frequency == 0 ? 0.0f
                       : static_cast<float>(SDL_GetPerformanceCounter() - m_impl->start_counter) /
                             static_cast<float>(frequency);
    m_impl->submit_triangle();
    if (demo_enabled(m_impl->config.mode, DemoMode::Render2D))
        m_impl->submit_2d(time_seconds);
    if (demo_enabled(m_impl->config.mode, DemoMode::Text))
        m_impl->submit_text(time_seconds);
}

void SandboxDemoHarness::set_position(float normalized_x, float normalized_y)
{
    m_impl->demo_position = {clamp01(normalized_x), clamp01(normalized_y)};
    preview_bridge::emit_state_changed(m_impl->demo_position,
                                       EngineTooling::preview_running(m_impl->engine));
}

void SandboxDemoHarness::reset_position() { set_position(0.5f, 0.5f); }

preview_bridge::NormalizedPosition SandboxDemoHarness::position() const noexcept
{
    return m_impl->demo_position;
}

} // namespace noveltea::sandbox
