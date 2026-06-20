#include "noveltea/renderer.hpp"

#include "bgfx_renderer_internal.hpp"
#include "render/bgfx/bgfx_shader_loader.hpp"

#include <SDL3/SDL.h>

#include <bgfx/bgfx.h>
#include <bgfx/platform.h>

#include <bimg/bimg.h>

#include <bx/file.h>
#include <bx/error.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>

namespace noveltea {

using namespace bgfx_backend;

// ---------------------------------------------------------------------------
// Vertex / index data for a colored triangle
// ---------------------------------------------------------------------------

struct PosColorVertex {
    float x, y;
    float r, g, b, a;
};

static PosColorVertex s_triangle_vertices[3] = {
    {0.0f, -42.0f, 1.0f, 0.0f, 0.0f, 1.0f},  // top - red
    {-48.0f, 42.0f, 0.0f, 1.0f, 0.0f, 1.0f}, // bottom-left - green
    {48.0f, 42.0f, 0.0f, 0.0f, 1.0f, 1.0f},  // bottom-right - blue
};

static const uint16_t s_triangle_indices[3] = {0, 1, 2};

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
        if (!file_path || !data || width == 0 || height == 0 || pitch < width * 4u ||
            size < pitch * height) {
            std::fprintf(stderr, "[renderer] invalid screenshot callback payload\n");
            return;
        }

        const std::filesystem::path output(file_path);
        if (output.has_parent_path()) {
            std::error_code ec;
            std::filesystem::create_directories(output.parent_path(), ec);
        }

        const std::string ext = output.extension().string();
        if (ext == ".png") {
            bx::FileWriter writer;
            bx::Error err;
            if (!writer.open(bx::FilePath(file_path), false, &err)) {
                std::fprintf(stderr, "[renderer] failed to open PNG screenshot: %s\n", file_path);
                return;
            }
            bimg::imageWritePng(&writer, width, height, pitch, data, bimg::TextureFormat::BGRA8,
                                yflip, &err);
            if (!err.isOk()) {
                std::fprintf(stderr, "[renderer] PNG write error: %s\n",
                             err.getMessage().getCPtr());
            }
            writer.close();
            return;
        }

        std::ofstream file(output, std::ios::binary);
        if (!file) {
            std::fprintf(stderr, "[renderer] failed to write screenshot: %s\n", file_path);
            return;
        }

        file << "P6\n" << width << ' ' << height << "\n255\n";
        const auto* bytes = static_cast<const uint8_t*>(data);
        for (uint32_t y = 0; y < height; ++y) {
            const uint32_t source_y = yflip ? (height - 1u - y) : y;
            const uint8_t* row = bytes + source_y * pitch;
            for (uint32_t x = 0; x < width; ++x) {
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
};

RendererCallback s_renderer_callback;

// ---------------------------------------------------------------------------
// Renderer implementation
// ---------------------------------------------------------------------------

Renderer::Renderer() = default;
Renderer::~Renderer() { shutdown(); }

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
    const SurfaceMetrics surface = sanitize_surface_metrics(config.surface);
    init.resolution.width = static_cast<uint32_t>(surface.framebuffer_width);
    init.resolution.height = static_cast<uint32_t>(surface.framebuffer_height);
    init.resolution.reset = config.vsync ? BGFX_RESET_VSYNC : 0;

    if (!bgfx::init(init)) {
        std::fprintf(stderr, "[renderer] bgfx::init failed\n");
        return false;
    }

    m_surface = surface;
    m_vsync = config.vsync;
    m_assets = config.assets;
    m_initialized = true;

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x4040c0ff, 1.0f, 0);
    bgfx::setViewRect(ViewGameLayerBackground, 0, 0,
                      static_cast<uint16_t>(m_surface.framebuffer_width),
                      static_cast<uint16_t>(m_surface.framebuffer_height));

    create_triangle();
    create_2d();
    create_text();

    SDL_Log("[renderer] bgfx initialized: %s logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f",
            renderer_name(), m_surface.logical_width, m_surface.logical_height,
            m_surface.framebuffer_width, m_surface.framebuffer_height, m_surface.scale_x,
            m_surface.scale_y);
    return true;
}

void Renderer::begin_frame()
{
    const auto fb_w = static_cast<uint16_t>(m_surface.framebuffer_width);
    const auto fb_h = static_cast<uint16_t>(m_surface.framebuffer_height);

    // Game layer views — Background clears, successive layers composite over.
    bgfx::setViewClear(ViewGameLayerBackground, BGFX_CLEAR_COLOR | BGFX_CLEAR_DEPTH, 0x20242cff,
                       1.0f, 0);
    bgfx::setViewRect(ViewGameLayerBackground, 0, 0, fb_w, fb_h);
    bgfx::setViewRect(ViewGameLayerMain, 0, 0, fb_w, fb_h);
    bgfx::setViewRect(ViewGameLayerForeground, 0, 0, fb_w, fb_h);
    bgfx::setViewRect(ViewGameLayerUIOverlay, 0, 0, fb_w, fb_h);

    bgfx::setViewRect(ViewTextLab, 0, 0, fb_w, fb_h);
    bgfx::setViewRect(ViewDebugUI, 0, 0, fb_w, fb_h);

    float ortho[16];
    make_ortho(ortho, static_cast<float>(m_surface.logical_width),
               static_cast<float>(m_surface.logical_height));
    bgfx::setViewTransform(ViewGameLayerBackground, nullptr, ortho);
    bgfx::setViewTransform(ViewGameLayerMain, nullptr, ortho);
    bgfx::setViewTransform(ViewGameLayerForeground, nullptr, ortho);
    bgfx::setViewTransform(ViewGameLayerUIOverlay, nullptr, ortho);
    bgfx::setViewTransform(ViewTextLab, nullptr, ortho);

    bgfx::setDebug(BGFX_DEBUG_TEXT);
    bgfx::dbgTextClear();

    // Touch every game view so bgfx processes them in order.
    bgfx::touch(ViewGameLayerBackground);
    bgfx::touch(ViewGameLayerMain);
    bgfx::touch(ViewGameLayerForeground);
    bgfx::touch(ViewGameLayerUIOverlay);

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

void Renderer::draw_preview_triangle(preview_bridge::NormalizedPosition position)
{
    if (!m_initialized || m_surface.logical_width <= 0 || m_surface.logical_height <= 0)
        return;

    if (bgfx::isValid(bgfx::VertexBufferHandle{m_triangle_vb}) &&
        bgfx::isValid(bgfx::IndexBufferHandle{m_triangle_ib}) &&
        bgfx::isValid(bgfx::ProgramHandle{m_triangle_program})) {
        constexpr float half_width = 48.0f;
        constexpr float half_height = 42.0f;
        const float usable_width = static_cast<float>(m_surface.logical_width) - half_width * 2.0f;
        const float usable_height =
            static_cast<float>(m_surface.logical_height) - half_height * 2.0f;
        const float x = half_width + position.x * (usable_width > 0.0f ? usable_width : 0.0f);
        const float y = half_height + position.y * (usable_height > 0.0f ? usable_height : 0.0f);
        const float transform[16] = {
            1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
            0.0f, 0.0f, 1.0f, 0.0f, x,    y,    0.0f, 1.0f,
        };
        bgfx::setTransform(transform);
        bgfx::setVertexBuffer(0, bgfx::VertexBufferHandle{m_triangle_vb});
        bgfx::setIndexBuffer(bgfx::IndexBufferHandle{m_triangle_ib});
        bgfx::submit(ViewGameLayerUIOverlay, bgfx::ProgramHandle{m_triangle_program});
    }
}

void Renderer::end_frame()
{
    if (!m_pending_screenshot.empty()) {
        bgfx::requestScreenShot(BGFX_INVALID_HANDLE, m_pending_screenshot.c_str());
        m_pending_screenshot.clear();
    }
    bgfx::frame();
}

void Renderer::request_screenshot(const std::string& path) { m_pending_screenshot = path; }

void Renderer::resize(const SurfaceMetrics& surface)
{
    if (!m_initialized)
        return;

    m_surface = sanitize_surface_metrics(surface);

    bgfx::reset(static_cast<uint32_t>(m_surface.framebuffer_width),
                static_cast<uint32_t>(m_surface.framebuffer_height),
                m_vsync ? BGFX_RESET_VSYNC : 0);
    bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(m_surface.framebuffer_width),
                      static_cast<uint16_t>(m_surface.framebuffer_height));
    SDL_Log("[renderer] resized logical=%dx%d framebuffer=%dx%d scale=%.3fx%.3f",
            m_surface.logical_width, m_surface.logical_height, m_surface.framebuffer_width,
            m_surface.framebuffer_height, m_surface.scale_x, m_surface.scale_y);
    resize_text();
}

void Renderer::shutdown()
{
    if (m_initialized) {
        destroy_text();
        destroy_2d();
        destroy_triangle();
        bgfx::shutdown();
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

// ---------------------------------------------------------------------------
// Triangle resource lifecycle
// ---------------------------------------------------------------------------

void Renderer::create_triangle()
{
    if (!m_assets) {
        std::fprintf(stderr, "[renderer] no AssetManager for triangle shader\n");
        return;
    }
    BgfxShaderLoader shaders(*m_assets);
    bgfx::ProgramHandle program = shaders.load_program(SystemShader::Triangle);
    if (!bgfx::isValid(program)) {
        std::fprintf(stderr, "[renderer] triangle shader load failed; skipping triangle\n");
        return;
    }

    m_triangle_program = program.idx;

    // Vertex layout.
    bgfx::VertexLayout layout;
    layout.begin()
        .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
        .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
        .end();

    m_triangle_vb = bgfx::createVertexBuffer(
                        bgfx::makeRef(s_triangle_vertices, sizeof(s_triangle_vertices)), layout)
                        .idx;

    m_triangle_ib =
        bgfx::createIndexBuffer(bgfx::makeRef(s_triangle_indices, sizeof(s_triangle_indices))).idx;

    SDL_Log("[renderer] triangle resources created");
}

void Renderer::destroy_triangle()
{
    if (bgfx::isValid(bgfx::ProgramHandle{m_triangle_program})) {
        bgfx::destroy(bgfx::ProgramHandle{m_triangle_program});
    }
    if (bgfx::isValid(bgfx::VertexBufferHandle{m_triangle_vb})) {
        bgfx::destroy(bgfx::VertexBufferHandle{m_triangle_vb});
    }
    if (bgfx::isValid(bgfx::IndexBufferHandle{m_triangle_ib})) {
        bgfx::destroy(bgfx::IndexBufferHandle{m_triangle_ib});
    }

    m_triangle_vb = UINT16_MAX;
    m_triangle_ib = UINT16_MAX;
    m_triangle_program = UINT16_MAX;

    SDL_Log("[renderer] triangle resources destroyed");
}

} // namespace noveltea
