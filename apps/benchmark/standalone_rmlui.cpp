#include "standalone_rmlui.hpp"
#include "benchmark_assets.hpp"
#include "rmlui_effect_probe.hpp"
#include "ui_effect_verification.hpp"

#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/Element.h>
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

        auto vertex_handle = load_benchmark_shader(
            (std::string(NOVELTEA_BENCHMARK_SHADER_ROOT) + "/" + vertex).c_str());
        if (!bgfx::isValid(vertex_handle))
            return BGFX_INVALID_HANDLE;
        auto fragment_handle = load_benchmark_shader(
            (std::string(NOVELTEA_BENCHMARK_SHADER_ROOT) + "/" + fragment).c_str());
        if (!bgfx::isValid(fragment_handle)) {
            bgfx::destroy(vertex_handle);
            return BGFX_INVALID_HANDLE;
        }
        // rmlui-bgfx owns and destroys the returned program.
        return bgfx::createProgram(vertex_handle, fragment_handle, true);
    }
};

struct StandaloneRmlUi::EffectDiagnostics final : rmlui_bgfx::Diagnostics {
    bool capturing = false;
    uint32_t errors = 0;
    void warning(std::string_view message) override
    {
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
    }
    void error(std::string_view message) override
    {
        if (capturing)
            ++errors;
        std::fprintf(stderr, "[rmlui] %.*s\n", int(message.size()), message.data());
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
                                 int framebuffer_height, std::string& reason,
                                 const Options* scaling)
{
    shutdown();
    if (framebuffer_width < 1 || framebuffer_height < 1 || framebuffer_width > 65535 ||
        framebuffer_height > 65535 || scene.width == 0 || scene.height == 0 ||
        scene.rects.empty()) {
        reason = "invalid standalone RmlUi reference dimensions";
        return false;
    }
    shaders_ = std::make_unique<Shaders>();
    effect_diagnostics_ = std::make_unique<EffectDiagnostics>();
    system_ = std::make_unique<System>();
    rmlui_bgfx::RendererConfig config;
    config.surface = {static_cast<int>(scene.width),
                      static_cast<int>(scene.height),
                      framebuffer_width,
                      framebuffer_height,
                      static_cast<float>(framebuffer_width) / scene.width,
                      static_cast<float>(framebuffer_height) / scene.height};
    config.viewport = {0, 0, framebuffer_width, framebuffer_height};
    config.views = {2, 63}; // View 0 clears; preview remaps view 1 (ImGui) to last.
    config.shaders = shaders_.get();
    config.diagnostics = effect_diagnostics_.get();
    config.enable_perf_logging = false;
    config.render_path = rmlui_bgfx::RenderPath::Optimized;
    // Capture *effective constructor inputs*, not a label guessed from
    // scenario name. MSAA=2 means the base layer cannot be direct.
    backend_settings_ = {
        .reference_msaa_samples = config.reference_msaa_samples,
        .base_direct_compatibility_requested = false,
        .preserve_backbuffer = config.preserve_backbuffer,
        .optimized_render_path = config.render_path == rmlui_bgfx::RenderPath::Optimized,
        .output_framebuffer_bound = bgfx::isValid(config.output_framebuffer),
        .viewport_width = config.viewport.width,
        .viewport_height = config.viewport.height,
    };
    renderer_ = std::make_unique<rmlui_bgfx::RenderInterface>(config);
    if (!*renderer_) {
        reason = "rmlui-bgfx renderer initialization failed (check packaged shaders)";
        shutdown();
        return false;
    }
    Rml::SetSystemInterface(system_.get());
    requested_effects_ = scene.effects;
    effects_ = scene.id == "ui-effects-reference";
    effect_probe_ = std::make_unique<RmlUiEffectProbe>(*renderer_);
    effect_probe_->capture(scene.id == "ui-effects-reference");
    Rml::SetRenderInterface(effect_probe_.get());
    if (!Rml::Initialise()) {
        reason = "RmlUi initialization failed";
        shutdown();
        return false;
    }
    core_initialized_ = true;
    // RmlUi's pathname loader uses ordinary fopen, which cannot read APK
    // assets. SDL_LoadFile resolves both packaged Android assets and the
    // regular Linux/Web benchmark paths. Retain the bytes until Shutdown.
    const std::string font_path = benchmark_asset_path(NOVELTEA_BENCHMARK_FONT_PATH).string();
    size_t font_size = 0;
    void* font_bytes = SDL_LoadFile(font_path.c_str(), &font_size);
    if (font_bytes && font_size > 0) {
        const auto* first = static_cast<const Rml::byte*>(font_bytes);
        font_memory_.assign(first, first + font_size);
    }
    SDL_free(font_bytes);
    const bool font_loaded = !font_memory_.empty() &&
                             Rml::LoadFontFace(Rml::Span<const Rml::byte>(font_memory_),
                                               "Liberation Sans", Rml::Style::FontStyle::Normal);
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
    visible_documents_.push_back(document_);
    scaling_ = scaling != nullptr;
    if (scaling) {
        dynamic_text_ = scaling->ui_text_mode == "dynamic" && scaling->ui_text_lines > 0;
        dirty_only_ = scaling->ui_redraw == "dirty-only";
        const uint32_t total =
            scaling->ui_visible_contexts + scaling->ui_empty_contexts + scaling->ui_hidden_contexts;
        for (uint32_t index = 1; index < total; ++index) {
            const std::string name = "benchmark-ui-" + std::to_string(index);
            auto* context = Rml::CreateContext(
                name, {static_cast<int>(scene.width), static_cast<int>(scene.height)});
            if (!context) {
                reason = "cannot create standalone scaling context " + name;
                shutdown();
                return false;
            }
            extra_contexts_.push_back(context);
            const bool visible = index < scaling->ui_visible_contexts;
            const bool hidden = index >= scaling->ui_visible_contexts + scaling->ui_empty_contexts;
            if (visible || hidden) {
                auto* document = context->LoadDocumentFromMemory(markup);
                if (!document) {
                    reason = "cannot load scaling context document " + name;
                    shutdown();
                    return false;
                }
                if (visible) {
                    document->Show();
                    visible_documents_.push_back(document);
                } else {
                    document->Hide();
                }
            }
        }
    }
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
    const auto start =
        diagnostic ? std::chrono::steady_clock::now() : std::chrono::steady_clock::time_point{};
    if (effects_) {
        // Equivalent CSS widths keep every pixel fixed but ensure each
        // benchmark frame exercises the actual effect submission path rather
        // than an idle/cached UI layer.
        if (auto* background = document_->GetElementById("reference-background"))
            background->SetProperty("width", frame_index_ % 2 == 0 ? "1280.0px" : "1280px");
    }
    if (scaling_ && !dirty_only_) {
        // Equivalent CSS spellings force a layout invalidation while the
        // presented rectangle dimensions and all pixels stay unchanged.
        for (auto* document : visible_documents_)
            document->GetElementById("ui-element-0")
                ->SetProperty("width", frame_index_ % 2 == 0 ? "15.0px" : "15px");
    }
    if (dynamic_text_) {
        const auto replacement = ui_dynamic_text(frame_index_);
        for (auto* document : visible_documents_) {
            if (auto* text = document->GetElementById("ui-text-0"))
                text->SetInnerRML(replacement);
        }
    }
    ++frame_index_;
    const auto update = [&]() {
        context_->Update();
        for (auto* context : extra_contexts_)
            context->Update();
    };
    const auto render = [&]() {
        context_->Render();
        for (auto* context : extra_contexts_)
            context->Render();
    };
    if (diagnostic) {
        update();
        const auto after_update = std::chrono::steady_clock::now();
        render();
        const auto after_render = std::chrono::steady_clock::now();
        stages_.update_seconds = std::chrono::duration<double>(after_update - start).count();
        stages_.render_seconds = std::chrono::duration<double>(after_render - after_update).count();
    } else {
        update();
        render();
    }
    renderer_->end_frame();
    return true;
}

UiEffectActivity StandaloneRmlUi::effect_activity() const
{
    auto activity = effect_probe_ ? effect_probe_->activity() : UiEffectActivity{};
    if (effect_diagnostics_)
        activity.backend_errors = effect_diagnostics_->errors;
    return activity;
}

bool StandaloneRmlUi::verify_effects(std::string& reason)
{
    if (!effect_probe_)
        return false;
    const auto activity = effect_activity();
    effect_probe_->capture(false);
    if (effect_diagnostics_)
        effect_diagnostics_->capturing = false;
    return verify_ui_effect_activity(requested_effects_, activity, reason);
}

void StandaloneRmlUi::shutdown()
{
    visible_documents_.clear();
    for (size_t i = 0; i < extra_contexts_.size(); ++i)
        Rml::RemoveContext("benchmark-ui-" + std::to_string(i + 1));
    extra_contexts_.clear();
    scaling_ = false;
    effects_ = false;
    dynamic_text_ = false;
    dirty_only_ = false;
    frame_index_ = 0;
    if (context_) {
        Rml::RemoveContext("benchmark-standalone-ui");
        context_ = nullptr;
        document_ = nullptr;
    }
    if (core_initialized_)
        Rml::Shutdown();
    core_initialized_ = false;
    font_memory_.clear();
    Rml::SetRenderInterface(nullptr);
    Rml::SetSystemInterface(nullptr);
    effect_probe_.reset();
    renderer_.reset();
    requested_effects_ = {};
    effect_diagnostics_.reset();
    shaders_.reset();
    system_.reset();
    framebuffer_width_ = 0;
    framebuffer_height_ = 0;
    stages_ = {};
    backend_settings_ = {};
}

} // namespace noveltea::benchmark
