#pragma once

#include "reference_scene.hpp"
#include "benchmark_report.hpp"

#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/ElementDocument.h>
#include <rmlui_bgfx/render_interface.hpp>

#include <chrono>
#include <memory>
#include <string>

namespace noveltea::benchmark {

// Owns only the standalone RmlUi stack. The SDL window and bgfx device belong
// to the benchmark host; neither Engine nor RuntimeUI is constructed here.
class StandaloneRmlUi final {
public:
    struct DiagnosticStages {
        double update_seconds = 0.0;
        double render_seconds = 0.0;
    };

    StandaloneRmlUi();
    ~StandaloneRmlUi();
    StandaloneRmlUi(const StandaloneRmlUi&) = delete;
    StandaloneRmlUi& operator=(const StandaloneRmlUi&) = delete;

    bool initialize(const ReferenceScene& scene, int framebuffer_width, int framebuffer_height,
                    std::string& reason);
    bool submit(bool diagnostic, std::string& reason);
    void shutdown();
    [[nodiscard]] bool initialized() const { return context_ != nullptr; }
    // Captured only for Diagnostic runs; Clean frames perform no stage timing.
    [[nodiscard]] DiagnosticStages last_diagnostic_stages() const { return stages_; }
    [[nodiscard]] UiBackendSettings backend_settings() const { return backend_settings_; }

private:
    struct Shaders;
    struct System;
    std::unique_ptr<Shaders> shaders_;
    std::unique_ptr<System> system_;
    std::unique_ptr<rmlui_bgfx::RenderInterface> renderer_;
    Rml::Context* context_ = nullptr;
    bool core_initialized_ = false;
    Rml::ElementDocument* document_ = nullptr;
    int framebuffer_width_ = 0;
    int framebuffer_height_ = 0;
    uint32_t clear_rgba_ = 0;
    DiagnosticStages stages_;
    UiBackendSettings backend_settings_;
};

} // namespace noveltea::benchmark
