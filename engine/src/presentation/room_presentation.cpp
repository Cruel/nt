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

bool located_at(const compiled::RoomPlacementRef& location, const RoomVisitContext& visit) noexcept
{
    return location.room == visit.room;
}

} // namespace

Result<PreparedRoomNavigationTarget, Diagnostics> prepare_room_navigation_target(
    const CompiledProject& project, const runtime::RuntimeWorld& world,
    const SessionState& settled_state, const RoomNavigationPreparationInput& input,
    RoomPresentationConditionEvaluator evaluate, RoomPresentationTextResolver resolve_text,
    RoomCompositionCallback* composition)
{
    if (input.owner.number() == 0)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.invalid_owner", "Room navigation preparation requires a Flow owner"));
    if (input.target_visit_index == 0)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.invalid_visit", "Prepared Room visit index must be non-zero"));
    const auto* target = world.room(input.target_room);
    if (target == nullptr)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.missing_target", "Prepared Room navigation target is missing"));

    const compiled::RoomDefinition* source = nullptr;
    if (input.source_room) {
        source = world.room(*input.source_room);
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
    auto resolution = resolver.resolve(project, world, settled_state, target_visit,
                                       std::move(evaluate), std::move(resolve_text), composition);
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
    const CompiledProject& project, const runtime::RuntimeWorld& world, const SessionState& state,
    const RoomVisitContext& visit, RoomPresentationConditionEvaluator evaluate,
    RoomPresentationTextResolver resolve_text, RoomCompositionCallback* composition) const
{
    const auto* room = world.room(visit.room);
    if (room == nullptr || visit.visit_index == 0)
        return Result<RoomPresentationResolution, Diagnostics>::failure(error(
            "room_resolution.invalid_visit", "Room resolution requires a valid active visit"));

    RoomPresentationDefinitionView definition{
        .room = room->identity.id,
        .background = room->background,
        .description = 0,
        .description_markup = room->description.markup,
        .character_defaults = {},
        .overlays = {},
        .cast = {},
        .props = {},
        .environments = {},
        .placements = {},
        .exits = {},
        .has_composition = room->compose.has_value(),
    };

    std::vector<const Condition*> conditions;
    std::vector<const TextSource*> texts{&room->description.source};
    const auto condition_token = [&](const Condition& condition) {
        conditions.push_back(&condition);
        return conditions.size() - 1;
    };
    const auto text_token = [&](const TextSource& text) {
        texts.push_back(&text);
        return texts.size() - 1;
    };

    for (const auto& character_state : state.character_world()) {
        const auto* character = world.character(character_state.character);
        if (character != nullptr)
            definition.character_defaults.push_back(
                {character->identity.id, character->defaults.pose_id,
                 character->defaults.expression_id, character->defaults.idle_id});
    }
    for (const auto& overlay : room->overlays)
        definition.overlays.push_back({overlay.id, overlay.layout,
                                       condition_token(overlay.condition), overlay.visible,
                                       overlay.order});
    for (const auto& cast : room->cast)
        definition.cast.push_back({cast.id, cast.character, condition_token(cast.condition),
                                   cast.placement_id, cast.pose_id, cast.expression_id,
                                   cast.idle_id, cast.visible, cast.order});
    for (const auto& prop : room->props)
        definition.props.push_back({prop.id, condition_token(prop.condition), prop.placement_id,
                                    prop.asset, prop.material, prop.visible, prop.order});
    for (const auto& environment : room->environments)
        definition.environments.push_back({environment.id, condition_token(environment.condition),
                                           environment.asset, environment.material,
                                           environment.bounds, environment.plane, environment.order,
                                           environment.clock, environment.scroll_per_second,
                                           environment.opacity, environment.visible});
    for (const auto& placement : room->placements) {
        std::optional<RoomPresentationTextToken> label;
        TextMarkup markup = TextMarkup::Plain;
        if (placement.presentation.label) {
            label = text_token(placement.presentation.label->source);
            markup = placement.presentation.label->markup;
        }
        definition.placements.push_back({placement.id, placement.bounds, label, markup,
                                         placement.presentation.layout, placement.order});
    }
    for (const auto& exit : room->exits)
        definition.exits.push_back({exit.id, condition_token(exit.condition), exit.direction,
                                    text_token(exit.label.source), exit.target});

    RoomPresentationStateView state_view;
    for (const auto& character : state.character_world()) {
        const auto* location = std::get_if<compiled::RoomPlacementRef>(&character.location);
        if (location != nullptr && located_at(*location, visit))
            state_view.characters.push_back({character.character, location->placement_id,
                                             character.enabled, character.visible});
    }
    for (const auto& interactable : state.interactables()) {
        const auto* location = std::get_if<compiled::RoomPlacementRef>(&interactable.location);
        if (location != nullptr && located_at(*location, visit))
            state_view.interactables.push_back({interactable.interactable, location->placement_id,
                                                interactable.enabled, interactable.visible});
    }
    for (const auto& overlay : room->overlays) {
        const MountedLayoutPresentationKey mount_key =
            RoomOverlayLayoutMountKey{visit.room, overlay.id};
        const auto mounted = std::find_if(
            state.mounted_layouts().begin(), state.mounted_layouts().end(),
            [&mount_key](const DesiredMountedLayout& candidate) {
                return candidate.key == mount_key &&
                       presentation_authority(candidate.owner) == PresentationAuthority::Gameplay;
            });
        if (mounted != state.mounted_layouts().end())
            state_view.overlay_visibility.push_back(
                {overlay.id, mounted->policy.visibility == LayoutVisibility::Visible});
    }

    RoomPresentationResolverCore core;
    auto resolved = core.resolve(
        definition, state_view, visit,
        [evaluate, conditions](RoomPresentationConditionToken token) {
            if (token >= conditions.size())
                return Result<bool, Diagnostics>::failure(
                    error("room_resolution.invalid_condition_token",
                          "Room condition token is outside the definition view"));
            return evaluate(*conditions[token]);
        },
        [resolve_text = std::move(resolve_text), texts](RoomPresentationTextToken token) {
            if (token >= texts.size())
                return Result<std::string, Diagnostics>::failure(
                    error("room_resolution.invalid_text_token",
                          "Room text token is outside the definition view"));
            return resolve_text(*texts[token]);
        },
        composition, room->compose ? &*room->compose : nullptr);
    if (!resolved)
        return resolved;

    auto& presentation = resolved.value_if()->presentation;
    const auto activation_available =
        [&](const compiled::RoomHotspotActivation& activation) -> Result<bool, Diagnostics> {
        if (const auto* verb = std::get_if<compiled::VerbHotspotActivation>(&activation)) {
            const auto* definition = project.find_verb(verb->verb);
            if (definition == nullptr)
                return Result<bool, Diagnostics>::failure(
                    error("room_resolution.hotspot_verb_missing",
                          "Hotspot activation references a missing Verb"));
            return evaluate(definition->availability);
        }
        const auto& exit = std::get<compiled::RoomExitHotspotActivation>(activation);
        const auto found = std::find_if(
            resolved.value_if()->view.exits.begin(), resolved.value_if()->view.exits.end(),
            [&](const RoomExitView& candidate) { return candidate.exit == exit.exit_id; });
        if (found == resolved.value_if()->view.exits.end())
            return Result<bool, Diagnostics>::failure(
                error("room_resolution.hotspot_exit_missing",
                      "Hotspot activation references a missing Room exit"));
        return Result<bool, Diagnostics>::success(found->enabled);
    };
    for (const auto& hotspot : room->hotspots) {
        auto condition = evaluate(hotspot.condition);
        auto available = activation_available(hotspot.activation);
        if (!condition || !available)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                !condition ? condition.error() : available.error());
        presentation.hotspots.push_back({compiled::RoomHotspotRef{room->identity.id, hotspot.id},
                                         hotspot.label, *condition.value_if(),
                                         *available.value_if(), hotspot.activation, hotspot.shape,
                                         hotspot.input_order, hotspot.highlight, std::nullopt,
                                         std::nullopt, PresentationPlane::WorldBackground, 0});
    }
    for (const auto& interactable : presentation.interactables) {
        const auto* definition = world.interactable(interactable.interactable);
        if (definition == nullptr || !definition->presentation.sprite)
            continue;
        const auto placement = std::find_if(
            room->placements.begin(), room->placements.end(),
            [&](const auto& candidate) { return candidate.id == interactable.placement; });
        if (placement == room->placements.end())
            continue;
        const auto append = [&](const compiled::InteractableHotspotBehavior& hotspot,
                                std::variant<std::monostate, compiled::RectHotspotShape> shape)
            -> Result<void, Diagnostics> {
            auto condition = evaluate(hotspot.condition);
            const auto* verb = project.find_verb(hotspot.activation.verb);
            if (!condition || verb == nullptr)
                return Result<void, Diagnostics>::failure(
                    !condition ? condition.error()
                               : error("room_resolution.hotspot_verb_missing",
                                       "Hotspot activation references a missing Verb"));
            auto available = evaluate(verb->availability);
            if (!available)
                return Result<void, Diagnostics>::failure(available.error());
            presentation.hotspots.push_back(
                {compiled::InteractableHotspotRef{interactable.interactable, hotspot.id},
                 hotspot.label, *condition.value_if(), *available.value_if(), hotspot.activation,
                 std::move(shape), hotspot.input_order, hotspot.highlight,
                 compiled::RoomPlacementRef{visit.room, interactable.placement}, placement->bounds,
                 PresentationPlane::WorldContent, placement->order});
            return Result<void, Diagnostics>::success();
        };
        if (const auto* alpha =
                std::get_if<compiled::SpriteAlphaHotspots>(&definition->presentation.hotspots)) {
            auto added = append(alpha->hotspot, std::monostate{});
            if (!added)
                return Result<RoomPresentationResolution, Diagnostics>::failure(added.error());
        } else {
            for (const auto& hotspot :
                 std::get<compiled::CustomInteractableHotspots>(definition->presentation.hotspots)
                     .hotspots) {
                auto added = append(hotspot, hotspot.shape);
                if (!added)
                    return Result<RoomPresentationResolution, Diagnostics>::failure(added.error());
            }
        }
    }
    return resolved;
}

Result<RoomPresentationResolution, Diagnostics> RoomPresentationResolverCore::resolve(
    const RoomPresentationDefinitionView& room, const RoomPresentationStateView& state,
    const RoomVisitContext& visit, RoomPresentationConditionTokenEvaluator evaluate,
    RoomPresentationTextTokenResolver resolve_text, RoomCompositionCallback* composition,
    const compiled::RoomCompositionHook* composition_hook) const
{
    if (visit.room != room.room || visit.visit_index == 0)
        return Result<RoomPresentationResolution, Diagnostics>::failure(error(
            "room_resolution.invalid_visit", "Room resolution requires a valid active visit"));

    RoomPresentationDraft draft{.background = room.background,
                                .actors = {},
                                .interactables = {},
                                .props = {},
                                .environments = {},
                                .overlays = {}};
    for (const auto& overlay : room.overlays) {
        auto enabled = evaluate(overlay.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if()) {
            const auto state_overlay = std::find_if(
                state.overlay_visibility.begin(), state.overlay_visibility.end(),
                [&overlay](const RoomPresentationStateView::OverlayVisibility& candidate) {
                    return candidate.overlay == overlay.id;
                });
            draft.overlays.push_back({overlay.id, overlay.layout,
                                      state_overlay == state.overlay_visibility.end()
                                          ? overlay.visible
                                          : state_overlay->visible});
        }
    }

    for (const auto& character : state.characters) {
        const auto definition = std::find_if(
            room.character_defaults.begin(), room.character_defaults.end(),
            [&character](const RoomPresentationDefinitionView::CharacterDefaults& candidate) {
                return candidate.character == character.character;
            });
        if (definition == room.character_defaults.end())
            continue;
        if (std::none_of(room.placements.begin(), room.placements.end(),
                         [&character](const RoomPresentationDefinitionView::Placement& placement) {
                             return placement.id == character.placement;
                         }))
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_character_placement",
                      "Character world state references a missing Room placement"));
        draft.actors.push_back({PersistentCharacterPresentationId{character.character},
                                character.character, character.placement, definition->pose,
                                definition->expression, definition->idle, character.enabled,
                                character.visible, 0});
    }
    for (const auto& interactable : state.interactables) {
        if (std::none_of(
                room.placements.begin(), room.placements.end(),
                [&interactable](const RoomPresentationDefinitionView::Placement& placement) {
                    return placement.id == interactable.placement;
                }))
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_interactable_placement",
                      "Interactable state references a missing Room placement"));
        draft.interactables.push_back({interactable.interactable, interactable.placement,
                                       interactable.enabled, interactable.visible});
    }
    for (const auto& cast : room.cast) {
        auto enabled = evaluate(cast.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (!*enabled.value_if())
            continue;
        const auto character = std::find_if(
            room.character_defaults.begin(), room.character_defaults.end(),
            [&cast](const RoomPresentationDefinitionView::CharacterDefaults& candidate) {
                return candidate.character == cast.character;
            });
        if (character == room.character_defaults.end() ||
            std::none_of(room.placements.begin(), room.placements.end(),
                         [&cast](const RoomPresentationDefinitionView::Placement& placement) {
                             return placement.id == cast.placement;
                         }))
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_cast", "Room cast entry cannot be resolved"));
        draft.actors.push_back(
            {RoomCastPresentationId{room.room, cast.id}, cast.character, cast.placement,
             cast.pose.value_or(character->pose), cast.expression.value_or(character->expression),
             cast.idle ? cast.idle : character->idle, true, cast.visible, cast.order});
    }
    for (const auto& prop : room.props) {
        auto enabled = evaluate(prop.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if())
            draft.props.push_back(
                {prop.id, prop.placement, prop.asset, prop.material, prop.visible, prop.order});
    }
    for (const auto& environment : room.environments) {
        auto enabled = evaluate(environment.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (*enabled.value_if())
            draft.environments.push_back({environment.id, environment.asset, environment.material,
                                          environment.bounds, environment.plane, environment.order,
                                          environment.clock, environment.scroll_per_second,
                                          environment.opacity, environment.visible});
    }
    if (room.has_composition) {
        if (composition == nullptr || composition_hook == nullptr)
            return Result<RoomPresentationResolution, Diagnostics>::failure(error(
                "room_resolution.composition_unavailable",
                "Room defines a composition hook but no restricted composition callback is bound"));
        auto composed = composition->compose(*composition_hook, visit, draft);
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

    auto description = resolve_text(room.description);
    if (!description)
        return Result<RoomPresentationResolution, Diagnostics>::failure(description.error());
    RoomView view{.room = room.room,
                  .visits = visit.visit_index,
                  .description = std::move(*description.value_if()),
                  .description_markup = room.description_markup,
                  .background = draft.background,
                  .overlays = draft.overlays,
                  .placements = {},
                  .exits = {},
                  .controls = {}};
    for (const auto& placement : room.placements) {
        RoomPlacementView item{.placement = placement.id,
                               .bounds = placement.bounds,
                               .label = std::nullopt,
                               .label_markup = TextMarkup::Plain,
                               .layout = placement.layout,
                               .order = placement.order,
                               .occupants = {}};
        if (placement.label) {
            auto label = resolve_text(*placement.label);
            if (!label)
                return Result<RoomPresentationResolution, Diagnostics>::failure(label.error());
            item.label = std::move(*label.value_if());
            item.label_markup = placement.label_markup;
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
    for (const auto& exit : room.exits) {
        auto label = resolve_text(exit.label);
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
                                          std::move(draft.overlays),
                                          {}};
    return Result<RoomPresentationResolution, Diagnostics>::success(
        {std::move(presentation), std::move(view), std::move(subjects)});
}

} // namespace noveltea::core
