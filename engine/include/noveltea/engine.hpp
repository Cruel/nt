#pragma once

#include "platform.hpp"
#include "preview_bridge.hpp"
#include "renderer.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "ui_debug.hpp"
#include "ui_runtime.hpp"
#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/core/runtime_session_host.hpp"
#include "noveltea/runtime_shell.hpp"
#include "noveltea/tween_service.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/script/runtime_script_executor.hpp"

#include <cstdint>
#include <filesystem>
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
    std::string runtime_project;
    std::string screenshot_path;
    bool enable_debug_ui = true;
    bool preview_widget = false;
    bool render_perf_logging = false;
    bool rmlui_base_direct_compat = false;
    bool enable_audio = true;
    bool show_fps_counter = false;
    std::vector<std::string> audio_sfx_paths;
    std::vector<std::string> audio_track_specs;
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
    bool runtime_preview_reset();
    bool runtime_preview_start();
    bool runtime_preview_stop();
    bool runtime_preview_step(double delta_seconds);
    bool runtime_preview_continue();
    bool runtime_preview_dialogue_option(int option_index);
    bool runtime_preview_navigate(int direction);
    bool runtime_preview_select_object(const std::string& object_id);
    bool runtime_preview_clear_object_selection();
    bool runtime_preview_run_action(const std::string& verb_id,
                                    const std::vector<std::string>& object_ids);
    std::string runtime_preview_set_variable(const std::string& variable_id,
                                             const std::string& value_json);
    std::string runtime_preview_reset_variable(const std::string& variable_id);
    std::string runtime_preview_give_object(const std::string& object_id);
    std::string runtime_preview_remove_inventory_object(const std::string& object_id);
    std::string runtime_preview_teleport_room(const std::string& room_id);
    std::string runtime_preview_debug_snapshot() const;
    AudioVoiceHandle play_audio_sfx(const std::string& path, float volume = 1.0f,
                                    float pitch = 1.0f);
    AudioTrackHandle play_audio_track(const AudioTrackId& track_id, const std::string& path,
                                      float volume = 1.0f, bool loop = true);
    void stop_audio_track(const AudioTrackId& track_id, float fade_seconds = 0.0f);
    preview_bridge::NormalizedPosition demo_position() const { return m_demo_position; }
    bool preview_running() const { return m_preview_running; }

    bool is_running() const { return m_running; }

private:
    void handle_events();
    bool throttle_frame_start();
    void finish_frame_timing_sample();
    uint32_t effective_frame_pace_cap() const;
    void handle_mouse_down(float x, float y, uint8_t button);
    void update(float dt);
    void render();
    void configure_assets(const EngineRunConfig& run_config);
    bool load_project_shader_materials();
    bool load_runtime_project(const std::string& logical_path);
    bool apply_runtime_preview_input(core::RuntimeInput input);
    void process_runtime_result(core::RuntimeInputResult& result);
    void process_audio_outputs(const std::vector<core::RuntimeOutput>& outputs);

    assets::AssetManager m_assets;
    AudioSystem m_audio;
    Platform m_platform;
    Renderer m_renderer;
    TweenService m_tweens;
    script::ScriptRuntime m_scripts;
    script::RuntimeScriptExecutor m_script_executor;
    ShaderMaterialProject m_shader_materials;
    RuntimeUI m_runtime_ui;
    RuntimeShell m_runtime_shell;
    DebugUI m_debug_ui;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    uint32_t m_fps_cap = 0;
    uint64_t m_next_frame_counter = 0;
    std::string m_screenshot_path;
    DemoMode m_demo_mode = DemoMode::None;
    float m_elapsed_seconds = 0.0f;
    Vec2 m_pointer_position{};
    bool m_pointer_valid = false;
    preview_bridge::NormalizedPosition m_demo_position{0.5f, 0.5f};
    bool m_preview_running = true;
    bool m_debug_ui_enabled = true;
    bool m_render_perf_logging = false;
    bool m_audio_enabled = true;
    bool m_preview_widget = false;
    bool m_show_fps_counter = false;
    uint32_t m_fps_sample_frames = 0;
    uint64_t m_fps_sample_start_counter = 0;
    std::string m_runtime_project_path;
};

} // namespace noveltea
