#include "noveltea/presentation/room_presentation.hpp"

#include "noveltea/runtime/runtime_capabilities.hpp"

#include <algorithm>
#include <tuple>

namespace noveltea::core {
namespace {

Diagnostics preparation_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

Diagnostics error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

const compiled::RoomPlacement* find_placement(const compiled::RoomDefinition& room,
                                              const RoomPlacementId& id)
{
    const auto found =
        std::find_if(room.placements.begin(), room.placements.end(),
                     [&id](const compiled::RoomPlacement& value) { return value.id == id; });
    return found == room.placements.end() ? nullptr : &*found;
}

bool located_at(const compiled::RoomPlacementRef& location, const RoomVisitContext& visit) noexcept
{
    return location.room == visit.room;
}

} // namespace

Result<PreparedRoomNavigationTarget, Diagnostics> prepare_room_navigation_target(
    const CompiledProject& project, const SessionState& settled_state,
    const RoomNavigationPreparationInput& input, RoomPresentationConditionEvaluator evaluate,
    RoomPresentationTextResolver resolve_text, RoomCompositionCallback* composition)
{
    if (input.owner.number() == 0)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.invalid_owner", "Room navigation preparation requires a Flow owner"));
    if (input.target_visit_index == 0)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.invalid_visit", "Prepared Room visit index must be non-zero"));
    const auto* target = project.find_room(input.target_room);
    if (target == nullptr)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.missing_target", "Prepared Room navigation target is missing"));

    const compiled::RoomDefinition* source = nullptr;
    if (input.source_room) {
        source = project.find_room(*input.source_room);
        if (source == nullptr)
            return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
                "room_navigation.missing_source", "Prepared Room navigation source is missing"));
    }

    const compiled::RoomExit* selected = nullptr;
    if (input.selected_exit) {
        if (!input.source_room || input.selected_exit->room != *input.source_room)
            return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(
                preparation_error("room_navigation.invalid_exit_owner",
                                  "Selected Room exit does not belong to the navigation source"));
        const auto found = std::find_if(source->exits.begin(), source->exits.end(),
                                        [&](const compiled::RoomExit& candidate) {
                                            return candidate.id == input.selected_exit->exit_id;
                                        });
        if (found == source->exits.end() || found->target != input.target_room)
            return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
                "room_navigation.invalid_exit",
                "Selected Room exit is missing or does not target the prepared Room"));
        selected = &*found;
    }

    RoomVisitContext target_visit{input.target_room, input.source_room, input.selected_exit,
                                  input.target_visit_index};
    RoomPresentationResolver resolver;
    auto resolution = resolver.resolve(project, settled_state, target_visit, std::move(evaluate),
                                       std::move(resolve_text), composition);
    if (!resolution)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(resolution.error());
    auto* resolved = resolution.value_if();
    assert(resolved != nullptr);

    const compiled::RoomNavigationTransition policy =
        input.explicit_transition ? *input.explicit_transition
        : selected != nullptr && selected->transition
            ? *selected->transition
            : project.settings().room_navigation_transition;
    std::optional<RoomVisitContext> source_visit;
    if (settled_state.room_visit() && input.source_room &&
        settled_state.room_visit()->room == *input.source_room)
        source_visit = *settled_state.room_visit();

    return Result<PreparedRoomNavigationTarget, Diagnostics>::success(PreparedRoomNavigationTarget{
        std::move(*resolved), PreparedRoomNavigationTransition{input.owner, std::move(source_visit),
                                                               std::move(target_visit), policy}});
}

Result<RoomPresentationResolution, Diagnostics> RoomPresentationResolver::resolve(
    const CompiledProject& project, const SessionState& state, const RoomVisitContext& visit,
    RoomPresentationConditionEvaluator evaluate, RoomPresentationTextResolver resolve_text,
    RoomCompositionCallback* composition) const
{
    const auto* room = project.find_room(visit.room);
    if (room == nullptr || visit.visit_index == 0)
        return Result<RoomPresentationResolution, Diagnostics>::failure(error(
            "room_resolution.invalid_visit", "Room resolution requires a valid active visit"));

    RoomPresentationDraft draft{.background = room->background,
                                .actors = {},
                                .interactables = {},
                                .props = {},
                                .environments = {},
                                .overlays = {}};
    for (const auto& overlay : room->overlays) {
        auto enabled = evaluate(overlay.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if()) {
            const MountedLayoutPresentationKey mount_key =
                RoomOverlayLayoutMountKey{visit.room, overlay.id};
            const auto state_overlay = std::find_if(
                state.mounted_layouts().begin(), state.mounted_layouts().end(),
                [&mount_key](const DesiredMountedLayout& candidate) {
                    return candidate.key == mount_key && presentation_authority(candidate.owner) ==
                                                             PresentationAuthority::Gameplay;
                });
            draft.overlays.push_back(
                {overlay.id, overlay.layout,
                 state_overlay == state.mounted_layouts().end()
                     ? overlay.visible
                     : state_overlay->policy.visibility == LayoutVisibility::Visible});
        }
    }

    for (const auto& character : state.character_world()) {
        const auto* location = std::get_if<compiled::RoomPlacementRef>(&character.location);
        const auto* definition = project.find_character(character.character);
        if (location == nullptr || !located_at(*location, visit) || definition == nullptr)
            continue;
        if (find_placement(*room, location->placement_id) == nullptr)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_character_placement",
                      "Character world state references a missing Room placement"));
        draft.actors.push_back({PersistentCharacterPresentationId{character.character},
                                character.character, location->placement_id,
                                definition->defaults.pose_id, definition->defaults.expression_id,
                                definition->defaults.idle_id, character.enabled, character.visible,
                                0});
    }
    for (const auto& interactable : state.interactables()) {
        const auto* location = std::get_if<compiled::RoomPlacementRef>(&interactable.location);
        if (location == nullptr || !located_at(*location, visit))
            continue;
        if (find_placement(*room, location->placement_id) == nullptr)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_interactable_placement",
                      "Interactable state references a missing Room placement"));
        draft.interactables.push_back({interactable.interactable, location->placement_id,
                                       interactable.enabled, interactable.visible});
    }
    for (const auto& cast : room->cast) {
        auto enabled = evaluate(cast.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (!*enabled.value_if())
            continue;
        const auto* character = project.find_character(cast.character);
        if (character == nullptr || find_placement(*room, cast.placement_id) == nullptr)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_cast", "Room cast entry cannot be resolved"));
        draft.actors.push_back({RoomCastPresentationId{room->identity.id, cast.id}, cast.character,
                                cast.placement_id,
                                cast.pose_id.value_or(character->defaults.pose_id),
                                cast.expression_id.value_or(character->defaults.expression_id),
                                cast.idle_id ? cast.idle_id : character->defaults.idle_id, true,
                                cast.visible, cast.order});
    }
    for (const auto& prop : room->props) {
        auto enabled = evaluate(prop.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if())
            draft.props.push_back(
                {prop.id, prop.placement_id, prop.asset, prop.material, prop.visible, prop.order});
    }
    for (const auto& environment : room->environments) {
        auto enabled = evaluate(environment.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if())
            draft.environments.push_back({environment.id, environment.asset, environment.material,
                                          environment.bounds, environment.plane, environment.order,
                                          environment.clock, environment.scroll_per_second,
                                          environment.opacity, environment.visible});
    }
    if (room->compose) {
        if (composition == nullptr)
            return Result<RoomPresentationResolution, Diagnostics>::failure(error(
                "room_resolution.composition_unavailable",
                "Room defines a composition hook but no restricted composition callback is bound"));
        auto composed = composition->compose(*room->compose, visit, draft);
        if (!composed)
            return Result<RoomPresentationResolution, Diagnostics>::failure(composed.error());
    }

    for (std::size_t index = 0; index < draft.actors.size(); ++index) {
        if (std::find_if(draft.actors.begin() + static_cast<std::ptrdiff_t>(index + 1),
                         draft.actors.end(), [&draft, index](const ResolvedRoomActor& candidate) {
                             return candidate.id == draft.actors[index].id;
                         }) != draft.actors.end())
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.duplicate_actor_identity",
                      "Room composition produced duplicate actor presentation identities"));
    }
    for (std::size_t index = 0; index < draft.props.size(); ++index) {
        if (std::find_if(draft.props.begin() + static_cast<std::ptrdiff_t>(index + 1),
                         draft.props.end(), [&draft, index](const ResolvedRoomProp& candidate) {
                             return candidate.prop == draft.props[index].prop;
                         }) != draft.props.end())
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.duplicate_prop_identity",
                      "Room composition produced duplicate prop presentation identities"));
    }
    for (std::size_t index = 0; index < draft.environments.size(); ++index) {
        if (std::find_if(draft.environments.begin() + static_cast<std::ptrdiff_t>(index + 1),
                         draft.environments.end(),
                         [&draft, index](const ResolvedRoomEnvironment& candidate) {
                             return candidate.environment == draft.environments[index].environment;
                         }) != draft.environments.end())
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.duplicate_environment_identity",
                      "Room composition produced duplicate environment presentation identities"));
    }

    std::sort(draft.actors.begin(), draft.actors.end(), [](const auto& left, const auto& right) {
        return std::tie(left.order, left.character, left.placement) <
               std::tie(right.order, right.character, right.placement);
    });
    std::sort(
        draft.interactables.begin(), draft.interactables.end(),
        [](const auto& left, const auto& right) { return left.interactable < right.interactable; });
    std::sort(draft.props.begin(), draft.props.end(), [](const auto& left, const auto& right) {
        return std::tie(left.order, left.prop) < std::tie(right.order, right.prop);
    });
    std::sort(draft.environments.begin(), draft.environments.end(),
              [](const auto& left, const auto& right) {
                  return std::tie(left.plane, left.order, left.environment) <
                         std::tie(right.plane, right.order, right.environment);
              });

    auto description = resolve_text(room->description.source);
    if (!description)
        return Result<RoomPresentationResolution, Diagnostics>::failure(description.error());
    RoomView view{.room = room->identity.id,
                  .visits = visit.visit_index,
                  .description = std::move(*description.value_if()),
                  .description_markup = room->description.markup,
                  .background = draft.background,
                  .overlays = draft.overlays,
                  .placements = {},
                  .exits = {},
                  .controls = {}};
    for (const auto& placement : room->placements) {
        RoomPlacementView item{.placement = placement.id,
                               .bounds = placement.bounds,
                               .label = std::nullopt,
                               .label_markup = TextMarkup::Plain,
                               .layout = placement.presentation.layout,
                               .order = placement.order,
                               .occupants = {}};
        if (placement.presentation.label) {
            auto label = resolve_text(placement.presentation.label->source);
            if (!label)
                return Result<RoomPresentationResolution, Diagnostics>::failure(label.error());
            item.label = std::move(*label.value_if());
            item.label_markup = placement.presentation.label->markup;
        }
        for (const auto& actor : draft.actors) {
            if (actor.placement == placement.id)
                item.occupants.push_back({compiled::CharacterInteractionSubject{actor.character},
                                          actor.enabled, actor.visible});
        }
        for (const auto& interactable : draft.interactables) {
            if (interactable.placement == placement.id)
                item.occupants.push_back(
                    {compiled::InteractableInteractionSubject{interactable.interactable},
                     interactable.enabled, interactable.visible});
        }
        view.placements.push_back(std::move(item));
    }
    for (const auto& exit : room->exits) {
        auto label = resolve_text(exit.label.source);
        auto enabled = evaluate(exit.condition);
        if (!label || !enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                !label ? label.error() : enabled.error());
        view.exits.push_back(RoomExitView{exit.id, exit.target, exit.direction,
                                          std::move(*label.value_if()), *enabled.value_if()});
    }

    std::vector<compiled::InteractionSubject> subjects;
    for (const auto& actor : draft.actors) {
        if (!actor.enabled || !actor.visible)
            continue;
        const compiled::InteractionSubject subject =
            compiled::CharacterInteractionSubject{actor.character};
        if (std::find(subjects.begin(), subjects.end(), subject) == subjects.end())
            subjects.push_back(subject);
    }
    for (const auto& interactable : draft.interactables) {
        if (!interactable.enabled || !interactable.visible)
            continue;
        const compiled::InteractionSubject subject =
            compiled::InteractableInteractionSubject{interactable.interactable};
        if (std::find(subjects.begin(), subjects.end(), subject) == subjects.end())
            subjects.push_back(subject);
    }

    ResolvedRoomPresentation presentation{visit,
                                          draft.background,
                                          std::move(draft.actors),
                                          std::move(draft.interactables),
                                          std::move(draft.props),
                                          std::move(draft.environments),
                                          std::move(draft.overlays)};
    return Result<RoomPresentationResolution, Diagnostics>::success(
        {std::move(presentation), std::move(view), std::move(subjects)});
}

} // namespace noveltea::core
