#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/runtime/runtime_ports.hpp"
#include "noveltea/script/runtime_checkpoint_service.hpp"

#include <cstddef>
#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::script {

class TypedExecutionKernel;

class TypedRuntimeSession final : private runtime::RuntimeCommandGatewayServices {
public:
    [[nodiscard]] static core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>
    create(const core::CompiledProject& project, runtime::ScriptInvocationPort& scripts,
           runtime::PresentationRuntimePort& presentation, core::TypedSaveSlotStore& saves,
           std::string runtime_locale = {},
           runtime::RuntimeBudgetConfiguration runtime_budget = {});
    ~TypedRuntimeSession() override;

    [[nodiscard]] runtime::RuntimeDispatchResult dispatch(const core::RuntimeInputMessage& input);
    [[nodiscard]] core::PresentationOperationId allocate_presentation_operation_id() noexcept
    {
        return core::PresentationOperationId::from_number(m_next_presentation_id++);
    }
    [[nodiscard]] const core::SessionState& presentation_state() const noexcept;
    [[nodiscard]] const RuntimeCheckpointService& checkpoint_service() const noexcept
    {
        return m_checkpoint_service;
    }
    [[nodiscard]] std::vector<core::CheckpointSaveOutcome> take_checkpoint_save_outcomes()
    {
        return m_checkpoint_service.take_completed_save_outcomes();
    }
    [[nodiscard]] std::size_t pending_command_count() const noexcept;
    [[nodiscard]] runtime::RuntimeCommandGateway& gateway() noexcept;
    [[nodiscard]] const runtime::RuntimeCommandGateway& gateway() const noexcept;

    [[nodiscard]] bool explicit_gameplay_paused() const noexcept;
    void set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept;

private:
    struct WorkResult {
        runtime::RuntimeInputDisposition disposition = runtime::RuntimeInputDisposition::Handled;
        std::vector<core::RuntimeOutputMessage> outputs;
        std::vector<runtime::RuntimeEvent> events;
        std::vector<std::size_t> event_output_offsets;
        core::Diagnostics diagnostics;
    };

    using PendingRuntimeEmission = std::variant<core::RuntimeOutputMessage, runtime::RuntimeEvent>;

    TypedRuntimeSession(const core::CompiledProject& project,
                        runtime::ScriptInvocationPort& scripts,
                        runtime::PresentationRuntimePort& presentation,
                        core::TypedSaveSlotStore& saves,
                        std::unique_ptr<TypedExecutionKernel> kernel, std::string runtime_locale,
                        runtime::RuntimeBudgetConfiguration runtime_budget) noexcept;

    [[nodiscard]] WorkResult apply_input(const core::RuntimeInputMessage& input);
    [[nodiscard]] core::Diagnostics settle_transaction();
    void commit_work_events(WorkResult& work, runtime::RuntimeDispatchResult& result);
    void project_publication(WorkResult& work, runtime::RuntimeDispatchResult& result);
    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept_presentation(const core::PresentationOperation& operation);
    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept_audio(const core::AudioOperation& operation);

    [[nodiscard]] core::Diagnostics run_kernel(std::vector<core::RuntimeOutputMessage>& outputs,
                                               std::vector<runtime::RuntimeEvent>& events,
                                               std::vector<std::size_t>& event_output_offsets);
    [[nodiscard]] core::Diagnostics
    run_kernel_once(std::vector<core::RuntimeOutputMessage>& outputs,
                    std::vector<runtime::RuntimeEvent>& events,
                    std::vector<std::size_t>& event_output_offsets);
    void collect_runtime_actions(core::Diagnostics& diagnostics);
    void stage_gateway_events();
    void drain_pending_emissions(std::vector<core::RuntimeOutputMessage>& outputs,
                                 std::vector<runtime::RuntimeEvent>& events,
                                 std::vector<std::size_t>& event_output_offsets);
    void drain_deferred_commands(std::vector<core::RuntimeOutputMessage>& outputs,
                                 std::vector<runtime::RuntimeEvent>& events,
                                 std::vector<std::size_t>& event_output_offsets,
                                 core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostics
    execute_deferred_command(const runtime::DeferredRuntimeCommand& command);
    [[nodiscard]] bool
    source_owner_is_current(const runtime::DeferredRuntimeCommand& command) const noexcept;
    void attach_command_context(core::Diagnostics& diagnostics,
                                const runtime::DeferredRuntimeCommand& command) const;
    [[nodiscard]] core::Diagnostics
    complete_presentation(core::PresentationOperationId operation, const core::FlowFrameId& owner,
                          const core::PresentationFlowBlockerHandle& completion, bool cancel);
    [[nodiscard]] core::Diagnostics complete_audio(core::AudioOperationId operation,
                                                   const core::FlowFrameId& owner,
                                                   const core::AudioCompletionHandle& completion,
                                                   bool cancel);
    void drain_script_inputs(std::vector<core::RuntimeOutputMessage>& outputs,
                             std::vector<runtime::RuntimeEvent>& events,
                             std::vector<std::size_t>& event_output_offsets,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;
    void record_structural_mutation() noexcept;
    void record_time_mutation(std::chrono::milliseconds elapsed) noexcept;
    void invalidate_kernel(runtime::ScriptCancellationReason reason) noexcept;

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
                  double volume, bool await_completion) override;
    [[nodiscard]] const core::TypedRuntimeUIViewState& current_view() const noexcept override
    {
        return m_script_view;
    }
    void queue_input(core::RuntimeInputMessage input) override;

    const core::CompiledProject& m_project;
    runtime::ScriptInvocationPort& m_scripts;
    runtime::PresentationRuntimePort& m_presentation;
    core::TypedSaveSlotStore& m_saves;
    RuntimeCheckpointService m_checkpoint_service;
    runtime::MutationImpactJournal m_transaction_impacts;
    std::chrono::milliseconds m_transaction_elapsed{0};
    runtime::RuntimeBudgetOutcome m_transaction_budget_outcome;
    bool m_dispatch_active = false;
    bool m_force_publication = false;
    std::optional<runtime::RuntimePublication> m_current_publication;
    runtime::RuntimePublicationRevision m_next_publication_revision =
        *runtime::RuntimePublicationRevision::from_number(1);
    std::unique_ptr<TypedExecutionKernel> m_kernel;
    runtime::CapabilityGeneration m_next_capability_generation =
        *runtime::CapabilityGeneration::from_number(2);
    core::TypedRuntimeUIViewState m_script_view;
    std::vector<core::RuntimeInputMessage> m_script_inputs;
    bool m_draining_script_inputs = false;
    runtime::RuntimeBudgetConfiguration m_runtime_budget;
    bool m_draining_deferred_commands = false;
    bool m_skip_next_checkpoint_settlement = false;
    std::string m_runtime_locale;
    bool m_running = false;
    bool m_playback = false;
    core::EffectiveGameplayPause m_effective_gameplay_pause;
    std::size_t m_playback_step = 0;
    std::vector<core::InteractableId> m_selection;
    std::optional<core::TransitionPresentationOperation> m_pending_presentation;
    std::optional<core::AudioOperation> m_pending_audio;
    std::vector<PendingRuntimeEmission> m_pending_emissions;
    std::uint64_t m_next_presentation_id = 1;
    std::uint64_t m_next_audio_id = 1;
};

} // namespace noveltea::script
