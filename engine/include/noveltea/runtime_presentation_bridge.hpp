#pragma once

#include "noveltea/core/presentation_coordinator.hpp"
#include "noveltea/runtime_audio_adapter.hpp"

#include <functional>
#include <optional>

namespace noveltea {

struct RuntimePresentationDispatchResult {
    std::vector<core::RuntimeInputMessage> inputs;
    core::Diagnostics diagnostics;
};

class RuntimePresentationOperationHandler {
public:
    virtual ~RuntimePresentationOperationHandler() = default;
    [[nodiscard]] virtual RuntimePresentationDispatchResult
    accept(const core::PresentationOperation& operation) = 0;
    [[nodiscard]] virtual RuntimePresentationDispatchResult
    accept(const core::AudioOperation& operation) = 0;
    [[nodiscard]] virtual RuntimePresentationDispatchResult flush() = 0;
    [[nodiscard]] virtual core::Diagnostics set_active_text_causal(bool active) = 0;
    [[nodiscard]] virtual core::Diagnostics reconcile() = 0;
    virtual void terminate(core::PresentationCancellationReason reason) = 0;
};

class RuntimePresentationBridge final : public RuntimePresentationOperationHandler,
                                        private core::PresentationSnapshotBackendPort,
                                        private core::PresentationOperationBackendPort {
public:
    explicit RuntimePresentationBridge(RuntimeAudioAdapter& audio);

    [[nodiscard]] RuntimePresentationDispatchResult
    accept(const core::PresentationOperation& operation) override;
    [[nodiscard]] RuntimePresentationDispatchResult
    accept(const core::AudioOperation& operation) override;
    [[nodiscard]] RuntimePresentationDispatchResult flush() override;
    [[nodiscard]] core::Diagnostics set_active_text_causal(bool active) override;
    [[nodiscard]] core::Diagnostics reconcile() override;
    [[nodiscard]] RuntimePresentationDispatchResult poll_audio();
    [[nodiscard]] core::Diagnostics reconcile(const core::CompiledProject& project,
                                              const core::SessionState& state);
    void terminate(core::PresentationCancellationReason reason) override;
    void bind_presentation_id_allocator(std::function<core::PresentationOperationId()> allocator);
    void bind_runtime(const core::CompiledProject* project,
                      std::function<const core::SessionState&()> state_provider);

    [[nodiscard]] const core::PresentationCheckpointStatus& checkpoint_status() const noexcept
    {
        return m_coordinator.checkpoint_status();
    }

private:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile(const core::RuntimePresentationSnapshot& snapshot) override;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    realize(const core::CoordinatedOperationDelivery& delivery) override;
    void reset(core::PresentationCancellationReason reason) override;
    [[nodiscard]] RuntimePresentationDispatchResult drain_backend_facts();
    [[nodiscard]] std::optional<core::RuntimeInputMessage>
    terminal_input(const core::PresentationOperationLifecycle& lifecycle, bool completed) const;

    RuntimeAudioAdapter& m_audio;
    core::PresentationCoordinator m_coordinator;
    core::RuntimePresentationSnapshotPublisher m_publisher;
    std::vector<core::BackendOperationAcknowledgement> m_backend_facts;
    std::function<core::PresentationOperationId()> m_allocate_presentation_id;
    std::optional<core::PresentationOperationId> m_active_text_operation;
    const core::CompiledProject* m_project = nullptr;
    std::function<const core::SessionState&()> m_state_provider;
};

} // namespace noveltea
