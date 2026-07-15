#pragma once

#include "platform.hpp"
#include "preview_bridge.hpp"
#include "renderer.hpp"
#include "runtime_preview_controller.hpp"
#include "noveltea/runtime_audio_adapter.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "ui_debug.hpp"
#include "ui_runtime.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/tween_service.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/compiled_runtime.hpp"

#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

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
    DemoMode demo_mode = DemoMode::None;
    std::filesystem::path system_asset_root;
    std::filesystem::path project_asset_root;
    std::filesystem::path cache_asset_root;
    std::string runtime_ui_document;
    std::string compiled_project;
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

class Engine {
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
    const PresentationMetrics& presentation() const { return m_presentation; }
    void set_preview_display_override(std::optional<DisplayProfile> profile);
    void shutdown();
    void request_stop();
    void set_demo_position(float normalized_x, float normalized_y);
    void reset_demo_position();
    void set_preview_running(bool running);
    void set_show_fps_counter(bool show);
    void set_fps_cap(uint32_t frames_per_second);
    bool show_fps_counter() const { return m_show_fps_counter; }
    uint32_t fps_cap() const { return m_fps_cap; }
    bool load_preview_rml_document(const std::string& rml);
    bool execute_preview_lua_script(const std::string& source);
    bool apply_editor_preview_document(const std::string& kind, const std::string& data_json);
    RuntimePreviewController& runtime_preview() noexcept { return m_runtime_preview; }
    const RuntimePreviewController& runtime_preview() const noexcept { return m_runtime_preview; }
    AudioVoiceHandle play_audio_sfx(const std::string& path, float volume = 1.0f,
                                    float pitch = 1.0f);
    AudioTrackHandle play_audio_track(const AudioTrackId& track_id, const std::string& path,
                                      float volume = 1.0f, bool loop = true);
    void stop_audio_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    preview_bridge::NormalizedPosition demo_position() const { return m_demo_position; }
    bool preview_running() const { return m_preview_running; }

    bool is_running() const { return m_running; }

private:
    friend class RuntimePreviewController;

    void handle_events();
    bool throttle_frame_start();
    void finish_frame_timing_sample();
    uint32_t effective_frame_pace_cap() const;
    void handle_mouse_down(float x, float y, uint8_t button);
    void update(double host_delta_seconds);
    void render();
    void configure_assets(const EngineRunConfig& run_config);
    bool load_project_shader_materials();
    bool load_compiled_project(const std::string& logical_path, bool load_title_screen = true);
    assets::AssetManager m_assets;
    AudioSystem m_audio;
    Platform m_platform;
    DisplayProfile m_display_profile{};
    std::optional<DisplayProfile> m_preview_display_override;
    PresentationMetrics m_presentation{};
    Renderer m_renderer;
    TweenService m_tweens;
    script::ScriptRuntime m_scripts;
    core::TypedMemorySaveSlotStore m_typed_saves;
    core::RuntimeClock m_runtime_clock;
    core::RuntimeClockUpdate m_frame_clock{};
    core::TypedSaveSlotStore* m_save_slots = &m_typed_saves;
    std::unique_ptr<script::CompiledRuntime> m_compiled_runtime;
    std::vector<core::RuntimeOutputMessage> m_typed_runtime_outputs;
    core::Diagnostics m_typed_runtime_diagnostics;
    ShaderMaterialProject m_shader_materials;
    RuntimeUiAssetResolver m_runtime_ui_asset_resolver;
    RuntimeAudioAdapter m_runtime_audio_adapter;
    RuntimeUI m_runtime_ui;
    RuntimeLayoutManager m_runtime_layouts;
    std::optional<core::MountedLayoutInstanceId> m_title_layout_instance;
    std::optional<core::MountedLayoutInstanceId> m_game_hud_layout_instance;
    RuntimePreviewController m_runtime_preview;
    DebugUI m_debug_ui;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    uint32_t m_fps_cap = 0;
    uint64_t m_next_frame_counter = 0;
    std::string m_screenshot_path;
    DemoMode m_demo_mode = DemoMode::None;
    Vec2 m_pointer_position{};
    bool m_pointer_valid = false;
    preview_bridge::NormalizedPosition m_demo_position{0.5f, 0.5f};
    bool m_preview_running = true;
    bool m_debug_ui_enabled = true;
    bool m_render_perf_logging = false;
    bool m_audio_enabled = true;
    bool m_preview_widget = false;
    bool m_show_fps_counter = false;
    bool m_host_suspended = false;
    uint32_t m_fps_sample_frames = 0;
    uint64_t m_fps_sample_start_counter = 0;
    std::string m_compiled_project_path;
};

} // namespace noveltea
