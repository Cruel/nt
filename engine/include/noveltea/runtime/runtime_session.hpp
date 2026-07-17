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
           PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
           std::string runtime_locale = {}, RuntimeBudgetConfiguration runtime_budget = {});
    ~RuntimeSession() override;

    [[nodiscard]] RuntimeDispatchResult dispatch(const core::RuntimeInputMessage& input);
    [[nodiscard]] core::PresentationOperationId allocate_presentation_operation_id() noexcept
    {
        assert_owner_thread();
        return core::PresentationOperationId::from_number(m_next_presentation_id++);
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

    RuntimeSession(const core::CompiledProject& project, ScriptInvocationPort& scripts,
                   PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
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
                                               std::vector<core::RuntimeObservation>& observations);
    [[nodiscard]] core::Diagnostics
    run_kernel_once(std::vector<RuntimeEvent>& events,
                    std::vector<core::RuntimeObservation>& observations);
    void collect_runtime_actions(core::Diagnostics& diagnostics);
    void stage_gateway_events();
    void drain_pending_events(std::vector<RuntimeEvent>& events);
    void drain_deferred_commands(std::vector<RuntimeEvent>& events,
                                 std::vector<core::RuntimeObservation>& observations,
                                 core::Diagnostics& diagnostics);
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
    void drain_script_inputs(std::vector<RuntimeEvent>& events,
                             std::vector<core::RuntimeObservation>& observations,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;
    void record_structural_mutation() noexcept;
    void record_time_mutation(std::chrono::milliseconds elapsed) noexcept;
    void invalidate_kernel(ScriptCancellationReason reason) noexcept;
    void assert_owner_thread() const noexcept;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode, bool visible,
                std::optional<core::MapLocationId> focused_location) override;
    [[nodiscard]] core::Result<void, core::Diagnostics> hide_map() override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_map_location(core::MapLocationId location) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    activate_map_connection(core::MapConnectionId connection) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop,
                  double volume, bool await_completion,
                  core::AudioOperationPurpose purpose) override;
    [[nodiscard]] const core::TypedRuntimeUIViewState& current_view() const noexcept override
    {
        return m_script_view;
    }
    void queue_input(core::RuntimeInputMessage input) override;

    const core::CompiledProject& m_project;
    ScriptInvocationPort& m_scripts;
    PresentationRuntimePort& m_presentation;
    core::TypedSaveSlotStore& m_saves;
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
    CapabilityGeneration m_next_capability_generation = *CapabilityGeneration::from_number(2);
    core::TypedRuntimeUIViewState m_script_view;
    std::vector<core::RuntimeInputMessage> m_script_inputs;
    bool m_draining_script_inputs = false;
    RuntimeBudgetConfiguration m_runtime_budget;
    bool m_draining_deferred_commands = false;
    bool m_skip_next_checkpoint_settlement = false;
    std::string m_runtime_locale;
    bool m_running = false;
    bool m_playback = false;
    core::EffectiveGameplayPause m_effective_gameplay_pause;
    std::size_t m_playback_step = 0;
    std::vector<core::compiled::InteractionSubject> m_selection;
    std::optional<PendingPresentationCompletion> m_pending_presentation;
    std::optional<core::AudioOperation> m_pending_audio;
    std::vector<RuntimeEvent> m_pending_events;
    std::uint64_t m_next_presentation_id = 1;
    std::uint64_t m_next_audio_id = 1;
    std::thread::id m_owner_thread;
};

} // namespace noveltea::runtime
