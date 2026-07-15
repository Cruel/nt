#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/script/runtime_checkpoint_service.hpp"
#include "noveltea/script/runtime_script_api.hpp"

#include <memory>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::script {

class ScriptRuntime;
class TypedExecutionKernel;

enum class RuntimeInputDisposition : std::uint8_t {
    Handled,
    Unhandled,
    Failed
};

struct TypedRuntimeSessionResult {
    RuntimeInputDisposition disposition = RuntimeInputDisposition::Handled;
    core::TypedRuntimeUIViewState view;
    std::vector<core::RuntimeOutputMessage> outputs;
    core::Diagnostics diagnostics;
};

class TypedRuntimeSession final : public RuntimeScriptApiTarget {
public:
    [[nodiscard]] static core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>
    create(const core::CompiledProject& project, ScriptRuntime& runtime,
           core::TypedSaveSlotStore& saves, std::string runtime_locale = {});
    ~TypedRuntimeSession() override;

    [[nodiscard]] TypedRuntimeSessionResult apply(const core::RuntimeInputMessage& input);
    void begin_dispatch_transaction() noexcept;
    void bind_transient_reset_handler(
        std::function<void(core::PresentationCancellationReason)> handler) noexcept
    {
        m_transient_reset_handler = std::move(handler);
    }
    [[nodiscard]] core::Diagnostics settle_dispatch_transaction();
    [[nodiscard]] core::Diagnostics accept_runtime_output(const core::RuntimeOutputMessage& output);
    [[nodiscard]] core::Diagnostics
    commit_transient_operation(const core::PresentationOperationRef& operation);
    [[nodiscard]] core::Diagnostics update_active_text_checkpoint_status(bool active);
    [[nodiscard]] const RuntimeCheckpointService& checkpoint_service() const noexcept
    {
        return m_checkpoint_service;
    }
    [[nodiscard]] std::vector<core::CheckpointSaveOutcome> take_checkpoint_save_outcomes()
    {
        return m_checkpoint_service.take_completed_save_outcomes();
    }
    [[nodiscard]] const core::PresentationCheckpointStatus&
    presentation_checkpoint_status() const noexcept
    {
        return m_presentation_checkpoint_status;
    }
    [[nodiscard]] std::size_t pending_host_request_count() const noexcept
    {
        return m_pending_host_requests.size();
    }

    [[nodiscard]] core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    script_definition(core::ProjectDefinitionKind kind, std::string id) const override;
    [[nodiscard]] core::Result<core::RuntimeValue, core::Diagnostics>
    script_variable(const core::VariableId& id) const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_set_variable(const core::VariableId& id, core::RuntimeValue value) override;
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    script_property(const core::PropertyOwnerRef& owner,
                    const core::PropertyId& property) const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_set_property(core::PropertyOwnerRef owner, core::PropertyId property,
                        core::RuntimeValue value) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_unset_property(const core::PropertyOwnerRef& owner,
                          const core::PropertyId& property) override;
    [[nodiscard]] core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    script_interactable_location(const core::InteractableId& interactable) const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_interactable_location(core::InteractableId interactable,
                                         core::compiled::InteractableLocation target) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_navigation(core::compiled::RoomExitRef exit) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_transient(core::SceneId scene) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_transient(core::DialogueId dialogue) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_child(core::SceneId scene) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_child(core::DialogueId dialogue) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_tail_replacement(core::FlowTarget target) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_notification(std::string message) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_seed_random(std::uint64_t seed) override;
    [[nodiscard]] core::Result<std::int64_t, core::Diagnostics>
    script_random_integer(std::int64_t minimum, std::int64_t maximum) override;
    [[nodiscard]] core::Result<double, core::Diagnostics> script_random_unit() override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode,
                       bool visible, std::optional<core::MapLocationId> focused_location) override;
    [[nodiscard]] core::Result<void, core::Diagnostics> script_hide_map() override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_select_map_location(core::MapLocationId location) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_activate_map_connection(core::MapConnectionId connection) override;
    [[nodiscard]] core::Result<core::MapPresentationState, core::Diagnostics>
    script_map_state() const override;
    [[nodiscard]] core::Result<std::optional<core::LayoutId>, core::Diagnostics>
    script_layout(core::compiled::LayoutSlot slot) const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_set_layout(core::compiled::LayoutSlot slot, core::LayoutId layout) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_clear_layout(core::compiled::LayoutSlot slot) override;
    [[nodiscard]] core::Result<bool, core::Diagnostics> script_gameplay_paused() const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_set_gameplay_paused(bool paused) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                         std::optional<core::AssetId> asset, std::chrono::milliseconds fade,
                         bool loop, double volume, bool await_completion) override;
    [[nodiscard]] core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
    script_audio_channel(core::compiled::AudioChannel channel) const override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    script_append_text_log(core::TextLogEntry entry) override;
    [[nodiscard]] core::Result<void, core::Diagnostics> script_clear_text_log() override;
    [[nodiscard]] const core::TypedRuntimeUIViewState& script_view() const noexcept override
    {
        return m_script_view;
    }
    [[nodiscard]] bool explicit_gameplay_paused() const noexcept;
    void set_effective_gameplay_pause(core::EffectiveGameplayPause pause) noexcept;
    void queue_script_input(core::RuntimeInputMessage input) override;

private:
    struct PendingHostRequest {
        core::TypedHostRequest output;
        core::ScriptHostRequest source;
    };

    TypedRuntimeSession(const core::CompiledProject& project, ScriptRuntime& runtime,
                        core::TypedSaveSlotStore& saves,
                        std::unique_ptr<TypedExecutionKernel> kernel,
                        std::string runtime_locale) noexcept;

    [[nodiscard]] core::Diagnostics run_kernel(std::vector<core::RuntimeOutputMessage>& outputs);
    void drain_host_requests(std::vector<core::RuntimeOutputMessage>& outputs,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostics acknowledge(core::HostRequestId id);
    [[nodiscard]] core::Diagnostics
    complete_presentation(core::PresentationOperationId operation, const core::FlowFrameId& owner,
                          const core::PresentationFlowBlockerHandle& completion, bool cancel);
    [[nodiscard]] core::Diagnostics complete_audio(core::AudioOperationId operation,
                                                   const core::FlowFrameId& owner,
                                                   const core::AudioCompletionHandle& completion,
                                                   bool cancel);
    void drain_script_audio(std::vector<core::RuntimeOutputMessage>& outputs);
    void append_view(TypedRuntimeSessionResult& result);
    void drain_script_inputs(std::vector<core::RuntimeOutputMessage>& outputs,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;
    void record_structural_mutation() noexcept;
    void record_time_mutation(std::chrono::milliseconds elapsed) noexcept;
    [[nodiscard]] core::Diagnostics register_causal_operation(core::PresentationOperationRef op);
    [[nodiscard]] core::Diagnostics remove_causal_operation(core::PresentationOperationRef op);

    const core::CompiledProject& m_project;
    ScriptRuntime& m_runtime;
    core::TypedSaveSlotStore& m_saves;
    RuntimeCheckpointService m_checkpoint_service;
    core::PresentationCheckpointStatus m_presentation_checkpoint_status{
        core::CheckpointStatusRevision::from_number(1), {}};
    RuntimeTransactionMutations m_transaction_mutations;
    std::uint64_t m_next_checkpoint_barrier_id = 1;
    std::uint64_t m_next_checkpoint_status_revision = 2;
    std::size_t m_dispatch_transaction_depth = 0;
    std::unique_ptr<TypedExecutionKernel> m_kernel;
    RuntimeScriptApi m_script_api;
    core::TypedRuntimeUIViewState m_script_view;
    std::vector<core::RuntimeInputMessage> m_script_inputs;
    bool m_draining_script_inputs = false;
    bool m_skip_next_checkpoint_settlement = false;
    std::string m_runtime_locale;
    bool m_running = false;
    bool m_playback = false;
    core::EffectiveGameplayPause m_effective_gameplay_pause;
    std::size_t m_playback_step = 0;
    std::vector<core::InteractableId> m_selection;
    std::vector<PendingHostRequest> m_pending_host_requests;
    std::optional<core::TransitionPresentationOperation> m_pending_presentation;
    std::optional<core::AudioOperation> m_pending_audio;
    std::optional<core::PresentationOperationId> m_active_text_checkpoint_operation;
    std::vector<core::AudioOperation> m_script_audio;
    std::uint64_t m_next_host_request_id = 1;
    std::uint64_t m_next_presentation_id = 1;
    std::uint64_t m_next_audio_id = 1;
    std::function<void(core::PresentationCancellationReason)> m_transient_reset_handler;
};

} // namespace noveltea::script
