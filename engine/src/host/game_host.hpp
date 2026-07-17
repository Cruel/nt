#pragma once

#include "host/layout_realization_contracts.hpp"
#include "host/runtime_host_contracts.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/audio/audio_system.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/core/runtime_user_settings.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"
#include "noveltea/runtime/running_game.hpp"
#include "noveltea/runtime/runtime_identity.hpp"
#include "noveltea/runtime/runtime_ports.hpp"
#include "noveltea/runtime_audio_adapter.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/runtime_presentation_bridge.hpp"
#include "noveltea/runtime_system_layouts.hpp"
#include "noveltea/ui_runtime.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <unordered_map>
#include <vector>

namespace noveltea {

class WorldTransitionBackend;

namespace host {

struct GameSessionGenerationTag;
using GameSessionGeneration = runtime::RuntimeMonotonicId<GameSessionGenerationTag>;

enum class LoadedGameLifecycleState : std::uint8_t {
    Empty,
    Loaded,
    Running,
    Stopped,
};

struct GameHostHostValues {
    core::RuntimeClockUpdate frame_clock{};
    bool host_suspended = false;
    bool runtime_input_admitted = true;
};

struct GameHostLoadRequest {
    std::string logical_path;
    std::string runtime_locale = "en";
    bool load_title_screen = true;
    bool stop_runtime_after_load = true;
};

struct GameHostLoadHooks {
    std::function<core::Result<void, core::Diagnostics>(const runtime::RunningGame&,
                                                        const runtime::RuntimePublication&)>
        prepare_candidate;
    std::function<void()> detach_current_resources;
    std::function<void(const runtime::RunningGame&, const runtime::RuntimePublication&)>
        commit_candidate_resources;
    std::function<void(const runtime::RunningGame&)> restore_previous_resources;
};

class GameHost final : public RuntimeInputSink {
public:
    struct Dependencies {
        assets::AssetManager& content_assets;
        runtime::ScriptInvocationPort& script_invocations;
        core::TypedSaveSlotStore& save_slots;
        RuntimeUI& runtime_ui;
        LayoutRealizationSink* layout_realizer = nullptr;
        AudioSystem& audio;
        RuntimePublicationSink* preview_publication_sink = nullptr;
        RuntimeObservationSink* observation_sink = nullptr;
        core::RuntimeClock& runtime_clock;
        const GameHostHostValues& host_values;
        RuntimeSystemLayoutHost& system_layout_host;
        WorldTransitionBackend* world_transitions = nullptr;
        script::ScriptRuntime& script_certifier;
        std::function<void(HostFrameStage, const core::Diagnostic&)> diagnostic_sink;
    };

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

    explicit GameHost(Dependencies dependencies) noexcept;
    ~GameHost();

    GameHost(const GameHost&) = delete;
    GameHost& operator=(const GameHost&) = delete;
    GameHost(GameHost&&) = delete;
    GameHost& operator=(GameHost&&) = delete;

    [[nodiscard]] runtime::RunningGame* running_game() noexcept { return m_running_game.get(); }
    [[nodiscard]] const runtime::RunningGame* running_game() const noexcept
    {
        return m_running_game.get();
    }
    void replace_running_game(std::unique_ptr<runtime::RunningGame> running_game) noexcept;
    void release_running_game() noexcept;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    load_compiled_project(GameHostLoadRequest request, const GameHostLoadHooks& hooks);
    [[nodiscard]] HostRuntimeDispatchResult
    submit_runtime_input(core::RuntimeInputMessage input) override;
    [[nodiscard]] bool dispatch_pending_runtime_inputs();
    [[nodiscard]] bool flush_runtime_presentation(core::Diagnostics* diagnostics = nullptr);
    void poll_runtime_presentation();
    void mark_running() noexcept;
    void mark_stopped() noexcept;

    [[nodiscard]] LoadedGameLifecycleState lifecycle_state() const noexcept
    {
        return m_lifecycle_state;
    }
    [[nodiscard]] GameSessionGeneration session_generation() const noexcept
    {
        return m_session_generation;
    }
    [[nodiscard]] bool accepts(GameSessionGeneration generation) const noexcept
    {
        return generation == m_session_generation;
    }
    void invalidate_session_generation() noexcept { advance_session_generation(); }

    [[nodiscard]] runtime::PresentationRuntimePort& presentation_port() noexcept
    {
        return m_runtime_presentation;
    }
    [[nodiscard]] const core::PresentationCheckpointStatus& checkpoint_status() const noexcept
    {
        return m_runtime_presentation.checkpoint_status();
    }

    [[nodiscard]] assets::AssetManager& content_assets() noexcept
    {
        return m_dependencies.content_assets;
    }
    [[nodiscard]] runtime::ScriptInvocationPort& script_invocations() noexcept
    {
        return m_dependencies.script_invocations;
    }
    [[nodiscard]] RuntimeUI& runtime_ui() noexcept { return m_dependencies.runtime_ui; }
    [[nodiscard]] LayoutRealizationSink* layout_realizer() const noexcept
    {
        return m_dependencies.layout_realizer;
    }
    [[nodiscard]] AudioSystem& audio() noexcept { return m_dependencies.audio; }
    [[nodiscard]] RuntimePublicationSink* preview_publication_sink() const noexcept
    {
        return m_dependencies.preview_publication_sink;
    }
    [[nodiscard]] RuntimeObservationSink* observation_sink() const noexcept
    {
        return m_dependencies.observation_sink;
    }
    [[nodiscard]] core::RuntimeClock& runtime_clock() noexcept
    {
        return m_dependencies.runtime_clock;
    }
    [[nodiscard]] const GameHostHostValues& host_values() const noexcept
    {
        return m_dependencies.host_values;
    }

    void bind_layout_realizer(LayoutRealizationSink* layout_realizer) noexcept
    {
        m_dependencies.layout_realizer = layout_realizer;
    }
    void bind_preview_publication_sink(RuntimePublicationSink* sink) noexcept
    {
        m_dependencies.preview_publication_sink = sink;
    }
    void bind_observation_sink(RuntimeObservationSink* sink) noexcept
    {
        m_dependencies.observation_sink = sink;
    }

    [[nodiscard]] core::TypedSaveSlotStore& save_slots() noexcept { return *m_save_slots; }
    [[nodiscard]] core::TypedSaveSlotStore*& save_slots_owner() noexcept { return m_save_slots; }
    void bind_save_slots(core::TypedSaveSlotStore& save_slots) noexcept
    {
        m_save_slots = &save_slots;
    }

    // Transitional accessors used by Engine::Impl until Phases 2C-2F move the workflows.
    [[nodiscard]] std::unique_ptr<runtime::RunningGame>& running_game_owner() noexcept
    {
        return m_running_game;
    }
    [[nodiscard]] std::optional<runtime::RuntimePublication>& runtime_publication() noexcept
    {
        return m_runtime_publication;
    }
    [[nodiscard]] std::vector<runtime::RuntimeEvent>& runtime_events() noexcept
    {
        return m_runtime_events;
    }
    [[nodiscard]] runtime::RuntimeObservationSnapshot& runtime_observations() noexcept
    {
        return m_runtime_observations;
    }
    [[nodiscard]] core::Diagnostics& runtime_diagnostics() noexcept
    {
        return m_runtime_diagnostics;
    }
    [[nodiscard]] const std::vector<HostRuntimeDiagnosticRecord>&
    runtime_diagnostic_records() const noexcept
    {
        return m_runtime_diagnostic_records;
    }
    [[nodiscard]] std::vector<core::RuntimeInputMessage>& pending_runtime_inputs() noexcept
    {
        return m_pending_runtime_inputs;
    }
    [[nodiscard]] RuntimeUiAssetResolver& runtime_ui_asset_resolver() noexcept
    {
        return m_runtime_ui_asset_resolver;
    }
    [[nodiscard]] RuntimeAudioAdapter& runtime_audio_adapter() noexcept
    {
        return m_runtime_audio_adapter;
    }
    [[nodiscard]] RuntimePresentationBridge& runtime_presentation() noexcept
    {
        return m_runtime_presentation;
    }
    [[nodiscard]] RuntimeLayoutManager& runtime_layouts() noexcept { return m_runtime_layouts; }
    [[nodiscard]] RuntimeSystemLayouts& system_layouts() noexcept { return m_system_layouts; }
    [[nodiscard]] core::RuntimeUserSettings& runtime_user_settings() noexcept
    {
        return m_runtime_user_settings;
    }
    [[nodiscard]] std::unordered_map<std::string, RealizedPresentationLayout>&
    presentation_layout_instances() noexcept
    {
        return m_presentation_layout_instances;
    }
    [[nodiscard]] std::unordered_map<std::uint64_t, std::vector<RealizedPresentationLayout>>&
    retained_presentation_layout_instances() noexcept
    {
        return m_retained_presentation_layout_instances;
    }
    [[nodiscard]] std::optional<core::PresentationSnapshotRevision>&
    current_presentation_revision() noexcept
    {
        return m_current_presentation_revision;
    }
    [[nodiscard]] std::string& compiled_project_path() noexcept { return m_compiled_project_path; }

private:
    class RunningGamePresentationPort;

    void advance_session_generation() noexcept;
    void detach_runtime_bindings() noexcept;
    void clear_loaded_game_state() noexcept;
    void retain_runtime_diagnostics(HostFrameStage stage, const core::Diagnostics& diagnostics);
    [[nodiscard]] bool apply_runtime_publication(const runtime::RuntimePublication& publication,
                                                 std::span<const runtime::RuntimeEvent> events,
                                                 core::Diagnostics& application_diagnostics);
    [[nodiscard]] core::Result<void, core::Diagnostics> attach_runtime_bindings(bool show_title);

    Dependencies m_dependencies;
    core::TypedSaveSlotStore* m_save_slots = nullptr;

    RuntimeUiAssetResolver m_runtime_ui_asset_resolver;
    RuntimeAudioAdapter m_runtime_audio_adapter;
    RuntimePresentationBridge m_runtime_presentation;
    RuntimeLayoutManager m_runtime_layouts;
    RuntimeSystemLayouts m_system_layouts;

    std::optional<runtime::RuntimePublication> m_runtime_publication;
    std::vector<runtime::RuntimeEvent> m_runtime_events;
    runtime::RuntimeObservationSnapshot m_runtime_observations;
    core::Diagnostics m_runtime_diagnostics;
    std::vector<HostRuntimeDiagnosticRecord> m_runtime_diagnostic_records;
    std::vector<core::RuntimeInputMessage> m_pending_runtime_inputs;
    core::RuntimeUserSettings m_runtime_user_settings = core::RuntimeUserSettings::defaults();

    std::unordered_map<std::string, RealizedPresentationLayout> m_presentation_layout_instances;
    std::unordered_map<std::uint64_t, std::vector<RealizedPresentationLayout>>
        m_retained_presentation_layout_instances;
    std::optional<core::PresentationSnapshotRevision> m_current_presentation_revision;

    std::string m_compiled_project_path;
    GameSessionGeneration m_session_generation = *GameSessionGeneration::from_number(1);
    LoadedGameLifecycleState m_lifecycle_state = LoadedGameLifecycleState::Empty;
    bool m_dispatch_active = false;
    std::unique_ptr<RunningGamePresentationPort> m_running_game_presentation_port;
    std::unique_ptr<runtime::RunningGame> m_running_game;
};

} // namespace host
} // namespace noveltea
