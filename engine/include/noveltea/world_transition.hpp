#pragma once

#include "noveltea/animation/tween_service.hpp"
#include "noveltea/presentation/presentation_coordinator.hpp"
#include "noveltea/core/runtime_clock.hpp"
#include "noveltea/world_presentation.hpp"

#include <chrono>
#include <optional>
#include <variant>
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
    bool operator==(const WorldTransitionRenderState& other) const noexcept
    {
        return operation == other.operation && source == other.source && target == other.target &&
               kind == other.kind && color.r == other.color.r && color.g == other.color.g &&
               color.b == other.color.b && color.a == other.color.a && progress == other.progress;
    }
};

struct WorldTransitionScenePlan {
    bool render_source = false;
    bool render_target = false;
    bool blend_completed_scenes = false;
    std::uint8_t native_scene_target_count = 0;

    bool operator==(const WorldTransitionScenePlan&) const = default;
};

[[nodiscard]] WorldTransitionScenePlan
make_world_transition_scene_plan(const WorldTransitionRenderState& state) noexcept;

using TargetedPresentationOperation =
    std::variant<core::BackgroundPresentationOperation, core::ActorPresentationOperation,
                 core::LayoutFinitePresentationOperation>;

struct TargetedPresentationRenderState {
    core::PresentationOperationRef operation;
    TargetedPresentationOperation request;
    float progress = 0.0f;
    bool operator==(const TargetedPresentationRenderState&) const = default;
};

struct LayoutTransitionRenderState {
    core::PresentationOperationRef operation;
    core::LayoutOperationTarget target;
    core::PresentationRevisionBinding revisions;
    float progress = 0.0f;
    bool operator==(const LayoutTransitionRenderState&) const = default;
};

class WorldTransitionBackend final : public core::PresentationOperationBackendPort {
public:
    explicit WorldTransitionBackend(const WorldPresentationBackend& world) : m_world(world) {}

    [[nodiscard]] core::Result<void, core::Diagnostics>
    realize(const core::CoordinatedOperationDelivery& delivery) override;
    void advance(const core::RuntimeClockUpdate& clocks);
    void snap_to_target(core::PresentationOperationRef operation);
    void fail_active(core::Diagnostic diagnostic);
    void fail_operation(core::PresentationOperationRef operation, core::Diagnostic diagnostic);
    void reset(core::PresentationCancellationReason reason) override;

    [[nodiscard]] std::vector<core::BackendOperationAcknowledgement> take_acknowledgements();
    [[nodiscard]] const std::optional<WorldTransitionRenderState>& render_state() const noexcept
    {
        return m_render_state;
    }
    [[nodiscard]] std::vector<TargetedPresentationRenderState> targeted_render_states() const;
    [[nodiscard]] std::vector<LayoutTransitionRenderState> layout_render_states() const;
    [[nodiscard]] std::vector<core::PresentationSnapshotRevision> active_revisions() const;
    [[nodiscard]] core::Result<QuadBatch, core::Diagnostics> compose_targeted_world_batch() const;

private:
    struct ActiveOperation {
        core::PresentationOperationMetadata metadata;
        core::FinitePresentationOperationCommon common;
        core::FinitePresentationOperationTarget target;
        WorldTransitionVisualKind kind = WorldTransitionVisualKind::Fade;
        Color color{};
        animation::TweenHandle tween;
    };

    struct ActiveTargetedOperation {
        core::PresentationOperationMetadata metadata;
        TargetedPresentationOperation request;
        animation::TweenHandle tween;
    };

    [[nodiscard]] animation::TweenService& tween_service(core::LayoutClockDomain clock) noexcept;
    [[nodiscard]] const animation::TweenService&
    tween_service(core::LayoutClockDomain clock) const noexcept;
    [[nodiscard]] core::Result<animation::TweenHandle, core::Diagnostic>
    start_tween(const core::FinitePresentationOperationCommon& common);
    [[nodiscard]] std::optional<animation::ScalarTweenSample>
    tween_sample(const core::FinitePresentationOperationCommon& common,
                 animation::TweenHandle handle) const noexcept;
    void cancel_tween(const core::FinitePresentationOperationCommon& common,
                      animation::TweenHandle handle) noexcept;
    void release_tween(const core::FinitePresentationOperationCommon& common,
                       animation::TweenHandle handle) noexcept;
    void publish_running(const core::PresentationOperationMetadata& metadata);
    void publish_completed(const core::PresentationOperationMetadata& metadata);
    void publish_failure(const core::CoordinatedOperationDelivery& delivery,
                         core::Diagnostic diagnostic);
    void update_render_state();

    const WorldPresentationBackend& m_world;
    std::optional<ActiveOperation> m_active;
    std::vector<ActiveTargetedOperation> m_targeted;
    std::optional<WorldTransitionRenderState> m_render_state;
    std::vector<core::BackendOperationAcknowledgement> m_acknowledgements;
    animation::TweenService m_gameplay_tweens;
    animation::TweenService m_unscaled_tweens;
};

} // namespace noveltea
