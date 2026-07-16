#include "noveltea/core/presentation_operation_requests.hpp"

#include <algorithm>
#include <cmath>
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
