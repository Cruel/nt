#include "noveltea/script/runtime_checkpoint_service.hpp"

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/save_state.hpp"
#include "noveltea/core/save_state_codec.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/core/typed_save_slot_store.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <utility>

namespace noveltea::script {
namespace {

core::Diagnostics checkpoint_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

void add_issue(std::vector<core::CheckpointReadinessIssue>& issues,
               core::CheckpointReadinessReason reason, core::Diagnostics diagnostics)
{
    for (const auto& diagnostic : diagnostics)
        issues.push_back(core::CheckpointReadinessIssue{reason, std::nullopt, diagnostic});
}

bool is_exact_room_default(const core::CompiledProject& project, const core::SessionState& session)
{
    const auto* mode = std::get_if<core::RoomMode>(&session.mode());
    if (mode == nullptr)
        return false;
    const auto* room = project.find_room(mode->room);
    const auto& background = session.background();
    if (room == nullptr || !background || background->asset != room->background.asset ||
        background->color != room->background.color || background->fit != room->background.fit ||
        background->material != room->background.material)
        return false;
    if (session.overlays().size() != room->overlays.size())
        return false;
    for (std::size_t index = 0; index < room->overlays.size(); ++index) {
        const auto& restored = session.overlays()[index];
        const auto& definition = room->overlays[index];
        if (restored.room != mode->room || restored.overlay != definition.id ||
            restored.visible != definition.enabled)
            return false;
    }
    return true;
}

} // namespace

RuntimeCheckpointService::RuntimeCheckpointService(const core::CompiledProject& project,
                                                   core::TypedSaveSlotStore& saves) noexcept
    : m_project(project), m_saves(saves),
      m_readiness{core::CheckpointReadinessRevision::from_number(1), {}}
{
}

core::Result<void, core::Diagnostics> RuntimeCheckpointService::record_structural_mutation()
{
    if (m_generations.structural_generation == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.structural_generation_exhausted",
                             "Checkpoint structural generation identity is exhausted."));
    ++m_generations.structural_generation;
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeCheckpointService::record_time_mutation()
{
    if (m_generations.time_generation == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.time_generation_exhausted",
                             "Checkpoint time generation identity is exhausted."));
    ++m_generations.time_generation;
    return core::Result<void, core::Diagnostics>::success();
}

bool RuntimeCheckpointService::time_only_refresh_due(std::chrono::milliseconds now) const noexcept
{
    return now >= m_next_time_only_refresh;
}

core::Diagnostics
RuntimeCheckpointService::validate_reconstructibility(const core::SessionState& session) const
{
    const bool has_room_defaults = is_exact_room_default(m_project, session);
    const bool non_derivable_background_or_overlays =
        (!has_room_defaults && (session.background().has_value() || !session.overlays().empty()));
    if (session.actors().empty() && session.layouts().empty() && !session.presented_text() &&
        !session.active_choice() && !session.transition() && session.audio_channels().empty() &&
        !session.map_presentation() && !non_derivable_background_or_overlays)
        return {};

    return checkpoint_error("checkpoint.reconstructible_state_invalid",
                            "Current save format omits non-derivable presentation state; retain "
                            "the previous checkpoint.");
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::publish_readiness(std::vector<core::CheckpointReadinessIssue> issues)
{
    std::stable_sort(issues.begin(), issues.end(), [](const auto& left, const auto& right) {
        return left.reason < right.reason;
    });
    if (issues == m_readiness.issues)
        return core::Result<void, core::Diagnostics>::success();
    if (m_next_readiness_revision == std::numeric_limits<std::uint64_t>::max())
        return core::Result<void, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.readiness_revision_exhausted",
                             "Checkpoint readiness revision identity is exhausted."));
    m_readiness = {core::CheckpointReadinessRevision::from_number(m_next_readiness_revision++),
                   std::move(issues)};
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<core::SaveCheckpointRevision, core::Diagnostics>
RuntimeCheckpointService::allocate_checkpoint_revision()
{
    if (m_next_checkpoint_revision == std::numeric_limits<std::uint64_t>::max())
        return core::Result<core::SaveCheckpointRevision, core::Diagnostics>::failure(
            checkpoint_error("checkpoint.revision_exhausted",
                             "Checkpoint revision identity is exhausted."));
    return core::Result<core::SaveCheckpointRevision, core::Diagnostics>::success(
        core::SaveCheckpointRevision::from_number(m_next_checkpoint_revision++));
}

core::Result<void, core::Diagnostics>
RuntimeCheckpointService::publish_candidate(const core::SessionState& session,
                                            core::SaveSnapshotContext context)
{
    std::vector<core::CheckpointReadinessIssue> issues;
    const auto reconstructibility = validate_reconstructibility(session);
    add_issue(issues, core::CheckpointReadinessReason::ReconstructibleStateInvalid,
              reconstructibility);
    if (!issues.empty()) {
        auto published = publish_readiness(std::move(issues));
        return published ? core::Result<void, core::Diagnostics>::failure(reconstructibility)
                         : published;
    }

    auto save = core::make_save_state(m_project, session, context);
    core::Diagnostics failure;
    if (!save) {
        failure = save.error();
        add_issue(issues, core::CheckpointReadinessReason::SaveProjectionFailed, failure);
    } else {
        auto* projected = save.value_if();
        auto valid = core::validate_save_state(m_project, *projected, "checkpoint-candidate");
        if (!valid) {
            failure = valid.error();
            add_issue(issues, core::CheckpointReadinessReason::SaveValidationFailed, failure);
        } else {
            auto encoded = core::encode_save_state_text(m_project, *projected);
            if (!encoded) {
                failure = encoded.error();
                add_issue(issues, core::CheckpointReadinessReason::SaveEncodingFailed, failure);
            } else {
                auto readiness = publish_readiness({});
                if (!readiness)
                    return readiness;
                auto revision = allocate_checkpoint_revision();
                if (!revision)
                    return core::Result<void, core::Diagnostics>::failure(revision.error());
                auto* encoded_value = encoded.value_if();
                const auto* revision_value = revision.value_if();
                const core::SaveCheckpointMetadata metadata{
                    .save_format_version = projected->metadata.format_version,
                    .project = projected->metadata.project,
                    .project_version = projected->metadata.project_version,
                    .play_time = projected->play_time,
                    .generations = m_generations};
                core::LatestSaveCheckpoint candidate{*revision_value, std::move(*encoded_value),
                                                     metadata};
                m_latest_checkpoint = std::move(candidate);
                m_generations.captured_structural_generation = m_generations.structural_generation;
                m_generations.captured_time_generation = m_generations.time_generation;
                m_next_time_only_refresh = projected->play_time + std::chrono::seconds(1);
                return core::Result<void, core::Diagnostics>::success();
            }
        }
    }
    auto published = publish_readiness(std::move(issues));
    if (!published)
        return published;
    return core::Result<void, core::Diagnostics>::failure(std::move(failure));
}

} // namespace noveltea::script
