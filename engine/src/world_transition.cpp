#include "noveltea/world_transition.hpp"

#include <algorithm>
#include <charconv>
#include <type_traits>

namespace noveltea {
namespace {

std::optional<Color> parse_color(std::string_view value)
{
    if ((value.size() != 7 && value.size() != 9) || value.front() != '#')
        return std::nullopt;
    const auto component = [value](std::size_t offset) -> std::optional<unsigned> {
        unsigned result = 0;
        const char* first = value.data() + offset;
        const char* last = first + 2;
        const auto parsed = std::from_chars(first, last, result, 16);
        return parsed.ec == std::errc{} && parsed.ptr == last ? std::optional<unsigned>{result}
                                                              : std::nullopt;
    };
    const auto red = component(1);
    const auto green = component(3);
    const auto blue = component(5);
    const auto alpha = value.size() == 9 ? component(7) : std::optional<unsigned>{255};
    if (!red || !green || !blue || !alpha)
        return std::nullopt;
    return Color::from_rgba8(*red, *green, *blue, *alpha);
}

core::Diagnostic failure(std::string code, std::string message)
{
    return {.code = std::move(code), .message = std::move(message)};
}

struct NormalizedWorldTransition {
    core::FinitePresentationOperationCommon common;
    WorldTransitionVisualKind kind = WorldTransitionVisualKind::Fade;
    Color color{};
};

core::Result<NormalizedWorldTransition, core::Diagnostic>
normalize(const core::CoordinatedPresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) -> core::Result<NormalizedWorldTransition, core::Diagnostic> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::SceneTransitionGroupOperation> ||
                          std::is_same_v<T, core::RoomNavigationTransitionOperation>) {
                if (value.kind == core::compiled::TransitionKind::Dissolve) {
                    return core::Result<NormalizedWorldTransition, core::Diagnostic>::success(
                        {value.common, WorldTransitionVisualKind::Dissolve, {}});
                }
                if (value.kind != core::compiled::TransitionKind::Fade) {
                    return core::Result<NormalizedWorldTransition, core::Diagnostic>::failure(
                        failure("presentation.world_transition_kind_unsupported",
                                "World transition backend accepts only finite Fade or Dissolve "
                                "operations"));
                }
                const std::string color_text = value.color.value_or("#000000");
                const auto color = parse_color(color_text);
                if (!color) {
                    return core::Result<NormalizedWorldTransition, core::Diagnostic>::failure(
                        failure("presentation.world_transition_color_invalid",
                                "World Fade color must be #RRGGBB or #RRGGBBAA"));
                }
                return core::Result<NormalizedWorldTransition, core::Diagnostic>::success(
                    {value.common, WorldTransitionVisualKind::Fade, *color});
            }
            return core::Result<NormalizedWorldTransition, core::Diagnostic>::failure(
                failure("presentation.world_transition_operation_unsupported",
                        "Operation is not a Room-navigation or Scene TransitionGroup world "
                        "transition"));
        },
        operation);
}

} // namespace

core::Result<void, core::Diagnostics>
WorldTransitionBackend::realize(const core::CoordinatedOperationDelivery& delivery)
{
    if (m_active && m_active->metadata.operation != delivery.metadata.operation) {
        m_active.reset();
        m_render_state.reset();
    }
    auto normalized = normalize(delivery.operation);
    if (!normalized) {
        publish_failure(delivery, std::move(normalized).error());
        return core::Result<void, core::Diagnostics>::success();
    }
    const auto& value = *normalized.value_if();
    if (!m_world.frame(value.common.revisions.source) ||
        !m_world.frame(value.common.revisions.target)) {
        publish_failure(
            delivery,
            failure("presentation.world_transition_revision_unavailable",
                    "World transition source and target must both be realized from their exact "
                    "published revisions"));
        return core::Result<void, core::Diagnostics>::success();
    }

    if (m_active && m_active->metadata.operation == delivery.metadata.operation) {
        publish_running(*m_active);
        return core::Result<void, core::Diagnostics>::success();
    }

    m_active = ActiveOperation{delivery.metadata, value.common, value.kind, value.color,
                               std::chrono::microseconds{0}};
    update_render_state();
    publish_running(*m_active);
    return core::Result<void, core::Diagnostics>::success();
}

void WorldTransitionBackend::advance(const core::RuntimeClockUpdate& clocks)
{
    if (!m_active)
        return;
    const auto delta = m_active->common.clock == core::LayoutClockDomain::Gameplay
                           ? clocks.gameplay_delta
                           : clocks.unscaled_presentation_delta;
    if (delta > std::chrono::microseconds{0})
        m_active->elapsed += delta;
    const auto duration =
        std::chrono::duration_cast<std::chrono::microseconds>(m_active->common.duration);
    if (duration <= std::chrono::microseconds{0} || m_active->elapsed >= duration) {
        const auto completed = *m_active;
        m_active.reset();
        m_render_state.reset();
        publish_completed(completed);
        return;
    }
    update_render_state();
}

void WorldTransitionBackend::snap_to_target(core::PresentationOperationRef operation)
{
    if (!m_active || m_active->metadata.operation != operation)
        return;
    m_active.reset();
    m_render_state.reset();
}

void WorldTransitionBackend::fail_active(core::Diagnostic diagnostic)
{
    if (!m_active)
        return;
    const auto metadata = m_active->metadata;
    m_active.reset();
    m_render_state.reset();
    m_acknowledgements.push_back(
        {metadata.operation, metadata.sequence, metadata.owner,
         core::BackendOperationFailed{core::PresentationFailureDomain::WorldPresentation,
                                      std::move(diagnostic)}});
}

void WorldTransitionBackend::reset(core::PresentationCancellationReason reason)
{
    (void)reason;
    m_active.reset();
    m_render_state.reset();
    m_acknowledgements.clear();
}

std::vector<core::BackendOperationAcknowledgement>
WorldTransitionBackend::take_acknowledgements()
{
    auto result = std::move(m_acknowledgements);
    m_acknowledgements.clear();
    return result;
}

void WorldTransitionBackend::publish_running(const ActiveOperation& operation)
{
    m_acknowledgements.push_back({operation.metadata.operation, operation.metadata.sequence,
                                  operation.metadata.owner, core::BackendOperationRunning{}});
}

void WorldTransitionBackend::publish_completed(const ActiveOperation& operation)
{
    m_acknowledgements.push_back({operation.metadata.operation, operation.metadata.sequence,
                                  operation.metadata.owner, core::BackendOperationCompleted{}});
}

void WorldTransitionBackend::publish_failure(const core::CoordinatedOperationDelivery& delivery,
                                             core::Diagnostic diagnostic)
{
    m_acknowledgements.push_back(
        {delivery.metadata.operation, delivery.metadata.sequence, delivery.metadata.owner,
         core::BackendOperationFailed{core::PresentationFailureDomain::WorldPresentation,
                                      std::move(diagnostic)}});
}

void WorldTransitionBackend::update_render_state()
{
    if (!m_active) {
        m_render_state.reset();
        return;
    }
    const auto duration =
        std::chrono::duration_cast<std::chrono::microseconds>(m_active->common.duration);
    const double progress = duration.count() <= 0
                                ? 1.0
                                : static_cast<double>(m_active->elapsed.count()) /
                                      static_cast<double>(duration.count());
    m_render_state = WorldTransitionRenderState{
        m_active->metadata.operation, m_active->common.revisions.source,
        m_active->common.revisions.target, m_active->kind, m_active->color,
        static_cast<float>(std::clamp(progress, 0.0, 1.0))};
}

} // namespace noveltea
