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
    if (input.target_entry_sequence == 0 || input.target_visit_index == 0)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(
            preparation_error("room_navigation.invalid_visit",
                              "Prepared Room entry sequence and visit index must be non-zero"));
    const auto* target = world.resolved_configuration(input.target_room);
    if (target == nullptr)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(preparation_error(
            "room_navigation.missing_target", "Prepared Room navigation target is missing"));

    const compiled::RoomDefinition* source = nullptr;
    if (input.source_room) {
        source = world.resolved_configuration(*input.source_room);
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

    RoomVisitContext target_visit{input.target_room,           input.source_room,
                                  input.selected_exit,         input.entry_cause,
                                  input.target_entry_sequence, input.target_visit_index};
    RoomPresentationResolver resolver;
    auto resolution = resolver.resolve(project, world, settled_state, target_visit,
                                       std::move(evaluate), std::move(resolve_text), composition);
    if (!resolution)
        return Result<PreparedRoomNavigationTarget, Diagnostics>::failure(resolution.error());
    auto* resolved = resolution.value_if();
    assert(resolved != nullptr);

    const compiled::RoomNavigationTransition policy =
        input.explicit_transition                     ? *input.explicit_transition
        : selected != nullptr && selected->transition ? *selected->transition
        : input.entry_cause == RoomEntryCause::Entrypoint
            ? compiled::RoomNavigationTransition{compiled::TransitionKind::Cut, 0, std::nullopt,
                                                 true}
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
    RoomPresentationTextResolver resolve_text, RoomCompositionCallback* composition,
    RoomPresentationResolveMode mode) const
{
    const auto* room = world.resolved_configuration(visit.room);
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
        .interactables = {},
        .props = {},
        .environments = {},
        .placements = {},
        .exits = {},
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
        const auto* character = world.resolved_configuration(character_state.character);
        if (character != nullptr) {
            const auto profile =
                std::ranges::find_if(character->profiles, [&](const auto& candidate) {
                    return candidate.id == character->defaults.profile_id;
                });
            if (profile == character->profiles.end())
                continue;
            definition.character_defaults.push_back(
                {character->identity.id, character->defaults.profile_id, profile->default_pose_id,
                 character->defaults.expression_id, character->defaults.appearance_id,
                 character->defaults.idle_id});
        }
    }
    for (const auto& overlay : room->overlays)
        definition.overlays.push_back({overlay.id, overlay.layout,
                                       condition_token(overlay.condition), overlay.visible,
                                       overlay.order});
    for (const auto& cast : room->cast)
        definition.cast.push_back({cast.id, cast.character, condition_token(cast.condition),
                                   cast.placement_id, cast.profile_id, cast.pose_id,
                                   cast.expression_id, cast.appearance_id, cast.idle_id,
                                   cast.visible, cast.order});
    for (const auto& interactable : room->interactables)
        definition.interactables.push_back(
            {interactable.id, interactable.interactable, condition_token(interactable.condition),
             interactable.placement_id, interactable.visible, interactable.order});
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
        const auto* location = std::get_if<compiled::RoomLocation>(&character.location);
        if (mode == RoomPresentationResolveMode::StagedScene ||
            (location != nullptr && location->room == visit.room))
            state_view.characters.push_back(
                {character.character, character.enabled, character.visible});
    }
    for (const auto& interactable : state.interactables()) {
        const auto* location = std::get_if<compiled::RoomLocation>(&interactable.location);
        if (mode == RoomPresentationResolveMode::StagedScene ||
            (location != nullptr && location->room == visit.room))
            state_view.interactables.push_back(
                {interactable.interactable, interactable.enabled, interactable.visible});
    }
    if (mode == RoomPresentationResolveMode::ActiveVisit)
        for (const auto& overlay : room->overlays) {
            const MountedLayoutPresentationKey mount_key =
                RoomOverlayLayoutMountKey{visit.room, overlay.id};
            const auto mounted = std::find_if(
                state.mounted_layouts().begin(), state.mounted_layouts().end(),
                [&mount_key](const DesiredMountedLayout& candidate) {
                    return candidate.key == mount_key && presentation_authority(candidate.owner) ==
                                                             PresentationAuthority::Gameplay;
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
        mode == RoomPresentationResolveMode::StagedScene ? nullptr : composition);
    if (!resolved)
        return resolved;

    auto& resolution = *resolved.value_if();
    auto& presentation = resolution.presentation;
    if (mode == RoomPresentationResolveMode::StagedScene) {
        // A staged Room is a visual composition template, not an active exploration context.
        // Keep its resolved visual occurrences but expose no semantic subjects or input hotspots.
        resolution.eligible_subjects.clear();
        presentation.hotspots.clear();
        return resolved;
    }
    const auto append_subject = [&](compiled::InteractionSubject subject) {
        if (std::find(resolution.eligible_subjects.begin(), resolution.eligible_subjects.end(),
                      subject) == resolution.eligible_subjects.end())
            resolution.eligible_subjects.push_back(std::move(subject));
    };
    for (const auto& feature : room->features)
        append_subject(compiled::FeatureInteractionSubject{
            RoomFeatureRef{room->identity.id, feature.identity.id}});
    for (const auto& stack : state.item_stacks()) {
        if (world.effective_room(stack.id) == visit.room)
            append_subject(compiled::ItemStackInteractionSubject{stack.id});
    }
    for (const auto& interactable : presentation.interactables) {
        const compiled::InteractionSubject owner =
            compiled::InteractableInteractionSubject{interactable.interactable};
        if (std::find(resolution.eligible_subjects.begin(), resolution.eligible_subjects.end(),
                      owner) == resolution.eligible_subjects.end())
            continue;
        const auto* definition = world.resolved_configuration(interactable.interactable);
        if (definition == nullptr)
            continue;
        for (const auto& feature : definition->features)
            append_subject(compiled::FeatureInteractionSubject{
                InteractableFeatureRef{interactable.interactable, feature.identity.id}});
    }

    const auto subject_available = [&](const compiled::InteractionSubject& subject) {
        return std::find(resolution.eligible_subjects.begin(), resolution.eligible_subjects.end(),
                         subject) != resolution.eligible_subjects.end();
    };
    const auto subject_label =
        [&](const compiled::InteractionSubject& subject) -> Result<std::string, Diagnostics> {
        return std::visit(
            [&](const auto& value) -> Result<std::string, Diagnostics> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>) {
                    const auto* definition = world.resolved_configuration(value.character);
                    if (definition != nullptr)
                        return Result<std::string, Diagnostics>::success(definition->display_name);
                } else if constexpr (std::is_same_v<T, compiled::InteractableInteractionSubject>) {
                    const auto* definition = world.resolved_configuration(value.interactable);
                    if (definition != nullptr)
                        return Result<std::string, Diagnostics>::success(definition->display_name);
                } else if constexpr (std::is_same_v<T, compiled::ItemStackInteractionSubject>) {
                    const auto* stack = world.item_stack(value.item_stack);
                    const auto* definition = stack != nullptr
                                                 ? project.find_item_definition(stack->definition)
                                                 : nullptr;
                    if (definition != nullptr)
                        return Result<std::string, Diagnostics>::success(definition->display_name);
                } else {
                    const auto* definition = std::visit(
                        [&](const auto& reference) -> const compiled::FeatureDefinition* {
                            using R = std::decay_t<decltype(reference)>;
                            if constexpr (std::is_same_v<R, RoomFeatureRef>) {
                                const auto* owner = world.resolved_configuration(reference.room);
                                if (owner == nullptr)
                                    return nullptr;
                                const auto found = std::find_if(
                                    owner->features.begin(), owner->features.end(),
                                    [&](const auto& feature) {
                                        return feature.identity.id == reference.feature_id;
                                    });
                                return found == owner->features.end() ? nullptr : &*found;
                            } else {
                                const auto* owner =
                                    world.resolved_configuration(reference.interactable);
                                if (owner == nullptr)
                                    return nullptr;
                                const auto found = std::find_if(
                                    owner->features.begin(), owner->features.end(),
                                    [&](const auto& feature) {
                                        return feature.identity.id == reference.feature_id;
                                    });
                                return found == owner->features.end() ? nullptr : &*found;
                            }
                        },
                        value.feature);
                    if (definition != nullptr)
                        return Result<std::string, Diagnostics>::success(definition->label);
                }
                return Result<std::string, Diagnostics>::failure(
                    error("room_resolution.hotspot_target_missing",
                          "Hotspot target references a missing semantic subject"));
            },
            subject);
    };
    const auto resolved_target =
        [&](const compiled::RoomHotspotTarget& target) -> compiled::ResolvedHotspotTarget {
        return std::visit(
            [&](const auto& value) -> compiled::ResolvedHotspotTarget {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, compiled::HotspotOwnerFeatureTarget>)
                    return compiled::InteractionSubject{compiled::FeatureInteractionSubject{
                        RoomFeatureRef{room->identity.id, value.feature_id}}};
                else if constexpr (std::is_same_v<T, compiled::HotspotSubjectTarget>)
                    return value.subject;
                else
                    return compiled::RoomExitRef{room->identity.id, value.exit_id};
            },
            target);
    };
    const auto target_availability =
        [&](const compiled::ResolvedHotspotTarget& target) -> Result<bool, Diagnostics> {
        if (const auto* subject = std::get_if<compiled::InteractionSubject>(&target))
            return Result<bool, Diagnostics>::success(subject_available(*subject));
        const auto& exit = std::get<compiled::RoomExitRef>(target);
        const auto found = std::find_if(
            resolution.view.exits.begin(), resolution.view.exits.end(),
            [&](const RoomExitView& candidate) { return candidate.exit == exit.exit_id; });
        if (found == resolution.view.exits.end())
            return Result<bool, Diagnostics>::failure(
                error("room_resolution.hotspot_exit_missing",
                      "Hotspot target references a missing Room exit"));
        return Result<bool, Diagnostics>::success(found->enabled);
    };
    const auto target_label =
        [&](const compiled::ResolvedHotspotTarget& target) -> Result<std::string, Diagnostics> {
        if (const auto* subject = std::get_if<compiled::InteractionSubject>(&target))
            return subject_label(*subject);
        const auto& exit = std::get<compiled::RoomExitRef>(target);
        const auto found = std::find_if(
            resolution.view.exits.begin(), resolution.view.exits.end(),
            [&](const RoomExitView& candidate) { return candidate.exit == exit.exit_id; });
        if (found == resolution.view.exits.end())
            return Result<std::string, Diagnostics>::failure(
                error("room_resolution.hotspot_exit_missing",
                      "Hotspot target references a missing Room exit"));
        return Result<std::string, Diagnostics>::success(found->label);
    };

    for (const auto& hotspot : room->hotspots) {
        auto condition = evaluate(hotspot.condition);
        auto target = resolved_target(hotspot.target);
        auto available = target_availability(target);
        auto label = target_label(target);
        if (!condition || !available || !label)
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                !condition   ? condition.error()
                : !available ? available.error()
                             : label.error());
        presentation.hotspots.push_back(
            {.ref = compiled::RoomHotspotRef{room->identity.id, hotspot.id},
             .label = std::move(*label.value_if()),
             .condition_eligible = *condition.value_if(),
             .target_available = *available.value_if(),
             .target = std::move(target),
             .shape = hotspot.shape,
             .input_order = hotspot.input_order,
             .highlight = hotspot.highlight,
             .interactable_placement = std::nullopt,
             .interactable_bounds = std::nullopt,
             .owner_plane = PresentationPlane::WorldBackground,
             .owner_order = 0});
    }
    for (const auto& interactable : presentation.interactables) {
        const auto* definition = world.resolved_configuration(interactable.interactable);
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
            if (!condition)
                return Result<void, Diagnostics>::failure(condition.error());
            auto target = std::visit(
                [&](const auto& value) -> compiled::ResolvedHotspotTarget {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, compiled::HotspotOwnerTarget>)
                        return compiled::InteractionSubject{
                            compiled::InteractableInteractionSubject{interactable.interactable}};
                    else if constexpr (std::is_same_v<T, compiled::HotspotOwnerFeatureTarget>)
                        return compiled::InteractionSubject{compiled::FeatureInteractionSubject{
                            InteractableFeatureRef{interactable.interactable, value.feature_id}}};
                    else
                        return value.subject;
                },
                hotspot.target);
            auto available = target_availability(target);
            auto label = target_label(target);
            if (!available || !label)
                return Result<void, Diagnostics>::failure(!available ? available.error()
                                                                     : label.error());
            presentation.hotspots.push_back(
                {.ref = compiled::InteractableHotspotRef{interactable.interactable, hotspot.id},
                 .label = std::move(*label.value_if()),
                 .condition_eligible = *condition.value_if(),
                 .target_available = *available.value_if(),
                 .target = std::move(target),
                 .shape = std::move(shape),
                 .input_order = hotspot.input_order,
                 .highlight = hotspot.highlight,
                 .interactable_placement =
                     compiled::RoomPlacementRef{visit.room, interactable.placement},
                 .interactable_bounds = placement->bounds,
                 .owner_plane = PresentationPlane::WorldContent,
                 .owner_order = placement->order});
            return Result<void, Diagnostics>::success();
        };
        if (const auto* alpha =
                std::get_if<compiled::SpriteAlphaHotspots>(&definition->presentation.hotspots)) {
            auto added = append(alpha->hotspot, std::monostate{});
            if (!added)
                return Result<RoomPresentationResolution, Diagnostics>::failure(added.error());
        } else if (const auto* custom = std::get_if<compiled::CustomInteractableHotspots>(
                       &definition->presentation.hotspots)) {
            for (const auto& hotspot : custom->hotspots) {
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
    RoomPresentationTextTokenResolver resolve_text, RoomCompositionCallback* composition) const
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

    for (const auto& cast : room.cast) {
        auto enabled = evaluate(cast.condition);
        if (!enabled)
            return Result<RoomPresentationResolution, Diagnostics>::failure(enabled.error());
        if (!*enabled.value_if())
            continue;
        const auto character_state =
            std::find_if(state.characters.begin(), state.characters.end(),
                         [&cast](const RoomPresentationStateView::Character& candidate) {
                             return candidate.character == cast.character;
                         });
        if (character_state == state.characters.end())
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
        draft.actors.push_back({RoomCastPresentationId{room.room, cast.id}, cast.character,
                                cast.placement, cast.profile.value_or(character->profile),
                                cast.pose.value_or(character->pose),
                                cast.expression.value_or(character->expression),
                                cast.appearance ? cast.appearance : character->appearance,
                                cast.idle ? cast.idle : character->idle, character_state->enabled,
                                character_state->visible && cast.visible, cast.order});
    }
    for (const auto& occurrence : room.interactables) {
        auto condition = evaluate(occurrence.condition);
        if (!condition)
            return Result<RoomPresentationResolution, Diagnostics>::failure(condition.error());
        if (!*condition.value_if())
            continue;
        const auto state_interactable =
            std::find_if(state.interactables.begin(), state.interactables.end(),
                         [&occurrence](const RoomPresentationStateView::Interactable& candidate) {
                             return candidate.interactable == occurrence.interactable;
                         });
        if (state_interactable == state.interactables.end())
            continue;
        if (std::none_of(room.placements.begin(), room.placements.end(),
                         [&occurrence](const RoomPresentationDefinitionView::Placement& placement) {
                             return placement.id == occurrence.placement;
                         }))
            return Result<RoomPresentationResolution, Diagnostics>::failure(
                error("room_resolution.invalid_interactable_occurrence",
                      "Interactable occurrence references a missing Room placement"));
        draft.interactables.push_back({occurrence.id, occurrence.interactable, occurrence.placement,
                                       state_interactable->enabled,
                                       state_interactable->visible && occurrence.visible});
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
    if (composition != nullptr) {
        auto composed = composition->compose(visit, draft);
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
                  .item_stacks = {},
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
