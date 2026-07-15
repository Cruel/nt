#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/save_state.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <variant>
#include <vector>

namespace noveltea::core {
class CompiledProject;
class SessionState;
class TypedSaveSlotStore;
} // namespace noveltea::core

namespace noveltea::script {

struct RuntimeCheckpointFacts {
    bool input_queue_settled = true;
    bool output_queue_settled = true;
    bool script_input_queue_settled = true;
    bool presentation_acknowledgements_settled = true;
    bool immediate_script_invocation_active = false;
    std::optional<core::FlowBlocker> flow_blocker;
    std::vector<core::HostRequestId> pending_host_requests;
    core::PresentationCheckpointStatus presentation_status;
    std::size_t in_flight_external_requests = 0;
};

struct RuntimeTransactionMutations {
    bool structural = false;
    bool time = false;
    std::chrono::milliseconds elapsed{0};
};

// Owns checkpoint readiness, candidate publication, and retained checkpoint values for one
// runtime session. Runtime transaction wiring and save-command dispatch deliberately arrive in
// later Phase 2 slices.
class RuntimeCheckpointService final {
public:
    RuntimeCheckpointService(const core::CompiledProject& project,
                             core::TypedSaveSlotStore& saves) noexcept;

    [[nodiscard]] const core::CheckpointGenerationState& generations() const noexcept
    {
        return m_generations;
    }
    [[nodiscard]] const core::CheckpointReadinessStatus& readiness() const noexcept
    {
        return m_readiness;
    }
    [[nodiscard]] const std::optional<core::LatestSaveCheckpoint>&
    latest_checkpoint() const noexcept
    {
        return m_latest_checkpoint;
    }
    [[nodiscard]] const std::optional<core::DeferredAutosaveRequest>&
    pending_deferred_autosave() const noexcept
    {
        return m_pending_deferred_autosave;
    }

    [[nodiscard]] core::Result<void, core::Diagnostics> record_structural_mutation();
    [[nodiscard]] core::Result<void, core::Diagnostics> record_time_mutation();
    [[nodiscard]] bool time_only_refresh_due(std::chrono::milliseconds now) const noexcept;

    // This is the sole candidate-publication path. Callers provide a const session projection;
    // this service never takes ownership of mutable runtime state or presentation backends.
    [[nodiscard]] core::Result<void, core::Diagnostics>
    publish_candidate(const core::SessionState& session, core::SaveSnapshotContext context = {});
    [[nodiscard]] core::Result<void, core::Diagnostics>
    settle(const core::SessionState& session, const RuntimeCheckpointFacts& facts,
           RuntimeTransactionMutations mutations);
    [[nodiscard]] core::Result<void, core::CheckpointSaveOutcome>
    request(const core::ManualSaveRequest& request) noexcept;
    [[nodiscard]] core::CheckpointSaveOutcome
    request(const core::DeferredAutosaveRequest& request) noexcept;
    [[nodiscard]] core::CheckpointSaveOutcome
    request(const core::ImmediateRetainedCheckpointWriteRequest& request);
    [[nodiscard]] std::vector<core::CheckpointSaveOutcome> take_completed_save_outcomes();
    [[nodiscard]] core::Result<core::LatestSaveCheckpoint, core::Diagnostics>
    prepare_loaded_checkpoint(std::string encoded_save, const core::SaveState& decoded);
    void commit_loaded_checkpoint(core::LatestSaveCheckpoint checkpoint) noexcept;
    void reset() noexcept;

private:
    [[nodiscard]] core::Diagnostics
    validate_reconstructibility(const core::SessionState& session) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    publish_readiness(std::vector<core::CheckpointReadinessIssue> issues);
    [[nodiscard]] core::Result<core::SaveCheckpointRevision, core::Diagnostics>
    allocate_checkpoint_revision();
    [[nodiscard]] core::CheckpointSaveOutcome
    write_checkpoint(core::TypedSaveSlotId slot, const core::LatestSaveCheckpoint& checkpoint,
                     core::CheckpointWriteSource source);
    void fulfill_deferred_autosave();

    const core::CompiledProject& m_project;
    [[maybe_unused]] core::TypedSaveSlotStore& m_saves;
    core::CheckpointGenerationState m_generations;
    core::CheckpointReadinessStatus m_readiness;
    std::optional<core::LatestSaveCheckpoint> m_latest_checkpoint;
    std::optional<core::DeferredAutosaveRequest> m_pending_deferred_autosave;
    std::vector<core::TypedSaveSlotId> m_pending_manual_saves;
    std::optional<core::LatestSaveCheckpoint> m_deferred_autosave_target;
    std::vector<core::CheckpointSaveOutcome> m_completed_save_outcomes;
    std::uint64_t m_next_checkpoint_revision = 1;
    std::uint64_t m_next_readiness_revision = 2;
    std::chrono::milliseconds m_next_time_only_refresh{0};
    std::chrono::milliseconds m_elapsed_runtime{0};
};

} // namespace noveltea::script
