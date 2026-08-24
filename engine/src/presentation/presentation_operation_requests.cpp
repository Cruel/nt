#include "noveltea/presentation/presentation_operation_requests.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <type_traits>

namespace noveltea::core {
namespace {
Diagnostic diagnostic(std::string code, std::string message)
{
    return {.code = std::move(code), .message = std::move(message)};
}

bool gameplay_owner(const PresentationOwner& owner) noexcept
{
    return presentation_authority(owner) == PresentationAuthority::Gameplay;
}

template<class Value, class Key, class KeyOf>
void upsert(std::vector<Value>& values, Value value, const Key& key, KeyOf key_of)
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&](const Value& current) { return key_of(current) == key; });
    if (found == values.end())
        values.push_back(std::move(value));
    else
        *found = std::move(value);
}
} // namespace

FinitePresentationOperationTarget operation_target(const FinitePresentationOperation& operation)
{
    return std::visit(
        [](const auto& value) -> FinitePresentationOperationTarget {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneTransitionGroupOperation>)
                return WorldCompositionOperationTarget{};
            else if constexpr (std::is_same_v<T, RoomNavigationTransitionOperation>)
                return value.target;
            else if constexpr (std::is_same_v<T, BackgroundPresentationOperation>)
                return BackgroundOperationTarget{};
            else
                return value.target;
        },
        operation);
}

bool operation_skippable(const FinitePresentationOperation& operation) noexcept
{
    return std::visit([](const auto& value) { return value.common.skippable; }, operation);
}

Result<CameraFocusCapture, Diagnostics>
capture_camera_focus(const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
                     const CameraFocusSource& source)
{
    if (!snapshot.camera)
        return Result<CameraFocusCapture, Diagnostics>::failure(
            {diagnostic("presentation.camera_focus_unavailable",
                        "Focus capture requires an effective Camera View")});

    const auto world_bounds = [&](const compiled::NormalizedRect& bounds) {
        return compiled::WorldPresentationRect{bounds.x * snapshot.camera->space.size.x,
                                               bounds.y * snapshot.camera->space.size.y,
                                               bounds.width * snapshot.camera->space.size.x,
                                               bounds.height * snapshot.camera->space.size.y};
    };
    std::optional<compiled::NormalizedRect> captured;
    auto resolved = std::visit(
        [&](const auto& value) -> bool {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ActorPresentationKey>) {
                const auto actor = std::find_if(
                    snapshot.actors.begin(), snapshot.actors.end(),
                    [&](const PresentationActor& candidate) { return candidate.key == value; });
                if (actor != snapshot.actors.end() && actor->room_bounds)
                    captured = *actor->room_bounds;
                return captured.has_value();
            } else if constexpr (std::is_same_v<T, compiled::RoomPlacementRef>) {
                const auto actor = std::find_if(snapshot.actors.begin(), snapshot.actors.end(),
                                                [&](const PresentationActor& candidate) {
                                                    return candidate.room_placement == value &&
                                                           candidate.room_bounds.has_value();
                                                });
                if (actor != snapshot.actors.end())
                    captured = *actor->room_bounds;
                if (!captured) {
                    const auto interactable =
                        std::find_if(snapshot.interactables.begin(), snapshot.interactables.end(),
                                     [&](const PresentationInteractable& candidate) {
                                         return candidate.placement == value;
                                     });
                    if (interactable != snapshot.interactables.end())
                        captured = interactable->bounds;
                }
                if (!captured) {
                    const auto prop = std::find_if(snapshot.props.begin(), snapshot.props.end(),
                                                   [&](const PresentationProp& candidate) {
                                                       return candidate.placement == value;
                                                   });
                    if (prop != snapshot.props.end())
                        captured = prop->bounds;
                }
                return captured.has_value();
            } else {
                if (snapshot.current_room != value.room)
                    return false;
                const auto* room = project.find_room(value.room);
                if (!room)
                    return false;
                const auto anchor = std::find_if(
                    room->anchors.begin(), room->anchors.end(),
                    [&](const auto& candidate) { return candidate.id == value.anchor; });
                if (anchor != room->anchors.end())
                    captured = anchor->bounds;
                return captured.has_value();
            }
        },
        source);
    if (!resolved)
        return Result<CameraFocusCapture, Diagnostics>::failure({diagnostic(
            "presentation.camera_focus_source_unavailable",
            "Focus source is not a capturable occurrence or Anchor in the exact snapshot")});

    return Result<CameraFocusCapture, Diagnostics>::success(
        CameraFocusCapture{source, world_bounds(*captured)});
}

Result<CharacterGestureOperation, Diagnostics> make_character_gesture_operation(
    const CompiledProject& project, const RuntimePresentationSnapshot& snapshot,
    const ActorPresentationKey& actor, const CharacterGestureId& gesture,
    PresentationOperationId operation, std::optional<PresentationFlowCompletion> completion,
    bool skippable)
{
    const auto actor_state =
        std::ranges::find_if(snapshot.actors, [&](const PresentationActor& candidate) {
            return candidate.key == actor;
        });
    if (actor_state == snapshot.actors.end() || !actor_state->enabled || !actor_state->visible)
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_actor_unavailable",
                        "Character Gesture requires a visible Actor occurrence")});
    const auto* character = project.find_character(actor_state->character);
    if (character == nullptr)
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_character_missing",
                        "Character Gesture Actor references a missing Character")});
    const auto gesture_definition = std::ranges::find_if(
        character->gestures, [&](const auto& candidate) { return candidate.id == gesture; });
    if (gesture_definition == character->gestures.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_missing", "Character Gesture is missing")});
    const auto gesture_profile =
        std::ranges::find_if(gesture_definition->profiles, [&](const auto& candidate) {
            return candidate.profile_id == actor_state->profile;
        });
    if (gesture_profile == gesture_definition->profiles.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_profile_missing",
                        "Character Gesture has no mapping for the Actor presentation Profile")});
    const auto profile = std::ranges::find_if(character->profiles, [&](const auto& candidate) {
        return candidate.id == actor_state->profile;
    });
    if (profile == character->profiles.end())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_profile_missing",
                        "Character Gesture Actor presentation Profile is missing")});
    const auto clip = std::ranges::find_if(profile->animation_clips, [&](const auto& candidate) {
        return candidate.id == gesture_profile->clip_id;
    });
    if (clip == profile->animation_clips.end() || clip->frames.empty())
        return Result<CharacterGestureOperation, Diagnostics>::failure(
            {diagnostic("presentation.character_gesture_clip_missing",
                        "Character Gesture animation clip is missing or empty")});
    std::uint64_t duration_ms = 0;
    for (const auto& frame : clip->frames) {
        if (frame.duration_ms >
            static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) - duration_ms)
            return Result<CharacterGestureOperation, Diagnostics>::failure(
                {diagnostic("presentation.character_gesture_duration_overflow",
                            "Character Gesture animation duration is too large")});
        duration_ms += frame.duration_ms;
    }
    return Result<CharacterGestureOperation, Diagnostics>::success(CharacterGestureOperation{
        {.id = operation,
         .duration = std::chrono::milliseconds{static_cast<std::int64_t>(duration_ms)},
         .skippable = skippable,
         .clock = clip->clock,
         .revisions = {snapshot.revision, snapshot.revision},
         .easing = PresentationEasing::Linear},
        {actor},
        actor_state->character,
        gesture,
        gesture_profile->clip_id,
        gesture_profile->cues,
        std::move(completion)});
}

Result<PresentationTargetDraft, Diagnostics>
build_transition_group_target(const PresentationTargetDraft& source,
                              const std::vector<TransitionGroupTargetMutation>& mutations)
{
    if (mutations.empty())
        return Result<PresentationTargetDraft, Diagnostics>::failure(
            {diagnostic("presentation.empty_transition_group",
                        "TransitionGroup target construction requires at least one mutation")});

    PresentationTargetDraft target = source;
    for (const auto& mutation : mutations) {
        auto applied = std::visit(
            [&](const auto& value) -> Result<void, Diagnostics> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, TransitionGroupUpsertBackgroundTarget>) {
                    if (!gameplay_owner(value.value.owner))
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_owner",
                            "TransitionGroup background mutations require gameplay authority")});
                    upsert(target.background_overrides, value.value, value.value.owner,
                           [](const DesiredBackgroundOverride& current) { return current.owner; });
                } else if constexpr (std::is_same_v<T, TransitionGroupClearBackgroundTarget>) {
                    if (!gameplay_owner(value.owner))
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_owner",
                            "TransitionGroup background mutations require gameplay authority")});
                    std::erase_if(target.background_overrides,
                                  [&](const DesiredBackgroundOverride& current) {
                                      return current.owner == value.owner;
                                  });
                } else if constexpr (std::is_same_v<T, TransitionGroupUpsertCameraTarget>) {
                    if (!gameplay_owner(value.value.owner) ||
                        !std::isfinite(value.value.view.center.x) ||
                        !std::isfinite(value.value.view.center.y) ||
                        !std::isfinite(value.value.view.zoom) || value.value.view.zoom <= 0.0 ||
                        !std::isfinite(value.value.view.rotation_degrees))
                        return Result<void, Diagnostics>::failure(
                            {diagnostic("presentation.invalid_transition_group_camera",
                                        "TransitionGroup Camera View targets require gameplay "
                                        "authority and finite logical framing")});
                    upsert(target.camera_views, value.value, value.value.owner,
                           [](const DesiredCameraView& current) { return current.owner; });
                } else if constexpr (std::is_same_v<T, TransitionGroupClearCameraTarget>) {
                    if (!gameplay_owner(value.owner))
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_owner",
                            "TransitionGroup Camera View mutations require gameplay authority")});
                    std::erase_if(target.camera_views, [&](const DesiredCameraView& current) {
                        return current.owner == value.owner;
                    });
                } else if constexpr (std::is_same_v<T, TransitionGroupUpsertActorTarget>) {
                    if (!gameplay_owner(value.value.owner) ||
                        !std::isfinite(value.value.placement.offset.x) ||
                        !std::isfinite(value.value.placement.offset.y) ||
                        !std::isfinite(value.value.placement.scale) ||
                        value.value.placement.scale <= 0.0 || !value.value.presentation_complete)
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_actor",
                            "TransitionGroup actor targets require gameplay authority, finite "
                            "placement, and a durable completed target")});
                    upsert(target.actors, value.value, value.value.key,
                           [](const DesiredActorPresentation& current) { return current.key; });
                } else if constexpr (std::is_same_v<T, TransitionGroupRemoveActorTarget>) {
                    if (!gameplay_owner(value.owner))
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_owner",
                            "TransitionGroup actor mutations require gameplay authority")});
                    std::erase_if(target.actors, [&](const DesiredActorPresentation& current) {
                        return current.key == value.key && current.owner == value.owner;
                    });
                } else if constexpr (std::is_same_v<T, TransitionGroupUpsertLayoutTarget>) {
                    if (!gameplay_owner(value.value.owner) ||
                        value.value.policy.plane != PresentationPlane::WorldOverlay ||
                        value.value.composition_group != PresentationCompositionGroup::World)
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.excluded_transition_group_plane",
                            "TransitionGroup Layout targets require gameplay-owned WorldOverlay "
                            "participation")});
                    upsert(target.layouts, value.value, value.value.key,
                           [](const DesiredMountedLayout& current) { return current.key; });
                } else {
                    if (!gameplay_owner(value.owner))
                        return Result<void, Diagnostics>::failure({diagnostic(
                            "presentation.invalid_transition_group_owner",
                            "TransitionGroup Layout mutations require gameplay authority")});
                    std::erase_if(target.layouts, [&](const DesiredMountedLayout& current) {
                        return current.key == value.key && current.owner == value.owner;
                    });
                }
                return Result<void, Diagnostics>::success();
            },
            mutation);
        if (!applied)
            return Result<PresentationTargetDraft, Diagnostics>::failure(applied.error());
    }
    return Result<PresentationTargetDraft, Diagnostics>::success(std::move(target));
}

} // namespace noveltea::core
