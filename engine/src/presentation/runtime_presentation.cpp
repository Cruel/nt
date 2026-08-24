#include "noveltea/presentation/runtime_presentation.hpp"

#include "noveltea/presentation/room_presentation.hpp"
#include "noveltea/core/property_resolver.hpp"
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

const compiled::RoomPlacement* find_placement(const runtime::RuntimeWorld& world,
                                              const compiled::RoomPlacementRef& ref) noexcept
{
    const auto* room = world.resolved_configuration(ref.room);
    if (room == nullptr)
        return nullptr;
    const auto found =
        std::find_if(room->placements.begin(), room->placements.end(),
                     [&ref](const auto& value) { return value.id == ref.placement_id; });
    return found == room->placements.end() ? nullptr : &*found;
}

void validate_text_and_choice(const CompiledProject& project, const runtime::RuntimeWorld& world,
                              const SessionState& state, Diagnostics& diagnostics)
{
    if (state.presented_text() && state.presented_text()->speaker &&
        world.resolved_configuration(*state.presented_text()->speaker) == nullptr)
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

struct EffectiveBackground {
    compiled::BackgroundPresentation background;
    std::optional<PresentationOwner> owner;
};

std::optional<EffectiveBackground> effective_background(const SessionState& state,
                                                        const ResolvedRoomPresentation* room)
{
    std::optional<EffectiveBackground> result;
    if (room != nullptr)
        result = EffectiveBackground{room->background, std::nullopt};
    std::uint64_t selected_precedence = 0;
    for (const auto& override : state.background_overrides()) {
        const auto precedence = background_precedence(state, override.owner);
        if (precedence && *precedence > selected_precedence) {
            selected_precedence = *precedence;
            result = EffectiveBackground{override.background, override.owner};
        }
    }
    return result;
}

std::optional<PresentationCamera> effective_camera(const runtime::RuntimeWorld& world,
                                                   const SessionState& state,
                                                   const ResolvedRoomPresentation* room)
{
    std::optional<PresentationCamera> result;
    if (room != nullptr) {
        const auto* configuration = world.resolved_configuration(room->visit.room);
        if (configuration != nullptr)
            result = PresentationCamera{configuration->presentation_space,
                                        configuration->presentation_space.default_view};
    }
    std::uint64_t selected_precedence = 0;
    for (const auto& desired : state.camera_views()) {
        const auto precedence = background_precedence(state, desired.owner);
        if (precedence && *precedence > selected_precedence) {
            selected_precedence = *precedence;
            if (result)
                result->view = desired.view;
        }
    }
    return result;
}

void validate_actor_key(const CompiledProject& project, const runtime::RuntimeWorld& world,
                        const ActorPresentationKey& key, Diagnostics& diagnostics)
{
    std::visit(
        [&project, &world, &diagnostics](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                if (world.resolved_configuration(value.room) == nullptr)
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

bool valid_layout_scale_overrides(const LayoutScaleOverrides& overrides) noexcept
{
    return (!overrides.ui || *overrides.ui <= LayoutScaleInheritance::Ignore) &&
           (!overrides.text || *overrides.text <= LayoutScaleInheritance::Ignore);
}

struct ActorSource {
    ActorPresentationKey key;
    CharacterId character;
    CharacterPresentationProfileId profile;
    CharacterPoseId pose;
    CharacterExpressionId expression;
    std::optional<CharacterAppearanceId> appearance;
    std::optional<CharacterIdleId> idle;
    ActorLogicalPlacement placement;
    std::optional<compiled::RoomPlacementRef> room_placement;
    std::optional<compiled::NormalizedRect> room_bounds;
    std::int32_t order = 0;
    bool enabled = true;
    bool visible = true;
    bool presentation_complete = true;
    bool speaking = false;
    bool desired_override = false;
    std::optional<PresentationOwner> desired_owner;
};

template<class SemanticEntry>
const compiled::CharacterProfileLayerOverrides*
profile_overrides(const SemanticEntry* entry,
                  const CharacterPresentationProfileId& profile) noexcept
{
    if (entry == nullptr)
        return nullptr;
    const auto found = std::ranges::find_if(
        entry->profiles, [&](const auto& candidate) { return candidate.profile_id == profile; });
    return found == entry->profiles.end() ? nullptr : &*found;
}

std::optional<std::vector<PresentationActorLayer>>
resolve_actor_layers(const CompiledProject* project, const compiled::CharacterDefinition& character,
                     const CharacterPresentationProfileId& profile_id,
                     const CharacterPoseId& pose_id, const CharacterExpressionId& expression_id,
                     const std::optional<CharacterAppearanceId>& appearance_id,
                     Diagnostics& diagnostics)
{
    const auto profile = std::ranges::find_if(
        character.profiles, [&](const auto& candidate) { return candidate.id == profile_id; });
    if (profile == character.profiles.end()) {
        diagnostics.push_back(unresolved("Character presentation profile", profile_id.text()));
        return std::nullopt;
    }
    const auto pose = std::ranges::find_if(
        profile->poses, [&](const auto& candidate) { return candidate.id == pose_id; });
    if (pose == profile->poses.end()) {
        diagnostics.push_back(unresolved("Character pose", pose_id.text()));
        return std::nullopt;
    }
    const auto expression = std::ranges::find_if(character.expressions, [&](const auto& candidate) {
        return candidate.id == expression_id;
    });
    if (expression == character.expressions.end()) {
        diagnostics.push_back(unresolved("Character expression", expression_id.text()));
        return std::nullopt;
    }
    const auto default_expression =
        std::ranges::find_if(character.expressions, [&](const auto& candidate) {
            return candidate.id == character.defaults.expression_id;
        });
    auto expression_overrides = profile_overrides(&*expression, profile_id);
    if (expression_overrides == nullptr && expression != default_expression &&
        default_expression != character.expressions.end())
        expression_overrides = profile_overrides(&*default_expression, profile_id);

    const compiled::CharacterProfileLayerOverrides* appearance_overrides = nullptr;
    if (appearance_id) {
        const auto appearance =
            std::ranges::find_if(character.appearances, [&](const auto& candidate) {
                return candidate.id == *appearance_id;
            });
        if (appearance == character.appearances.end()) {
            diagnostics.push_back(unresolved("Character appearance", appearance_id->text()));
            return std::nullopt;
        }
        appearance_overrides = profile_overrides(&*appearance, profile_id);
    }

    std::vector<PresentationActorLayer> layers;
    layers.reserve(profile->layers.size());
    for (const auto& definition : profile->layers) {
        const auto base = std::ranges::find_if(pose->layers, [&](const auto& candidate) {
            return candidate.layer_id == definition.id;
        });
        if (base == pose->layers.end())
            continue;
        PresentationActorLayer layer{definition.id, definition.role, base->sprite, base->material,
                                     base->anchor,  base->offset,    base->scale,  base->visible};
        const auto apply = [&](const compiled::CharacterProfileLayerOverrides* overrides) {
            if (overrides == nullptr)
                return;
            const auto patch = std::ranges::find_if(overrides->layers, [&](const auto& candidate) {
                return candidate.layer_id == definition.id;
            });
            if (patch == overrides->layers.end())
                return;
            if (patch->sprite.specified)
                layer.sprite = patch->sprite.value;
            if (patch->material.specified)
                layer.material = patch->material.value;
            if (patch->visible)
                layer.visible = *patch->visible;
        };
        apply(expression_overrides);
        apply(appearance_overrides);
        if (project != nullptr)
            validate_asset(*project, layer.sprite, compiled::AssetKind::Image,
                           "Character presentation layer sprite", diagnostics);
        layers.push_back(std::move(layer));
    }
    return layers;
}

void append_actor(const CompiledProject& project, const runtime::RuntimeWorld& world,
                  const ActorSource& actor, RuntimePresentationSnapshot& result,
                  Diagnostics& diagnostics)
{
    validate_actor_key(project, world, actor.key, diagnostics);
    const auto* character = world.resolved_configuration(actor.character);
    if (character == nullptr) {
        diagnostics.push_back(unresolved("Character", actor.character.text()));
        return;
    }
    auto layers = resolve_actor_layers(&project, *character, actor.profile, actor.pose,
                                       actor.expression, actor.appearance, diagnostics);
    if (!layers)
        return;
    const auto profile = std::ranges::find_if(
        character->profiles, [&](const auto& candidate) { return candidate.id == actor.profile; });
    if (profile == character->profiles.end()) {
        diagnostics.push_back(unresolved("Character presentation profile", actor.profile.text()));
        return;
    }
    std::optional<compiled::CharacterIdle> idle;
    if (actor.idle) {
        const auto found = std::find_if(character->idles.begin(), character->idles.end(),
                                        [&](const auto& value) { return value.id == *actor.idle; });
        if (found == character->idles.end()) {
            diagnostics.push_back(unresolved("Character idle", actor.idle->text()));
            return;
        }
        idle = *found;
    }
    result.actors.push_back(PresentationActor{actor.key,
                                              actor.desired_owner,
                                              actor.character,
                                              actor.profile,
                                              actor.pose,
                                              actor.expression,
                                              actor.appearance,
                                              std::move(idle),
                                              profile->animation_clips,
                                              profile->automatic_animations,
                                              std::move(*layers),
                                              actor.placement,
                                              actor.room_placement,
                                              actor.room_bounds,
                                              PresentationPlane::WorldContent,
                                              actor.order,
                                              actor.enabled,
                                              actor.visible,
                                              actor.presentation_complete,
                                              actor.speaking});
}

Result<PresentationEnvironmentInstanceId, Diagnostics>
room_environment_instance(const RoomId& room, const RoomEnvironmentId& environment)
{
    return PresentationEnvironmentInstanceId::create("room-" + std::to_string(room.text().size()) +
                                                     "-" + room.text() + "-" + environment.text());
}

Result<PresentationEnvironmentStopKey, Diagnostics>
room_environment_stop_key(const RoomId& room, const RoomEnvironmentId& environment)
{
    return PresentationEnvironmentStopKey::create("room-" + std::to_string(room.text().size()) +
                                                  "-" + room.text() + "-" + environment.text());
}

[[maybe_unused]] void
append_room_baseline(const CompiledProject& project, const runtime::RuntimeWorld& world,
                     const ResolvedRoomPresentation& room, std::vector<ActorSource>& actors,
                     RuntimePresentationSnapshot& result, Diagnostics& diagnostics)
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
        const auto* definition = find_placement(world, placement);
        if (definition == nullptr) {
            diagnostics.push_back(unresolved("actor Room placement", actor.placement.text()));
            continue;
        }
        actors.push_back(ActorSource{key,
                                     actor.character,
                                     actor.profile,
                                     actor.pose,
                                     actor.expression,
                                     actor.appearance,
                                     actor.idle,
                                     {},
                                     placement,
                                     definition->bounds,
                                     actor.order,
                                     actor.enabled,
                                     actor.visible,
                                     true,
                                     false,
                                     false,
                                     std::nullopt});
    }

    for (const auto& interactable : room.interactables) {
        const auto* definition = world.resolved_configuration(interactable.interactable);
        const compiled::RoomPlacementRef placement{room.visit.room, interactable.placement};
        const auto* placement_definition = find_placement(world, placement);
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
        const auto* placement_definition = find_placement(world, placement);
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

    for (const auto& environment : room.environments) {
        auto instance = room_environment_instance(room.visit.room, environment.environment);
        auto stop_key = room_environment_stop_key(room.visit.room, environment.environment);
        if (!instance || !stop_key) {
            append_diagnostics(diagnostics, !instance ? std::move(instance.error())
                                                      : std::move(stop_key.error()));
            continue;
        }
        validate_asset(project, environment.asset, compiled::AssetKind::Image,
                       "Room environment asset", diagnostics);
        result.environments.push_back(PresentationEnvironment{
            std::move(*instance.value_if()), RoomPresentationOwner{room.visit.room},
            std::move(*stop_key.value_if()), environment.asset, environment.material,
            environment.bounds, environment.plane, environment.order, environment.clock,
            environment.scroll_per_second, environment.opacity, environment.visible});
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
    std::sort(result.material_parameters.begin(), result.material_parameters.end(),
              [](const auto& a, const auto& b) {
                  return std::tie(a.owner, a.occurrence, a.material, a.parameter) <
                         std::tie(b.owner, b.occurrence, b.material, b.parameter);
              });
    std::sort(result.postprocess_effects.begin(), result.postprocess_effects.end(),
              [](const auto& a, const auto& b) {
                  return std::tie(a.scope, a.order, a.instance, a.owner) <
                         std::tie(b.scope, b.order, b.instance, b.owner);
              });
    std::sort(result.layouts.begin(), result.layouts.end(), [](const auto& a, const auto& b) {
        return std::tie(a.policy.plane, a.policy.local_order, a.key) <
               std::tie(b.policy.plane, b.policy.local_order, b.key);
    });
    std::sort(result.desired_audio.begin(), result.desired_audio.end(),
              [](const auto& a, const auto& b) {
                  return std::tie(a.purpose, a.owner, a.instance) <
                         std::tie(b.purpose, b.owner, b.instance);
              });
}

RoomPresentationVisualCatalog
build_room_visual_catalog_impl(const runtime::RuntimeWorld& world,
                               const RoomPresentationResolution& resolution)
{
    RoomPresentationVisualCatalog catalog;
    const auto* room = world.resolved_configuration(resolution.presentation.visit.room);
    if (room != nullptr) {
        for (const auto& placement : room->placements)
            catalog.placements.push_back({placement.id, placement.bounds, placement.order});
    }
    for (const auto& actor : resolution.presentation.actors) {
        const auto* character = world.resolved_configuration(actor.character);
        if (character == nullptr)
            continue;
        Diagnostics ignored;
        auto layers = resolve_actor_layers(nullptr, *character, actor.profile, actor.pose,
                                           actor.expression, actor.appearance, ignored);
        if (!layers)
            continue;
        std::optional<compiled::CharacterIdle> idle;
        if (actor.idle) {
            const auto found =
                std::find_if(character->idles.begin(), character->idles.end(),
                             [&](const auto& value) { return value.id == *actor.idle; });
            if (found != character->idles.end())
                idle = *found;
        }
        catalog.characters.push_back({actor.character, actor.profile, actor.pose, actor.expression,
                                      actor.appearance, actor.idle, std::move(*layers),
                                      std::move(idle)});
    }
    for (const auto& interactable : resolution.presentation.interactables) {
        const auto* definition = world.resolved_configuration(interactable.interactable);
        if (definition != nullptr)
            catalog.interactables.push_back({interactable.interactable,
                                             definition->presentation.sprite,
                                             definition->presentation.material});
    }
    return catalog;
}
} // namespace

RoomPresentationVisualCatalog
build_room_presentation_visual_catalog(const runtime::RuntimeWorld& world,
                                       const RoomPresentationResolution& resolution)
{
    return build_room_visual_catalog_impl(world, resolution);
}

Result<RuntimePresentationSnapshot, Diagnostics>
RoomPresentationSnapshotProjector::project(const RoomPresentationResolution& resolution,
                                           const RoomPresentationVisualCatalog& visuals)
{
    RoomPresentationResolution passive = resolution;
    passive.presentation.hotspots.clear();
    RuntimePresentationSnapshot result;
    Diagnostics diagnostics;
    result.mode = PresentationRuntimeMode::Room;
    result.current_room = passive.presentation.visit.room;
    if (passive.presentation.background.asset || passive.presentation.background.color ||
        passive.presentation.background.material)
        result.background = PresentationBackground{
            std::nullopt, passive.presentation.background.asset,
            passive.presentation.background.color, passive.presentation.background.fit,
            passive.presentation.background.material};

    const auto placement =
        [&](const RoomPlacementId& id) -> const RoomPresentationVisualCatalog::Placement* {
        const auto found = std::find_if(visuals.placements.begin(), visuals.placements.end(),
                                        [&](const auto& value) { return value.placement == id; });
        return found == visuals.placements.end() ? nullptr : &*found;
    };
    for (const auto& interactable : passive.presentation.interactables) {
        const auto visual = std::find_if(
            visuals.interactables.begin(), visuals.interactables.end(),
            [&](const auto& value) { return value.interactable == interactable.interactable; });
        const auto* bounds = placement(interactable.placement);
        if (visual == visuals.interactables.end() || bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_interactable_visual_missing",
                                          "Room Interactable visual catalog entry is missing"));
            continue;
        }
        result.interactables.push_back(
            PresentationInteractable{interactable.interactable,
                                     {passive.presentation.visit.room, interactable.placement},
                                     bounds->bounds,
                                     visual->sprite,
                                     visual->material,
                                     PresentationPlane::WorldContent,
                                     bounds->order,
                                     interactable.enabled,
                                     interactable.visible});
    }
    // Reuse the complete projector for production paths; focused preview callers require only the
    // pre-existing passive Room fields and initialize the new hotspot collection empty.
    for (const auto& actor : passive.presentation.actors) {
        const auto visual = std::find_if(
            visuals.characters.begin(), visuals.characters.end(), [&](const auto& value) {
                return value.character == actor.character && value.profile == actor.profile &&
                       value.pose == actor.pose && value.expression == actor.expression &&
                       value.appearance == actor.appearance && value.idle_id == actor.idle;
            });
        const auto* bounds = placement(actor.placement);
        if (visual == visuals.characters.end() || bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_actor_visual_missing",
                                          "Room actor visual catalog entry is missing"));
            continue;
        }
        const ActorPresentationKey key = std::visit(
            [](const auto& value) -> ActorPresentationKey {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, PersistentCharacterPresentationId>)
                    return CharacterActorKey{value.character};
                else
                    return RoomCastActorKey{value.room, value.entry};
            },
            actor.id);
        result.actors.push_back(
            {key,
             std::nullopt,
             actor.character,
             actor.profile,
             actor.pose,
             actor.expression,
             actor.appearance,
             visual->idle,
             {},
             {},
             visual->layers,
             {},
             compiled::RoomPlacementRef{passive.presentation.visit.room, actor.placement},
             bounds->bounds,
             PresentationPlane::WorldContent,
             actor.order,
             actor.enabled,
             actor.visible,
             true});
    }
    for (const auto& prop : passive.presentation.props) {
        const auto* bounds = placement(prop.placement);
        if (bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_prop_placement_missing",
                                          "Room prop placement is missing"));
            continue;
        }
        result.props.push_back(PresentationProp{
            RoomPropPresentationKey{passive.presentation.visit.room, prop.prop},
            RoomPresentationOwner{passive.presentation.visit.room}, prop.asset, prop.material,
            compiled::RoomPlacementRef{passive.presentation.visit.room, prop.placement},
            bounds->bounds, PresentationPlane::WorldContent, prop.order, prop.visible});
    }
    for (const auto& environment : passive.presentation.environments) {
        auto instance =
            room_environment_instance(passive.presentation.visit.room, environment.environment);
        auto stop_key =
            room_environment_stop_key(passive.presentation.visit.room, environment.environment);
        if (!instance || !stop_key) {
            append_diagnostics(diagnostics, !instance ? std::move(instance.error())
                                                      : std::move(stop_key.error()));
            continue;
        }
        result.environments.push_back(PresentationEnvironment{
            std::move(*instance.value_if()), RoomPresentationOwner{passive.presentation.visit.room},
            std::move(*stop_key.value_if()), environment.asset, environment.material,
            environment.bounds, environment.plane, environment.order, environment.clock,
            environment.scroll_per_second, environment.opacity, environment.visible});
    }
    canonicalize(result);
    if (!diagnostics.empty())
        return Result<RuntimePresentationSnapshot, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimePresentationSnapshot, Diagnostics>::success(std::move(result));
}

Result<RuntimePresentationSnapshot, Diagnostics>
RoomPresentationSnapshotProjector::project(const CompiledProject& project,
                                           const RoomPresentationResolution& resolution,
                                           const RoomPresentationVisualCatalog& visuals)
{
    RuntimePresentationSnapshot result;
    Diagnostics diagnostics;
    result.mode = PresentationRuntimeMode::Room;
    result.current_room = resolution.presentation.visit.room;
    if (resolution.presentation.background.asset || resolution.presentation.background.color ||
        resolution.presentation.background.material)
        result.background = PresentationBackground{
            std::nullopt, resolution.presentation.background.asset,
            resolution.presentation.background.color, resolution.presentation.background.fit,
            resolution.presentation.background.material};

    const auto placement =
        [&](const RoomPlacementId& id) -> const RoomPresentationVisualCatalog::Placement* {
        const auto found = std::find_if(visuals.placements.begin(), visuals.placements.end(),
                                        [&](const auto& value) { return value.placement == id; });
        return found == visuals.placements.end() ? nullptr : &*found;
    };
    for (const auto& actor : resolution.presentation.actors) {
        const auto visual = std::find_if(
            visuals.characters.begin(), visuals.characters.end(), [&](const auto& value) {
                return value.character == actor.character && value.profile == actor.profile &&
                       value.pose == actor.pose && value.expression == actor.expression &&
                       value.appearance == actor.appearance && value.idle_id == actor.idle;
            });
        const auto* bounds = placement(actor.placement);
        if (visual == visuals.characters.end() || bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_actor_visual_missing",
                                          "Room actor visual catalog entry is missing"));
            continue;
        }
        const ActorPresentationKey key = std::visit(
            [](const auto& value) -> ActorPresentationKey {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, PersistentCharacterPresentationId>) {
                    return CharacterActorKey{value.character};
                } else {
                    return RoomCastActorKey{value.room, value.entry};
                }
            },
            actor.id);
        const compiled::RoomPlacementRef room_placement{resolution.presentation.visit.room,
                                                        actor.placement};
        std::vector<compiled::CharacterAnimationClip> animation_clips;
        compiled::CharacterAutomaticAnimations automatic_animations;
        if (const auto* character = project.find_character(actor.character)) {
            const auto profile =
                std::ranges::find_if(character->profiles, [&](const auto& candidate) {
                    return candidate.id == actor.profile;
                });
            if (profile != character->profiles.end()) {
                animation_clips = profile->animation_clips;
                automatic_animations = profile->automatic_animations;
            }
        }
        result.actors.push_back(PresentationActor{key,
                                                  std::nullopt,
                                                  actor.character,
                                                  actor.profile,
                                                  actor.pose,
                                                  actor.expression,
                                                  actor.appearance,
                                                  visual->idle,
                                                  std::move(animation_clips),
                                                  std::move(automatic_animations),
                                                  visual->layers,
                                                  {},
                                                  room_placement,
                                                  bounds->bounds,
                                                  PresentationPlane::WorldContent,
                                                  actor.order,
                                                  actor.enabled,
                                                  actor.visible,
                                                  true});
    }
    for (const auto& interactable : resolution.presentation.interactables) {
        const auto visual = std::find_if(
            visuals.interactables.begin(), visuals.interactables.end(),
            [&](const auto& value) { return value.interactable == interactable.interactable; });
        const auto* bounds = placement(interactable.placement);
        if (visual == visuals.interactables.end() || bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_interactable_visual_missing",
                                          "Room Interactable visual catalog entry is missing"));
            continue;
        }
        result.interactables.push_back(
            PresentationInteractable{interactable.interactable,
                                     {resolution.presentation.visit.room, interactable.placement},
                                     bounds->bounds,
                                     visual->sprite,
                                     visual->material,
                                     PresentationPlane::WorldContent,
                                     bounds->order,
                                     interactable.enabled,
                                     interactable.visible});
    }
    for (const auto& prop : resolution.presentation.props) {
        const auto* bounds = placement(prop.placement);
        if (bounds == nullptr) {
            diagnostics.push_back(invalid("presentation.room_prop_placement_missing",
                                          "Room prop placement is missing"));
            continue;
        }
        result.props.push_back(PresentationProp{
            RoomPropPresentationKey{resolution.presentation.visit.room, prop.prop},
            RoomPresentationOwner{resolution.presentation.visit.room}, prop.asset, prop.material,
            compiled::RoomPlacementRef{resolution.presentation.visit.room, prop.placement},
            bounds->bounds, PresentationPlane::WorldContent, prop.order, prop.visible});
    }
    for (const auto& environment : resolution.presentation.environments) {
        auto instance =
            room_environment_instance(resolution.presentation.visit.room, environment.environment);
        auto stop_key =
            room_environment_stop_key(resolution.presentation.visit.room, environment.environment);
        if (!instance || !stop_key) {
            append_diagnostics(diagnostics, !instance ? std::move(instance.error())
                                                      : std::move(stop_key.error()));
            continue;
        }
        result.environments.push_back(PresentationEnvironment{
            std::move(*instance.value_if()),
            RoomPresentationOwner{resolution.presentation.visit.room},
            std::move(*stop_key.value_if()), environment.asset, environment.material,
            environment.bounds, environment.plane, environment.order, environment.clock,
            environment.scroll_per_second, environment.opacity, environment.visible});
    }
    for (const auto& hotspot : resolution.presentation.hotspots) {
        std::optional<AssetId> source;
        if (std::holds_alternative<compiled::RoomHotspotRef>(hotspot.ref)) {
            source = resolution.presentation.background.asset;
        } else {
            const auto& ref = std::get<compiled::InteractableHotspotRef>(hotspot.ref);
            const auto visual = std::find_if(
                visuals.interactables.begin(), visuals.interactables.end(),
                [&](const auto& candidate) { return candidate.interactable == ref.interactable; });
            if (visual != visuals.interactables.end())
                source = visual->sprite;
        }
        const auto* image = source ? project.find_asset(*source) : nullptr;
        if (!source || image == nullptr || !image->width || !image->height || *image->width == 0 ||
            *image->height == 0 || *image->width > UINT16_MAX || *image->height > UINT16_MAX) {
            diagnostics.push_back(invalid("presentation.hotspot_source_image_invalid",
                                          "Presented hotspot requires a dimensioned source image"));
            continue;
        }
        const auto shape = std::visit(
            [](const auto& value) -> std::variant<AlphaHotspotShape, compiled::NormalizedRect> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, std::monostate>)
                    return AlphaHotspotShape{};
                else
                    return value.bounds;
            },
            hotspot.shape);
        result.hotspots.push_back(
            {hotspot.ref, hotspot.label, hotspot.condition_eligible, hotspot.target_available,
             hotspot.target, shape, hotspot.input_order, hotspot.highlight, *source,
             static_cast<std::uint16_t>(*image->width), static_cast<std::uint16_t>(*image->height),
             hotspot.interactable_placement, hotspot.interactable_bounds, hotspot.owner_plane,
             hotspot.owner_order});
    }
    canonicalize(result);
    if (!diagnostics.empty())
        return Result<RuntimePresentationSnapshot, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimePresentationSnapshot, Diagnostics>::success(std::move(result));
}

Result<RuntimePresentationSnapshot, Diagnostics>
PresentationProjector::project(const CompiledProject& project, const runtime::RuntimeWorld& world,
                               const SessionState& state,
                               const ResolvedRoomPresentation* room_presentation,
                               const std::vector<SceneStageRoomPresentation>* scene_stages)
{
    RuntimePresentationSnapshot result;
    Diagnostics diagnostics;
    result.mode = mode_of(state.mode());
    struct StageLayout {
        ScenePresentationOwner owner;
        std::string occurrence_key;
        LayoutId layout;
        std::int32_t order = 0;
        bool visible = true;
    };
    std::vector<StageLayout> stage_layouts;
    bool scene_stage_replaced_world = false;

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

    std::vector<ActorSource> actors;
    if (room_presentation != nullptr) {
        RoomPresentationResolution resolution{
            *room_presentation,
            RoomView{.room = room_presentation->visit.room,
                     .visits = room_presentation->visit.visit_index,
                     .description = {},
                     .description_markup = TextMarkup::Plain,
                     .background = room_presentation->background,
                     .overlays = room_presentation->overlays,
                     .placements = {},
                     .exits = {},
                     .item_stacks = {},
                     .controls = {}},
            {}};
        auto baseline = RoomPresentationSnapshotProjector::project(
            project, resolution, build_room_presentation_visual_catalog(world, resolution));
        if (!baseline) {
            append_diagnostics(diagnostics, std::move(baseline.error()));
        } else {
            auto value = std::move(*baseline.value_if());
            result.background = std::move(value.background);
            result.actors = std::move(value.actors);
            result.interactables = std::move(value.interactables);
            result.props = std::move(value.props);
            result.environments = std::move(value.environments);
            result.hotspots = std::move(value.hotspots);
        }
    }

    for (const auto& flow_frame : state.flow_stack()) {
        const auto* frame = std::get_if<SceneFrame>(&flow_frame);
        if (frame == nullptr || !frame->position.stage_initialized)
            continue;
        const auto* scene = project.find_scene(frame->scene);
        if (scene == nullptr) {
            diagnostics.push_back(unresolved("Scene", frame->scene.text()));
            continue;
        }
        const ScenePresentationOwner owner{frame->frame_id, frame->scene};
        if (std::holds_alternative<compiled::InheritedSceneStage>(scene->stage))
            continue;

        scene_stage_replaced_world = true;
        result.background.reset();
        result.camera.reset();
        result.actors.clear();
        result.interactables.clear();
        result.props.clear();
        result.environments.clear();
        result.hotspots.clear();

        if (const auto* blank = std::get_if<compiled::BlankSceneStage>(&scene->stage)) {
            if (blank->background.asset || blank->background.color || blank->background.material)
                result.background = PresentationBackground{
                    PresentationOwner{owner}, blank->background.asset, blank->background.color,
                    blank->background.fit, blank->background.material};
            if (blank->layout)
                stage_layouts.push_back({owner, "blank", *blank->layout, 0, true});
            continue;
        }

        const auto* staged = std::get_if<compiled::StagedRoomSceneStage>(&scene->stage);
        if (staged == nullptr || scene_stages == nullptr) {
            diagnostics.push_back(
                invalid("presentation.scene_stage_unavailable",
                        "Staged Room Scene presentation is unavailable for the active invocation"));
            continue;
        }
        const auto resolved = std::find_if(
            scene_stages->begin(), scene_stages->end(),
            [&](const SceneStageRoomPresentation& candidate) { return candidate.owner == owner; });
        if (resolved == scene_stages->end()) {
            diagnostics.push_back(
                invalid("presentation.scene_stage_unavailable",
                        "Staged Room Scene presentation is unavailable for the active invocation"));
            continue;
        }
        auto staged_snapshot = RoomPresentationSnapshotProjector::project(
            project, resolved->resolution,
            build_room_presentation_visual_catalog(world, resolved->resolution));
        if (!staged_snapshot) {
            append_diagnostics(diagnostics, std::move(staged_snapshot).error());
            continue;
        }
        auto staged_value = std::move(*staged_snapshot.value_if());
        result.background = std::move(staged_value.background);
        if (result.background)
            result.background->material_owner = PresentationOwner{owner};
        result.actors = std::move(staged_value.actors);
        result.interactables = std::move(staged_value.interactables);
        result.props = std::move(staged_value.props);
        result.environments = std::move(staged_value.environments);
        result.hotspots = std::move(staged_value.hotspots);

        const auto* staged_room = world.resolved_configuration(staged->room);
        if (staged_room != nullptr)
            result.camera = PresentationCamera{staged_room->presentation_space,
                                               staged_room->presentation_space.default_view};

        for (std::size_t index = 0; index < result.actors.size(); ++index) {
            const auto semantic_key = std::visit(
                [](const auto& key) {
                    using Key = std::decay_t<decltype(key)>;
                    if constexpr (std::is_same_v<Key, CharacterActorKey>)
                        return std::string{"character-"} + key.character.text();
                    else if constexpr (std::is_same_v<Key, RoomCastActorKey>)
                        return std::string{"room-cast-"} + key.room.text() + "-" + key.entry.text();
                    else if constexpr (std::is_same_v<Key, SceneActorKey>)
                        return std::string{"scene-slot-"} + key.slot.text();
                    else
                        return std::string{"scoped-"} + key.instance.text();
                },
                result.actors[index].key);
            const auto instance = StrongId<ScopedActorInstanceTag>::create(
                "scene-stage-" + std::to_string(frame->frame_id.number()) + "-actor-" +
                semantic_key);
            if (!instance) {
                append_diagnostics(diagnostics, instance.error());
                continue;
            }
            result.actors[index].key = ScopedActorKey{*instance.value_if()};
            result.actors[index].material_owner = PresentationOwner{owner};
        }
        for (std::size_t index = 0; index < result.props.size(); ++index) {
            const auto semantic_key = std::visit(
                [](const auto& key) {
                    using Key = std::decay_t<decltype(key)>;
                    if constexpr (std::is_same_v<Key, RoomPropPresentationKey>)
                        return std::string{"room-prop-"} + key.room.text() + "-" + key.prop.text();
                    else
                        return std::string{"scoped-prop-"} + key.instance.text();
                },
                result.props[index].key);
            auto instance = PresentationPropInstanceId::create(
                "scene-stage-" + std::to_string(frame->frame_id.number()) + "-prop-" +
                semantic_key);
            if (!instance) {
                append_diagnostics(diagnostics, instance.error());
                continue;
            }
            result.props[index].key = ScopedPropPresentationKey{*instance.value_if()};
            result.props[index].owner = PresentationOwner{owner};
        }
        for (std::size_t index = 0; index < result.environments.size(); ++index) {
            const auto semantic_key = result.environments[index].instance.text();
            auto instance = PresentationEnvironmentInstanceId::create(
                "scene-stage-" + std::to_string(frame->frame_id.number()) + "-environment-" +
                semantic_key);
            auto stop_key = PresentationEnvironmentStopKey::create(
                "scene-stage-" + std::to_string(frame->frame_id.number()) + "-environment-" +
                semantic_key);
            if (!instance || !stop_key) {
                append_diagnostics(diagnostics, !instance ? std::move(instance.error())
                                                          : std::move(stop_key.error()));
                continue;
            }
            result.environments[index].instance = *instance.value_if();
            result.environments[index].stop_key = *stop_key.value_if();
            result.environments[index].owner = PresentationOwner{owner};
        }
        if (staged_room != nullptr) {
            for (const auto& overlay : resolved->resolution.presentation.overlays) {
                const auto authored =
                    std::ranges::find_if(staged_room->overlays, [&](const auto& candidate) {
                        return candidate.id == overlay.overlay;
                    });
                stage_layouts.push_back(
                    {owner, "room-overlay-" + overlay.overlay.text(), overlay.layout,
                     authored == staged_room->overlays.end() ? 0 : authored->order,
                     overlay.visible});
            }
        }
    }

    const auto background =
        effective_background(state, scene_stage_replaced_world ? nullptr : room_presentation);
    if (background) {
        validate_asset(project, background->background.asset, compiled::AssetKind::Image,
                       "background image asset", diagnostics);
        result.background = PresentationBackground{
            background->owner, background->background.asset, background->background.color,
            background->background.fit, background->background.material};
    }
    const auto camera =
        effective_camera(world, state, scene_stage_replaced_world ? nullptr : room_presentation);
    if (camera)
        result.camera = camera;

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
            existing->profile = desired.profile;
            existing->pose = desired.pose;
            existing->expression = desired.expression;
            existing->appearance = desired.appearance;
            existing->idle = desired.idle;
            existing->placement = desired.placement;
            existing->visible = desired.visible;
            existing->presentation_complete = desired.presentation_complete;
            existing->speaking = desired.speaking;
            existing->desired_override = true;
            existing->desired_owner = desired.owner;
            continue;
        }
        if (std::holds_alternative<CharacterActorKey>(desired.key) ||
            std::holds_alternative<RoomCastActorKey>(desired.key))
            continue;
        actors.push_back(ActorSource{
            desired.key, desired.character, desired.profile, desired.pose, desired.expression,
            desired.appearance, desired.idle, desired.placement, std::nullopt, std::nullopt,
            actor_order(project, desired.key), true, desired.visible, desired.presentation_complete,
            desired.speaking, true, desired.owner});
    }
    const auto* dialogue_frame = state.flow_stack().empty()
                                     ? nullptr
                                     : std::get_if<DialogueFrame>(&state.flow_stack().back());
    for (const auto& actor : actors)
        append_actor(project, world, actor, result, diagnostics);
    if (dialogue_frame == nullptr && state.presented_text() && state.presented_text()->speaker) {
        for (auto& actor : result.actors)
            actor.speaking = actor.speaking || actor.character == *state.presented_text()->speaker;
    }

    const auto* dialogue =
        dialogue_frame == nullptr ? nullptr : project.find_dialogue(dialogue_frame->dialogue);
    if (dialogue_frame != nullptr && dialogue != nullptr) {
        for (std::size_t index = 0; index < dialogue_frame->stage_slots.size(); ++index) {
            const auto& slot_state = dialogue_frame->stage_slots[index];
            if (!slot_state.value)
                continue;
            const auto slot_definition = std::find_if(
                dialogue->stage_slots.begin(), dialogue->stage_slots.end(),
                [&slot_state](const auto& candidate) { return candidate.id == slot_state.slot; });
            if (slot_definition == dialogue->stage_slots.end()) {
                diagnostics.push_back(unresolved("Dialogue Stage Slot", slot_state.slot.text()));
                continue;
            }
            const auto instance = StrongId<ScopedActorInstanceTag>::create(
                "dialogue-" + std::to_string(dialogue_frame->frame_id.number()) + "-" +
                slot_state.slot.text());
            if (!instance) {
                append_diagnostics(diagnostics, instance.error());
                continue;
            }
            const auto* character = project.find_character(slot_state.value->character);
            if (character == nullptr) {
                diagnostics.push_back(
                    unresolved("Dialogue Stage Character", slot_state.value->character.text()));
                continue;
            }
            const bool speaking = slot_definition->speaker_sync && state.presented_text() &&
                                  state.presented_text()->speaker &&
                                  *state.presented_text()->speaker == slot_state.value->character;
            const auto order =
                index > static_cast<std::size_t>(std::numeric_limits<std::int32_t>::max())
                    ? std::numeric_limits<std::int32_t>::max()
                    : static_cast<std::int32_t>(index);
            append_actor(
                project, world,
                ActorSource{
                    ScopedActorKey{std::move(*instance.value_if())}, slot_state.value->character,
                    slot_state.value->profile_id, slot_state.value->pose_id,
                    slot_state.value->expression_id, slot_state.value->appearance_id,
                    character->defaults.idle_id,
                    ActorLogicalPlacement{slot_state.value->position, slot_state.value->offset,
                                          slot_state.value->scale},
                    std::nullopt, std::nullopt, order, true, slot_state.value->visible, true,
                    speaking, true,
                    DialoguePresentationOwner{dialogue_frame->frame_id, dialogue_frame->dialogue}},
                result, diagnostics);
        }
    }

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
            const auto* placement = find_placement(world, *desired.placement);
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
        validate_asset(project, desired.asset, compiled::AssetKind::Image,
                       "presentation environment asset", diagnostics);
        result.environments.push_back(PresentationEnvironment{
            desired.instance, desired.owner, desired.stop_key, desired.asset, desired.material,
            desired.bounds, desired.plane, desired.order, desired.clock, desired.scroll_per_second,
            desired.opacity, desired.visible});
    }

    for (const auto& desired : state.material_parameters()) {
        if (!state.presentation_owner_is_active(desired.owner))
            continue;
        PresentationMaterialParameter projected{
            desired.owner, desired.occurrence, desired.material, desired.parameter,
            desired.value, std::nullopt,       desired.clock};
        if (desired.binding) {
            const bool resolved = std::visit(
                [&](const auto& binding) {
                    using B = std::decay_t<decltype(binding)>;
                    if constexpr (std::is_same_v<B, MaterialStandardFacetBinding>) {
                        projected.standard_facet = binding.facet;
                        return true;
                    } else {
                        PropertyResolver resolver(project, const_cast<SessionState&>(state));
                        Result<PropertyLookupResult, Diagnostics> lookup =
                            std::holds_alternative<GlobalPropertyTarget>(binding.target)
                                ? resolver.get_global(binding.property)
                                : std::visit(
                                      [&](const auto& target)
                                          -> Result<PropertyLookupResult, Diagnostics> {
                                          using T = std::decay_t<decltype(target)>;
                                          if constexpr (std::is_same_v<T, GlobalPropertyTarget>)
                                              return resolver.get_global(binding.property);
                                          else
                                              return resolver.get(PropertyOwnerRef{target},
                                                                  binding.property);
                                      },
                                      binding.target);
                        if (!lookup) {
                            append_diagnostics(diagnostics, lookup.error());
                            return false;
                        }
                        const auto* value = std::get_if<RuntimeValue>(lookup.value_if());
                        if (value == nullptr) {
                            diagnostics.push_back(invalid(
                                "presentation.material_parameter_binding_unresolved",
                                "Material Parameter Property binding resolved without a value"));
                            return false;
                        }
                        if (const auto* number = std::get_if<double>(value))
                            projected.value = compiled::MaterialParameterValue{*number};
                        else if (const auto* integer = std::get_if<std::int64_t>(value)) {
                            const auto* interface =
                                project.find_material_interface(desired.material);
                            const auto declaration =
                                interface == nullptr
                                    ? decltype(interface->parameters.begin()){}
                                    : std::find_if(interface->parameters.begin(),
                                                   interface->parameters.end(),
                                                   [&](const auto& item) {
                                                       return item.name == desired.parameter;
                                                   });
                            if (interface != nullptr &&
                                declaration != interface->parameters.end() &&
                                declaration->type == compiled::MaterialParameterType::Float)
                                projected.value =
                                    compiled::MaterialParameterValue{static_cast<double>(*integer)};
                            else
                                projected.value = compiled::MaterialParameterValue{*integer};
                        } else if (const auto* flag = std::get_if<bool>(value))
                            projected.value = compiled::MaterialParameterValue{*flag};
                        else {
                            diagnostics.push_back(
                                invalid("presentation.material_parameter_binding_type",
                                        "Material Parameter Property binding resolved to a "
                                        "non-scalar value"));
                            return false;
                        }
                        return true;
                    }
                },
                *desired.binding);
            if (!resolved)
                continue;
        }
        result.material_parameters.push_back(std::move(projected));
    }

    for (const auto& desired : state.postprocess_effects()) {
        if (state.presentation_owner_is_active(desired.owner) && desired.visible)
            result.postprocess_effects.push_back(desired);
    }
    for (const auto scope : {compiled::MaterialPostprocessScope::World,
                             compiled::MaterialPostprocessScope::FullGameViewport}) {
        if (std::ranges::count_if(result.postprocess_effects, [&](const auto& effect) {
                return effect.scope == scope;
            }) > static_cast<std::ptrdiff_t>(max_postprocess_effects_per_scope))
            diagnostics.push_back(invalid("presentation.postprocess_stack_limit",
                                          "Effective postprocess stack exceeds its bounded scope"));
    }

    for (const auto& mount : state.mounted_layouts()) {
        if (!state.presentation_owner_is_active(mount.owner))
            continue;
        if (std::any_of(result.layouts.begin(), result.layouts.end(), [&](const auto& value) {
                return value.key == mount.key && value.owner == mount.owner;
            })) {
            diagnostics.push_back(invalid("presentation.duplicate_layout_identity",
                                          "Multiple active mounted Layout records share one "
                                          "owner-qualified stable identity"));
            continue;
        }
        const auto* layout_definition = project.find_layout(mount.layout);
        if (layout_definition == nullptr) {
            diagnostics.push_back(unresolved("Layout", mount.layout.text()));
            continue;
        }
        if (!valid_layout_policy(mount.policy) ||
            !valid_layout_scale_overrides(mount.scale_overrides)) {
            diagnostics.push_back(
                invalid("presentation.invalid_layout_policy",
                        "Mounted Layout policy contains an invalid or not-yet-supported value"));
            continue;
        }
        auto inputs = state.resolve_layout_inputs(project, mount);
        if (!inputs) {
            append_diagnostics(diagnostics, std::move(inputs).error());
            continue;
        }
        std::vector<PresentationLayoutStateValue> state_values;
        if (layout_definition->contract.state) {
            if (!mount.occurrence) {
                diagnostics.push_back(
                    invalid("presentation.layout_state_missing_occurrence",
                            "Stateful mounted Layout is missing its Mount occurrence identity"));
                continue;
            }
            std::vector<LayoutStateScope> scopes;
            if (std::holds_alternative<CurrentRoomPresentationOwner>(mount.owner)) {
                scopes = {LayoutStateScope::Visit, LayoutStateScope::Room,
                          LayoutStateScope::Session};
            } else if (std::holds_alternative<RoomPresentationOwner>(mount.owner)) {
                scopes = {LayoutStateScope::Room, LayoutStateScope::Session};
            } else if (std::holds_alternative<ScenePresentationOwner>(mount.owner)) {
                scopes = {LayoutStateScope::Flow, LayoutStateScope::Session};
            } else if (std::holds_alternative<DialoguePresentationOwner>(mount.owner)) {
                scopes = {LayoutStateScope::Flow, LayoutStateScope::Session};
            } else if (std::holds_alternative<SessionPresentationOwner>(mount.owner)) {
                scopes = {LayoutStateScope::Session};
            }
            bool state_valid = true;
            for (const auto scope : scopes) {
                auto value =
                    state.layout_state(project, mount.owner, mount.key, *mount.occurrence, scope);
                if (!value) {
                    append_diagnostics(diagnostics, std::move(value).error());
                    state_valid = false;
                    break;
                }
                state_values.push_back(
                    PresentationLayoutStateValue{scope, std::move(*value.value_if())});
            }
            if (!state_valid)
                continue;
        }
        result.layouts.push_back(PresentationMountedLayout{
            mount.key, mount.owner, mount.layout, mount.policy, mount.scale_overrides,
            mount.composition_group, mount.occurrence, std::move(*inputs.value_if()),
            mount.connected_signals, layout_definition->contract.state, std::move(state_values)});
    }
    for (const auto& stage_layout : stage_layouts) {
        const auto* layout_definition = project.find_layout(stage_layout.layout);
        if (layout_definition == nullptr) {
            diagnostics.push_back(unresolved("Scene Stage Layout", stage_layout.layout.text()));
            continue;
        }
        auto scoped = ScopedLayoutInstanceId::create(
            "scene-stage-" + std::to_string(stage_layout.owner.invocation.number()) + "-" +
            stage_layout.occurrence_key);
        if (!scoped) {
            append_diagnostics(diagnostics, std::move(scoped.error()));
            continue;
        }
        MountedLayoutPolicy policy;
        policy.plane = PresentationPlane::GameUi;
        policy.local_order = stage_layout.order;
        policy.clock = LayoutClockDomain::Gameplay;
        policy.input = LayoutInputMode::Normal;
        policy.gameplay_pause = GameplayPausePolicy::Continue;
        policy.visibility =
            stage_layout.visible ? LayoutVisibility::Visible : LayoutVisibility::Hidden;
        policy.escape_dismissal = EscapeDismissalPolicy::Ignore;
        result.layouts.push_back(PresentationMountedLayout{ScopedLayoutMountKey{*scoped.value_if()},
                                                           PresentationOwner{stage_layout.owner},
                                                           stage_layout.layout,
                                                           policy,
                                                           {},
                                                           PresentationCompositionGroup::Interface,
                                                           std::nullopt,
                                                           {},
                                                           {},
                                                           layout_definition->contract.state,
                                                           {}});
    }

    validate_text_and_choice(project, world, state, diagnostics);
    result.text_and_choice = {state.presented_text(), state.active_choice()};

    result.active_audio_owners.push_back(state.session_presentation_owner());
    result.active_audio_owners.push_back(state.shell_presentation_owner());
    if (const auto room_owner = state.current_room_presentation_owner()) {
        result.active_audio_owners.push_back(*room_owner);
        result.active_audio_owners.push_back(RoomPresentationOwner{room_owner->room});
    }
    for (const auto& frame : state.flow_stack()) {
        if (const auto* scene = std::get_if<SceneFrame>(&frame))
            result.active_audio_owners.push_back(
                ScenePresentationOwner{scene->frame_id, scene->scene});
        else if (const auto* dialogue = std::get_if<DialogueFrame>(&frame))
            result.active_audio_owners.push_back(
                DialoguePresentationOwner{dialogue->frame_id, dialogue->dialogue});
    }
    std::sort(result.active_audio_owners.begin(), result.active_audio_owners.end());
    result.active_audio_owners.erase(
        std::unique(result.active_audio_owners.begin(), result.active_audio_owners.end()),
        result.active_audio_owners.end());

    for (const auto& audio : state.desired_audio()) {
        if (!state.presentation_owner_is_active(audio.owner))
            continue;
        if (duplicate_key(result.desired_audio, std::pair{audio.owner, audio.instance},
                          [](const PresentationDesiredAudio& value) {
                              return std::pair{value.owner, value.instance};
                          })) {
            diagnostics.push_back(
                invalid("presentation.duplicate_desired_audio_identity",
                        "Multiple desired audio records share one stable identity"));
            continue;
        }
        validate_asset(project, std::optional<AssetId>{audio.asset}, compiled::AssetKind::Audio,
                       "desired audio asset", diagnostics);
        auto resolved_pan =
            state.resolve_audio_pan(project, audio.owner, audio.pan, audio.pan_source);
        if (!resolved_pan) {
            append_diagnostics(diagnostics, std::move(resolved_pan).error());
            continue;
        }
        result.desired_audio.push_back({audio.instance, audio.owner, audio.purpose,
                                        audio.pause_policy, audio.asset, audio.gain,
                                        *resolved_pan.value_if(), audio.pan_source, audio.fade_in,
                                        audio.fade_out, audio.replacement_key});
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

Result<bool, Diagnostics> RuntimePresentationSnapshotPublisher::reproject(
    const CompiledProject& project, const runtime::RuntimeWorld& world, const SessionState& state,
    const ResolvedRoomPresentation* room_presentation)
{
    auto candidate = PresentationProjector::project(project, world, state, room_presentation);
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
