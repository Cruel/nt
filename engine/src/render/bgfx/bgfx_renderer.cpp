#include "noveltea/renderer.hpp"

#include "bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_material_binder.hpp"
#include "render/bgfx/bgfx_screenshot_capture.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"
#include "render/bgfx/bgfx_shader_program_cache.hpp"
#include "render/bgfx/bgfx_typed_asset_loader.hpp"

#include <SDL3/SDL.h>

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <bimg/bimg.h>

#include <bx/file.h>
#include <bx/error.h>
#include <bx/allocator.h>
#include <bx/readerwriter.h>

#include <algorithm>
#include <charconv>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

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

class RendererCallback final : public bgfx::CallbackI {
public:
    enum class RequestKind : std::uint8_t {
        File,
        Capture
    };

    struct Request {
        std::uint64_t callback_id = 0;
        RequestKind kind = RequestKind::File;
        std::uint64_t capture_id = 0;
        std::string output_path;
        IntegerSize captured_host_size{};
        IntegerRect crop{};
    };

    struct Capture {
        std::uint64_t request_id = 0;
        std::uint32_t width = 0;
        std::uint32_t height = 0;
        std::string png_bytes;
    };

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

    void screenShot(const char* file_path, uint32_t width, uint32_t height, uint32_t pitch,
#if BGFX_API_VERSION >= 143
                    bgfx::TextureFormat::Enum,
#endif
                    const void* data, uint32_t size, bool yflip) override
    {
        constexpr std::string_view capture_prefix = "__noveltea_game_viewport_capture_";
        constexpr std::string_view capture_suffix = ".ntcapture";
        if (!file_path) {
            std::fprintf(stderr, "[renderer] screenshot callback has no request path\n");
            return;
        }
        const std::string_view requested_path(file_path);
        if (!requested_path.starts_with(capture_prefix) ||
            !requested_path.ends_with(capture_suffix)) {
            std::fprintf(stderr, "[renderer] unrecognized screenshot callback request: %s\n",
                         file_path);
            return;
        }

        const auto id_text = requested_path.substr(capture_prefix.size(),
                                                   requested_path.size() - capture_prefix.size() -
                                                       capture_suffix.size());
        std::uint64_t callback_id = 0;
        const auto parsed =
            std::from_chars(id_text.data(), id_text.data() + id_text.size(), callback_id);
        if (parsed.ec != std::errc{} || parsed.ptr != id_text.data() + id_text.size()) {
            std::fprintf(stderr, "[renderer] invalid screenshot callback id\n");
            return;
        }

        auto request = take_request(callback_id);
        if (!request) {
            if (take_cancelled_callback(callback_id))
                return;
            std::fprintf(stderr, "[renderer] screenshot callback id is no longer outstanding\n");
            return;
        }

        auto cropped = crop_screenshot_bgra8(data, width, height, pitch, size, yflip,
                                             request->captured_host_size, request->crop);
        if (!cropped) {
            std::fprintf(stderr,
                         "[renderer] screenshot crop rejected: callback=%ux%u captured=%dx%d "
                         "crop=%d,%d %dx%d\n",
                         width, height, request->captured_host_size.width,
                         request->captured_host_size.height, request->crop.x, request->crop.y,
                         request->crop.width, request->crop.height);
            fail_capture(*request);
            return;
        }

        if (request->kind == RequestKind::Capture) {
            bx::DefaultAllocator allocator;
            bx::MemoryBlock memory(&allocator);
            bx::MemoryWriter writer(&memory);
            bx::Error err;
            const auto encoded_size =
                bimg::imageWritePng(&writer, cropped->width, cropped->height, cropped->pitch,
                                    cropped->bgra8.data(), bimg::TextureFormat::BGRA8, false, &err);
            if (!err.isOk() || encoded_size <= 0 ||
                static_cast<std::uint32_t>(encoded_size) > memory.getSize()) {
                std::fprintf(stderr, "[renderer] checkpoint PNG write error: %s\n",
                             err.getMessage().getCPtr());
                fail_capture(*request);
                return;
            }
            Capture capture{request->capture_id, cropped->width, cropped->height,
                            std::string(static_cast<const char*>(memory.more()),
                                        static_cast<std::size_t>(encoded_size))};
            std::scoped_lock lock(m_mutex);
            m_captures.push_back(std::move(capture));
            return;
        }

        const std::filesystem::path output(request->output_path);
        if (output.has_parent_path()) {
            std::error_code ec;
            std::filesystem::create_directories(output.parent_path(), ec);
            if (ec) {
                std::fprintf(stderr, "[renderer] failed to create screenshot directory: %s\n",
                             ec.message().c_str());
                return;
            }
        }

        const std::string ext = output.extension().string();
        if (ext == ".png") {
            bx::FileWriter writer;
            bx::Error err;
            if (!writer.open(bx::FilePath(request->output_path.c_str()), false, &err)) {
                std::fprintf(stderr, "[renderer] failed to open PNG screenshot: %s\n",
                             request->output_path.c_str());
                return;
            }
            bimg::imageWritePng(&writer, cropped->width, cropped->height, cropped->pitch,
                                cropped->bgra8.data(), bimg::TextureFormat::BGRA8, false, &err);
            if (!err.isOk()) {
                std::fprintf(stderr, "[renderer] PNG write error: %s\n",
                             err.getMessage().getCPtr());
            }
            writer.close();
            return;
        }

        std::ofstream file(output, std::ios::binary);
        if (!file) {
            std::fprintf(stderr, "[renderer] failed to write screenshot: %s\n",
                         request->output_path.c_str());
            return;
        }

        file << "P6\n" << cropped->width << ' ' << cropped->height << "\n255\n";
        for (uint32_t y = 0; y < cropped->height; ++y) {
            const uint8_t* row =
                cropped->bgra8.data() + static_cast<std::size_t>(y) * cropped->pitch;
            for (uint32_t x = 0; x < cropped->width; ++x) {
                const uint8_t b = row[x * 4u + 0u];
                const uint8_t g = row[x * 4u + 1u];
                const uint8_t r = row[x * 4u + 2u];
                const char rgb[3] = {static_cast<char>(r), static_cast<char>(g),
                                     static_cast<char>(b)};
                file.write(rgb, sizeof(rgb));
            }
        }
    }

    void captureBegin(uint32_t, uint32_t, uint32_t, bgfx::TextureFormat::Enum, bool) override {}
    void captureEnd() override {}
    void captureFrame(const void*, uint32_t) override {}

    void register_request(Request request)
    {
        std::scoped_lock lock(m_mutex);
        m_requests.push_back(std::move(request));
    }

    [[nodiscard]] std::optional<Capture> take_capture(std::uint64_t request_id)
    {
        std::scoped_lock lock(m_mutex);
        const auto found = std::find_if(
            m_captures.begin(), m_captures.end(),
            [request_id](const Capture& capture) { return capture.request_id == request_id; });
        if (found == m_captures.end())
            return std::nullopt;
        Capture capture = std::move(*found);
        m_captures.erase(found);
        return capture;
    }

    [[nodiscard]] bool take_capture_failure(std::uint64_t request_id)
    {
        std::scoped_lock lock(m_mutex);
        const auto found =
            std::find(m_failed_captures.begin(), m_failed_captures.end(), request_id);
        if (found == m_failed_captures.end())
            return false;
        m_failed_captures.erase(found);
        return true;
    }

    void cancel_capture(std::uint64_t request_id)
    {
        std::scoped_lock lock(m_mutex);
        for (const auto& request : m_requests) {
            if (request.kind == RequestKind::Capture && request.capture_id == request_id)
                m_cancelled_callbacks.push_back(request.callback_id);
        }
        std::erase_if(m_requests, [request_id](const Request& request) {
            return request.kind == RequestKind::Capture && request.capture_id == request_id;
        });
        std::erase_if(m_captures, [request_id](const Capture& capture) {
            return capture.request_id == request_id;
        });
        std::erase(m_failed_captures, request_id);
    }

    void clear_captures()
    {
        std::scoped_lock lock(m_mutex);
        m_captures.clear();
        m_requests.clear();
        m_failed_captures.clear();
        m_cancelled_callbacks.clear();
    }

private:
    void fail_capture(const Request& request)
    {
        if (request.kind != RequestKind::Capture)
            return;
        std::scoped_lock lock(m_mutex);
        if (std::find(m_failed_captures.begin(), m_failed_captures.end(), request.capture_id) ==
            m_failed_captures.end())
            m_failed_captures.push_back(request.capture_id);
    }

    [[nodiscard]] std::optional<Request> take_request(std::uint64_t callback_id)
    {
        std::scoped_lock lock(m_mutex);
        const auto found = std::find_if(
            m_requests.begin(), m_requests.end(),
            [callback_id](const Request& request) { return request.callback_id == callback_id; });
        if (found == m_requests.end())
            return std::nullopt;
        Request request = std::move(*found);
        m_requests.erase(found);
        return request;
    }

    [[nodiscard]] bool take_cancelled_callback(std::uint64_t callback_id)
    {
        std::scoped_lock lock(m_mutex);
        const auto found =
            std::find(m_cancelled_callbacks.begin(), m_cancelled_callbacks.end(), callback_id);
        if (found == m_cancelled_callbacks.end())
            return false;
        m_cancelled_callbacks.erase(found);
        return true;
    }

    std::mutex m_mutex;
    std::vector<Request> m_requests;
    std::vector<Capture> m_captures;
    std::vector<std::uint64_t> m_failed_captures;
    std::vector<std::uint64_t> m_cancelled_callbacks;
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

    bgfx::Init init;
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    init.type = bgfx::RendererType::OpenGL;
#else
    init.type = bgfx::RendererType::Count; // auto-detect (Android: GLES, Web: GLES/WebGL)
#endif
    init.platformData = pd;
    init.callback = &s_renderer_callback;
    const PresentationMetrics presentation = config.presentation;
    const HostSurfaceMetrics host = sanitize_host_surface_metrics(presentation.host);
    init.resolution.width = static_cast<uint32_t>(host.framebuffer_size.width);
    init.resolution.height = static_cast<uint32_t>(host.framebuffer_size.height);
    // Keep swapchain MSAA off. RmlUi resolves its own offscreen MSAA before final presentation,
    // matching the upstream GL3 renderer's normal-backbuffer final pass.
    init.resolution.reset = (config.vsync ? BGFX_RESET_VSYNC : 0);

    if (!bgfx::init(init)) {
        std::fprintf(stderr, "[renderer] bgfx::init failed\n");
        return false;
    }

    m_presentation = presentation;
    m_bar_color_rgba = config.bar_color_rgba;
    m_vsync = config.vsync;
    m_assets = config.assets;
    m_initialized = true;

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(ViewPresentationClear, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, m_bar_color_rgba,
                       1.0f, 0);

    create_2d();
    if (!prepare_ordinary_world_surface()) {
        std::fprintf(stderr, "[renderer] failed to create ordinary world color target\n");
        shutdown();
        return false;
    }
    create_text();

    SDL_Log("[renderer] bgfx initialized: %s %s", renderer_name(),
            format_presentation_metrics(m_presentation).c_str());
    return true;
}

void Renderer::begin_frame()
{
    const auto& host = m_presentation.host;
    const auto& viewport = m_presentation.viewport.host_framebuffer_rect;
    const auto fb_x = static_cast<uint16_t>(viewport.x);
    const auto fb_y = static_cast<uint16_t>(viewport.y);
    const auto fb_w = static_cast<uint16_t>(viewport.width);
    const auto fb_h = static_cast<uint16_t>(viewport.height);

    bgfx::setViewClear(ViewPresentationClear, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, m_bar_color_rgba,
                       1.0f, 0);
    bgfx::setViewRect(ViewPresentationClear, 0, 0,
                      static_cast<uint16_t>(host.framebuffer_size.width),
                      static_cast<uint16_t>(host.framebuffer_size.height));
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
          ViewGameUiUnderlay, ViewFullGamePostprocessComposite})
        bgfx::setViewFrameBuffer(view, BGFX_INVALID_HANDLE);
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

void Renderer::end_frame()
{
    if (!m_pending_screenshot.empty()) {
        submit_screenshot_request(std::move(m_pending_screenshot), std::nullopt);
        m_pending_screenshot.clear();
    }
    if (m_pending_screenshot_capture) {
        submit_screenshot_request({}, m_pending_screenshot_capture);
        m_outstanding_screenshot_capture = m_pending_screenshot_capture;
        m_pending_screenshot_capture.reset();
    }
    bgfx::frame();
}

void Renderer::submit_screenshot_request(std::string output_path,
                                         std::optional<std::uint64_t> capture_id)
{
    const std::uint64_t callback_id = m_next_screenshot_callback_id;
    ++m_next_screenshot_callback_id;
    if (m_next_screenshot_callback_id == 0)
        m_next_screenshot_callback_id = 1;

    s_renderer_callback.register_request(
        RendererCallback::Request{.callback_id = callback_id,
                                  .kind = capture_id ? RendererCallback::RequestKind::Capture
                                                     : RendererCallback::RequestKind::File,
                                  .capture_id = capture_id.value_or(0),
                                  .output_path = std::move(output_path),
                                  .captured_host_size = m_presentation.host.framebuffer_size,
                                  .crop = m_presentation.viewport.host_framebuffer_rect});
    const std::string callback_path =
        "__noveltea_game_viewport_capture_" + std::to_string(callback_id) + ".ntcapture";
    bgfx::requestScreenShot(BGFX_INVALID_HANDLE, callback_path.c_str());
}

void Renderer::request_screenshot(const std::string& path) { m_pending_screenshot = path; }

bool Renderer::request_screenshot_capture(std::uint64_t request_id)
{
    if (!m_initialized || request_id == 0 || m_pending_screenshot_capture ||
        m_outstanding_screenshot_capture)
        return false;
    m_pending_screenshot_capture = request_id;
    return true;
}

std::optional<RendererScreenshotCapture> Renderer::take_screenshot_capture()
{
    if (!m_outstanding_screenshot_capture)
        return std::nullopt;
    const std::uint64_t request_id = *m_outstanding_screenshot_capture;
    auto capture = s_renderer_callback.take_capture(request_id);
    if (!capture && s_renderer_callback.take_capture_failure(request_id)) {
        m_outstanding_screenshot_capture.reset();
        return std::nullopt;
    }
    if (!capture)
        return std::nullopt;
    m_outstanding_screenshot_capture.reset();
    return RendererScreenshotCapture{capture->request_id, capture->width, capture->height,
                                     std::move(capture->png_bytes)};
}

void Renderer::resize(const PresentationMetrics& presentation)
{
    if (!m_initialized)
        return;

    if (m_pending_screenshot_capture) {
        s_renderer_callback.cancel_capture(*m_pending_screenshot_capture);
        m_pending_screenshot_capture.reset();
    }
    if (m_outstanding_screenshot_capture) {
        s_renderer_callback.cancel_capture(*m_outstanding_screenshot_capture);
        m_outstanding_screenshot_capture.reset();
    }

    m_presentation = presentation;
    destroy_world_transition_surfaces();
    destroy_postprocess_surface();
    const HostSurfaceMetrics& host = m_presentation.host;

    bgfx::reset(static_cast<uint32_t>(host.framebuffer_size.width),
                static_cast<uint32_t>(host.framebuffer_size.height),
                (m_vsync ? BGFX_RESET_VSYNC : 0));
    bgfx::setViewRect(ViewPresentationClear, 0, 0,
                      static_cast<uint16_t>(host.framebuffer_size.width),
                      static_cast<uint16_t>(host.framebuffer_size.height));
    if (!prepare_ordinary_world_surface())
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION,
                     "[renderer] failed to resize ordinary world color target");
    SDL_Log("[renderer] resized %s", format_presentation_metrics(m_presentation).c_str());
    resize_text();
}

void Renderer::shutdown()
{
    if (m_initialized) {
        destroy_text();
        destroy_world_transition_surfaces();
        destroy_postprocess_surface();
        destroy_ordinary_world_surface();
        destroy_2d();
        bgfx::shutdown();
        s_renderer_callback.clear_captures();
        m_pending_screenshot.clear();
        m_pending_screenshot_capture.reset();
        m_outstanding_screenshot_capture.reset();
        m_next_screenshot_callback_id = 1;
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
