#pragma once

#include "noveltea/core/presentation_coordinator.hpp"
#include "noveltea/runtime/runtime_ports.hpp"
#include "noveltea/runtime_audio_adapter.hpp"

#include <functional>
#include <optional>

namespace noveltea {

struct RuntimePresentationDispatchResult {
    std::vector<core::RuntimeInputMessage> inputs;
    core::Diagnostics diagnostics;
};

struct RuntimePresentationFastForwardResult {
    core::PresentationFastForwardDisposition disposition =
        core::PresentationFastForwardDisposition::Idle;
    std::vector<core::RuntimeInputMessage> inputs;
    core::Diagnostics diagnostics;
};

class RuntimePresentationOperationHandler {
public:
    virtual ~RuntimePresentationOperationHandler() = default;
    [[nodiscard]] virtual RuntimePresentationDispatchResult flush() = 0;
    [[nodiscard]] virtual core::Diagnostics
    set_active_text_phase(core::ActiveTextPresentationPhase phase) = 0;
    [[nodiscard]] virtual core::Diagnostics
    reconcile_publication(const core::RuntimePresentationSnapshot& snapshot) = 0;
    virtual void terminate(core::PresentationCancellationReason reason) = 0;
};

class RuntimePresentationBridge final : public RuntimePresentationOperationHandler,
                                        public runtime::PresentationRuntimePort,
                                        private core::PresentationSnapshotBackendPort,
                                        private core::PresentationOperationBackendPort {
public:
    explicit RuntimePresentationBridge(RuntimeAudioAdapter& audio);

    [[nodiscard]] core::Result<void, core::Diagnostics>
    reconcile_snapshot(const core::RuntimePresentationSnapshot& snapshot) override;
    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::PresentationOperation& operation) override;
    [[nodiscard]] core::Result<runtime::PresentationAcceptance, core::Diagnostics>
    accept(const core::AudioOperation& operation) override;
    [[nodiscard]] RuntimePresentationDispatchResult flush() override;
    [[nodiscard]] core::Diagnostics
    set_active_text_phase(core::ActiveTextPresentationPhase phase) override;
    [[nodiscard]] core::Diagnostics
    reconcile_publication(const core::RuntimePresentationSnapshot& snapshot) override;
    [[nodiscard]] RuntimePresentationDispatchResult poll_audio();
    [[nodiscard]] RuntimePresentationFastForwardResult fast_forward_one();
    void terminate(core::PresentationCancellationReason reason) override;
    void bind_presentation_id_allocator(std::function<core::PresentationOperationId()> allocator);
    void bind_snapshot_backend(std::function<core::Result<void, core::Diagnostics>(
                                   const core::RuntimePresentationSnapshot&)>
                                   backend);

    [[nodiscard]] const core::PresentationCheckpointStatus&
    checkpoint_status() const noexcept override
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
    std::vector<core::BackendOperationAcknowledgement> m_backend_facts;
    std::function<core::PresentationOperationId()> m_allocate_presentation_id;
    std::optional<core::PresentationOperationId> m_active_text_operation;
    core::ActiveTextPresentationPhase m_active_text_phase =
        core::ActiveTextPresentationPhase::Stable;
    std::function<core::Result<void, core::Diagnostics>(const core::RuntimePresentationSnapshot&)>
        m_snapshot_backend;
};

} // namespace noveltea
