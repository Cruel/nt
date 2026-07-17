#pragma once

#include "noveltea/audio/audio_types.hpp"
#include "noveltea/preview_bridge.hpp"
#include "noveltea/surface.hpp"

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

struct PlatformConfig;
class RuntimePreviewController;

namespace core {
class TypedSaveSlotStore;
}

enum class DemoMode {
    None,
    All,
    Render2D,
    RmlUi,
    Text,
};

struct EngineRunConfig {
    uint32_t frame_limit = 0;
    uint32_t fps_cap = 0;
    double fixed_delta_seconds = 0.0;
    DemoMode demo_mode = DemoMode::None;
    std::filesystem::path system_asset_root;
    std::filesystem::path project_asset_root;
    std::filesystem::path cache_asset_root;
    std::string runtime_ui_document;
    std::string compiled_project;
    bool load_title_screen = true;
    bool keep_runtime_running = false;
    std::string screenshot_path;
    bool enable_debug_ui = true;
    bool preview_widget = false;
    bool render_perf_logging = false;
    bool rmlui_base_direct_compat = false;
    bool enable_audio = true;
    bool show_fps_counter = false;
    std::vector<std::string> audio_sfx_paths;
    std::vector<std::string> audio_track_specs;
    core::TypedSaveSlotStore* save_slot_store = nullptr;
};

class Engine final {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    bool initialize(const PlatformConfig& config, const EngineRunConfig& run_config = {});
    int run();
    bool tick();
    void resize(const SurfaceMetrics& surface);
    void resize_host(const SurfaceMetrics& surface);
    const PresentationMetrics& presentation() const;
    void set_preview_display_override(std::optional<DisplayProfile> profile);
    void shutdown();
    void request_stop();
    void set_demo_position(float normalized_x, float normalized_y);
    void reset_demo_position();
    void set_preview_running(bool running);
    void set_show_fps_counter(bool show);
    void set_fps_cap(uint32_t frames_per_second);
    bool show_fps_counter() const;
    uint32_t fps_cap() const;
    bool load_preview_rml_document(const std::string& rml);
    bool execute_preview_lua_script(const std::string& source);
    bool apply_editor_preview_document(const std::string& kind, const std::string& data_json);
    RuntimePreviewController& runtime_preview() noexcept;
    const RuntimePreviewController& runtime_preview() const noexcept;
    AudioVoiceHandle play_audio_sfx(const std::string& path, float volume = 1.0f,
                                    float pitch = 1.0f);
    AudioTrackHandle play_audio_track(const AudioTrackId& track_id, const std::string& path,
                                      float volume = 1.0f, bool loop = true);
    void stop_audio_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    preview_bridge::NormalizedPosition demo_position() const;
    bool preview_running() const;
    bool is_running() const;

private:
    friend class RuntimePreviewController;

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea
