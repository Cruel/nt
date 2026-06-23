#pragma once

#include <bgfx/bgfx.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace rmlui_bgfx {

struct SurfaceMetrics {
    int logical_width = 1;
    int logical_height = 1;
    int framebuffer_width = 1;
    int framebuffer_height = 1;
    float scale_x = 1.0f;
    float scale_y = 1.0f;
};

[[nodiscard]] inline SurfaceMetrics sanitize_surface_metrics(SurfaceMetrics metrics)
{
    metrics.logical_width = std::max(metrics.logical_width, 1);
    metrics.logical_height = std::max(metrics.logical_height, 1);
    metrics.framebuffer_width = std::max(metrics.framebuffer_width, 1);
    metrics.framebuffer_height = std::max(metrics.framebuffer_height, 1);
    metrics.scale_x = metrics.scale_x > 0.0f
                          ? metrics.scale_x
                          : float(metrics.framebuffer_width) / float(metrics.logical_width);
    metrics.scale_y = metrics.scale_y > 0.0f
                          ? metrics.scale_y
                          : float(metrics.framebuffer_height) / float(metrics.logical_height);
    if (metrics.scale_x <= 0.0f)
        metrics.scale_x = 1.0f;
    if (metrics.scale_y <= 0.0f)
        metrics.scale_y = 1.0f;
    return metrics;
}

struct ViewRange {
    bgfx::ViewId begin = 0;
    bgfx::ViewId end = 0;
};

enum class SystemProgram {
    RmlUi,
    Composite,
    CompositeFilter,
    Copy,
    Opacity,
    ColorMatrix,
    MaskMultiply,
    Blur,
    DropShadow,
    Gradient,
};

[[nodiscard]] inline std::string_view system_program_name(SystemProgram program)
{
    switch (program) {
    case SystemProgram::RmlUi:
        return "RmlUi";
    case SystemProgram::Composite:
        return "Composite";
    case SystemProgram::CompositeFilter:
        return "CompositeFilter";
    case SystemProgram::Copy:
        return "Copy";
    case SystemProgram::Opacity:
        return "Opacity";
    case SystemProgram::ColorMatrix:
        return "ColorMatrix";
    case SystemProgram::MaskMultiply:
        return "MaskMultiply";
    case SystemProgram::Blur:
        return "Blur";
    case SystemProgram::DropShadow:
        return "DropShadow";
    case SystemProgram::Gradient:
        return "Gradient";
    }
    return "Unknown";
}

class ShaderProvider {
public:
    virtual ~ShaderProvider() = default;
    [[nodiscard]] virtual bgfx::ProgramHandle load_program(SystemProgram program) = 0;
};

struct LoadedTexture {
    int width = 0;
    int height = 0;
    std::vector<std::uint8_t> rgba8;
};

class TextureLoader {
public:
    virtual ~TextureLoader() = default;
    [[nodiscard]] virtual bool load_rgba8(const char* source, LoadedTexture& out,
                                          std::string* error_message) = 0;
};

class Diagnostics {
public:
    virtual ~Diagnostics() = default;
    virtual void warning(std::string_view message) = 0;
    virtual void error(std::string_view message) = 0;
};

class PerfLogger {
public:
    virtual ~PerfLogger() = default;
    virtual void log_perf_line(std::string_view message) = 0;
};

struct RendererConfig {
    SurfaceMetrics surface{};
    ViewRange views{};
    ShaderProvider* shaders = nullptr;
    TextureLoader* textures = nullptr;
    Diagnostics* diagnostics = nullptr;
    PerfLogger* perf_logger = nullptr;
    bool enable_perf_logging = false;
};

} // namespace rmlui_bgfx
