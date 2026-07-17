#pragma once

#include "noveltea/engine.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/runtime/running_game.hpp"
#include "noveltea/runtime_audio_adapter.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/runtime_presentation_bridge.hpp"
#include "noveltea/runtime_preview_controller.hpp"
#include "noveltea/runtime_system_layouts.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_debug.hpp"
#include "noveltea/ui_runtime.hpp"
#include "noveltea/world_presentation.hpp"
#include "noveltea/world_transition.hpp"
#include "noveltea/platform.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea {

struct Engine::Impl final : private RuntimeSystemLayoutHost {
    explicit Impl(Engine& owner);

    void handle_events();
    bool throttle_frame_start();
    void finish_frame_timing_sample();
    uint32_t effective_frame_pace_cap() const;
    void handle_mouse_down(float x, float y, uint8_t button);
    void update(double host_delta_seconds);
    void render();
    [[nodiscard]] bool dispatch_runtime_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool dispatch_runtime_input_once(const core::RuntimeInputMessage& input);
    [[nodiscard]] bool flush_runtime_presentation();
    void append_runtime_diagnostics(core::Diagnostics diagnostics);
    void configure_assets(const EngineRunConfig& run_config);
    bool load_project_shader_materials();
    bool load_compiled_project(const std::string& logical_path, bool load_title_screen = true,
                               bool stop_runtime_after_load = true);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_presentation_snapshot(const core::RuntimePresentationSnapshot& snapshot);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_presentation_layouts(const core::RuntimePresentationSnapshot& snapshot);
    [[nodiscard]] core::Result<std::string, core::Diagnostics>
    prepare_runtime_layout_document(const core::LayoutId& layout, const std::string& document_id);
    [[nodiscard]] core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
    mount_system_layout(core::compiled::SystemLayoutRole role,
                        core::MountedLayoutPolicy policy) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_system_layout_visible(core::MountedLayoutInstanceId instance, bool visible) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    unmount_system_layout(core::MountedLayoutInstanceId instance) override;
    [[nodiscard]] bool dispatch_shell_runtime_input(core::RuntimeInputMessage input) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_runtime_user_settings(core::RuntimeUserSettings settings) override;
    [[nodiscard]] core::RuntimeShellViewState
    build_runtime_shell_view(core::RuntimeShellScreen screen,
                             const std::optional<core::RuntimeShellConfirmation>& confirmation,
                             bool game_active) override;
    void publish_runtime_shell_view(core::RuntimeShellViewState view) override;
    void request_shell_quit() override;
    void apply_world_transition_layout_state();
    void release_retained_presentation_layouts();

    bool initialize(const PlatformConfig& config, const EngineRunConfig& run_config);
    int run();
    bool tick();
    void resize(const SurfaceMetrics& surface);
    void resize_host(const SurfaceMetrics& surface);
    void set_preview_display_override(std::optional<DisplayProfile> profile);
    void shutdown();
    void request_stop();
    void set_demo_position(float normalized_x, float normalized_y);
    void reset_demo_position();
    void set_preview_running(bool running);
    void set_show_fps_counter(bool show);
    void set_fps_cap(uint32_t frames_per_second);
    bool load_preview_rml_document(const std::string& rml);
    bool execute_preview_lua_script(const std::string& source);
    bool apply_editor_preview_document(const std::string& kind, const std::string& data_json);
    AudioVoiceHandle play_audio_sfx(const std::string& path, float volume, float pitch);
    AudioTrackHandle play_audio_track(const AudioTrackId& track_id, const std::string& path,
                                      float volume, bool loop);
    void stop_audio_track(const AudioTrackId& track_id, float fade_seconds);

    assets::AssetManager m_assets;
    AssetWorldPresentationResourceResolver m_world_presentation_resources;
    WorldPresentationBackend m_world_presentation;
    WorldTransitionBackend m_world_transitions;
    AudioSystem m_audio;
    Platform m_platform;
    DisplayProfile m_display_profile{};
    std::optional<DisplayProfile> m_preview_display_override;
    PresentationMetrics m_presentation{};
    Renderer m_renderer;
    script::ScriptRuntime m_scripts;
    core::TypedMemorySaveSlotStore m_typed_saves;
    core::RuntimeClock m_runtime_clock;
    core::RuntimeClockUpdate m_frame_clock{};
    core::TypedSaveSlotStore* m_save_slots = &m_typed_saves;
    std::unique_ptr<runtime::RunningGame> m_running_game;
    std::optional<runtime::RuntimePublication> m_runtime_publication;
    core::Diagnostics m_runtime_diagnostics;
    std::vector<core::RuntimeInputMessage> m_pending_runtime_inputs;
    ShaderMaterialProject m_shader_materials;
    RuntimeUiAssetResolver m_runtime_ui_asset_resolver;
    RuntimeAudioAdapter m_runtime_audio_adapter;
    RuntimePresentationBridge m_runtime_presentation;
    RuntimeUI m_runtime_ui;
    RuntimeLayoutManager m_runtime_layouts;
    RuntimeSystemLayouts m_system_layouts;
    core::RuntimeUserSettings m_runtime_user_settings = core::RuntimeUserSettings::defaults();

    struct RealizedPresentationLayout {
        std::optional<core::MountedLayoutPresentationKey> key;
        core::MountedLayoutInstanceId instance;
        core::LayoutId layout;
        core::MountedLayoutOwner owner = core::MountedLayoutOwner::Gameplay;
        core::MountedLayoutPolicy policy;
        core::PresentationCompositionGroup composition_group =
            core::PresentationCompositionGroup::Interface;
        std::string document_id;
        core::PresentationSnapshotRevision revision =
            core::PresentationSnapshotRevision::from_number(0);
    };

    std::unordered_map<std::string, RealizedPresentationLayout> m_presentation_layout_instances;
    std::unordered_map<std::uint64_t, std::vector<RealizedPresentationLayout>>
        m_retained_presentation_layout_instances;
    std::optional<core::PresentationSnapshotRevision> m_current_presentation_revision;

    struct PendingCheckpointThumbnailCapture {
        std::uint64_t renderer_request = 0;
        core::CheckpointThumbnailCaptureRequest checkpoint;
    };

    std::optional<PendingCheckpointThumbnailCapture> m_checkpoint_thumbnail_capture;
    std::uint64_t m_next_checkpoint_thumbnail_capture = 1;
    RuntimePreviewController m_runtime_preview;
    DebugUI m_debug_ui;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    uint32_t m_fps_cap = 0;
    double m_fixed_delta_seconds = 0.0;
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
