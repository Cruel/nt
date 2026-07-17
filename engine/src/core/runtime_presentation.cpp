#include "noveltea/core/runtime_presentation.hpp"

#include "noveltea/core/room_presentation.hpp"
#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <tuple>
#include <type_traits>

namespace noveltea::core {
namespace {
Diagnostic unresolved(std::string family, const std::string& id)
{
    return Diagnostic{.code = "presentation.unresolved_reference",
                      .message = "Unresolved " + std::move(family) + " reference: " + id};
}

Diagnostic invalid(std::string code, std::string message)
{
    return Diagnostic{.code = std::move(code), .message = std::move(message)};
}

void validate_asset(const CompiledProject& project, const std::optional<AssetId>& asset,
                    compiled::AssetKind expected_kind, std::string family, Diagnostics& diagnostics)
{
    if (!asset)
        return;
    const auto* definition = project.find_asset(*asset);
    if (definition == nullptr || definition->kind != expected_kind)
        diagnostics.push_back(unresolved(std::move(family), asset->text()));
}

const compiled::RoomPlacement* find_placement(const CompiledProject& project,
                                              const compiled::RoomPlacementRef& ref) noexcept
{
    const auto* room = project.find_room(ref.room);
    if (room == nullptr)
        return nullptr;
    const auto found =
        std::find_if(room->placements.begin(), room->placements.end(),
                     [&ref](const auto& value) { return value.id == ref.placement_id; });
    return found == room->placements.end() ? nullptr : &*found;
}

void validate_text_and_choice(const CompiledProject& project, const SessionState& state,
                              Diagnostics& diagnostics)
{
    if (state.presented_text() && state.presented_text()->speaker &&
        project.find_character(*state.presented_text()->speaker) == nullptr)
        diagnostics.push_back(
            unresolved("presented-text speaker", state.presented_text()->speaker->text()));

    if (!state.active_choice())
        return;
    std::visit(
        [&](const auto& choice) {
            using T = std::decay_t<decltype(choice)>;
            if constexpr (std::is_same_v<T, SceneChoiceState>) {
                const auto* scene = project.find_scene(choice.scene);
                if (scene == nullptr) {
                    diagnostics.push_back(unresolved("choice Scene", choice.scene.text()));
                    return;
                }
                const auto instruction =
                    std::find_if(scene->program.instructions.begin(),
                                 scene->program.instructions.end(), [&](const auto& value) {
                                     const auto* item =
                                         std::get_if<compiled::ChoiceSceneInstruction>(&value);
                                     return item != nullptr && item->id == choice.step;
                                 });
                if (instruction == scene->program.instructions.end())
                    diagnostics.push_back(unresolved("choice Scene step", choice.step.text()));
            } else {
                const auto* dialogue = project.find_dialogue(choice.dialogue);
                if (dialogue == nullptr) {
                    diagnostics.push_back(unresolved("choice Dialogue", choice.dialogue.text()));
                    return;
                }
                const bool block_exists =
                    std::any_of(dialogue->program.blocks.begin(), dialogue->program.blocks.end(),
                                [&](const auto& value) {
                                    const auto* item =
                                        std::get_if<compiled::DialogueChoiceBlock>(&value);
                                    return item != nullptr && item->id == choice.block;
                                });
                if (!block_exists)
                    diagnostics.push_back(unresolved("choice Dialogue block", choice.block.text()));
            }
        },
        *state.active_choice());
}

PresentationRuntimeMode mode_of(const RuntimeMode& mode)
{
    if (std::holds_alternative<RoomMode>(mode))
        return PresentationRuntimeMode::Room;
    if (std::holds_alternative<EndedMode>(mode))
        return PresentationRuntimeMode::Ended;
    return PresentationRuntimeMode::Flow;
}

std::optional<std::size_t> scene_owner_depth(const SessionState& state,
                                             const ScenePresentationOwner& owner) noexcept
{
    for (std::size_t index = 0; index < state.flow_stack().size(); ++index) {
        const auto* frame = std::get_if<SceneFrame>(&state.flow_stack()[index]);
        if (frame != nullptr && frame->frame_id == owner.invocation && frame->scene == owner.scene)
            return index;
    }
    return std::nullopt;
}

std::optional<std::uint64_t> background_precedence(const SessionState& state,
                                                   const PresentationOwner& owner) noexcept
{
    return std::visit(
        [&state](const auto& value) -> std::optional<std::uint64_t> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ScenePresentationOwner>) {
                const auto depth = scene_owner_depth(state, value);
                return depth ? std::optional<std::uint64_t>{400 + *depth} : std::nullopt;
            } else if constexpr (std::is_same_v<T, CurrentRoomPresentationOwner>) {
                return state.presentation_owner_is_active(PresentationOwner{value})
                           ? std::optional<std::uint64_t>{300}
                           : std::nullopt;
            } else if constexpr (std::is_same_v<T, RoomPresentationOwner>) {
                return state.presentation_owner_is_active(PresentationOwner{value})
                           ? std::optional<std::uint64_t>{200}
                           : std::nullopt;
            } else if constexpr (std::is_same_v<T, SessionPresentationOwner>) {
                return state.presentation_owner_is_active(PresentationOwner{value})
                           ? std::optional<std::uint64_t>{100}
                           : std::nullopt;
            } else {
                return std::nullopt;
            }
        },
        owner);
}

std::optional<compiled::BackgroundPresentation>
effective_background(const SessionState& state, const ResolvedRoomPresentation* room)
{
    std::optional<compiled::BackgroundPresentation> result;
    if (room != nullptr)
        result = room->background;
    std::uint64_t selected_precedence = 0;
    for (const auto& override : state.background_overrides()) {
        const auto precedence = background_precedence(state, override.owner);
        if (precedence && *precedence > selected_precedence) {
            selected_precedence = *precedence;
            result = override.background;
        }
    }
    return result;
}

void validate_actor_key(const CompiledProject& project, const ActorPresentationKey& key,
                        Diagnostics& diagnostics)
{
    std::visit(
        [&project, &diagnostics](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                if (project.find_room(value.room) == nullptr)
                    diagnostics.push_back(unresolved("actor Room", value.room.text()));
            } else if constexpr (std::is_same_v<T, SceneActorKey>) {
                if (project.find_scene(value.owner.scene) == nullptr)
                    diagnostics.push_back(unresolved("actor Scene", value.owner.scene.text()));
            }
        },
        key);
}

std::int32_t actor_order(const CompiledProject& project, const ActorPresentationKey& key) noexcept
{
    const auto* scene_key = std::get_if<SceneActorKey>(&key);
    if (scene_key == nullptr)
        return 0;
    const auto* scene = project.find_scene(scene_key->owner.scene);
    if (scene == nullptr)
        return 0;
    for (std::size_t index = 0; index < scene->program.instructions.size(); ++index) {
        const auto* cue =
            std::get_if<compiled::ActorCueInstruction>(&scene->program.instructions[index]);
        if (cue != nullptr && cue->slot_id == scene_key->slot) {
            return index > static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max())
                       ? std::numeric_limits<std::int32_t>::max()
                       : static_cast<std::int32_t>(index);
        }
    }
    return 0;
}

bool valid_layout_policy(const MountedLayoutPolicy& policy) noexcept
{
    return policy.plane <= PresentationPlane::Debug &&
           policy.clock <= LayoutClockDomain::UnscaledPresentation &&
           policy.input <= LayoutInputMode::Modal &&
           policy.gameplay_pause <= GameplayPausePolicy::PauseWhileVisible &&
           policy.visibility <= LayoutVisibility::Visible &&
           policy.escape_dismissal <= EscapeDismissalPolicy::Dismiss &&
           !policy.entrance_operation && !policy.exit_operation;
}

struct ActorSource {
    ActorPresentationKey key;
    CharacterId character;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    ActorLogicalPlacement placement;
    std::optional<compiled::RoomPlacementRef> room_placement;
    std::optional<compiled::NormalizedRect> room_bounds;
    std::int32_t order = 0;
    bool enabled = true;
    bool visible = true;
    bool presentation_complete = true;
    bool desired_override = false;
};

void append_actor(const CompiledProject& project, const ActorSource& actor,
                  RuntimePresentationSnapshot& result, Diagnostics& diagnostics)
{
    validate_actor_key(project, actor.key, diagnostics);
    const auto* character = project.find_character(actor.character);
    if (character == nullptr) {
        diagnostics.push_back(unresolved("Character", actor.character.text()));
        return;
    }
    const auto expression =
        std::find_if(character->expressions.begin(), character->expressions.end(),
                     [&](const auto& value) { return value.id == actor.expression; });
    if (expression == character->expressions.end()) {
        diagnostics.push_back(unresolved("Character expression", actor.expression.text()));
        return;
    }
    const CharacterPoseId resolved_pose = expression->pose_id.value_or(actor.pose);
    const auto pose = std::find_if(character->poses.begin(), character->poses.end(),
                                   [&](const auto& value) { return value.id == resolved_pose; });
    if (pose == character->poses.end()) {
        diagnostics.push_back(unresolved("Character pose", resolved_pose.text()));
        return;
    }
    validate_asset(project, pose->sprite, compiled::AssetKind::Image, "Character pose sprite",
                   diagnostics);
    validate_asset(project, expression->sprite, compiled::AssetKind::Image,
                   "Character expression sprite", diagnostics);
    result.actors.push_back(PresentationActor{
        actor.key, actor.character, resolved_pose, actor.expression, pose->sprite, pose->material,
        pose->anchor, pose->offset, pose->scale, expression->sprite, expression->material,
        actor.placement, actor.room_placement, actor.room_bounds, PresentationPlane::WorldContent,
        actor.order, actor.enabled, actor.visible, actor.presentation_complete});
}

void append_room_baseline(const CompiledProject& project, const ResolvedRoomPresentation& room,
                          std::vector<ActorSource>& actors, RuntimePresentationSnapshot& result,
                          Diagnostics& diagnostics)
{
    for (const auto& actor : room.actors) {
        const ActorPresentationKey key = std::visit(
            [](const auto& value) -> ActorPresentationKey {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, PersistentCharacterPresentationId>)
                    return CharacterActorKey{value.character};
                else
                    return RoomCastActorKey{value.room, value.entry};
            },
            actor.id);
        const compiled::RoomPlacementRef placement{room.visit.room, actor.placement};
        const auto* definition = find_placement(project, placement);
        if (definition == nullptr) {
            diagnostics.push_back(unresolved("actor Room placement", actor.placement.text()));
            continue;
        }
        actors.push_back(ActorSource{key,
                                     actor.character,
                                     actor.pose,
                                     actor.expression,
                                     {},
                                     placement,
                                     definition->bounds,
                                     actor.order,
                                     actor.enabled,
                                     actor.visible,
                                     true,
                                     false});
    }

    for (const auto& interactable : room.interactables) {
        const auto* definition = project.find_interactable(interactable.interactable);
        const compiled::RoomPlacementRef placement{room.visit.room, interactable.placement};
        const auto* placement_definition = find_placement(project, placement);
        if (definition == nullptr) {
            diagnostics.push_back(unresolved("Interactable", interactable.interactable.text()));
            continue;
        }
        if (placement_definition == nullptr) {
            diagnostics.push_back(
                unresolved("Interactable Room placement", interactable.placement.text()));
            continue;
        }
        validate_asset(project, definition->presentation.sprite, compiled::AssetKind::Image,
                       "Interactable sprite", diagnostics);
        result.interactables.push_back(PresentationInteractable{
            interactable.interactable, placement, placement_definition->bounds,
            definition->presentation.sprite, definition->presentation.material,
            PresentationPlane::WorldContent, placement_definition->order, interactable.enabled,
            interactable.visible});
    }

    for (const auto& prop : room.props) {
        const compiled::RoomPlacementRef placement{room.visit.room, prop.placement};
        const auto* placement_definition = find_placement(project, placement);
        if (placement_definition == nullptr) {
            diagnostics.push_back(unresolved("Room prop placement", prop.placement.text()));
            continue;
        }
        validate_asset(project, prop.asset, compiled::AssetKind::Image, "Room prop asset",
                       diagnostics);
        result.props.push_back(
            PresentationProp{RoomPropPresentationKey{room.visit.room, prop.prop},
                             RoomPresentationOwner{room.visit.room}, prop.asset, prop.material,
                             placement, placement_definition->bounds,
                             PresentationPlane::WorldContent, prop.order, prop.visible});
    }
}

template<class Value, class Key, class KeyOf>
bool duplicate_key(const std::vector<Value>& values, const Key& key, KeyOf key_of)
{
    return std::any_of(values.begin(), values.end(),
                       [&](const Value& value) { return key_of(value) == key; });
}

void canonicalize(RuntimePresentationSnapshot& result)
{
    std::sort(result.actors.begin(), result.actors.end(), [](const auto& a, const auto& b) {
        return std::tie(a.plane, a.order, a.key) < std::tie(b.plane, b.order, b.key);
    });
    std::sort(result.interactables.begin(), result.interactables.end(),
              [](const auto& a, const auto& b) {
                  return std::tie(a.plane, a.order, a.interactable) <
                         std::tie(b.plane, b.order, b.interactable);
              });
    std::sort(result.props.begin(), result.props.end(), [](const auto& a, const auto& b) {
        return std::tie(a.plane, a.order, a.key) < std::tie(b.plane, b.order, b.key);
    });
    std::sort(
        result.environments.begin(), result.environments.end(), [](const auto& a, const auto& b) {
            return std::tie(a.plane, a.order, a.instance) < std::tie(b.plane, b.order, b.instance);
        });
    std::sort(result.layouts.begin(), result.layouts.end(), [](const auto& a, const auto& b) {
        return std::tie(a.policy.plane, a.policy.local_order, a.key) <
               std::tie(b.policy.plane, b.policy.local_order, b.key);
    });
    std::sort(result.audio_channels.begin(), result.audio_channels.end(),
              [](const auto& a, const auto& b) { return a.channel < b.channel; });
}
} // namespace

Result<RuntimePresentationSnapshot, Diagnostics>
PresentationProjector::project(const CompiledProject& project, const SessionState& state,
                               const ResolvedRoomPresentation* room_presentation)
{
    RuntimePresentationSnapshot result;
    Diagnostics diagnostics;
    result.mode = mode_of(state.mode());

    if (state.room_visit()) {
        result.current_room = state.room_visit()->room;
        if (room_presentation == nullptr || room_presentation->visit != *state.room_visit())
            diagnostics.push_back(
                invalid("presentation.room_resolution_unavailable",
                        "Effective presentation requires the resolved active Room presentation"));
    } else if (room_presentation != nullptr) {
        diagnostics.push_back(invalid("presentation.stale_room_resolution",
                                      "Room presentation exists without an active Room visit"));
    }

    const auto background = effective_background(state, room_presentation);
    if (background) {
        validate_asset(project, background->asset, compiled::AssetKind::Image,
                       "background image asset", diagnostics);
        result.background = PresentationBackground{background->asset, background->color,
                                                   background->fit, background->material};
    }

    std::vector<ActorSource> actors;
    if (room_presentation != nullptr)
        append_room_baseline(project, *room_presentation, actors, result, diagnostics);

    for (const auto& desired : state.actors()) {
        if (!state.presentation_owner_is_active(desired.owner))
            continue;
        auto existing = std::find_if(actors.begin(), actors.end(), [&](const ActorSource& value) {
            return value.key == desired.key;
        });
        if (existing != actors.end()) {
            if (existing->desired_override) {
                diagnostics.push_back(
                    invalid("presentation.duplicate_actor_identity",
                            "Multiple active desired actor records share one stable identity"));
                continue;
            }
            existing->character = desired.character;
            existing->pose = desired.pose;
            existing->expression = desired.expression;
            existing->placement = desired.placement;
            existing->visible = desired.visible;
            existing->presentation_complete = desired.presentation_complete;
            existing->desired_override = true;
            continue;
        }
        if (std::holds_alternative<CharacterActorKey>(desired.key) ||
            std::holds_alternative<RoomCastActorKey>(desired.key))
            continue;
        actors.push_back(ActorSource{desired.key, desired.character, desired.pose,
                                     desired.expression, desired.placement, std::nullopt,
                                     std::nullopt, actor_order(project, desired.key), true,
                                     desired.visible, desired.presentation_complete, true});
    }
    for (const auto& actor : actors)
        append_actor(project, actor, result, diagnostics);

    for (const auto& desired : state.presentation_props()) {
        if (!state.presentation_owner_is_active(desired.owner))
            continue;
        if (desired.placement &&
            (!result.current_room || desired.placement->room != *result.current_room))
            continue;
        const PresentationPropKey key = ScopedPropPresentationKey{desired.instance};
        if (duplicate_key(result.props, key,
                          [](const PresentationProp& value) { return value.key; })) {
            diagnostics.push_back(
                invalid("presentation.duplicate_prop_identity",
                        "Multiple active presentation props share one stable identity"));
            continue;
        }
        auto bounds = desired.bounds;
        if (desired.placement) {
            const auto* placement = find_placement(project, *desired.placement);
            if (placement == nullptr) {
                diagnostics.push_back(unresolved("presentation prop placement",
                                                 desired.placement->placement_id.text()));
                continue;
            }
            bounds = placement->bounds;
        }
        validate_asset(project, desired.asset, compiled::AssetKind::Image,
                       "presentation prop asset", diagnostics);
        result.props.push_back(PresentationProp{key, desired.owner, desired.asset, desired.material,
                                                desired.placement, bounds, desired.plane,
                                                desired.order, desired.visible});
    }

    for (const auto& desired : state.presentation_environments()) {
        if (!state.presentation_owner_is_active(desired.owner))
            continue;
        if (duplicate_key(result.environments, desired.instance,
                          [](const PresentationEnvironment& value) { return value.instance; })) {
            diagnostics.push_back(
                invalid("presentation.duplicate_environment_identity",
                        "Multiple active presentation environments share one stable identity"));
            continue;
        }
        result.environments.push_back(
            PresentationEnvironment{desired.instance, desired.owner, desired.kind, desired.plane,
                                    desired.order, desired.clock, desired.visible});
    }

    for (const auto& mount : state.mounted_layouts()) {
        if (!state.presentation_owner_is_active(mount.owner))
            continue;
        if (duplicate_key(result.layouts, mount.key,
                          [](const PresentationMountedLayout& value) { return value.key; })) {
            diagnostics.push_back(
                invalid("presentation.duplicate_layout_identity",
                        "Multiple active mounted Layout records share one stable identity"));
            continue;
        }
        if (project.find_layout(mount.layout) == nullptr) {
            diagnostics.push_back(unresolved("Layout", mount.layout.text()));
            continue;
        }
        if (!valid_layout_policy(mount.policy)) {
            diagnostics.push_back(
                invalid("presentation.invalid_layout_policy",
                        "Mounted Layout policy contains an invalid or not-yet-supported value"));
            continue;
        }
        result.layouts.push_back(PresentationMountedLayout{mount.key, mount.owner, mount.layout,
                                                           mount.policy, mount.composition_group});
    }

    validate_text_and_choice(project, state, diagnostics);
    result.text_and_choice = {state.presented_text(), state.active_choice()};

    if (state.map_presentation()) {
        const auto& current = *state.map_presentation();
        const auto* map = project.find_map(current.map);
        if (map == nullptr) {
            diagnostics.push_back(unresolved("Map", current.map.text()));
        } else {
            validate_asset(project, map->presentation.background, compiled::AssetKind::Image,
                           "Map background", diagnostics);
            if (map->presentation.layout &&
                project.find_layout(*map->presentation.layout) == nullptr)
                diagnostics.push_back(unresolved("Map Layout", map->presentation.layout->text()));
            if (current.focused_location) {
                const auto location = std::find_if(
                    map->locations.begin(), map->locations.end(),
                    [&](const auto& value) { return value.id == *current.focused_location; });
                if (location == map->locations.end())
                    diagnostics.push_back(
                        unresolved("Map location", current.focused_location->text()));
            }
            result.map = PresentationMap{current.map,
                                         current.mode,
                                         current.visible,
                                         current.focused_location,
                                         map->presentation.background,
                                         map->presentation.layout};
        }
    }

    for (const auto& audio : state.audio_channels()) {
        validate_asset(project, audio.asset, compiled::AssetKind::Audio, "audio asset",
                       diagnostics);
        result.audio_channels.push_back(
            {audio.channel, audio.asset, audio.volume, audio.loop, audio.playing});
    }

    canonicalize(result);
    std::sort(diagnostics.begin(), diagnostics.end(), [](const auto& a, const auto& b) {
        return std::tie(a.code, a.message) < std::tie(b.code, b.message);
    });
    diagnostics.erase(std::unique(diagnostics.begin(), diagnostics.end()), diagnostics.end());
    if (!diagnostics.empty())
        return Result<RuntimePresentationSnapshot, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimePresentationSnapshot, Diagnostics>::success(std::move(result));
}

Result<bool, Diagnostics>
RuntimePresentationSnapshotPublisher::reproject(const CompiledProject& project,
                                                const SessionState& state,
                                                const ResolvedRoomPresentation* room_presentation)
{
    auto candidate = PresentationProjector::project(project, state, room_presentation);
    if (!candidate)
        return Result<bool, Diagnostics>::failure(candidate.error());

    auto value = std::move(*candidate.value_if());
    if (m_published) {
        value.revision = m_published->revision;
        if (value == *m_published)
            return Result<bool, Diagnostics>::success(false);
        if (m_published->revision.number() == std::numeric_limits<std::uint64_t>::max())
            return Result<bool, Diagnostics>::failure(Diagnostics{
                Diagnostic{.code = "presentation.snapshot_revision_exhausted",
                           .message = "Runtime presentation snapshot revision exhausted"}});
        value.revision =
            PresentationSnapshotRevision::from_number(m_published->revision.number() + 1);
    } else {
        value.revision = PresentationSnapshotRevision::from_number(1);
    }
    m_published = std::move(value);
    return Result<bool, Diagnostics>::success(true);
}

const RuntimePresentationSnapshot* RuntimePresentationSnapshotPublisher::published() const noexcept
{
    return m_published ? &*m_published : nullptr;
}
} // namespace noveltea::core
