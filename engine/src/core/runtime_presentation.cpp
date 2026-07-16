#include "noveltea/core/runtime_presentation.hpp"

#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <limits>
#include <string>
#include <tuple>

namespace noveltea::core {
namespace {
Diagnostic unresolved(std::string family, const std::string& id)
{
    return Diagnostic{.code = "presentation.unresolved_reference",
                      .message = "Unresolved " + std::move(family) + " reference: " + id};
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

std::optional<compiled::BackgroundPresentation> effective_background(const CompiledProject& project,
                                                                     const SessionState& state)
{
    std::optional<compiled::BackgroundPresentation> result;
    if (state.room_visit()) {
        const auto* room = project.find_room(state.room_visit()->room);
        if (room != nullptr)
            result = room->background;
    }
    std::uint64_t selected_precedence = 0;
    for (const auto& override : state.background_overrides()) {
        const auto precedence = background_precedence(state, override.owner);
        if (precedence && *precedence >= selected_precedence) {
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
} // namespace

Result<RuntimePresentationSnapshot, Diagnostics>
PresentationProjector::project(const CompiledProject& project, const SessionState& state)
{
    RuntimePresentationSnapshot result;
    Diagnostics diagnostics;
    result.mode = mode_of(state.mode());
    if (const auto* room = std::get_if<RoomMode>(&state.mode())) {
        result.current_room = room->room;
        if (project.find_room(room->room) == nullptr)
            diagnostics.push_back(unresolved("current Room", room->room.text()));
    }

    const auto background = effective_background(project, state);
    if (background) {
        validate_asset(project, background->asset, compiled::AssetKind::Image,
                       "background image asset", diagnostics);
        result.background = PresentationBackground{background->asset, background->color,
                                                   background->fit, background->material};
    }

    for (const auto& actor : state.actors()) {
        if (presentation_authority(actor.owner) != PresentationAuthority::Gameplay ||
            !state.presentation_owner_is_active(actor.owner))
            continue;
        validate_actor_key(project, actor.key, diagnostics);
        const auto* character = project.find_character(actor.character);
        if (character == nullptr) {
            diagnostics.push_back(unresolved("Character", actor.character.text()));
            continue;
        }
        const auto pose = std::find_if(character->poses.begin(), character->poses.end(),
                                       [&](const auto& value) { return value.id == actor.pose; });
        const auto expression =
            std::find_if(character->expressions.begin(), character->expressions.end(),
                         [&](const auto& value) { return value.id == actor.expression; });
        if (pose == character->poses.end())
            diagnostics.push_back(unresolved("Character pose", actor.pose.text()));
        if (expression == character->expressions.end())
            diagnostics.push_back(unresolved("Character expression", actor.expression.text()));
        if (pose == character->poses.end() || expression == character->expressions.end())
            continue;
        validate_asset(project, pose->sprite, compiled::AssetKind::Image, "Character pose sprite",
                       diagnostics);
        validate_asset(project, expression->sprite, compiled::AssetKind::Image,
                       "Character expression sprite", diagnostics);
        result.actors.push_back(PresentationActor{
            actor.key, actor.character, actor.pose, actor.expression, pose->sprite, pose->material,
            pose->anchor, pose->offset, pose->scale, expression->sprite, expression->material,
            actor.placement, actor.visible, actor.presentation_complete});
    }

    for (const auto& mount : state.mounted_layouts()) {
        if (presentation_authority(mount.owner) != PresentationAuthority::Gameplay ||
            !state.presentation_owner_is_active(mount.owner))
            continue;
        const auto* overlay = std::get_if<RoomOverlayLayoutMountKey>(&mount.key);
        if (overlay == nullptr)
            continue;
        const auto* room = project.find_room(overlay->room);
        if (room == nullptr) {
            diagnostics.push_back(unresolved("overlay Room", overlay->room.text()));
            continue;
        }
        const auto definition =
            std::find_if(room->overlays.begin(), room->overlays.end(),
                         [&](const auto& value) { return value.id == overlay->overlay; });
        if (definition == room->overlays.end()) {
            diagnostics.push_back(unresolved("Room overlay", overlay->overlay.text()));
            continue;
        }
        if (project.find_layout(mount.layout) == nullptr)
            diagnostics.push_back(unresolved("overlay Layout", mount.layout.text()));
        result.overlays.push_back({overlay->room, overlay->overlay, mount.layout,
                                   mount.policy.visibility == LayoutVisibility::Visible});
    }

    for (const auto& mount : state.mounted_layouts()) {
        if (presentation_authority(mount.owner) != PresentationAuthority::Gameplay ||
            !state.presentation_owner_is_active(mount.owner))
            continue;
        const auto* reserved = std::get_if<ReservedLayoutMountKey>(&mount.key);
        if (reserved == nullptr)
            continue;
        if (project.find_layout(mount.layout) == nullptr)
            diagnostics.push_back(unresolved("Layout", mount.layout.text()));
        result.layout_slots.push_back({reserved->slot, mount.layout});
    }
    validate_text_and_choice(project, state, diagnostics);
    result.text_and_choice = {state.presented_text(), state.active_choice()};
    if (state.transition())
        result.transition = PresentationLogicalTransition{
            state.transition()->kind, state.transition()->color, state.transition()->complete};

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

    std::sort(result.actors.begin(), result.actors.end(),
              [](const auto& a, const auto& b) { return a.key < b.key; });
    std::sort(result.overlays.begin(), result.overlays.end(), [](const auto& a, const auto& b) {
        return std::tie(a.room, a.overlay) < std::tie(b.room, b.overlay);
    });
    std::sort(result.layout_slots.begin(), result.layout_slots.end(),
              [](const auto& a, const auto& b) { return a.slot < b.slot; });
    std::sort(result.audio_channels.begin(), result.audio_channels.end(),
              [](const auto& a, const auto& b) { return a.channel < b.channel; });

    std::sort(diagnostics.begin(), diagnostics.end(), [](const auto& a, const auto& b) {
        return std::tie(a.code, a.message) < std::tie(b.code, b.message);
    });
    if (!diagnostics.empty())
        return Result<RuntimePresentationSnapshot, Diagnostics>::failure(std::move(diagnostics));
    return Result<RuntimePresentationSnapshot, Diagnostics>::success(std::move(result));
}

Result<bool, Diagnostics>
RuntimePresentationSnapshotPublisher::reproject(const CompiledProject& project,
                                                const SessionState& state)
{
    auto candidate = PresentationProjector::project(project, state);
    if (!candidate)
        return Result<bool, Diagnostics>::failure(candidate.error());

    auto* candidate_value = candidate.value_if();
    auto value = std::move(*candidate_value);
    if (m_published) {
        value.revision = m_published->revision;
        if (value == *m_published)
            return Result<bool, Diagnostics>::success(false);
        if (m_published->revision == std::numeric_limits<std::uint64_t>::max())
            return Result<bool, Diagnostics>::failure(Diagnostics{
                Diagnostic{.code = "presentation.snapshot_revision_exhausted",
                           .message = "Runtime presentation snapshot revision exhausted"}});
        value.revision = m_published->revision + 1;
    } else {
        value.revision = 1;
    }
    m_published = std::move(value);
    return Result<bool, Diagnostics>::success(true);
}

const RuntimePresentationSnapshot* RuntimePresentationSnapshotPublisher::published() const noexcept
{
    return m_published ? &*m_published : nullptr;
}
} // namespace noveltea::core
