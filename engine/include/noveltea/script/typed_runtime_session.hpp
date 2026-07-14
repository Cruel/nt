#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/script/typed_execution_kernel.hpp"

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::script {

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

class TypedRuntimeSession {
public:
    [[nodiscard]] static core::Result<std::unique_ptr<TypedRuntimeSession>, core::Diagnostics>
    create(const core::CompiledProject& project, ScriptRuntime& runtime,
           core::TypedSaveSlotStore& saves, std::string runtime_locale = {});

    [[nodiscard]] TypedRuntimeSessionResult apply(const core::RuntimeInputMessage& input);
    [[nodiscard]] const TypedExecutionKernel& kernel() const noexcept { return *m_kernel; }
    [[nodiscard]] std::size_t pending_host_request_count() const noexcept
    {
        return m_pending_host_requests.size();
    }

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
    [[nodiscard]] core::Diagnostic diagnostic(std::string code, std::string message) const;

    const core::CompiledProject& m_project;
    ScriptRuntime& m_runtime;
    core::TypedSaveSlotStore& m_saves;
    std::unique_ptr<TypedExecutionKernel> m_kernel;
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
