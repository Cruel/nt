#include "noveltea/world_transition.hpp"

#include "noveltea/presentation/presentation_operation_requests.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <numbers>
#include <tuple>
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
normalize_world(const core::CoordinatedPresentationOperation& operation)
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

core::FinitePresentationOperationTarget
world_target(const core::CoordinatedPresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) -> core::FinitePresentationOperationTarget {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::SceneTransitionGroupOperation> ||
                          std::is_same_v<T, core::RoomNavigationTransitionOperation>)
                return core::operation_target(core::FinitePresentationOperation{value});
            return core::WorldCompositionOperationTarget{};
        },
        operation);
}

const core::FinitePresentationOperationCommon&
targeted_common(const TargetedPresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) -> const core::FinitePresentationOperationCommon& {
            return value.common;
        },
        operation);
}

core::FinitePresentationOperationTarget
targeted_target(const TargetedPresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) {
            return core::operation_target(core::FinitePresentationOperation{value});
        },
        operation);
}

const core::PresentationActor* find_actor(const core::RuntimePresentationSnapshot& snapshot,
                                          const core::ActorPresentationKey& key)
{
    const auto found = std::find_if(snapshot.actors.begin(), snapshot.actors.end(),
                                    [&](const auto& actor) { return actor.key == key; });
    return found == snapshot.actors.end() ? nullptr : &*found;
}

const core::PresentationMountedLayout*
find_layout(const core::RuntimePresentationSnapshot& snapshot,
            const core::LayoutOperationTarget& target)
{
    const auto found =
        std::find_if(snapshot.layouts.begin(), snapshot.layouts.end(), [&](const auto& layout) {
            return layout.key == target.layout && layout.owner == target.owner;
        });
    return found == snapshot.layouts.end() ? nullptr : &*found;
}

bool actor_is_drawn(const core::PresentationActor* actor) noexcept
{
    return actor != nullptr && actor->enabled && actor->visible;
}

bool slide_compatible(const core::PresentationActor& source,
                      const core::PresentationActor& target) noexcept
{
    return source.key == target.key && source.character == target.character &&
           source.pose == target.pose && source.expression == target.expression &&
           source.pose_sprite == target.pose_sprite &&
           source.pose_material == target.pose_material &&
           source.pose_anchor == target.pose_anchor && source.pose_offset == target.pose_offset &&
           source.pose_scale == target.pose_scale &&
           source.expression_sprite == target.expression_sprite &&
           source.expression_material == target.expression_material &&
           source.plane == target.plane && source.order == target.order &&
           source.enabled == target.enabled;
}

std::vector<const WorldPresentationDraw*> actor_draws(const WorldPresentationFrame& frame,
                                                      const core::ActorPresentationKey& key)
{
    const std::string identity = world_actor_identity(key);
    std::vector<const WorldPresentationDraw*> result;
    for (const auto& draw : frame.draws) {
        if (draw.family == WorldDrawFamily::Actor && draw.stable_identity == identity)
            result.push_back(&draw);
    }
    std::sort(result.begin(), result.end(),
              [](const auto* lhs, const auto* rhs) { return lhs->sublayer < rhs->sublayer; });
    return result;
}

core::Result<void, core::Diagnostic>
validate_targeted(const WorldPresentationBackend& world,
                  const TargetedPresentationOperation& operation)
{
    const auto& common = targeted_common(operation);
    const auto* source_frame = world.frame(common.revisions.source);
    const auto* target_frame = world.frame(common.revisions.target);
    const auto* source_snapshot = world.snapshot(common.revisions.source);
    const auto* target_snapshot = world.snapshot(common.revisions.target);
    if (!source_frame || !target_frame || !source_snapshot || !target_snapshot) {
        return core::Result<void, core::Diagnostic>::failure(failure(
            "presentation.targeted_revision_unavailable",
            "Targeted finite realization requires exact source and target snapshot revisions"));
    }

    return std::visit(
        [&](const auto& value) -> core::Result<void, core::Diagnostic> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::BackgroundPresentationOperation>) {
                if (value.kind != core::BackgroundOperationKind::CrossFade) {
                    return core::Result<void, core::Diagnostic>::failure(
                        failure("presentation.background_operation_kind_unsupported",
                                "Background finite realization supports cross-fade only"));
                }
            } else if constexpr (std::is_same_v<T, core::CameraPanOperation> ||
                                 std::is_same_v<T, core::CameraZoomOperation> ||
                                 std::is_same_v<T, core::CameraRotationOperation> ||
                                 std::is_same_v<T, core::CameraFocusOperation> ||
                                 std::is_same_v<T, core::CameraShakeOperation> ||
                                 std::is_same_v<T, core::CameraPunchOperation> ||
                                 std::is_same_v<T, core::CameraFlashOperation>) {
                if (!source_snapshot->camera || !target_snapshot->camera) {
                    return core::Result<void, core::Diagnostic>::failure(failure(
                        "presentation.camera_revision_unavailable",
                        "Camera finite realization requires Camera Views in both exact revisions"));
                }
                const auto& source_view = source_snapshot->camera->view;
                const auto& target_view = target_snapshot->camera->view;
                if constexpr (std::is_same_v<T, core::CameraPanOperation> ||
                              std::is_same_v<T, core::CameraZoomOperation> ||
                              std::is_same_v<T, core::CameraRotationOperation>) {
                    if (source_view != value.source_view || target_view != value.target_view) {
                        return core::Result<void, core::Diagnostic>::failure(
                            failure("presentation.camera_revision_mismatch",
                                    "Camera motion must bind exactly to the committed source and "
                                    "target Views"));
                    }
                } else if constexpr (std::is_same_v<T, core::CameraFocusOperation>) {
                    if (source_view != target_view || target_view != value.return_view) {
                        return core::Result<void, core::Diagnostic>::failure(failure(
                            "presentation.camera_focus_durable_drift",
                            "Focus must preserve the desired Camera View and return to it"));
                    }
                } else if (source_view != target_view) {
                    return core::Result<void, core::Diagnostic>::failure(failure(
                        "presentation.camera_emphasis_durable_drift",
                        "Temporary camera emphasis must not mutate the desired Camera View"));
                }
            } else if constexpr (std::is_same_v<T, core::ActorPresentationOperation>) {
                const auto* source_actor = find_actor(*source_snapshot, value.target.actor);
                const auto* target_actor = find_actor(*target_snapshot, value.target.actor);
                const bool source_drawn = actor_is_drawn(source_actor);
                const bool target_drawn = actor_is_drawn(target_actor);
                if (!source_drawn && !target_drawn) {
                    return core::Result<void, core::Diagnostic>::failure(failure(
                        "presentation.actor_operation_target_not_drawn",
                        "Actor finite operation has no visible source or target realization"));
                }
                if (value.kind == core::ActorOperationKind::Slide) {
                    if (source_actor && target_actor &&
                        !slide_compatible(*source_actor, *target_actor)) {
                        return core::Result<void, core::Diagnostic>::failure(
                            failure("presentation.actor_slide_semantics_invalid",
                                    "Actor slide may change placement or visibility, but not pose, "
                                    "expression, resources, plane, or order"));
                    }
                    if ((source_drawn && actor_draws(*source_frame, value.target.actor).empty()) ||
                        (target_drawn && actor_draws(*target_frame, value.target.actor).empty())) {
                        return core::Result<void, core::Diagnostic>::failure(
                            failure("presentation.actor_slide_bounds_unavailable",
                                    "Actor slide requires resolved source or target actor bounds"));
                    }
                }
            } else {
                if (value.kind != core::LayoutOperationKind::Fade) {
                    return core::Result<void, core::Diagnostic>::failure(
                        failure("presentation.layout_operation_kind_unsupported",
                                "Layout finite realization supports fade only"));
                }
                if (!find_layout(*source_snapshot, value.target) &&
                    !find_layout(*target_snapshot, value.target)) {
                    return core::Result<void, core::Diagnostic>::failure(failure(
                        "presentation.layout_operation_target_missing",
                        "Layout finite operation target is absent from both exact revisions"));
                }
            }
            return core::Result<void, core::Diagnostic>::success();
        },
        operation);
}

Rect interpolate_rect(const Rect& source, const Rect& target, float progress) noexcept
{
    const auto interpolate = [progress](float lhs, float rhs) {
        return lhs + (rhs - lhs) * progress;
    };
    return {interpolate(source.x, target.x), interpolate(source.y, target.y),
            interpolate(source.width, target.width), interpolate(source.height, target.height)};
}

float interpolate_value(float source, float target, float progress) noexcept
{
    return source + (target - source) * progress;
}

core::compiled::CameraView interpolate_camera_view(const core::compiled::CameraView& source,
                                                   const core::compiled::CameraView& target,
                                                   float progress) noexcept
{
    const double amount = static_cast<double>(progress);
    return {{source.center.x + (target.center.x - source.center.x) * amount,
             source.center.y + (target.center.y - source.center.y) * amount},
            source.zoom + (target.zoom - source.zoom) * amount,
            source.rotation_degrees + (target.rotation_degrees - source.rotation_degrees) * amount};
}

core::PresentationCamera clamp_camera(core::PresentationCamera camera) noexcept
{
    if (camera.space.edge_policy != core::compiled::WorldPresentationEdgePolicy::Contain)
        return camera;
    const auto bounds = camera.space.bounds.value_or(
        core::compiled::WorldPresentationRect{0.0, 0.0, camera.space.size.x, camera.space.size.y});
    constexpr double degrees_to_radians = 0.017453292519943295769;
    const double radians = camera.view.rotation_degrees * degrees_to_radians;
    const double cosine = std::abs(std::cos(radians));
    const double sine = std::abs(std::sin(radians));
    const double half_width =
        (cosine * camera.space.size.x + sine * camera.space.size.y) / (2.0 * camera.view.zoom);
    const double half_height =
        (sine * camera.space.size.x + cosine * camera.space.size.y) / (2.0 * camera.view.zoom);
    const auto clamp_axis = [](double center, double start, double extent, double half_extent) {
        if (half_extent * 2.0 >= extent)
            return start + extent * 0.5;
        return std::clamp(center, start + half_extent, start + extent - half_extent);
    };
    camera.view.center.x = clamp_axis(camera.view.center.x, bounds.x, bounds.width, half_width);
    camera.view.center.y = clamp_axis(camera.view.center.y, bounds.y, bounds.height, half_height);
    return camera;
}

void reframe_command(QuadCommand& command, const core::PresentationCamera& source,
                     const core::PresentationCamera& target, Size viewport) noexcept
{
    const float source_center_x =
        static_cast<float>(source.view.center.x / source.space.size.x) * viewport.width;
    const float source_center_y =
        static_cast<float>(source.view.center.y / source.space.size.y) * viewport.height;
    const float target_center_x =
        static_cast<float>(target.view.center.x / target.space.size.x) * viewport.width;
    const float target_center_y =
        static_cast<float>(target.view.center.y / target.space.size.y) * viewport.height;
    const float source_zoom = static_cast<float>(source.view.zoom);
    const float target_zoom = static_cast<float>(target.view.zoom);
    const float half_width = viewport.width * 0.5f;
    const float half_height = viewport.height * 0.5f;
    const Rect base{(command.rect.x - half_width) / source_zoom + source_center_x,
                    (command.rect.y - half_height) / source_zoom + source_center_y,
                    command.rect.width / source_zoom, command.rect.height / source_zoom};
    command.rect = {(base.x - target_center_x) * target_zoom + half_width,
                    (base.y - target_center_y) * target_zoom + half_height,
                    base.width * target_zoom, base.height * target_zoom};
    command.rotation_degrees +=
        static_cast<float>(source.view.rotation_degrees - target.view.rotation_degrees);
    command.rotation_origin = {half_width, half_height};
}

bool same_draw_identity(const WorldPresentationDraw& left, const WorldPresentationDraw& right)
{
    return left.plane == right.plane && left.family == right.family && left.order == right.order &&
           left.stable_identity == right.stable_identity && left.sublayer == right.sublayer;
}

Rect offscreen_rect(Rect rect, Size viewport) noexcept
{
    const float center = rect.x + rect.width * 0.5f;
    rect.x = center <= viewport.width * 0.5f ? -rect.width : viewport.width;
    return rect;
}

struct LayeredDraw {
    WorldPresentationDraw draw;
    std::uint8_t blend_group = 1;
};

void append_with_opacity(std::vector<LayeredDraw>& output, const WorldPresentationDraw& draw,
                         float opacity, std::uint8_t blend_group)
{
    LayeredDraw copy{draw, blend_group};
    copy.draw.command.color.a *= std::clamp(opacity, 0.0f, 1.0f);
    output.push_back(std::move(copy));
}

} // namespace

WorldTransitionScenePlan
make_world_transition_scene_plan(const WorldTransitionRenderState& state) noexcept
{
    if (state.kind == WorldTransitionVisualKind::Dissolve)
        return {.render_source = true,
                .render_target = true,
                .blend_completed_scenes = true,
                .native_scene_target_count = 2};

    const bool source_phase = state.progress < 0.5f;
    return {.render_source = source_phase,
            .render_target = !source_phase,
            .blend_completed_scenes = false,
            .native_scene_target_count = 1};
}

core::Result<void, core::Diagnostics>
WorldTransitionBackend::realize(const core::CoordinatedOperationDelivery& delivery)
{
    if (std::holds_alternative<core::SceneTransitionGroupOperation>(delivery.operation) ||
        std::holds_alternative<core::RoomNavigationTransitionOperation>(delivery.operation)) {
        auto normalized = normalize_world(delivery.operation);
        if (!normalized) {
            publish_failure(delivery, std::move(normalized).error());
            return core::Result<void, core::Diagnostics>::success();
        }
        const auto& value = *normalized.value_if();
        const bool source_available = m_world.frame(value.common.revisions.source) != nullptr;
        const bool target_available = m_world.frame(value.common.revisions.target) != nullptr;
        if (!source_available || !target_available) {
            publish_failure(delivery,
                            failure("presentation.world_transition_revision_unavailable",
                                    "World transition requires exact source revision " +
                                        std::to_string(value.common.revisions.source.number()) +
                                        " (" + (source_available ? "available" : "missing") +
                                        ") and target revision " +
                                        std::to_string(value.common.revisions.target.number()) +
                                        " (" + (target_available ? "available" : "missing") + ")"));
            return core::Result<void, core::Diagnostics>::success();
        }

        if (m_active && m_active->metadata.operation == delivery.metadata.operation) {
            publish_running(m_active->metadata);
            return core::Result<void, core::Diagnostics>::success();
        }

        const auto target = world_target(delivery.operation);
        if (m_active && m_active->target != target) {
            publish_failure(
                delivery,
                failure("presentation.world_transition_target_conflict",
                        "A finite world transition cannot displace an active operation in a "
                        "different typed target domain"));
            return core::Result<void, core::Diagnostics>::success();
        }

        auto started = start_tween(value.common);
        if (!started) {
            publish_failure(delivery, std::move(started).error());
            return core::Result<void, core::Diagnostics>::success();
        }
        if (m_active)
            cancel_tween(m_active->common, m_active->tween);
        m_active = ActiveOperation{delivery.metadata, value.common, target,
                                   value.kind,        value.color,  *started.value_if()};
        update_render_state();
        publish_running(m_active->metadata);
        return core::Result<void, core::Diagnostics>::success();
    }

    const auto targeted = std::visit(
        [](const auto& value) -> std::optional<TargetedPresentationOperation> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::BackgroundPresentationOperation> ||
                          std::is_same_v<T, core::CameraPanOperation> ||
                          std::is_same_v<T, core::CameraZoomOperation> ||
                          std::is_same_v<T, core::CameraRotationOperation> ||
                          std::is_same_v<T, core::CameraFocusOperation> ||
                          std::is_same_v<T, core::CameraShakeOperation> ||
                          std::is_same_v<T, core::CameraPunchOperation> ||
                          std::is_same_v<T, core::CameraFlashOperation> ||
                          std::is_same_v<T, core::ActorPresentationOperation> ||
                          std::is_same_v<T, core::LayoutFinitePresentationOperation>)
                return TargetedPresentationOperation{value};
            return std::nullopt;
        },
        delivery.operation);
    if (!targeted) {
        publish_failure(delivery,
                        failure("presentation.finite_operation_unsupported",
                                "Finite presentation backend does not support this operation"));
        return core::Result<void, core::Diagnostics>::success();
    }

    auto valid = validate_targeted(m_world, *targeted);
    if (!valid) {
        publish_failure(delivery, std::move(valid).error());
        return core::Result<void, core::Diagnostics>::success();
    }
    const auto existing =
        std::find_if(m_targeted.begin(), m_targeted.end(), [&](const auto& value) {
            return value.metadata.operation == delivery.metadata.operation;
        });
    if (existing != m_targeted.end()) {
        publish_running(existing->metadata);
        return core::Result<void, core::Diagnostics>::success();
    }

    const auto target = targeted_target(*targeted);
    auto started = start_tween(targeted_common(*targeted));
    if (!started) {
        publish_failure(delivery, std::move(started).error());
        return core::Result<void, core::Diagnostics>::success();
    }
    for (auto it = m_targeted.begin(); it != m_targeted.end();) {
        if (targeted_target(it->request) != target) {
            ++it;
            continue;
        }
        cancel_tween(targeted_common(it->request), it->tween);
        it = m_targeted.erase(it);
    }
    m_targeted.push_back({delivery.metadata, *targeted, *started.value_if()});
    publish_running(delivery.metadata);
    return core::Result<void, core::Diagnostics>::success();
}

void WorldTransitionBackend::advance(const core::RuntimeClockUpdate& clocks)
{
    m_gameplay_tweens.advance(clocks.gameplay_delta);
    m_unscaled_tweens.advance(clocks.unscaled_presentation_delta);

    if (m_active) {
        const auto sample = tween_sample(m_active->common, m_active->tween);
        if (!sample) {
            fail_active(failure("presentation.world_transition_tween_missing",
                                "World transition lost its backend-local interpolation track"));
        } else if (sample->completed) {
            const auto metadata = m_active->metadata;
            release_tween(m_active->common, m_active->tween);
            m_active.reset();
            m_render_state.reset();
            publish_completed(metadata);
        } else {
            update_render_state();
        }
    }

    for (auto it = m_targeted.begin(); it != m_targeted.end();) {
        const auto& common = targeted_common(it->request);
        const auto sample = tween_sample(common, it->tween);
        if (!sample) {
            const auto metadata = it->metadata;
            it = m_targeted.erase(it);
            m_acknowledgements.push_back(
                {metadata.operation, metadata.sequence, metadata.owner,
                 core::BackendOperationFailed{
                     core::PresentationFailureDomain::WorldPresentation,
                     failure("presentation.targeted_tween_missing",
                             "Targeted finite realization lost its backend-local interpolation "
                             "track")}});
        } else if (sample->completed) {
            const auto metadata = it->metadata;
            release_tween(common, it->tween);
            it = m_targeted.erase(it);
            publish_completed(metadata);
        } else {
            ++it;
        }
    }
}

void WorldTransitionBackend::snap_to_target(core::PresentationOperationRef operation)
{
    if (m_active && m_active->metadata.operation == operation) {
        cancel_tween(m_active->common, m_active->tween);
        m_active.reset();
        m_render_state.reset();
    }
    for (auto it = m_targeted.begin(); it != m_targeted.end();) {
        if (it->metadata.operation != operation) {
            ++it;
            continue;
        }
        cancel_tween(targeted_common(it->request), it->tween);
        it = m_targeted.erase(it);
    }
}

void WorldTransitionBackend::fail_active(core::Diagnostic diagnostic)
{
    if (!m_active)
        return;
    fail_operation(m_active->metadata.operation, std::move(diagnostic));
}

void WorldTransitionBackend::fail_operation(core::PresentationOperationRef operation,
                                            core::Diagnostic diagnostic)
{
    if (m_active && m_active->metadata.operation == operation) {
        const auto metadata = m_active->metadata;
        cancel_tween(m_active->common, m_active->tween);
        m_active.reset();
        m_render_state.reset();
        m_acknowledgements.push_back(
            {metadata.operation, metadata.sequence, metadata.owner,
             core::BackendOperationFailed{core::PresentationFailureDomain::WorldPresentation,
                                          std::move(diagnostic)}});
        return;
    }
    const auto found = std::find_if(m_targeted.begin(), m_targeted.end(), [&](const auto& value) {
        return value.metadata.operation == operation;
    });
    if (found == m_targeted.end())
        return;
    const auto metadata = found->metadata;
    cancel_tween(targeted_common(found->request), found->tween);
    m_targeted.erase(found);
    m_acknowledgements.push_back(
        {metadata.operation, metadata.sequence, metadata.owner,
         core::BackendOperationFailed{core::PresentationFailureDomain::WorldPresentation,
                                      std::move(diagnostic)}});
}

void WorldTransitionBackend::reset(core::PresentationCancellationReason reason)
{
    (void)reason;
    m_active.reset();
    m_targeted.clear();
    m_render_state.reset();
    m_acknowledgements.clear();
    m_gameplay_tweens.reset();
    m_unscaled_tweens.reset();
}

std::vector<core::BackendOperationAcknowledgement> WorldTransitionBackend::take_acknowledgements()
{
    auto result = std::move(m_acknowledgements);
    m_acknowledgements.clear();
    return result;
}

std::vector<TargetedPresentationRenderState> WorldTransitionBackend::targeted_render_states() const
{
    std::vector<TargetedPresentationRenderState> result;
    result.reserve(m_targeted.size());
    for (const auto& active : m_targeted) {
        const auto sample = tween_sample(targeted_common(active.request), active.tween);
        result.push_back(
            {active.metadata.operation, active.request, sample ? sample->value : 1.0f});
    }
    return result;
}

std::vector<LayoutTransitionRenderState> WorldTransitionBackend::layout_render_states() const
{
    std::vector<LayoutTransitionRenderState> result;
    for (const auto& active : m_targeted) {
        const auto* layout = std::get_if<core::LayoutFinitePresentationOperation>(&active.request);
        if (!layout)
            continue;
        const auto sample = tween_sample(layout->common, active.tween);
        result.push_back({active.metadata.operation, layout->target, layout->common.revisions,
                          sample ? sample->value : 1.0f});
    }
    return result;
}

std::vector<core::PresentationSnapshotRevision> WorldTransitionBackend::active_revisions() const
{
    std::vector<core::PresentationSnapshotRevision> result;
    const auto append = [&](core::PresentationSnapshotRevision revision) {
        if (std::find(result.begin(), result.end(), revision) == result.end())
            result.push_back(revision);
    };
    if (m_active) {
        append(m_active->common.revisions.source);
        append(m_active->common.revisions.target);
    }
    for (const auto& active : m_targeted) {
        const auto& common = targeted_common(active.request);
        append(common.revisions.source);
        append(common.revisions.target);
    }
    return result;
}

core::Result<QuadBatch, core::Diagnostics>
WorldTransitionBackend::compose_targeted_world_batch() const
{
    const auto* current = m_world.frame();
    if (!current)
        return core::Result<QuadBatch, core::Diagnostics>::success(QuadBatch{});

    std::vector<LayeredDraw> draws;
    draws.reserve(current->draws.size() + m_targeted.size() * 4);
    for (const auto& draw : current->draws) {
        if (draw.plane != core::PresentationPlane::GameUi)
            draws.push_back({draw, 1});
    }
    std::optional<QuadCommand> flash_overlay;

    for (const auto& active : m_targeted) {
        const auto sample = tween_sample(targeted_common(active.request), active.tween);
        const float progress = sample ? sample->value : 1.0f;
        const auto& common = targeted_common(active.request);
        const auto* source = m_world.frame(common.revisions.source);
        const auto* target = m_world.frame(common.revisions.target);
        if (!source || !target)
            return core::Result<QuadBatch, core::Diagnostics>::failure(
                {failure("presentation.targeted_revision_unavailable",
                         "Camera finite realization lost an exact retained revision")});

        if (std::holds_alternative<core::CameraPanOperation>(active.request) ||
            std::holds_alternative<core::CameraZoomOperation>(active.request) ||
            std::holds_alternative<core::CameraRotationOperation>(active.request)) {
            std::vector<LayeredDraw> interpolated;
            interpolated.reserve(target->draws.size());
            for (const auto& target_draw : target->draws) {
                if (target_draw.plane == core::PresentationPlane::GameUi)
                    continue;
                const auto source_draw = std::find_if(
                    source->draws.begin(), source->draws.end(), [&](const auto& candidate) {
                        return same_draw_identity(candidate, target_draw);
                    });
                if (source_draw == source->draws.end())
                    return core::Result<QuadBatch, core::Diagnostics>::failure({failure(
                        "presentation.camera_draw_identity_mismatch",
                        "Camera motion requires stable world draw identities across revisions")});
                LayeredDraw draw{target_draw, 1};
                draw.draw.command.rect =
                    interpolate_rect(source_draw->command.rect, target_draw.command.rect, progress);
                draw.draw.command.rotation_degrees =
                    interpolate_value(source_draw->command.rotation_degrees,
                                      target_draw.command.rotation_degrees, progress);
                draw.draw.command.rotation_origin = {
                    interpolate_value(source_draw->command.rotation_origin.x,
                                      target_draw.command.rotation_origin.x, progress),
                    interpolate_value(source_draw->command.rotation_origin.y,
                                      target_draw.command.rotation_origin.y, progress)};
                interpolated.push_back(std::move(draw));
            }
            draws = std::move(interpolated);
            continue;
        }

        const bool temporary_camera =
            std::holds_alternative<core::CameraFocusOperation>(active.request) ||
            std::holds_alternative<core::CameraShakeOperation>(active.request) ||
            std::holds_alternative<core::CameraPunchOperation>(active.request);
        if (temporary_camera) {
            if (!current->camera)
                return core::Result<QuadBatch, core::Diagnostics>::failure(
                    {failure("presentation.camera_revision_unavailable",
                             "Temporary camera emphasis requires a current Camera View")});
            core::PresentationCamera emphasized = *current->camera;
            const double envelope = std::sin(std::numbers::pi_v<double> * progress);
            if (const auto* focus = std::get_if<core::CameraFocusOperation>(&active.request)) {
                core::compiled::CameraView focus_view = current->camera->view;
                focus_view.center = {focus->capture.bounds.x + focus->capture.bounds.width * 0.5,
                                     focus->capture.bounds.y + focus->capture.bounds.height * 0.5};
                focus_view.zoom =
                    std::min(current->camera->space.size.x / focus->capture.bounds.width,
                             current->camera->space.size.y / focus->capture.bounds.height);
                emphasized.view = interpolate_camera_view(current->camera->view, focus_view,
                                                          static_cast<float>(envelope));
            } else if (const auto* shake =
                           std::get_if<core::CameraShakeOperation>(&active.request)) {
                const double duration_seconds =
                    std::chrono::duration<double>(shake->common.duration).count();
                const double phase = 2.0 * std::numbers::pi_v<double> * shake->frequency_hz *
                                     duration_seconds * progress;
                emphasized.view.center.x += shake->amplitude.x * std::sin(phase) * envelope;
                emphasized.view.center.y += shake->amplitude.y * std::cos(phase) * envelope;
            } else if (const auto* punch =
                           std::get_if<core::CameraPunchOperation>(&active.request)) {
                emphasized.view.center.x -= punch->translation.x * envelope;
                emphasized.view.center.y -= punch->translation.y * envelope;
                emphasized.view.zoom =
                    std::max(0.001, emphasized.view.zoom + punch->zoom_delta * envelope);
                emphasized.view.rotation_degrees += punch->rotation_degrees * envelope;
            }
            emphasized = clamp_camera(std::move(emphasized));
            for (auto& draw : draws)
                reframe_command(draw.draw.command, *current->camera, emphasized,
                                m_world.viewport());
            continue;
        }

        if (const auto* flash = std::get_if<core::CameraFlashOperation>(&active.request)) {
            const auto color = parse_color(flash->color);
            if (!color)
                return core::Result<QuadBatch, core::Diagnostics>::failure(
                    {failure("presentation.camera_flash_color_invalid",
                             "Camera flash color must be #RRGGBB or #RRGGBBAA")});
            QuadCommand command;
            command.rect = {0.0f, 0.0f, m_world.viewport().width, m_world.viewport().height};
            command.color = *color;
            command.color.a *= static_cast<float>(flash->opacity *
                                                  std::sin(std::numbers::pi_v<double> * progress));
            command.layer = GameLayer::Foreground;
            flash_overlay = std::move(command);
        }
    }

    for (const auto& active : m_targeted) {
        const auto sample = tween_sample(targeted_common(active.request), active.tween);
        const float progress = sample ? sample->value : 1.0f;
        if (std::holds_alternative<core::LayoutFinitePresentationOperation>(active.request) ||
            std::holds_alternative<core::CameraPanOperation>(active.request) ||
            std::holds_alternative<core::CameraZoomOperation>(active.request) ||
            std::holds_alternative<core::CameraRotationOperation>(active.request) ||
            std::holds_alternative<core::CameraFocusOperation>(active.request) ||
            std::holds_alternative<core::CameraShakeOperation>(active.request) ||
            std::holds_alternative<core::CameraPunchOperation>(active.request) ||
            std::holds_alternative<core::CameraFlashOperation>(active.request))
            continue;

        const auto& common = targeted_common(active.request);
        const auto* source = m_world.frame(common.revisions.source);
        const auto* target = m_world.frame(common.revisions.target);
        if (!source || !target) {
            return core::Result<QuadBatch, core::Diagnostics>::failure(
                {failure("presentation.targeted_revision_unavailable",
                         "Targeted finite realization lost an exact retained revision")});
        }

        if (std::get_if<core::BackgroundPresentationOperation>(&active.request)) {
            draws.erase(std::remove_if(draws.begin(), draws.end(),
                                       [](const auto& item) {
                                           return item.draw.family == WorldDrawFamily::Background;
                                       }),
                        draws.end());
            for (const auto& draw : source->draws)
                if (draw.family == WorldDrawFamily::Background)
                    append_with_opacity(draws, draw, 1.0f - progress, 0);
            for (const auto& draw : target->draws)
                if (draw.family == WorldDrawFamily::Background)
                    append_with_opacity(draws, draw, progress, 1);
            continue;
        }

        const auto* value = std::get_if<core::ActorPresentationOperation>(&active.request);
        if (!value)
            continue;
        const std::string identity = world_actor_identity(value->target.actor);
        draws.erase(std::remove_if(draws.begin(), draws.end(),
                                   [&](const auto& item) {
                                       return item.draw.family == WorldDrawFamily::Actor &&
                                              item.draw.stable_identity == identity;
                                   }),
                    draws.end());
        const auto source_draws = actor_draws(*source, value->target.actor);
        const auto target_draws = actor_draws(*target, value->target.actor);
        if (value->kind == core::ActorOperationKind::Fade) {
            for (const auto* draw : source_draws)
                append_with_opacity(draws, *draw, 1.0f - progress, 0);
            for (const auto* draw : target_draws)
                append_with_opacity(draws, *draw, progress, 1);
        } else if (!source_draws.empty() && !target_draws.empty()) {
            for (const auto* target_draw : target_draws) {
                const auto source_draw =
                    std::find_if(source_draws.begin(), source_draws.end(), [&](const auto* item) {
                        return item->sublayer == target_draw->sublayer;
                    });
                if (source_draw == source_draws.end()) {
                    return core::Result<QuadBatch, core::Diagnostics>::failure(
                        {failure("presentation.actor_slide_layers_mismatch",
                                 "Actor slide source and target visual layers do not match")});
                }
                LayeredDraw interpolated{*target_draw, 1};
                interpolated.draw.command.rect = interpolate_rect(
                    (*source_draw)->command.rect, target_draw->command.rect, progress);
                draws.push_back(std::move(interpolated));
            }
        } else if (!target_draws.empty()) {
            for (const auto* target_draw : target_draws) {
                LayeredDraw interpolated{*target_draw, 1};
                interpolated.draw.command.rect =
                    interpolate_rect(offscreen_rect(target_draw->command.rect, m_world.viewport()),
                                     target_draw->command.rect, progress);
                draws.push_back(std::move(interpolated));
            }
        } else {
            for (const auto* source_draw : source_draws) {
                LayeredDraw interpolated{*source_draw, 1};
                interpolated.draw.command.rect = interpolate_rect(
                    source_draw->command.rect,
                    offscreen_rect(source_draw->command.rect, m_world.viewport()), progress);
                draws.push_back(std::move(interpolated));
            }
        }
    }

    std::sort(draws.begin(), draws.end(), [](const auto& lhs, const auto& rhs) {
        return std::tie(lhs.draw.plane, lhs.draw.family, lhs.draw.order, lhs.draw.stable_identity,
                        lhs.blend_group, lhs.draw.sublayer) <
               std::tie(rhs.draw.plane, rhs.draw.family, rhs.draw.order, rhs.draw.stable_identity,
                        rhs.blend_group, rhs.draw.sublayer);
    });
    QuadBatch batch;
    for (const auto& item : draws)
        batch.draw(item.draw.command);
    if (flash_overlay)
        batch.draw(std::move(*flash_overlay));
    return core::Result<QuadBatch, core::Diagnostics>::success(std::move(batch));
}

void WorldTransitionBackend::publish_running(const core::PresentationOperationMetadata& metadata)
{
    m_acknowledgements.push_back(
        {metadata.operation, metadata.sequence, metadata.owner, core::BackendOperationRunning{}});
}

animation::TweenService&
WorldTransitionBackend::tween_service(core::LayoutClockDomain clock) noexcept
{
    return clock == core::LayoutClockDomain::Gameplay ? m_gameplay_tweens : m_unscaled_tweens;
}

const animation::TweenService&
WorldTransitionBackend::tween_service(core::LayoutClockDomain clock) const noexcept
{
    return clock == core::LayoutClockDomain::Gameplay ? m_gameplay_tweens : m_unscaled_tweens;
}

core::Result<animation::TweenHandle, core::Diagnostic>
WorldTransitionBackend::start_tween(const core::FinitePresentationOperationCommon& common)
{
    animation::TweenEasing easing = animation::TweenEasing::QuadraticInOut;
    switch (common.easing) {
    case core::PresentationEasing::Linear:
        easing = animation::TweenEasing::Linear;
        break;
    case core::PresentationEasing::EaseIn:
        easing = animation::TweenEasing::QuadraticIn;
        break;
    case core::PresentationEasing::EaseOut:
        easing = animation::TweenEasing::QuadraticOut;
        break;
    case core::PresentationEasing::EaseInOut:
        easing = animation::TweenEasing::QuadraticInOut;
        break;
    }
    return tween_service(common.clock)
        .start_scalar(
            {.from = 0.0f,
             .to = 1.0f,
             .duration = std::chrono::duration_cast<std::chrono::microseconds>(common.duration),
             .easing = easing});
}

std::optional<animation::ScalarTweenSample>
WorldTransitionBackend::tween_sample(const core::FinitePresentationOperationCommon& common,
                                     animation::TweenHandle handle) const noexcept
{
    return tween_service(common.clock).sample(handle);
}

void WorldTransitionBackend::cancel_tween(const core::FinitePresentationOperationCommon& common,
                                          animation::TweenHandle handle) noexcept
{
    (void)tween_service(common.clock).cancel(handle);
}

void WorldTransitionBackend::release_tween(const core::FinitePresentationOperationCommon& common,
                                           animation::TweenHandle handle) noexcept
{
    (void)tween_service(common.clock).release(handle);
}

void WorldTransitionBackend::publish_completed(const core::PresentationOperationMetadata& metadata)
{
    m_acknowledgements.push_back(
        {metadata.operation, metadata.sequence, metadata.owner, core::BackendOperationCompleted{}});
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
    m_render_state =
        WorldTransitionRenderState{m_active->metadata.operation,
                                   m_active->common.revisions.source,
                                   m_active->common.revisions.target,
                                   m_active->kind,
                                   m_active->color,
                                   tween_sample(m_active->common, m_active->tween)
                                       .value_or(animation::ScalarTweenSample{.value = 1.0f})
                                       .value};
}

} // namespace noveltea
