#pragma once

#include "reference_scene.hpp"
#include "benchmark_report.hpp"

#include <RmlUi/Core/Core.h>
#include <RmlUi/Core/ElementDocument.h>
#include <rmlui_bgfx/render_interface.hpp>

#include <chrono>
#include <memory>
#include <string>
#include <vector>

namespace noveltea::benchmark {

class RmlUiEffectProbe;

// Owns only the standalone RmlUi stack. The SDL window and bgfx device belong
// to the benchmark host; neither Engine nor RuntimeUI is constructed here.
class StandaloneRmlUi final {
public:
    struct DiagnosticStages {
        double fixture_mutation_seconds = 0.0;
        double update_seconds = 0.0;
        double render_seconds = 0.0;
    };

    StandaloneRmlUi();
    ~StandaloneRmlUi();
    StandaloneRmlUi(const StandaloneRmlUi&) = delete;
    StandaloneRmlUi& operator=(const StandaloneRmlUi&) = delete;

    bool initialize(const ReferenceScene& scene, int framebuffer_width, int framebuffer_height,
                    std::string& reason, const Options* scaling = nullptr);
    bool submit(bool diagnostic, std::string& reason);
    void shutdown();
    [[nodiscard]] bool initialized() const { return context_ != nullptr; }
    // Captured only for Diagnostic runs; Clean frames perform no stage timing.
    [[nodiscard]] DiagnosticStages last_diagnostic_stages() const { return stages_; }
    [[nodiscard]] UiBackendSettings backend_settings() const { return backend_settings_; }
    [[nodiscard]] UiEffectActivity effect_activity() const;
    bool verify_effects(std::string& reason);

private:
    struct Shaders;
    struct EffectDiagnostics;
    struct System;
    std::unique_ptr<Shaders> shaders_;
    std::unique_ptr<EffectDiagnostics> effect_diagnostics_;
    std::unique_ptr<System> system_;
    std::unique_ptr<rmlui_bgfx::RenderInterface> renderer_;
    std::unique_ptr<RmlUiEffectProbe> effect_probe_;
    UiEffectCounts requested_effects_;
    Rml::Context* context_ = nullptr;
    bool core_initialized_ = false;
    // RmlUi retains memory-backed font bytes until Rml::Shutdown().
    std::vector<Rml::byte> font_memory_;
    Rml::ElementDocument* document_ = nullptr;
    std::vector<Rml::Context*> extra_contexts_;
    std::vector<Rml::ElementDocument*> visible_documents_;
    bool scaling_ = false;
    bool effects_ = false;
    bool dynamic_text_ = false;
    uint32_t dynamic_lines_ = 1;
    bool dirty_only_ = false;
    uint32_t frame_index_ = 0;
    int framebuffer_width_ = 0;
    int framebuffer_height_ = 0;
    uint32_t clear_rgba_ = 0;
    DiagnosticStages stages_;
    UiBackendSettings backend_settings_;
};

} // namespace noveltea::benchmark
