#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/save_state.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <vector>

namespace noveltea::core {
class CompiledProject;
class SessionState;
class TypedSaveSlotStore;
} // namespace noveltea::core

namespace noveltea::script {

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

private:
    [[nodiscard]] core::Diagnostics
    validate_reconstructibility(const core::SessionState& session) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    publish_readiness(std::vector<core::CheckpointReadinessIssue> issues);
    [[nodiscard]] core::Result<core::SaveCheckpointRevision, core::Diagnostics>
    allocate_checkpoint_revision();

    const core::CompiledProject& m_project;
    [[maybe_unused]] core::TypedSaveSlotStore& m_saves;
    core::CheckpointGenerationState m_generations;
    core::CheckpointReadinessStatus m_readiness;
    std::optional<core::LatestSaveCheckpoint> m_latest_checkpoint;
    std::optional<core::DeferredAutosaveRequest> m_pending_deferred_autosave;
    std::uint64_t m_next_checkpoint_revision = 1;
    std::uint64_t m_next_readiness_revision = 2;
    std::chrono::milliseconds m_next_time_only_refresh{0};
};

} // namespace noveltea::script
