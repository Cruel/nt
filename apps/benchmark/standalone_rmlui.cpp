#include "standalone_rmlui.hpp"
#include "benchmark_assets.hpp"

#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/SystemInterface.h>
#include <bgfx/bgfx.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <utility>
#include <vector>

namespace noveltea::benchmark {
namespace {

using Program = rmlui_bgfx::SystemProgram;

const char* program_name(Program program)
{
    switch (program) {
    case Program::RmlUi:
        return "rmlui";
    case Program::Composite:
        return "rmlui_composite";
    case Program::CompositeFilter:
        return "rmlui_composite_filter";
    case Program::Copy:
        return "rmlui_copy";
    case Program::Opacity:
        return "rmlui_opacity";
    case Program::ColorMatrix:
        return "rmlui_color_matrix";
    case Program::MaskMultiply:
        return "rmlui_mask_multiply";
    case Program::Blur:
        return "rmlui_blur";
    case Program::DropShadow:
        return "rmlui_drop_shadow";
    case Program::Gradient:
        return "rmlui_gradient";
    }
    return nullptr;
}

bgfx::ShaderHandle load_shader(const std::string& filename)
{
    std::ifstream file(benchmark_asset_path(filename.c_str()), std::ios::binary);
    if (!file)
        return BGFX_INVALID_HANDLE;
    const std::vector<char> bytes((std::istreambuf_iterator<char>(file)),
                                  std::istreambuf_iterator<char>());
    if (bytes.empty())
        return BGFX_INVALID_HANDLE;
    return bgfx::createShader(bgfx::copy(bytes.data(), static_cast<uint32_t>(bytes.size())));
}

uint32_t rgba(ReferenceColor value)
{
    return (uint32_t(value.r) << 24) | (uint32_t(value.g) << 16) | (uint32_t(value.b) << 8) |
           uint32_t(value.a);
}

} // namespace

struct StandaloneRmlUi::Shaders final : rmlui_bgfx::ShaderProvider {
    bgfx::ProgramHandle load_program(Program program) override
    {
        const char* name = program_name(program);
        if (!name)
            return BGFX_INVALID_HANDLE;
        std::string vertex = "rmlui.vs.bin";
        std::string fragment = "rmlui.fs.bin";
        if (program == Program::Blur)
            vertex = "rmlui_blur.vs.bin";
        else if (program != Program::RmlUi && program != Program::Gradient)
            vertex = "rmlui_composite.vs.bin";
        fragment = std::string(name) + ".fs.bin";
        if (program == Program::Copy)
            fragment = "rmlui_composite.fs.bin";

        auto vertex_handle =
            load_shader(std::string(NOVELTEA_BENCHMARK_SHADER_ROOT) + "/" + vertex);
        if (!bgfx::isValid(vertex_handle))
            return BGFX_INVALID_HANDLE;
        auto fragment_handle =
            load_shader(std::string(NOVELTEA_BENCHMARK_SHADER_ROOT) + "/" + fragment);
        if (!bgfx::isValid(fragment_handle)) {
            bgfx::destroy(vertex_handle);
            return BGFX_INVALID_HANDLE;
        }
        // rmlui-bgfx owns and destroys the returned program.
        return bgfx::createProgram(vertex_handle, fragment_handle, true);
    }
};

struct StandaloneRmlUi::System final : Rml::SystemInterface {
    std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
    double GetElapsedTime() override
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - origin).count();
    }
};

StandaloneRmlUi::StandaloneRmlUi() = default;
StandaloneRmlUi::~StandaloneRmlUi() { shutdown(); }

bool StandaloneRmlUi::initialize(const ReferenceScene& scene, int framebuffer_width,
                                 int framebuffer_height, std::string& reason)
{
    shutdown();
    if (framebuffer_width < 1 || framebuffer_height < 1 || framebuffer_width > 65535 ||
        framebuffer_height > 65535 || scene.width == 0 || scene.height == 0 ||
        scene.rects.empty()) {
        reason = "invalid standalone RmlUi reference dimensions";
        return false;
    }
    shaders_ = std::make_unique<Shaders>();
    system_ = std::make_unique<System>();
    rmlui_bgfx::RendererConfig config;
    config.surface = {static_cast<int>(scene.width),
                      static_cast<int>(scene.height),
                      framebuffer_width,
                      framebuffer_height,
                      static_cast<float>(framebuffer_width) / scene.width,
                      static_cast<float>(framebuffer_height) / scene.height};
    config.viewport = {0, 0, framebuffer_width, framebuffer_height};
    config.views = {2, 63}; // View 0 clears; View 1 belongs exclusively to ImGui preview.
    config.shaders = shaders_.get();
    config.enable_perf_logging = false;
    config.render_path = rmlui_bgfx::RenderPath::Optimized;
    renderer_ = std::make_unique<rmlui_bgfx::RenderInterface>(config);
    if (!*renderer_) {
        reason = "rmlui-bgfx renderer initialization failed (check packaged shaders)";
        shutdown();
        return false;
    }
    Rml::SetSystemInterface(system_.get());
    Rml::SetRenderInterface(renderer_.get());
    if (!Rml::Initialise()) {
        reason = "RmlUi initialization failed";
        shutdown();
        return false;
    }
    core_initialized_ = true;
    const std::string font_path = benchmark_asset_path(NOVELTEA_BENCHMARK_FONT_PATH).string();
    const bool font_loaded = Rml::LoadFontFace(font_path);
    if (!font_loaded) {
        reason = "cannot load standalone RmlUi common font";
        shutdown();
        return false;
    }
    context_ = Rml::CreateContext("benchmark-standalone-ui",
                                  {static_cast<int>(scene.width), static_cast<int>(scene.height)});
    if (!context_) {
        reason = "cannot create standalone RmlUi context";
        shutdown();
        return false;
    }
    const auto markup = simple_ui_reference_markup(scene);
    document_ = context_->LoadDocumentFromMemory(markup);
    if (!document_) {
        reason = "cannot load standalone RmlUi reference document";
        shutdown();
        return false;
    }
    for (const auto& rect : scene.rects) {
        if (!document_->GetElementById(rect.id)) {
            reason = "standalone RmlUi document missing rectangle " + rect.id;
            shutdown();
            return false;
        }
    }
    for (const auto& item : scene.texts) {
        if (!document_->GetElementById(item.id)) {
            reason = "standalone RmlUi document missing text " + item.id;
            shutdown();
            return false;
        }
    }
    document_->Show();
    clear_rgba_ = rgba(scene.clear_color);
    framebuffer_width_ = framebuffer_width;
    framebuffer_height_ = framebuffer_height;
    return true;
}

bool StandaloneRmlUi::submit(bool diagnostic, std::string& reason)
{
    if (!initialized() || !renderer_) {
        reason = "standalone RmlUi not prepared";
        return false;
    }
    bgfx::setViewRect(0, 0, 0, static_cast<uint16_t>(framebuffer_width_),
                      static_cast<uint16_t>(framebuffer_height_));
    bgfx::setViewClear(0, BGFX_CLEAR_COLOR, clear_rgba_);
    bgfx::touch(0);

    renderer_->begin_frame();
    if (diagnostic) {
        const auto start = std::chrono::steady_clock::now();
        context_->Update();
        const auto after_update = std::chrono::steady_clock::now();
        context_->Render();
        const auto after_render = std::chrono::steady_clock::now();
        stages_.update_seconds = std::chrono::duration<double>(after_update - start).count();
        stages_.render_seconds = std::chrono::duration<double>(after_render - after_update).count();
    } else {
        context_->Update();
        context_->Render();
    }
    renderer_->end_frame();
    return true;
}

void StandaloneRmlUi::shutdown()
{
    if (context_) {
        Rml::RemoveContext("benchmark-standalone-ui");
        context_ = nullptr;
        document_ = nullptr;
    }
    if (core_initialized_)
        Rml::Shutdown();
    core_initialized_ = false;
    Rml::SetRenderInterface(nullptr);
    Rml::SetSystemInterface(nullptr);
    renderer_.reset();
    shaders_.reset();
    system_.reset();
    framebuffer_width_ = 0;
    framebuffer_height_ = 0;
    stages_ = {};
}

} // namespace noveltea::benchmark
