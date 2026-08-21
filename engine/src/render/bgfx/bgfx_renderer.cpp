#include "noveltea/renderer.hpp"

#include "bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include <SDL3/SDL.h>

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <optional>
#include <utility>

namespace noveltea {

using namespace bgfx_backend;

static void make_ortho(float* out, float width, float height)
{
    std::memset(out, 0, sizeof(float) * 16);
    out[0] = 2.0f / width;
    out[5] = -2.0f / height;
    out[10] = 1.0f;
    out[12] = -1.0f;
    out[13] = 1.0f;
    out[15] = 1.0f;
}

namespace {

#if defined(NOVELTEA_PLATFORM_WEB)
[[nodiscard]] int align_backbuffer_dimension(int value)
{
    constexpr int alignment = 64;
    return ((std::max(value, 1) + alignment - 1) / alignment) * alignment;
}
#endif

[[nodiscard]] IntegerSize resolve_backbuffer_size(IntegerSize current, IntegerSize required)
{
#if defined(NOVELTEA_PLATFORM_WEB)
    auto grow_dimension = [](int current_value, int required_value) {
        if (current_value >= required_value)
            return current_value;
        if (current_value <= 0)
            return align_backbuffer_dimension(required_value);
        const int headroom = std::max(64, current_value / 4);
        return align_backbuffer_dimension(std::max(required_value, current_value + headroom));
    };
    return {grow_dimension(current.width, required.width),
            grow_dimension(current.height, required.height)};
#else
    return {std::max(required.width, 1), std::max(required.height, 1)};
#endif
}

} // namespace

class RendererCallback final : public bgfx::CallbackI {
public:
    void fatal(const char* file_path, uint16_t line, bgfx::Fatal::Enum code,
               const char* message) override
    {
        std::fprintf(stderr, "[bgfx] fatal %s:%u: %s\n", file_path ? file_path : "<unknown>", line,
                     message ? message : "");
        if (code != bgfx::Fatal::DebugCheck) {
            std::abort();
        }
    }

    void traceVargs(const char*, uint16_t, const char*, va_list) override {}
    void profilerBegin(const char*, uint32_t, const char*, uint16_t) override {}
    void profilerBeginLiteral(const char*, uint32_t, const char*, uint16_t) override {}
    void profilerEnd() override {}
    uint32_t cacheReadSize(uint64_t) override { return 0; }
    bool cacheRead(uint64_t, void*, uint32_t) override { return false; }
    void cacheWrite(uint64_t, const void*, uint32_t) override {}

    void screenShot(const char*, uint32_t, uint32_t, uint32_t,
#if BGFX_API_VERSION >= 143
                    bgfx::TextureFormat::Enum,
#endif
                    const void*, uint32_t, bool) override
    {
    }

    void captureBegin(uint32_t, uint32_t, uint32_t, bgfx::TextureFormat::Enum, bool) override {}
    void captureEnd() override {}
    void captureFrame(const void*, uint32_t) override {}
};

RendererCallback s_renderer_callback;

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

Renderer::Renderer() = default;
Renderer::~Renderer() { shutdown(); }

void Renderer::set_shader_material_project(const ShaderMaterialProject* project)
{
    m_shader_materials = project;
    if (m_typed_asset_loader) {
        m_typed_asset_loader->set_shader_material_project(project);
    }
}

void Renderer::set_shader_standard_inputs(const ShaderStandardInputs& inputs)
{
    m_shader_standard_inputs = inputs;
}

bool Renderer::initialize(const RendererConfig& config)
{
    if (m_initialized)
        return true;

    if (!config.native_window) {
        std::fprintf(stderr, "[renderer] no native window provided\n");
        return false;
    }

    bgfx::PlatformData pd{};
    pd.ndt = config.native_display;
    pd.nwh = config.native_window;
    pd.type = config.native_window_type == NativeWindowHandleType::Wayland
                  ? bgfx::NativeWindowHandleType::Wayland
                  : bgfx::NativeWindowHandleType::Default;

    bgfx::Init init;
#if defined(__APPLE__) && defined(NOVELTEA_PLATFORM_DESKTOP)
    init.type = bgfx::RendererType::Metal;
    constexpr const char* requested_renderer = "Metal";
#elif defined(NOVELTEA_PLATFORM_DESKTOP)
    init.type = bgfx::RendererType::OpenGL;
    constexpr const char* requested_renderer = "OpenGL";
#else
    init.type = bgfx::RendererType::Count; // auto-detect (Android: GLES, Web: GLES/WebGL)
    constexpr const char* requested_renderer = "auto";
#endif
    init.platformData = pd;
    init.callback = &s_renderer_callback;
    const PresentationMetrics presentation = config.presentation;
    const HostSurfaceMetrics host = sanitize_host_surface_metrics(presentation.host);
    const IntegerSize backbuffer_size = resolve_backbuffer_size({}, host.framebuffer_size);
    init.resolution.width = static_cast<uint32_t>(backbuffer_size.width);
    init.resolution.height = static_cast<uint32_t>(backbuffer_size.height);
    // Keep swapchain MSAA off. RmlUi resolves its own offscreen MSAA before final presentation,
    // matching the upstream GL3 renderer's normal-backbuffer final pass.
    init.resolution.reset = (config.vsync ? BGFX_RESET_VSYNC : 0);

    SDL_Log("[renderer] starting bgfx::init requested=%s window=%p display=%p", requested_renderer,
            config.native_window, config.native_display);
    if (!bgfx::init(init)) {
        std::fprintf(stderr, "[renderer] bgfx::init failed\n");
        return false;
    }
    SDL_Log("[renderer] bgfx core initialized: %s", renderer_name());

    m_presentation = presentation;
    m_backbuffer_size = backbuffer_size;
    m_bar_color_rgba = config.bar_color_rgba;
    m_vsync = config.vsync;
    m_assets = config.assets;
    m_initialized = true;

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(ViewPresentationClear, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, m_bar_color_rgba,
                       1.0f, 0);

    create_2d();
    SDL_Log("[renderer] 2d resources initialized");
    if (!prepare_ordinary_world_surface()) {
        std::fprintf(stderr, "[renderer] failed to create ordinary world color target\n");
        shutdown();
        return false;
    }
    SDL_Log("[renderer] ordinary world surface initialized");
    create_text();
    SDL_Log("[renderer] text resources initialized");

    SDL_Log("[renderer] bgfx initialized: %s %s", renderer_name(),
            format_presentation_metrics(m_presentation).c_str());
    return true;
}

void Renderer::begin_frame()
{
    if (m_pending_screenshot_capture && !m_active_screenshot_capture &&
        !m_outstanding_screenshot_capture) {
        auto request = *m_pending_screenshot_capture;
        m_pending_screenshot_capture.reset();
        if (prepare_screenshot_capture_surfaces(request))
            m_active_screenshot_capture = request;
    }

    const auto& host = m_presentation.host;
    const auto& viewport = m_presentation.viewport.host_framebuffer_rect;
    const bool capture_frame = m_active_screenshot_capture.has_value();
    const auto fb_x = static_cast<uint16_t>(capture_frame ? 0 : viewport.x);
    const auto fb_y = static_cast<uint16_t>(capture_frame ? 0 : viewport.y);
    const auto fb_w =
        static_cast<uint16_t>(capture_frame ? m_screenshot_scene_width : viewport.width);
    const auto fb_h =
        static_cast<uint16_t>(capture_frame ? m_screenshot_scene_height : viewport.height);
    bgfx::FrameBufferHandle final_framebuffer = BGFX_INVALID_HANDLE;
    if (capture_frame)
        final_framebuffer = bgfx::FrameBufferHandle{m_screenshot_scene_target.framebuffer};

    bgfx::setViewFrameBuffer(ViewPresentationClear, final_framebuffer);
    bgfx::setViewClear(ViewPresentationClear, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, m_bar_color_rgba,
                       1.0f, 0);
    bgfx::setViewRect(ViewPresentationClear, fb_x, fb_y, fb_w, fb_h);
    bgfx::touch(ViewPresentationClear);

    bgfx::setViewClear(ViewWorldSourceBackground, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff,
                       1.0f, 0);
    bgfx::setViewClear(ViewWorldSourceSceneComposite, BGFX_CLEAR_NONE);
    bgfx::setViewClear(ViewWorldTargetSceneComposite, BGFX_CLEAR_NONE);
    if (!prepare_ordinary_world_surface())
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[renderer] ordinary world color target is unavailable");
    for (const auto view :
         {ViewWorldSourceBackground, ViewWorldSourceContent, ViewWorldSourceSceneComposite,
          ViewWorldTargetSceneComposite, ViewWorldNativeOverlay, ViewWorldTransitionSourceComposite,
          ViewWorldTransitionTargetComposite, ViewGameTransition, ViewWorldPostprocessComposite,
          ViewGameUiUnderlay, ViewFullGamePostprocessComposite})
        bgfx::setViewRect(view, fb_x, fb_y, fb_w, fb_h);
    for (const auto view :
         {ViewWorldSourceBackground, ViewWorldSourceContent, ViewWorldTargetBackground,
          ViewWorldTargetContent, ViewWorldSourceSceneComposite, ViewWorldTargetSceneComposite,
          ViewWorldNativeOverlay, ViewWorldTransitionSourceComposite,
          ViewWorldTransitionTargetComposite, ViewGameTransition, ViewWorldPostprocessComposite,
          ViewGameUiUnderlay, ViewFullGamePostprocessComposite})
        bgfx::setViewMode(view, bgfx::ViewMode::Sequential);
    for (const auto view :
         {ViewWorldSourceBackground, ViewWorldSourceContent, ViewWorldSourceSceneComposite,
          ViewWorldTargetSceneComposite, ViewWorldNativeOverlay, ViewWorldTransitionSourceComposite,
          ViewWorldTransitionTargetComposite, ViewGameTransition, ViewWorldPostprocessComposite,
          ViewGameUiUnderlay, ViewActiveText, ViewFullGamePostprocessComposite})
        bgfx::setViewFrameBuffer(view, final_framebuffer);
    bgfx::setViewFrameBuffer(ViewPostprocessSceneClear, BGFX_INVALID_HANDLE);
    bgfx::setViewClear(ViewPostprocessSceneClear, BGFX_CLEAR_NONE);

    bgfx::setViewRect(ViewTextLab, fb_x, fb_y, fb_w, fb_h);
    bgfx::setViewRect(ViewActiveText, fb_x, fb_y, fb_w, fb_h);
    bgfx::setViewRect(ViewDebugUI, 0, 0, static_cast<uint16_t>(host.framebuffer_size.width),
                      static_cast<uint16_t>(host.framebuffer_size.height));

    float ortho[16];
    make_ortho(ortho, static_cast<float>(m_presentation.reference.size.width),
               static_cast<float>(m_presentation.reference.size.height));
    for (const auto view :
         {ViewWorldSourceBackground, ViewWorldSourceContent, ViewWorldTargetBackground,
          ViewWorldTargetContent, ViewWorldSourceSceneComposite, ViewWorldTargetSceneComposite,
          ViewWorldNativeOverlay, ViewWorldTransitionSourceComposite,
          ViewWorldTransitionTargetComposite, ViewGameTransition, ViewWorldPostprocessComposite,
          ViewGameUiUnderlay, ViewFullGamePostprocessComposite})
        bgfx::setViewTransform(view, nullptr, ortho);
    bgfx::setViewTransform(ViewPostprocessSceneClear, nullptr, ortho);
    bgfx::setViewTransform(ViewTextLab, nullptr, ortho);
    bgfx::setViewTransform(ViewActiveText, nullptr, ortho);

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::dbgTextClear();

    bgfx::touch(ViewWorldSourceBackground);
    bgfx::touch(ViewWorldSourceContent);
    bgfx::touch(ViewWorldSourceSceneComposite);
    bgfx::touch(ViewWorldTargetSceneComposite);
    bgfx::touch(ViewWorldNativeOverlay);
    bgfx::touch(ViewWorldTransitionSourceComposite);
    bgfx::touch(ViewWorldTransitionTargetComposite);
    bgfx::touch(ViewGameTransition);
    bgfx::touch(ViewWorldPostprocessComposite);
    bgfx::touch(ViewGameUiUnderlay);
    bgfx::touch(ViewFullGamePostprocessComposite);

    // Reset scissor stack at the start of each frame.
    m_scissor_stack.clear();
}

void Renderer::push_scissor(int16_t x, int16_t y, uint16_t w, uint16_t h)
{
    m_scissor_stack.push_back({x, y, w, h, true});
}

void Renderer::pop_scissor()
{
    if (!m_scissor_stack.empty()) {
        m_scissor_stack.pop_back();
    }
}

Renderer::ScissorRect Renderer::current_scissor() const
{
    return m_scissor_stack.empty() ? ScissorRect{} : m_scissor_stack.back();
}

void Renderer::end_frame() { m_bgfx_frame = bgfx::frame(); }

bool Renderer::request_screenshot_capture(RendererScreenshotRequest request)
{
    const auto valid_uv = [](const Rect& uv) {
        return uv.width > 0.0f && uv.height > 0.0f && uv.x >= 0.0f && uv.y >= 0.0f &&
               uv.x + uv.width <= 1.0f && uv.y + uv.height <= 1.0f;
    };
    if (!m_initialized || request.request_id == 0 || !valid_uv(request.source_uv) ||
        m_pending_screenshot_capture || m_active_screenshot_capture ||
        m_outstanding_screenshot_capture)
        return false;
    const auto readback_bytes = screenshot_rgba8_byte_size(request.width, request.height);
    const auto* caps = bgfx::getCaps();
    if (!readback_bytes || (caps != nullptr && (request.width > caps->limits.maxTextureSize ||
                                                request.height > caps->limits.maxTextureSize)))
        return false;
    m_pending_screenshot_capture = request;
    return true;
}

bool Renderer::game_viewport_capture_pending() const noexcept
{
    return m_pending_screenshot_capture.has_value() || m_active_screenshot_capture.has_value() ||
           m_outstanding_screenshot_capture.has_value();
}

std::uint16_t Renderer::screenshot_output_framebuffer() const noexcept
{
    return m_active_screenshot_capture ? m_screenshot_scene_target.framebuffer : UINT16_MAX;
}

std::optional<RendererScreenshotCapture> Renderer::take_screenshot_capture()
{
    if (!m_outstanding_screenshot_capture || m_bgfx_frame < m_screenshot_readback_ready_frame)
        return std::nullopt;

    const auto request_id = *m_outstanding_screenshot_capture;
    const auto* caps = bgfx::getCaps();
    const bool yflip = caps != nullptr && caps->originBottomLeft;
    RendererScreenshotCapture capture{
        request_id,
        m_screenshot_output_width,
        m_screenshot_output_height,
        static_cast<std::uint32_t>(m_screenshot_output_width) * 4u,
        RendererScreenshotPixelFormat::Rgba8,
        yflip,
        std::move(m_screenshot_readback_pixels),
    };
    m_outstanding_screenshot_capture.reset();
    m_screenshot_readback_ready_frame = 0;
    return capture;
}

void Renderer::resize(const PresentationMetrics& presentation)
{
    if (!m_initialized)
        return;

    m_presentation = presentation;
    destroy_world_transition_surfaces();
    destroy_postprocess_surface();
    const HostSurfaceMetrics& host = m_presentation.host;
    const IntegerSize next_backbuffer_size =
        resolve_backbuffer_size(m_backbuffer_size, host.framebuffer_size);
    if (next_backbuffer_size != m_backbuffer_size) {
        bgfx::reset(static_cast<uint32_t>(next_backbuffer_size.width),
                    static_cast<uint32_t>(next_backbuffer_size.height),
                    (m_vsync ? BGFX_RESET_VSYNC : 0));
        m_backbuffer_size = next_backbuffer_size;
    }
    bgfx::setViewRect(ViewPresentationClear, 0, 0,
                      static_cast<uint16_t>(host.framebuffer_size.width),
                      static_cast<uint16_t>(host.framebuffer_size.height));
    if (!prepare_ordinary_world_surface())
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[renderer] failed to resize ordinary world color target");
    SDL_Log("[renderer] resized %s backbuffer=%dx%d",
            format_presentation_metrics(m_presentation).c_str(), m_backbuffer_size.width,
            m_backbuffer_size.height);
    resize_text();
}

void Renderer::shutdown()
{
    if (m_initialized) {
        destroy_text();
        destroy_world_transition_surfaces();
        destroy_postprocess_surface();
        destroy_screenshot_capture_surfaces();
        destroy_ordinary_world_surface();
        destroy_2d();
        bgfx::shutdown();
        m_pending_screenshot_capture.reset();
        m_active_screenshot_capture.reset();
        m_outstanding_screenshot_capture.reset();
        m_screenshot_readback_pixels.clear();
        m_screenshot_readback_ready_frame = 0;
        m_bgfx_frame = 0;
        m_backbuffer_size = {};
        m_initialized = false;
        std::printf("[renderer] bgfx shutdown\n");
    }
}

const char* Renderer::renderer_name() const
{
    if (!m_initialized)
        return "uninitialized";
    return bgfx::getRendererName(bgfx::getRendererType());
}

const char* Renderer::active_shader_variant() const
{
    return m_shader_program_cache ? m_shader_program_cache->active_variant() : "";
}

void Renderer::debug_printf(uint16_t x, uint16_t y, uint8_t color, const char* fmt, ...)
{
    if (!m_initialized)
        return;
    char buf[256];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    bgfx::dbgTextPrintf(x, y, color, "%s", buf);
}

} // namespace noveltea
