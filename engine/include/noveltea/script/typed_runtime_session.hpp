#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/script/runtime_script_api.hpp"

#include <memory>
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
    [[nodiscard]] const core::TypedRuntimeUIViewState& script_view() const noexcept override
    {
        return m_script_view;
    }
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
                                                   const core::AudioFlowBlockerHandle& completion,
                                                   bool cancel);
    void append_view(TypedRuntimeSessionResult& result);
    void drain_script_inputs(std::vector<core::RuntimeOutputMessage>& outputs,
                             core::Diagnostics& diagnostics);
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;

    const core::CompiledProject& m_project;
    ScriptRuntime& m_runtime;
    core::TypedSaveSlotStore& m_saves;
    std::unique_ptr<TypedExecutionKernel> m_kernel;
    RuntimeScriptApi m_script_api;
    core::TypedRuntimeUIViewState m_script_view;
    std::vector<core::RuntimeInputMessage> m_script_inputs;
    bool m_draining_script_inputs = false;
    std::string m_runtime_locale;
    bool m_running = false;
    bool m_playback = false;
    std::size_t m_playback_step = 0;
    std::vector<core::InteractableId> m_selection;
    std::vector<PendingHostRequest> m_pending_host_requests;
    std::optional<core::TransitionPresentationOperation> m_pending_presentation;
    std::optional<core::AudioOperation> m_pending_audio;
    std::uint64_t m_next_host_request_id = 1;
    std::uint64_t m_next_presentation_id = 1;
    std::uint64_t m_next_audio_id = 1;
};

} // namespace noveltea::script
