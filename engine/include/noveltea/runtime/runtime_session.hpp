#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/runtime/runtime_ports.hpp"
#include "noveltea/runtime/runtime_checkpoint_service.hpp"

#include <cstddef>
#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace noveltea::runtime {

class RuntimeExecutor;

class RuntimeSession final : private RuntimeCommandGatewayServices {
public:
    // RuntimeSession is confined to the thread that constructs it. Platform/backend work returns
    // through later typed inputs; callbacks must never mutate the session directly.
    [[nodiscard]] static core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>
    create(const core::CompiledProject& project, ScriptInvocationPort& scripts,
           PresentationModelPort& presentation_model, PresentationRuntimePort& presentation,
           core::TypedSaveSlotStore& saves, const core::SaveStateCodecPort& save_codec,
           std::string runtime_locale = {}, RuntimeBudgetConfiguration runtime_budget = {});
    [[nodiscard]] static core::Result<std::unique_ptr<RuntimeSession>, core::Diagnostics>
    restore(const core::CompiledProject& project, ScriptInvocationPort& scripts,
            PresentationModelPort& presentation_model, PresentationRuntimePort& presentation,
            core::TypedSaveSlotStore& saves, const core::SaveStateCodecPort& save_codec,
            core::TypedSaveSlotId slot, std::string runtime_locale = {},
            RuntimeBudgetConfiguration runtime_budget = {});
    ~RuntimeSession() override;

    [[nodiscard]] RuntimeDispatchResult dispatch(const core::RuntimeInputMessage& input);
    [[nodiscard]] RuntimeDispatchResult publish_initial_state();
    [[nodiscard]] core::PresentationOperationId allocate_presentation_operation_id() noexcept
    {
        assert_owner_thread();
        return core::PresentationOperationId::from_number(m_next_presentation_id++);
    }
    [[nodiscard]] core::AudioOperationId allocate_audio_operation_id() noexcept
    {
        assert_owner_thread();
        return core::AudioOperationId::from_number(m_next_audio_id++);
    }
    [[nodiscard]] const core::SessionState& presentation_state() const noexcept;
    [[nodiscard]] const RuntimeCheckpointService& checkpoint_service() const noexcept
    {
        assert_owner_thread();
        return m_checkpoint_service;
    }
    [[nodiscard]] std::vector<core::CheckpointSaveOutcome> take_checkpoint_save_outcomes()
    {
        assert_owner_thread();
        return m_checkpoint_service.take_completed_save_outcomes();
    }
    [[nodiscard]] std::optional<core::CheckpointThumbnailCaptureRequest>
    pending_checkpoint_thumbnail_capture() const noexcept
    {
        assert_owner_thread();
        return m_checkpoint_service.pending_thumbnail_capture();
    }
    [[nodiscard]] core::Result<void, core::Diagnostics>
    attach_checkpoint_thumbnail(const core::CheckpointThumbnailCaptureRequest& request,
                                core::SaveCheckpointThumbnail thumbnail)
    {
        assert_owner_thread();
        return m_checkpoint_service.attach_thumbnail(request, std::move(thumbnail));
    }
    [[nodiscard]] bool discard_checkpoint_thumbnail_capture(
        const core::CheckpointThumbnailCaptureRequest& request) noexcept
    {
        assert_owner_thread();
        return m_checkpoint_service.discard_thumbnail_capture(request);
    }
    [[nodiscard]] std::size_t pending_command_count() const noexcept;
    [[nodiscard]] RuntimeCommandGateway& gateway() noexcept;
    [[nodiscard]] const RuntimeCommandGateway& gateway() const noexcept;

    [[nodiscard]] bool explicit_gameplay_paused() const noexcept;
    void set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept;

private:
    struct WorkResult {
        RuntimeInputDisposition disposition = RuntimeInputDisposition::Handled;
        std::vector<RuntimeEvent> events;
        std::vector<core::RuntimeObservation> observations;
        core::Diagnostics diagnostics;
    };

    struct PendingPresentationCompletion {
        core::PresentationOperationId operation;
        core::FlowFrameId owner;
        core::PresentationFlowBlockerHandle completion;
        bool room_navigation = false;
    };

    struct SceneEventPresentationOperation {
        core::FlowFrameId owner;
        core::SceneId scene;
        core::SceneStepId event;
        core::PresentationOperationId operation;
    };
    struct SceneEventAudioOperation {
        core::FlowFrameId owner;
        core::SceneId scene;
        core::SceneStepId event;
        core::AudioOperationId operation;
    };

    struct DialogueCueWait {
        core::FlowFrameId frame;
        core::DialogueId dialogue;
        core::DialogueSegmentId segment;
        std::uint64_t target_offset = 0;
        bool skipping = false;
    };
    struct DialogueAudioWait : DialogueCueWait {
        core::AudioFlowBlockerHandle completion;
    };
    struct DialoguePresentationWait : DialogueCueWait {
        core::PresentationFlowBlockerHandle completion;
    };

    struct RoomDescriptionVisit {
        core::RoomId room;
        std::uint64_t visits = 0;

        auto operator<=>(const RoomDescriptionVisit&) const = default;
    };

    RuntimeSession(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                   PresentationModelPort& presentation_model, PresentationRuntimePort& presentation,
                   core::TypedSaveSlotStore& saves, const core::SaveStateCodecPort& save_codec,
                   std::unique_ptr<RuntimeExecutor> executor, std::string runtime_locale,
                   RuntimeBudgetConfiguration runtime_budget) noexcept;

    [[nodiscard]] WorkResult apply_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] core::Diagnostics settle_transaction();
    void project_publication(WorkResult& work, RuntimeDispatchResult& result);
    [[nodiscard]] core::Result<PresentationAcceptance, core::Diagnostics>
    accept_presentation(const core::PresentationOperation& operation);
    [[nodiscard]] core::Result<PresentationAcceptance, core::Diagnostics>
    accept_audio(const core::AudioOperation& operation);

    [[nodiscard]] core::Diagnostics run_kernel(std::vector<RuntimeEvent>& events,
                                               std::vector<core::RuntimeObservation>& observations,
                                               bool fast_forward = false);
    [[nodiscard]] core::Diagnostics
    run_kernel_once(std::vector<RuntimeEvent>& events,
                    std::vector<core::RuntimeObservation>& observations, bool fast_forward = false);
    void collect_runtime_actions(core::Diagnostics& diagnostics);
    void stage_gateway_events();
    void drain_pending_events(std::vector<RuntimeEvent>& events);
    void drain_deferred_commands(std::vector<RuntimeEvent>& events,
                                 std::vector<core::RuntimeObservation>& observations,
                                 core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostics start_detached_scene(const StartDetachedSceneCommand& command,
                                                         const RuntimeSourceContext& source);
    void run_detached_flows(std::vector<RuntimeEvent>& events,
                            std::vector<core::RuntimeObservation>& observations,
                            core::Diagnostics& diagnostics,
                            std::chrono::milliseconds elapsed = std::chrono::milliseconds{0});
    [[nodiscard]] bool
    detached_owner_alive(const core::DetachedFlowExecution& execution) const noexcept;
    [[nodiscard]] bool flow_frame_alive(const core::FlowFrameId& frame) const noexcept;
    [[nodiscard]] core::Diagnostics execute_deferred_command(const DeferredRuntimeCommand& command);
    [[nodiscard]] bool
    source_owner_is_current(const DeferredRuntimeCommand& command) const noexcept;
    void attach_command_context(core::Diagnostics& diagnostics,
                                const DeferredRuntimeCommand& command) const;
    [[nodiscard]] core::Diagnostics
    complete_presentation(core::PresentationOperationId operation, const core::FlowFrameId& owner,
                          const core::PresentationFlowBlockerHandle& completion, bool cancel);
    [[nodiscard]] core::Diagnostics complete_audio(core::AudioOperationId operation,
                                                   const core::FlowFrameId& owner,
                                                   const core::AudioCompletionHandle& completion,
                                                   bool cancel);
    [[nodiscard]] core::Diagnostics
    advance_dialogue_reveal(const core::AdvanceDialogueRevealInput& input);
    void drain_script_inputs(std::vector<RuntimeEvent>& events,
                             std::vector<core::RuntimeObservation>& observations,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;
    [[nodiscard]] core::Diagnostics
    capture_command_builder_subject(const core::compiled::InteractionSubject& subject);
    void record_structural_mutation() noexcept;
    void record_time_mutation(std::chrono::milliseconds elapsed) noexcept;
    void invalidate_kernel(ScriptCancellationReason reason) noexcept;
    [[nodiscard]] bool
    scene_event_dependency_pending(const core::FlowFrameId& owner, const core::SceneId& scene,
                                   const core::SceneStepId& event) const noexcept;
    [[nodiscard]] bool
    scene_event_presentation_operation_active(const core::FlowFrameId& owner,
                                              const core::SceneId& scene,
                                              const core::SceneStepId& event) const noexcept;
    [[nodiscard]] bool
    scene_event_audio_operation_active(const core::FlowFrameId& owner, const core::SceneId& scene,
                                       const core::SceneStepId& event) const noexcept;
    void record_scene_event_presentation_operation(core::PresentationOperationId operation);
    void prune_scene_event_presentation_operations();
    void assert_owner_thread() const noexcept;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_audio(core::compiled::AudioAction action, core::compiled::AudioPurpose purpose,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, double gain,
                  double pan, bool await_completion, core::compiled::AudioCausality causality,
                  core::compiled::AudioPausePolicy pause_policy,
                  core::compiled::AudioSkipBehavior skip_behavior) override;
    [[nodiscard]] const core::TypedRuntimeUIViewState& current_view() const noexcept override
    {
        return m_script_view;
    }
    void queue_input(core::RuntimeInputMessage input) override;

    const core::CompiledProject& m_project;
    ScriptInvocationPort& m_scripts;
    PresentationModelPort& m_presentation_model;
    PresentationRuntimePort& m_presentation;
    RuntimeCheckpointService m_checkpoint_service;
    MutationImpactJournal m_transaction_impacts;
    std::chrono::milliseconds m_transaction_elapsed{0};
    RuntimeBudgetOutcome m_transaction_budget_outcome;
    bool m_dispatch_active = false;
    bool m_force_publication = false;
    std::optional<RuntimePublication> m_current_publication;
    RuntimePublicationRevision m_next_publication_revision =
        *RuntimePublicationRevision::from_number(1);
    std::unique_ptr<RuntimeExecutor> m_kernel;
    core::TypedRuntimeUIViewState m_script_view;
    std::vector<core::RuntimeInputMessage> m_script_inputs;
    std::optional<core::RuntimeInputMessage> m_session_replacement_request;
    bool m_draining_script_inputs = false;
    RuntimeBudgetConfiguration m_runtime_budget;
    bool m_draining_deferred_commands = false;
    bool m_running_detached_flows = false;
    std::string m_runtime_locale;
    bool m_running = false;
    bool m_playback = false;
    core::EffectiveGameplayPause m_effective_gameplay_pause;
    std::size_t m_playback_step = 0;
    struct CommandBuilderState {
        core::CommandBuilderOccurrenceId occurrence;
        std::uint64_t capture_revision = 0;
        std::optional<core::compiled::InteractionSubject> captured_subject;
        std::vector<core::compiled::InteractionSubject> captured_subjects;
        std::vector<core::compiled::InteractionSubject> watched_subjects;
        std::optional<core::RoomId> room;
    };

    std::vector<core::compiled::InteractionSubject> m_selection;
    bool m_verb_menu_open = false;
    std::optional<core::TriggerContext> m_interaction_trigger_context;
    std::optional<CommandBuilderState> m_command_builder;
    std::uint64_t m_next_command_builder_occurrence = 1;
    std::optional<RoomDescriptionVisit> m_room_description_visit;
    bool m_room_description_visible = false;
    std::optional<PendingPresentationCompletion> m_pending_presentation;
    std::vector<SceneEventPresentationOperation> m_scene_event_presentation_operations;
    std::vector<SceneEventAudioOperation> m_scene_event_audio_operations;
    std::optional<core::AudioOperation> m_pending_audio;
    std::optional<DialogueAudioWait> m_dialogue_audio_wait;
    std::optional<DialoguePresentationWait> m_dialogue_presentation_wait;
    std::vector<RuntimeEvent> m_pending_events;
    std::uint64_t m_next_presentation_id = 1;
    std::uint64_t m_next_audio_id = 1;
    std::optional<core::CheckpointRuntimeObservation> m_last_checkpoint_observation;
    std::thread::id m_owner_thread;
};

} // namespace noveltea::runtime
