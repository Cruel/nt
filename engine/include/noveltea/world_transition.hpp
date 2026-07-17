#pragma once

#include "noveltea/core/presentation_coordinator.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/world_presentation.hpp"

#include <chrono>
#include <optional>
#include <vector>

namespace noveltea {

enum class WorldTransitionVisualKind : std::uint8_t {
    Fade,
    Dissolve,
};

struct WorldTransitionRenderState {
    core::PresentationOperationRef operation;
    core::PresentationSnapshotRevision source;
    core::PresentationSnapshotRevision target;
    WorldTransitionVisualKind kind = WorldTransitionVisualKind::Fade;
    Color color{};
    float progress = 0.0f;
    bool operator==(const WorldTransitionRenderState&) const = default;
};

class WorldTransitionBackend final : public core::PresentationOperationBackendPort {
public:
    explicit WorldTransitionBackend(const WorldPresentationBackend& world) : m_world(world) {}

    [[nodiscard]] core::Result<void, core::Diagnostics>
    realize(const core::CoordinatedOperationDelivery& delivery) override;
    void advance(const core::RuntimeClockUpdate& clocks);
    void snap_to_target(core::PresentationOperationRef operation);
    void fail_active(core::Diagnostic diagnostic);
    void reset(core::PresentationCancellationReason reason) override;

    [[nodiscard]] std::vector<core::BackendOperationAcknowledgement> take_acknowledgements();
    [[nodiscard]] const std::optional<WorldTransitionRenderState>& render_state() const noexcept
    {
        return m_render_state;
    }

private:
    struct ActiveOperation {
        core::PresentationOperationMetadata metadata;
        core::FinitePresentationOperationCommon common;
        WorldTransitionVisualKind kind = WorldTransitionVisualKind::Fade;
        Color color{};
        std::chrono::microseconds elapsed{0};
    };

    void publish_running(const ActiveOperation& operation);
    void publish_completed(const ActiveOperation& operation);
    void publish_failure(const core::CoordinatedOperationDelivery& delivery,
                         core::Diagnostic diagnostic);
    void update_render_state();

    const WorldPresentationBackend& m_world;
    std::optional<ActiveOperation> m_active;
    std::optional<WorldTransitionRenderState> m_render_state;
    std::vector<core::BackendOperationAcknowledgement> m_acknowledgements;
};

} // namespace noveltea
