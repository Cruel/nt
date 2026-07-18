#pragma once

#include "noveltea/engine.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "devtools/debug_ui.hpp"
#include "host/debug_ui_command_executor.hpp"
#include "host/game_host.hpp"
#include "host/host_input_router.hpp"
#include "host/layout_realizer.hpp"
#include "host/preview_host.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/renderer.hpp"
#include "noveltea/runtime_preview_controller.hpp"
#include "noveltea/runtime_system_layouts.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"
#include "noveltea/world_presentation.hpp"
#include "noveltea/world_transition.hpp"
#include "noveltea/platform.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea {

struct Engine::Impl final : private RuntimeSystemLayoutHost {
    using RealizedPresentationLayout = host::GameHost::RealizedPresentationLayout;

    Impl();

    void handle_events();
    bool throttle_frame_start();
    void finish_frame_timing_sample();
    uint32_t effective_frame_pace_cap() const;
    [[nodiscard]] core::EffectiveGameplayPause current_effective_gameplay_pause() const;
    [[nodiscard]] std::optional<core::EffectiveGameplayPause>
    update_host_clocks(double host_delta_seconds);
    void update_presentation_audio_backends(bool runtime_input_admitted);
    void realize_layouts_and_bind_ui();
    void apply_pending_debug_ui_commands();
    [[nodiscard]] host::DebugUiObservationSnapshot debug_ui_observations() const;
    void render();
    [[nodiscard]] bool dispatch_runtime_input(const core::RuntimeInputMessage& input);
    void append_runtime_diagnostics(core::Diagnostics diagnostics);
    void configure_assets(const EngineRunConfig& run_config);
    bool load_project_shader_materials();
    bool load_compiled_project(const std::string& logical_path, bool load_title_screen = true,
                               bool stop_runtime_after_load = true);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_presentation_snapshot(const core::RuntimePresentationSnapshot& snapshot);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_presentation_layouts(const core::RuntimePresentationSnapshot& snapshot);
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
    void apply_preview_display_override(std::optional<DisplayProfile> profile);
    void shutdown();
    void request_stop();
    void set_preview_running(bool running);
    void set_show_fps_counter(bool show);
    void set_fps_cap(uint32_t frames_per_second);

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
    ShaderMaterialProject m_shader_materials;
    RuntimeUI m_runtime_ui;
    host::LayoutRealizer m_layout_realizer;
    host::HostInputRouter m_input_router;
    host::GameHostHostValues m_game_host_values;
    host::GameHost m_game_host;

    struct PendingCheckpointThumbnailCapture {
        std::uint64_t renderer_request = 0;
        core::CheckpointThumbnailCaptureRequest checkpoint;
    };

    std::optional<PendingCheckpointThumbnailCapture> m_checkpoint_thumbnail_capture;
    std::uint64_t m_next_checkpoint_thumbnail_capture = 1;
    bool m_preview_running = true;
    host::PreviewHost m_preview_host;
    RuntimePreviewController m_runtime_preview;
    DebugUI m_debug_ui;
    host::DebugUiCommandExecutor m_debug_ui_command_executor;
    std::vector<host::DebugUiCommand> m_pending_debug_ui_commands;
    bool m_initialized = false;
    bool m_running = false;
    uint32_t m_frame_count = 0;
    uint32_t m_frame_limit = 0;
    uint32_t m_fps_cap = 0;
    double m_fixed_delta_seconds = 0.0;
    uint64_t m_next_frame_counter = 0;
    std::string m_screenshot_path;
    Vec2 m_pointer_position{};
    bool m_pointer_valid = false;
    bool m_debug_ui_enabled = true;
    bool m_render_perf_logging = false;
    bool m_audio_enabled = true;
    bool m_preview_widget = false;
    bool m_show_fps_counter = false;
    uint32_t m_fps_sample_frames = 0;
    uint64_t m_fps_sample_start_counter = 0;
};

} // namespace noveltea
