#include "noveltea/core/session_state.hpp"
#include "noveltea/core/layout_policies.hpp"
#include "noveltea/core/property_resolver.hpp"

#include <algorithm>
#include <atomic>
#include <bit>
#include <cmath>
#include <limits>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

std::atomic<std::uint64_t> g_next_presentation_session_id{1};
std::atomic<std::uint64_t> g_next_shell_presentation_scope_id{1};
std::atomic<std::uint64_t> g_next_room_visit_instance_id{1};

template<class Id>
std::optional<Id> allocate_process_identity(std::atomic<std::uint64_t>& next) noexcept
{
    std::uint64_t current = next.load(std::memory_order_relaxed);
    while (current != std::numeric_limits<std::uint64_t>::max()) {
        if (next.compare_exchange_weak(current, current + 1, std::memory_order_relaxed,
                                       std::memory_order_relaxed))
            return Id::from_number(current);
    }
    return std::nullopt;
}

Diagnostics feature_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool material_parameter_value_matches(compiled::MaterialParameterType type,
                                      const compiled::MaterialParameterValue& value) noexcept
{
    switch (type) {
    case compiled::MaterialParameterType::Float:
        return std::holds_alternative<double>(value);
    case compiled::MaterialParameterType::Vec2:
        return std::holds_alternative<std::array<double, 2>>(value);
    case compiled::MaterialParameterType::Vec3:
        return std::holds_alternative<std::array<double, 3>>(value);
    case compiled::MaterialParameterType::Vec4:
        return std::holds_alternative<std::array<double, 4>>(value);
    case compiled::MaterialParameterType::Color:
        return std::holds_alternative<compiled::MaterialColorValue>(value);
    case compiled::MaterialParameterType::Int:
        return std::holds_alternative<std::int64_t>(value);
    case compiled::MaterialParameterType::Bool:
        return std::holds_alternative<bool>(value);
    }
    return false;
}

bool material_parameter_value_finite(const compiled::MaterialParameterValue& value) noexcept
{
    return std::visit(
        [](const auto& item) {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, double>)
                return std::isfinite(item);
            else if constexpr (std::is_same_v<T, std::array<double, 2>> ||
                               std::is_same_v<T, std::array<double, 3>> ||
                               std::is_same_v<T, std::array<double, 4>>)
                return std::all_of(item.begin(), item.end(),
                                   [](double component) { return std::isfinite(component); });
            else if constexpr (std::is_same_v<T, compiled::MaterialColorValue>)
                return std::isfinite(item.r) && std::isfinite(item.g) && std::isfinite(item.b) &&
                       std::isfinite(item.a);
            else
                return true;
        },
        value);
}

bool property_can_drive_material_parameter(const PropertyDefinition& property,
                                           compiled::MaterialParameterType type) noexcept
{
    switch (type) {
    case compiled::MaterialParameterType::Float:
        return std::holds_alternative<NumberPropertyType>(property.value_type()) ||
               std::holds_alternative<IntegerPropertyType>(property.value_type());
    case compiled::MaterialParameterType::Int:
        return std::holds_alternative<IntegerPropertyType>(property.value_type());
    case compiled::MaterialParameterType::Bool:
        return std::holds_alternative<BooleanPropertyType>(property.value_type());
    default:
        return false;
    }
}

std::string runtime_mode_text(const RuntimeMode& mode)
{
    if (std::holds_alternative<RoomMode>(mode))
        return "room";
    if (std::holds_alternative<FlowMode>(mode))
        return "flow";
    return "ended";
}

Result<RuntimeValue, Diagnostics> resolve_layout_input_source(const CompiledProject& project,
                                                              SessionState& state,
                                                              const LayoutInputSource& source)
{
    return std::visit(
        [&](const auto& value) -> Result<RuntimeValue, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, LayoutLiteralInput>) {
                if (!runtime_value_is_finite(value.value))
                    return Result<RuntimeValue, Diagnostics>::failure(feature_error(
                        "runtime.layout_input_non_finite", "Layout literal input must be finite"));
                return Result<RuntimeValue, Diagnostics>::success(value.value);
            } else if constexpr (std::is_same_v<T, LayoutVariableBinding>) {
                PropertyResolver resolver(project, state);
                auto result = resolver.get_global(value.variable);
                if (!result)
                    return Result<RuntimeValue, Diagnostics>::failure(std::move(result).error());
                if (const auto* resolved = std::get_if<RuntimeValue>(result.value_if()))
                    return Result<RuntimeValue, Diagnostics>::success(*resolved);
                return Result<RuntimeValue, Diagnostics>::success(RuntimeValue{std::monostate{}});
            } else if constexpr (std::is_same_v<T, LayoutPropertyBinding>) {
                PropertyResolver resolver(project, state);
                return std::visit(
                    [&](const auto& target) -> Result<RuntimeValue, Diagnostics> {
                        using Target = std::decay_t<decltype(target)>;
                        if constexpr (std::is_same_v<Target, GlobalPropertyTarget>) {
                            auto result = resolver.get_global(value.property);
                            if (!result)
                                return Result<RuntimeValue, Diagnostics>::failure(
                                    std::move(result).error());
                            if (const auto* resolved = std::get_if<RuntimeValue>(result.value_if()))
                                return Result<RuntimeValue, Diagnostics>::success(*resolved);
                        } else {
                            auto result = resolver.get(PropertyOwnerRef{target}, value.property);
                            if (!result)
                                return Result<RuntimeValue, Diagnostics>::failure(
                                    std::move(result).error());
                            if (const auto* resolved = std::get_if<RuntimeValue>(result.value_if()))
                                return Result<RuntimeValue, Diagnostics>::success(*resolved);
                        }
                        return Result<RuntimeValue, Diagnostics>::success(
                            RuntimeValue{std::monostate{}});
                    },
                    value.target);
            } else {
                switch (value.facet) {
                case LayoutStandardFacet::RuntimeMode:
                    return Result<RuntimeValue, Diagnostics>::success(
                        RuntimeValue{runtime_mode_text(state.mode())});
                case LayoutStandardFacet::CurrentRoom:
                    return Result<RuntimeValue, Diagnostics>::success(
                        state.room_visit() ? RuntimeValue{state.room_visit()->room.text()}
                                           : RuntimeValue{std::monostate{}});
                case LayoutStandardFacet::GameplayPaused:
                    return Result<RuntimeValue, Diagnostics>::success(
                        RuntimeValue{state.gameplay_paused()});
                }
            }
            return Result<RuntimeValue, Diagnostics>::failure(feature_error(
                "runtime.invalid_layout_input_source", "Layout input source is invalid"));
        },
        source);
}

const compiled::RoomDefinition* runtime_room(const SessionState& state, const RoomId& id) noexcept
{
    const auto found = std::find_if(state.runtime_rooms().begin(), state.runtime_rooms().end(),
                                    [&](const auto& value) { return value.id == id; });
    return found == state.runtime_rooms().end() ? nullptr : &found->effective_configuration();
}

const compiled::CharacterDefinition* runtime_character(const SessionState& state,
                                                       const CharacterId& id) noexcept
{
    const auto found =
        std::find_if(state.runtime_characters().begin(), state.runtime_characters().end(),
                     [&](const auto& value) { return value.id == id; });
    return found == state.runtime_characters().end() ? nullptr : &found->effective_configuration();
}

const compiled::InteractableDefinition*
runtime_interactable(const SessionState& state, const InteractableInstanceId& id) noexcept
{
    const auto found =
        std::find_if(state.runtime_interactables().begin(), state.runtime_interactables().end(),
                     [&](const auto& value) { return value.id == id; });
    return found == state.runtime_interactables().end() ? nullptr
                                                        : &found->effective_configuration();
}

bool valid_room_placement(const SessionState& state,
                          const compiled::RoomPlacementRef& placement) noexcept
{
    const auto* room = runtime_room(state, placement.room);
    return room != nullptr && std::any_of(room->placements.begin(), room->placements.end(),
                                          [&placement](const compiled::RoomPlacement& item) {
                                              return item.id == placement.placement_id;
                                          });
}

template<class Variant, class Id>
bool variant_has_id(const std::vector<Variant>& values, const Id& id) noexcept
{
    return std::any_of(values.begin(), values.end(), [&id](const Variant& value) {
        return std::visit([&id](const auto& item) { return item.id == id; }, value);
    });
}

const compiled::ActorCueInstruction* find_actor_cue(const compiled::SceneDefinition& scene,
                                                    const SceneActorKey& key,
                                                    const CharacterId& character) noexcept
{
    for (const auto& instruction : scene.program.instructions) {
        const auto* cue = std::get_if<compiled::ActorCueInstruction>(&instruction);
        if (cue != nullptr && cue->slot_id == key.slot && cue->character == character)
            return cue;
    }
    return nullptr;
}

bool valid_character_state(const compiled::CharacterDefinition& character,
                           const DesiredActorPresentation& actor) noexcept
{
    const auto profile = std::find_if(character.profiles.begin(), character.profiles.end(),
                                      [&](const auto& item) { return item.id == actor.profile; });
    if (profile == character.profiles.end())
        return false;
    const auto pose = std::find_if(
        profile->poses.begin(), profile->poses.end(),
        [&actor](const compiled::CharacterPose& item) { return item.id == actor.pose; });
    const auto expression = std::find_if(character.expressions.begin(), character.expressions.end(),
                                         [&actor](const compiled::CharacterExpression& item) {
                                             return item.id == actor.expression;
                                         });
    const bool idle_valid =
        !actor.idle || std::any_of(character.idles.begin(), character.idles.end(),
                                   [&actor](const compiled::CharacterIdle& item) {
                                       return item.id == *actor.idle;
                                   });
    const bool appearance_valid =
        !actor.appearance || std::any_of(character.appearances.begin(), character.appearances.end(),
                                         [&actor](const compiled::CharacterAppearance& item) {
                                             return item.id == *actor.appearance;
                                         });
    return pose != profile->poses.end() && expression != character.expressions.end() &&
           appearance_valid && idle_valid &&
           actor.placement.position <= compiled::ActorPosition::Custom &&
           std::isfinite(actor.placement.offset.x) && std::isfinite(actor.placement.offset.y) &&
           std::isfinite(actor.placement.scale) && actor.placement.scale > 0.0;
}

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

std::optional<MaterialId>
resolved_actor_layer_material(const compiled::CharacterDefinition& character,
                              const DesiredActorPresentation& actor,
                              const CharacterPresentationLayerId& layer_id) noexcept
{
    const auto profile = std::ranges::find_if(
        character.profiles, [&](const auto& candidate) { return candidate.id == actor.profile; });
    if (profile == character.profiles.end())
        return std::nullopt;
    const auto pose = std::ranges::find_if(
        profile->poses, [&](const auto& candidate) { return candidate.id == actor.pose; });
    if (pose == profile->poses.end())
        return std::nullopt;
    const auto layer = std::ranges::find_if(
        pose->layers, [&](const auto& candidate) { return candidate.layer_id == layer_id; });
    if (layer == pose->layers.end())
        return std::nullopt;
    auto result = layer->material;
    const auto expression = std::ranges::find_if(character.expressions, [&](const auto& candidate) {
        return candidate.id == actor.expression;
    });
    const auto default_expression =
        std::ranges::find_if(character.expressions, [&](const auto& candidate) {
            return candidate.id == character.defaults.expression_id;
        });
    const compiled::CharacterProfileLayerOverrides* expression_overrides = nullptr;
    if (expression != character.expressions.end())
        expression_overrides = profile_overrides(&*expression, actor.profile);
    if (expression_overrides == nullptr && expression != default_expression &&
        default_expression != character.expressions.end())
        expression_overrides = profile_overrides(&*default_expression, actor.profile);
    const auto apply_material = [&](const compiled::CharacterProfileLayerOverrides* overrides) {
        if (overrides == nullptr)
            return;
        const auto item = std::ranges::find_if(overrides->layers, [&](const auto& candidate) {
            return candidate.layer_id == layer_id;
        });
        if (item != overrides->layers.end() && item->material.specified)
            result = item->material.value;
    };
    apply_material(expression_overrides);
    if (actor.appearance) {
        const auto appearance =
            std::ranges::find_if(character.appearances, [&](const auto& candidate) {
                return candidate.id == *actor.appearance;
            });
        if (appearance != character.appearances.end())
            apply_material(profile_overrides(&*appearance, actor.profile));
    }
    return result;
}

bool has_inventory_id(const std::vector<compiled::InventoryDefinition>& inventories,
                      const InventoryId& id) noexcept
{
    return std::any_of(inventories.begin(), inventories.end(),
                       [&](const auto& inventory) { return inventory.id == id; });
}

bool runtime_inventory_exists(const CompiledProject& project, const SessionState& state,
                              const compiled::InventoryRef& inventory) noexcept
{
    return std::visit(
        [&](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::ProjectInventoryOwner>)
                return has_inventory_id(project.inventories(), inventory.inventory_id);
            else if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>) {
                const auto* definition = runtime_character(state, owner.character);
                return definition &&
                       has_inventory_id(definition->inventories, inventory.inventory_id);
            } else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>) {
                const auto* definition = runtime_interactable(state, owner.interactable);
                return definition &&
                       has_inventory_id(definition->inventories, inventory.inventory_id);
            } else if constexpr (std::is_same_v<T, RoomFeatureRef>) {
                const auto* definition = runtime_room(state, owner.room);
                if (!definition)
                    return false;
                const auto feature = std::find_if(
                    definition->features.begin(), definition->features.end(),
                    [&](const auto& value) { return value.identity.id == owner.feature_id; });
                return feature != definition->features.end() &&
                       has_inventory_id(feature->inventories, inventory.inventory_id);
            } else {
                const auto* definition = runtime_interactable(state, owner.interactable);
                if (!definition)
                    return false;
                const auto feature = std::find_if(
                    definition->features.begin(), definition->features.end(),
                    [&](const auto& value) { return value.identity.id == owner.feature_id; });
                return feature != definition->features.end() &&
                       has_inventory_id(feature->inventories, inventory.inventory_id);
            }
        },
        inventory.owner);
}

bool valid_interactable_location(const CompiledProject& project,
                                 const compiled::InteractableLocation& location) noexcept
{
    if (const auto* room = std::get_if<compiled::RoomLocation>(&location))
        return project.find_room(room->room) != nullptr;
    if (const auto* inventory = std::get_if<compiled::InventoryLocation>(&location))
        return project.find_inventory(inventory->inventory) != nullptr;
    return true;
}

bool valid_interactable_location(const CompiledProject& project, const SessionState& state,
                                 const compiled::InteractableLocation& location) noexcept
{
    if (const auto* room = std::get_if<compiled::RoomLocation>(&location))
        return runtime_room(state, room->room) != nullptr;
    if (const auto* inventory = std::get_if<compiled::InventoryLocation>(&location))
        return runtime_inventory_exists(project, state, inventory->inventory);
    return true;
}

std::optional<InteractableInstanceId>
inventory_interactable_owner(const compiled::InventoryRef& inventory) noexcept
{
    return std::visit(
        [](const auto& owner) -> std::optional<InteractableInstanceId> {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>)
                return owner.interactable;
            else if constexpr (std::is_same_v<T, InteractableFeatureRef>)
                return owner.interactable;
            else
                return std::nullopt;
        },
        inventory.owner);
}

const compiled::DialogueLineSegment*
find_dialogue_line(const compiled::DialogueDefinition& dialogue,
                   const DialogueSegmentId& segment) noexcept
{
    for (const auto& block : dialogue.program.blocks) {
        const auto* sequence = std::get_if<compiled::DialogueSequenceBlock>(&block);
        if (sequence == nullptr)
            continue;
        for (const auto& item : sequence->segments) {
            const auto* line = std::get_if<compiled::DialogueLineSegment>(&item);
            if (line != nullptr && line->id == segment)
                return line;
        }
    }
    return nullptr;
}

bool has_dialogue_choice_edge(const compiled::DialogueDefinition& dialogue,
                              const DialogueEdgeId& edge) noexcept
{
    return std::any_of(dialogue.program.edges.begin(), dialogue.program.edges.end(),
                       [&edge](const compiled::DialogueEdge& item) {
                           const auto* choice = std::get_if<compiled::DialogueChoiceEdge>(&item);
                           return choice != nullptr && choice->id == edge;
                       });
}

template<class Key>
std::uint64_t history_count(const std::vector<std::pair<Key, std::uint64_t>>& values,
                            const Key& key) noexcept
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&key](const auto& item) { return item.first == key; });
    return found == values.end() ? 0 : found->second;
}

template<class Key>
Result<void, Diagnostics> increment_history(std::vector<std::pair<Key, std::uint64_t>>& values,
                                            const Key& key)
{
    const auto found = std::find_if(values.begin(), values.end(),
                                    [&key](const auto& item) { return item.first == key; });
    if (found == values.end()) {
        values.emplace_back(key, 1);
        return Result<void, Diagnostics>::success();
    }
    if (found->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.history_overflow", "Feature history counter cannot be incremented"));
    ++found->second;
    return Result<void, Diagnostics>::success();
}

bool valid_scene_log_origin(const CompiledProject& project,
                            const SceneTextLogOrigin& origin) noexcept
{
    const auto* scene = project.find_scene(origin.scene);
    if (scene == nullptr)
        return false;
    return std::any_of(scene->program.instructions.begin(), scene->program.instructions.end(),
                       [&origin](const compiled::SceneInstruction& instruction) {
                           const auto* text =
                               std::get_if<compiled::ShowTextInstruction>(&instruction);
                           return text != nullptr && text->id == origin.step;
                       });
}

bool valid_dialogue_line_origin(const CompiledProject& project,
                                const DialogueLineTextLogOrigin& origin) noexcept
{
    const auto* dialogue = project.find_dialogue(origin.dialogue);
    return dialogue != nullptr && find_dialogue_line(*dialogue, origin.segment) != nullptr;
}

bool valid_dialogue_choice_origin(const CompiledProject& project,
                                  const DialogueChoiceTextLogOrigin& origin) noexcept
{
    const auto* dialogue = project.find_dialogue(origin.dialogue);
    return dialogue != nullptr && has_dialogue_choice_edge(*dialogue, origin.edge);
}

bool valid_interaction_log_origin(const CompiledProject& project,
                                  const InteractionTextLogOrigin& origin) noexcept
{
    const auto* interaction = project.find_interaction(origin.interaction);
    if (interaction == nullptr)
        return false;
    return std::any_of(interaction->rules.begin(), interaction->rules.end(),
                       [&origin](const compiled::InteractionRule& rule) {
                           return std::any_of(
                               rule.program.instructions.begin(), rule.program.instructions.end(),
                               [&origin](const compiled::InteractionInstruction& instruction) {
                                   const auto* notification =
                                       std::get_if<compiled::NotifyInstruction>(&instruction);
                                   return notification != nullptr &&
                                          notification->id == origin.instruction;
                               });
                       });
}

bool text_log_kind_matches_origin(TextLogEntryKind kind, const TextLogOrigin& origin) noexcept
{
    switch (kind) {
    case TextLogEntryKind::Line:
        return std::holds_alternative<SceneTextLogOrigin>(origin) ||
               std::holds_alternative<DialogueLineTextLogOrigin>(origin);
    case TextLogEntryKind::Choice:
        return std::holds_alternative<DialogueChoiceTextLogOrigin>(origin);
    case TextLogEntryKind::Notification:
        return std::holds_alternative<InteractionTextLogOrigin>(origin) ||
               std::holds_alternative<SystemTextLogOrigin>(origin);
    }
    return false;
}

bool valid_text_log_origin(const CompiledProject& project, const TextLogOrigin& origin) noexcept
{
    return std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneTextLogOrigin>)
                return valid_scene_log_origin(project, value);
            else if constexpr (std::is_same_v<T, DialogueLineTextLogOrigin>)
                return valid_dialogue_line_origin(project, value);
            else if constexpr (std::is_same_v<T, DialogueChoiceTextLogOrigin>)
                return valid_dialogue_choice_origin(project, value);
            else if constexpr (std::is_same_v<T, InteractionTextLogOrigin>)
                return valid_interaction_log_origin(project, value);
            else
                return true;
        },
        origin);
}

bool valid_background(const CompiledProject& project,
                      const compiled::BackgroundPresentation& background) noexcept
{
    return background.fit <= compiled::BackgroundFit::Center &&
           (!background.asset || project.find_asset(*background.asset) != nullptr);
}

bool valid_camera_view(const compiled::CameraView& view) noexcept
{
    return std::isfinite(view.center.x) && std::isfinite(view.center.y) &&
           std::isfinite(view.zoom) && view.zoom > 0.0 && std::isfinite(view.rotation_degrees);
}

bool valid_plane(PresentationPlane plane) noexcept { return plane <= PresentationPlane::Debug; }

bool valid_layout_policy(const MountedLayoutPolicy& policy) noexcept
{
    return valid_plane(policy.plane) && policy.clock <= LayoutClockDomain::UnscaledPresentation &&
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

bool owner_matches_scene_key(const PresentationOwner& owner, const SceneActorKey& key) noexcept
{
    const auto* scene_owner = std::get_if<ScenePresentationOwner>(&owner);
    return scene_owner != nullptr && *scene_owner == key.owner;
}

bool valid_prop_bounds(const compiled::NormalizedRect& bounds) noexcept
{
    return std::isfinite(bounds.x) && std::isfinite(bounds.y) && std::isfinite(bounds.width) &&
           std::isfinite(bounds.height) && bounds.width >= 0.0 && bounds.height >= 0.0;
}

bool valid_scene_choice(const CompiledProject& project, const SceneChoiceState& state) noexcept
{
    const auto* scene = project.find_scene(state.scene);
    if (scene == nullptr || state.options.empty())
        return false;
    const compiled::ChoiceSceneInstruction* choice = nullptr;
    for (const auto& instruction : scene->program.instructions) {
        const auto* candidate = std::get_if<compiled::ChoiceSceneInstruction>(&instruction);
        if (candidate != nullptr && candidate->id == state.step) {
            choice = candidate;
            break;
        }
    }
    if (choice == nullptr)
        return false;
    std::vector<SceneChoiceOptionId> seen;
    for (const auto& option : state.options) {
        if (std::find(seen.begin(), seen.end(), option.option) != seen.end() ||
            std::none_of(choice->options.begin(), choice->options.end(),
                         [&option](const compiled::SceneChoiceOption& item) {
                             return item.id == option.option;
                         }))
            return false;
        seen.push_back(option.option);
    }
    return true;
}

bool valid_dialogue_choice(const CompiledProject& project,
                           const DialogueChoiceState& state) noexcept
{
    const auto* dialogue = project.find_dialogue(state.dialogue);
    if (dialogue == nullptr || state.options.empty())
        return false;
    const bool choice_block =
        std::any_of(dialogue->program.blocks.begin(), dialogue->program.blocks.end(),
                    [&state](const compiled::DialogueBlock& block) {
                        const auto* choice = std::get_if<compiled::DialogueChoiceBlock>(&block);
                        return choice != nullptr && choice->id == state.block;
                    });
    if (!choice_block)
        return false;
    std::vector<DialogueEdgeId> seen;
    for (const auto& option : state.options) {
        const bool exists =
            std::any_of(dialogue->program.edges.begin(), dialogue->program.edges.end(),
                        [&state, &option](const compiled::DialogueEdge& edge) {
                            const auto* choice = std::get_if<compiled::DialogueChoiceEdge>(&edge);
                            return choice != nullptr && choice->id == option.edge &&
                                   choice->from_block_id == state.block;
                        });
        if (!exists || option.markup > TextMarkup::ActiveText ||
            std::find(seen.begin(), seen.end(), option.edge) != seen.end())
            return false;
        seen.push_back(option.edge);
    }
    return true;
}

std::optional<SceneStepId> first_scene_step(const compiled::SceneDefinition& scene)
{
    if (scene.program.instructions.empty())
        return std::nullopt;
    return std::visit([](const auto& instruction) { return instruction.id; },
                      scene.program.instructions.front());
}

std::vector<compiled::SceneInputBinding>
initial_scene_inputs(const compiled::SceneDefinition& scene)
{
    std::vector<compiled::SceneInputBinding> inputs;
    inputs.reserve(scene.inputs.size());
    for (const auto& input : scene.inputs) {
        if (input.default_value)
            inputs.push_back({input.id, *input.default_value});
        else if (input.nullable)
            inputs.push_back({input.id, RuntimeValue{std::monostate{}}});
    }
    return inputs;
}

Result<FlowStack, Diagnostics> initial_flow_stack(const CompiledProject& project,
                                                  const FlowFrameId& frame_id)
{
    FlowStack stack;
    const bool valid = std::visit(
        [&project, &stack, &frame_id](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>) {
                if (project.find_room(id) == nullptr)
                    return false;
                stack.emplace_back(RoomTransitionFrame{
                    .frame_id = frame_id,
                    .source_room = std::nullopt,
                    .target_room = id,
                    .selected_exit = std::nullopt,
                    .kind = RoomTransitionKind::DirectedRoomChange,
                    .entry_cause = RoomEntryCause::Entrypoint,
                    .source_context = std::nullopt,
                    .position = {RoomTransitionStage::TargetCanEnter, 0},
                });
                return true;
            } else if constexpr (std::is_same_v<T, SceneId>) {
                const auto* scene = project.find_scene(id);
                if (scene == nullptr)
                    return false;
                stack.emplace_back(SceneFrame{frame_id,
                                              id,
                                              {first_scene_step(*scene), {}},
                                              NoReturnDestination{},
                                              initial_scene_inputs(*scene),
                                              std::nullopt,
                                              std::nullopt,
                                              std::nullopt});
                return true;
            } else {
                const auto* dialogue = project.find_dialogue(id);
                if (dialogue == nullptr)
                    return false;
                std::vector<DialogueStageSlotRuntimeState> stage_slots;
                stage_slots.reserve(dialogue->stage_slots.size());
                for (const auto& slot : dialogue->stage_slots)
                    stage_slots.push_back({slot.id, slot.initial});
                std::vector<DialogueMediaSlotRuntimeState> media_slots;
                media_slots.reserve(dialogue->media_slots.size());
                for (const auto& slot : dialogue->media_slots)
                    media_slots.push_back({slot.id, slot.initial, slot.visible});
                stack.emplace_back(
                    DialogueFrame{frame_id,
                                  id,
                                  {dialogue->program.entry_block_id, std::nullopt, std::nullopt,
                                   DialogueFramePosition::Stage::EnterBlock, 0},
                                  std::move(stage_slots),
                                  std::move(media_slots),
                                  NoReturnDestination{}});
                return true;
            }
        },
        project.entrypoint());
    if (!valid)
        return Result<FlowStack, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "execution.invalid_entrypoint",
                       .message = "Compiled project entrypoint cannot initialize a flow frame"}});
    return Result<FlowStack, Diagnostics>::success(std::move(stack));
}

Result<LayoutStateScopeOwner, Diagnostics>
resolve_layout_state_scope_owner(const SessionState& state, const PresentationOwner& mount_owner,
                                 LayoutStateScope scope)
{
    if (!state.presentation_owner_is_active(mount_owner) ||
        presentation_authority(mount_owner) != PresentationAuthority::Gameplay)
        return Result<LayoutStateScopeOwner, Diagnostics>::failure(feature_error(
            "runtime.layout_state_stale_mount", "Layout state references an inactive Mount owner"));

    switch (scope) {
    case LayoutStateScope::Visit: {
        const auto* owner = std::get_if<CurrentRoomPresentationOwner>(&mount_owner);
        if (!owner)
            return Result<LayoutStateScopeOwner, Diagnostics>::failure(
                feature_error("runtime.layout_state_scope_mismatch",
                              "Visit Layout state requires an Active Room Context-owned Mount"));
        return Result<LayoutStateScopeOwner, Diagnostics>::success(
            LayoutVisitStateOwner{owner->visit});
    }
    case LayoutStateScope::Room: {
        if (const auto* owner = std::get_if<CurrentRoomPresentationOwner>(&mount_owner))
            return Result<LayoutStateScopeOwner, Diagnostics>::success(
                LayoutRoomStateOwner{owner->room});
        if (const auto* owner = std::get_if<RoomPresentationOwner>(&mount_owner))
            return Result<LayoutStateScopeOwner, Diagnostics>::success(
                LayoutRoomStateOwner{owner->room});
        return Result<LayoutStateScopeOwner, Diagnostics>::failure(
            feature_error("runtime.layout_state_scope_mismatch",
                          "Room Layout state requires an Active Room Context or Room-owned Mount"));
    }
    case LayoutStateScope::Flow: {
        if (const auto* owner = std::get_if<ScenePresentationOwner>(&mount_owner))
            return Result<LayoutStateScopeOwner, Diagnostics>::success(
                LayoutFlowStateOwner{owner->invocation});
        if (const auto* owner = std::get_if<DialoguePresentationOwner>(&mount_owner))
            return Result<LayoutStateScopeOwner, Diagnostics>::success(
                LayoutFlowStateOwner{owner->invocation});
        else
            return Result<LayoutStateScopeOwner, Diagnostics>::failure(
                feature_error("runtime.layout_state_scope_mismatch",
                              "Flow Layout state requires a Flow-owned Mount"));
    }
    case LayoutStateScope::Session:
        return Result<LayoutStateScopeOwner, Diagnostics>::success(
            LayoutSessionStateOwner{state.presentation_session_id()});
    }
    return Result<LayoutStateScopeOwner, Diagnostics>::failure(
        feature_error("runtime.layout_state_scope_invalid", "Layout state scope is invalid"));
}

std::optional<LayoutStateScope> layout_state_scope(const LayoutStateScopeOwner& owner) noexcept
{
    return std::visit(
        [](const auto& scoped) -> std::optional<LayoutStateScope> {
            using T = std::decay_t<decltype(scoped)>;
            if constexpr (std::is_same_v<T, LayoutVisitStateOwner>)
                return LayoutStateScope::Visit;
            else if constexpr (std::is_same_v<T, LayoutRoomStateOwner>)
                return LayoutStateScope::Room;
            else if constexpr (std::is_same_v<T, LayoutFlowStateOwner>)
                return LayoutStateScope::Flow;
            else if constexpr (std::is_same_v<T, LayoutSessionStateOwner>)
                return LayoutStateScope::Session;
            else
                return std::nullopt;
        },
        owner);
}

bool layout_state_slot_applies_to_mount(const SessionState& state, const LayoutStateSlot& slot,
                                        const PresentationOwner& mount_owner)
{
    const auto scope = layout_state_scope(slot.scope_owner);
    if (!scope)
        return false;
    auto resolved = resolve_layout_state_scope_owner(state, mount_owner, *scope);
    return resolved && *resolved.value_if() == slot.scope_owner;
}

} // namespace

Result<SessionState, Diagnostics> SessionState::create(const CompiledProject& project)
{
    const auto presentation_session =
        allocate_process_identity<PresentationSessionId>(g_next_presentation_session_id);
    const auto shell_presentation_scope =
        allocate_process_identity<ShellPresentationScopeId>(g_next_shell_presentation_scope_id);
    if (!presentation_session || !shell_presentation_scope)
        return Result<SessionState, Diagnostics>::failure(
            feature_error("runtime.presentation_identity_exhausted",
                          "Presentation session or shell-scope identities are exhausted"));

    auto stack = initial_flow_stack(project, FlowFrameId{1});
    auto* initial_stack = stack.value_if();
    if (initial_stack == nullptr)
        return Result<SessionState, Diagnostics>::failure(stack.error());
    std::vector<RuntimeRoomConfiguration> rooms;
    rooms.reserve(project.rooms().size());
    for (const auto& definition : project.rooms()) {
        rooms.push_back(RuntimeRoomConfiguration{
            definition.identity.id,
            true,
            CompiledRoomConfigurationSource{definition.identity.id},
            std::nullopt,
            RuntimeInstanceProvenance{RuntimeInstanceProvenanceKind::Declared, std::nullopt,
                                      std::nullopt},
            definition,
            std::nullopt,
            {},
            {},
            {}});
    }

    std::vector<RuntimeInteractableConfiguration> interactable_configurations;
    interactable_configurations.reserve(project.interactable_instances().size());
    std::vector<InteractableState> interactables;
    interactables.reserve(project.interactable_instances().size());
    for (const auto& declaration : project.interactable_instances()) {
        const auto* definition = project.find_interactable_definition(declaration.definition);
        if (definition == nullptr || !valid_interactable_location(project, declaration.location))
            return Result<SessionState, Diagnostics>::failure(
                feature_error("runtime.invalid_interactable_location",
                              "Interactable Instance declaration is unresolved"));
        auto effective_definition =
            realize_declared_interactable_configuration(*definition, declaration);
        interactable_configurations.push_back(RuntimeInteractableConfiguration{
            declaration.id, true, CompiledInteractableConfigurationSource{declaration.definition},
            std::nullopt,
            RuntimeInstanceProvenance{RuntimeInstanceProvenanceKind::Declared, std::nullopt,
                                      std::nullopt},
            std::move(effective_definition), std::nullopt});
        interactables.push_back(InteractableState{declaration.id, declaration.location,
                                                  declaration.enabled, declaration.visible});
    }
    std::vector<RuntimeCharacterConfiguration> character_configurations;
    character_configurations.reserve(project.characters().size());
    std::vector<CharacterWorldState> characters;
    characters.reserve(project.characters().size());
    for (const auto& definition : project.characters()) {
        if (const auto* placed =
                std::get_if<compiled::RoomLocation>(&definition.initial_world_state.location);
            placed && project.find_room(placed->room) == nullptr)
            return Result<SessionState, Diagnostics>::failure(
                feature_error("runtime.invalid_character_location",
                              "Character initial Room Location is unresolved"));
        character_configurations.push_back(RuntimeCharacterConfiguration{
            definition.identity.id, true,
            CompiledCharacterConfigurationSource{definition.identity.id}, std::nullopt,
            RuntimeInstanceProvenance{RuntimeInstanceProvenanceKind::Declared, std::nullopt,
                                      std::nullopt},
            definition, std::nullopt});
        characters.push_back(CharacterWorldState{
            definition.identity.id, definition.initial_world_state.location,
            definition.initial_world_state.enabled, definition.initial_world_state.visible});
    }
    // Item Definitions/Stacks are no longer canonical CompiledProject content. The legacy runtime
    // subsystem remains unreachable until its dedicated contraction ticket removes it.
    std::vector<ItemStackState> item_stacks;
    return Result<SessionState, Diagnostics>::success(
        SessionState(FlowMode{}, std::move(*initial_stack), std::move(rooms),
                     std::move(character_configurations), std::move(interactable_configurations),
                     std::move(characters), std::move(interactables), std::move(item_stacks), 2,
                     *presentation_session, *shell_presentation_scope));
}

Result<RoomVisitInstanceId, Diagnostics> SessionState::allocate_room_visit_instance_id()
{
    const auto id = allocate_process_identity<RoomVisitInstanceId>(g_next_room_visit_instance_id);
    return id ? Result<RoomVisitInstanceId, Diagnostics>::success(*id)
              : Result<RoomVisitInstanceId, Diagnostics>::failure(
                    feature_error("runtime.room_visit_instance_exhausted",
                                  "Room visit instance identities are exhausted"));
}

std::uint64_t SessionState::next_random_u64() noexcept
{
    // SplitMix64 is fully specified in terms of unsigned 64-bit arithmetic and therefore produces
    // the same stream on every supported target.
    m_random_state += 0x9e3779b97f4a7c15ULL;
    std::uint64_t value = m_random_state;
    value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31U);
}

double SessionState::next_random_unit() noexcept
{
    constexpr double denominator = 9007199254740992.0; // 2^53
    return static_cast<double>(next_random_u64() >> 11U) / denominator;
}

Result<std::int64_t, Diagnostics> SessionState::next_random_integer(std::int64_t minimum,
                                                                    std::int64_t maximum)
{
    if (minimum > maximum)
        return Result<std::int64_t, Diagnostics>::failure(feature_error(
            "runtime.invalid_random_range", "Random integer minimum cannot exceed maximum"));

    constexpr std::uint64_t sign_bit = std::uint64_t{1} << 63U;
    const auto ordered = [](std::int64_t value) {
        return std::bit_cast<std::uint64_t>(value) ^ sign_bit;
    };
    const std::uint64_t lower = ordered(minimum);
    const std::uint64_t upper = ordered(maximum);
    const std::uint64_t span = upper - lower + 1U;
    if (span == 0U)
        return Result<std::int64_t, Diagnostics>::success(
            std::bit_cast<std::int64_t>(next_random_u64()));

    const std::uint64_t threshold = (std::uint64_t{0} - span) % span;
    std::uint64_t draw = 0;
    do {
        draw = next_random_u64();
    } while (draw < threshold);
    const std::uint64_t result_bits = (lower + draw % span) ^ sign_bit;
    return Result<std::int64_t, Diagnostics>::success(std::bit_cast<std::int64_t>(result_bits));
}

Result<void, Diagnostics> SessionState::advance_time(std::chrono::milliseconds elapsed)
{
    if (elapsed.count() < 0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_elapsed_time", "Elapsed logical time cannot be negative"));
    if (elapsed.count() > std::chrono::milliseconds::max().count() - m_play_time.count())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.elapsed_time_overflow", "Logical play time would overflow"));

    auto timers = m_logical_timers;
    auto completions = m_pending_timer_completions;
    for (auto& timer : timers) {
        if (elapsed < timer.remaining) {
            timer.remaining -= elapsed;
            continue;
        }

        if (!timer.repeat_interval) {
            completions.push_back(LogicalTimerCompletion{timer.id, 1});
            timer.remaining = std::chrono::milliseconds{-1};
            continue;
        }

        const auto beyond_first = elapsed - timer.remaining;
        const auto interval = *timer.repeat_interval;
        const auto extra = static_cast<std::uint64_t>(beyond_first.count() / interval.count());
        if (extra == std::numeric_limits<std::uint64_t>::max())
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.timer_completion_overflow", "Logical timer occurrence count overflowed"));
        const auto occurrences = extra + 1;
        const auto remainder = beyond_first.count() % interval.count();
        timer.remaining =
            remainder == 0 ? interval : std::chrono::milliseconds{interval.count() - remainder};
        const auto existing = std::find_if(
            completions.begin(), completions.end(),
            [&timer](const LogicalTimerCompletion& item) { return item.id == timer.id; });
        if (existing != completions.end()) {
            if (occurrences > std::numeric_limits<std::uint64_t>::max() - existing->occurrences)
                return Result<void, Diagnostics>::failure(
                    feature_error("runtime.timer_completion_overflow",
                                  "Logical timer occurrence count overflowed"));
            existing->occurrences += occurrences;
        } else {
            completions.push_back(LogicalTimerCompletion{timer.id, occurrences});
        }
    }
    timers.erase(
        std::remove_if(timers.begin(), timers.end(),
                       [](const LogicalTimer& timer) { return timer.remaining.count() < 0; }),
        timers.end());

    m_play_time += elapsed;
    m_logical_timers = std::move(timers);
    m_pending_timer_completions = std::move(completions);
    return Result<void, Diagnostics>::success();
}

Result<LogicalTimerId, Diagnostics>
SessionState::start_logical_timer(std::chrono::milliseconds initial_duration,
                                  std::optional<std::chrono::milliseconds> repeat_interval)
{
    if (initial_duration.count() < 0 || (repeat_interval && repeat_interval->count() <= 0))
        return Result<LogicalTimerId, Diagnostics>::failure(feature_error(
            "runtime.invalid_logical_timer",
            "Logical timers require a nonnegative duration and a positive repeat interval"));
    if (m_next_logical_timer_id == 0)
        return Result<LogicalTimerId, Diagnostics>::failure(feature_error(
            "runtime.logical_timer_id_exhausted", "Logical timer identifiers are exhausted"));
    const LogicalTimerId id{m_next_logical_timer_id++};
    m_logical_timers.push_back(LogicalTimer{id, initial_duration, repeat_interval});
    return Result<LogicalTimerId, Diagnostics>::success(id);
}

bool SessionState::cancel_logical_timer(const LogicalTimerId& id) noexcept
{
    const auto found = std::find_if(m_logical_timers.begin(), m_logical_timers.end(),
                                    [&id](const LogicalTimer& timer) { return timer.id == id; });
    if (found == m_logical_timers.end())
        return false;
    m_logical_timers.erase(found);
    return true;
}

std::vector<LogicalTimerCompletion> SessionState::take_timer_completions() noexcept
{
    auto completions = std::move(m_pending_timer_completions);
    m_pending_timer_completions.clear();
    return completions;
}

const RuntimeValue* SessionState::property_override(const PropertyTargetRef& target,
                                                    const PropertyId& property) const noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&target, &property](const PropertyOverride& value) {
                         return value.target() == target && value.property_id() == property;
                     });
    return found == m_property_overrides.end() ? nullptr : &found->value();
}

const ItemStackState* SessionState::item_stack(const ItemStackId& id) const noexcept
{
    const auto found = std::find_if(m_item_stacks.begin(), m_item_stacks.end(),
                                    [&id](const auto& value) { return value.id == id; });
    return found == m_item_stacks.end() ? nullptr : &*found;
}

void SessionState::store_property_override(PropertyOverride value)
{
    const auto found = std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                                    [&value](const PropertyOverride& current) {
                                        return current.target() == value.target() &&
                                               current.property_id() == value.property_id();
                                    });
    if (found == m_property_overrides.end())
        m_property_overrides.push_back(std::move(value));
    else
        *found = std::move(value);
}

void SessionState::erase_property_override(const PropertyTargetRef& target,
                                           const PropertyId& property) noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&target, &property](const PropertyOverride& value) {
                         return value.target() == target && value.property_id() == property;
                     });
    if (found != m_property_overrides.end())
        m_property_overrides.erase(found);
}

std::optional<CurrentRoomPresentationOwner>
SessionState::current_room_presentation_owner() const noexcept
{
    if (!m_room_visit || !m_room_visit_instance)
        return std::nullopt;
    return CurrentRoomPresentationOwner{*m_room_visit_instance, m_room_visit->room};
}

bool SessionState::presentation_owner_is_active(const PresentationOwner& owner) const noexcept
{
    return std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ScenePresentationOwner>) {
                return std::any_of(
                    m_flow_stack.begin(), m_flow_stack.end(), [&value](const auto& f) {
                        const auto* scene = std::get_if<SceneFrame>(&f);
                        return scene != nullptr && scene->frame_id == value.invocation &&
                               scene->scene == value.scene;
                    });
            } else if constexpr (std::is_same_v<T, DialoguePresentationOwner>) {
                return std::any_of(
                    m_flow_stack.begin(), m_flow_stack.end(), [&value](const auto& f) {
                        const auto* dialogue = std::get_if<DialogueFrame>(&f);
                        return dialogue != nullptr && dialogue->frame_id == value.invocation &&
                               dialogue->dialogue == value.dialogue;
                    });
            } else if constexpr (std::is_same_v<T, CurrentRoomPresentationOwner>) {
                const auto current = current_room_presentation_owner();
                return current && *current == value;
            } else if constexpr (std::is_same_v<T, RoomPresentationOwner>) {
                return m_room_visit && m_room_visit->room == value.room;
            } else if constexpr (std::is_same_v<T, SessionPresentationOwner>) {
                return value.session == m_presentation_session;
            } else {
                return value.scope == m_shell_presentation_scope;
            }
        },
        owner);
}

Result<void, Diagnostics>
SessionState::validate_presentation_owner(const PresentationOwner& owner) const
{
    const bool valid = std::visit(
        [this](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, RoomPresentationOwner>)
                return true;
            else if constexpr (std::is_same_v<T, SessionPresentationOwner>)
                return value.session == m_presentation_session;
            else if constexpr (std::is_same_v<T, ShellPresentationOwner>)
                return value.scope == m_shell_presentation_scope;
            else
                return presentation_owner_is_active(PresentationOwner{value});
        },
        owner);
    return valid ? Result<void, Diagnostics>::success()
                 : Result<void, Diagnostics>::failure(feature_error(
                       "runtime.invalid_presentation_owner",
                       "Presentation owner is stale, inactive, or belongs to another session"));
}

Result<void, Diagnostics>
SessionState::validate_presentation_owner(const CompiledProject& project,
                                          const PresentationOwner& owner) const
{
    auto valid = validate_presentation_owner(owner);
    if (!valid)
        return valid;
    const auto* room_owner = std::get_if<RoomPresentationOwner>(&owner);
    if (room_owner != nullptr && runtime_room(*this, room_owner->room) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_owner", "Presentation owner references a missing Room"));
    return Result<void, Diagnostics>::success();
}

void SessionState::remove_presentation_owned_by(const PresentationOwner& owner) noexcept
{
    std::erase_if(m_background_overrides,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_camera_views, [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_actors, [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_presentation_props,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_presentation_environments,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_material_parameters,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_postprocess_effects,
                  [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_mounted_layouts, [&owner](const auto& value) { return value.owner == owner; });
    std::erase_if(m_layout_state_slots, [&owner](const LayoutStateSlot& slot) {
        return std::visit(
            [&](const auto& scoped) {
                using T = std::decay_t<decltype(scoped)>;
                if constexpr (std::is_same_v<T, LayoutVisitStateOwner>) {
                    const auto* current = std::get_if<CurrentRoomPresentationOwner>(&owner);
                    return current && current->visit == scoped.visit;
                } else if constexpr (std::is_same_v<T, LayoutRoomStateOwner>) {
                    const auto* room = std::get_if<RoomPresentationOwner>(&owner);
                    return room && room->room == scoped.room;
                } else if constexpr (std::is_same_v<T, LayoutFlowStateOwner>) {
                    const auto* flow = std::get_if<ScenePresentationOwner>(&owner);
                    const auto* dialogue = std::get_if<DialoguePresentationOwner>(&owner);
                    return (flow && flow->invocation == scoped.flow) ||
                           (dialogue && dialogue->invocation == scoped.flow);
                } else {
                    const auto* session = std::get_if<SessionPresentationOwner>(&owner);
                    return session && session->session == scoped.session;
                }
            },
            slot.scope_owner);
    });
    std::erase_if(m_desired_audio, [&owner](const auto& value) { return value.owner == owner; });
}

void SessionState::remove_scene_presentation(const FlowFrame& frame) noexcept
{
    if (const auto* scene = std::get_if<SceneFrame>(&frame))
        remove_presentation_owned_by(ScenePresentationOwner{scene->frame_id, scene->scene});
    else if (const auto* dialogue = std::get_if<DialogueFrame>(&frame))
        remove_presentation_owned_by(
            DialoguePresentationOwner{dialogue->frame_id, dialogue->dialogue});
}

Result<void, Diagnostics> SessionState::upsert_background_override(const CompiledProject& project,
                                                                   DesiredBackgroundOverride value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    if (!owner || !valid_background(project, value.background))
        return Result<void, Diagnostics>::failure(
            !owner ? owner.error()
                   : feature_error("runtime.invalid_background_override",
                                   "Background override contains an invalid owner or resource"));
    const auto found = std::find_if(m_background_overrides.begin(), m_background_overrides.end(),
                                    [&value](const DesiredBackgroundOverride& current) {
                                        return current.owner == value.owner;
                                    });
    if (found == m_background_overrides.end())
        m_background_overrides.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_background_override(const PresentationOwner& owner)
{
    const auto found = std::find_if(
        m_background_overrides.begin(), m_background_overrides.end(),
        [&owner](const DesiredBackgroundOverride& value) { return value.owner == owner; });
    if (found != m_background_overrides.end())
        m_background_overrides.erase(found);
    return Result<void, Diagnostics>::success();
}

const DesiredCameraView* SessionState::camera_view(const PresentationOwner& owner) const noexcept
{
    const auto found =
        std::find_if(m_camera_views.begin(), m_camera_views.end(),
                     [&owner](const DesiredCameraView& value) { return value.owner == owner; });
    return found == m_camera_views.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::set_camera_view(const CompiledProject& project,
                                                        DesiredCameraView value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    if (!owner || !valid_camera_view(value.view))
        return Result<void, Diagnostics>::failure(
            !owner ? owner.error()
                   : feature_error("runtime.invalid_camera_view",
                                   "Camera View must use finite coordinates, positive zoom, and "
                                   "finite rotation"));
    const auto found = std::find_if(
        m_camera_views.begin(), m_camera_views.end(),
        [&value](const DesiredCameraView& current) { return current.owner == value.owner; });
    if (found == m_camera_views.end())
        m_camera_views.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_camera_view(const PresentationOwner& owner)
{
    std::erase_if(m_camera_views,
                  [&owner](const DesiredCameraView& value) { return value.owner == owner; });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_background(const CompiledProject& project,
                                                       PresentationOwner owner,
                                                       compiled::BackgroundPresentation background)
{
    return upsert_background_override(
        project, DesiredBackgroundOverride{std::move(owner), std::move(background)});
}

const DesiredActorPresentation* SessionState::actor(const ActorPresentationKey& key,
                                                    const PresentationOwner& owner) const noexcept
{
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    return found == m_actors.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::set_actor(const CompiledProject& project,
                                                  DesiredActorPresentation value)
{
    const auto* character = runtime_character(*this, value.character);
    auto owner = validate_presentation_owner(project, value.owner);
    bool key_valid = false;
    std::visit(
        [&](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, CharacterActorKey>) {
                key_valid = key.character == value.character;
            } else if constexpr (std::is_same_v<T, RoomCastActorKey>) {
                const auto* room = runtime_room(*this, key.room);
                const auto* found =
                    room == nullptr ? nullptr : [&]() -> const compiled::RoomCastEntry* {
                    const auto item = std::find_if(room->cast.begin(), room->cast.end(),
                                                   [&key](const compiled::RoomCastEntry& entry) {
                                                       return entry.id == key.entry;
                                                   });
                    return item == room->cast.end() ? nullptr : &*item;
                }();
                const auto* room_owner = std::get_if<RoomPresentationOwner>(&value.owner);
                key_valid = found != nullptr && found->character == value.character &&
                            room_owner != nullptr && room_owner->room == key.room;
            } else if constexpr (std::is_same_v<T, SceneActorKey>) {
                const auto* scene = project.find_scene(key.owner.scene);
                key_valid = scene != nullptr && owner_matches_scene_key(value.owner, key) &&
                            find_actor_cue(*scene, key, value.character) != nullptr;
            } else {
                key_valid = true;
            }
        },
        value.key);
    if (!owner || character == nullptr || !key_valid || !valid_character_state(*character, value))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_actor_state", "Actor desired state must reference a valid owner, "
                                           "identity, Character, pose, expression, and idle"));
    const auto found = std::find_if(
        m_actors.begin(), m_actors.end(), [&value](const DesiredActorPresentation& current) {
            return current.key == value.key && current.owner == value.owner;
        });
    if (found == m_actors.end())
        m_actors.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_actor(const CompiledProject& project,
                                                     const ActorPresentationKey& key,
                                                     const PresentationOwner& owner)
{
    (void)project;
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    m_actors.erase(found);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::set_actor_presentation_complete(const CompiledProject& project,
                                              const ActorPresentationKey& key,
                                              const PresentationOwner& owner, bool complete)
{
    (void)project;
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    found->presentation_complete = complete;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_actor_speaking(const CompiledProject& project,
                                                           const ActorPresentationKey& key,
                                                           const PresentationOwner& owner,
                                                           bool speaking)
{
    (void)project;
    const auto found = std::find_if(m_actors.begin(), m_actors.end(),
                                    [&key, &owner](const DesiredActorPresentation& value) {
                                        return value.key == key && value.owner == owner;
                                    });
    if (found == m_actors.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_actor", "Actor slot has no live state"));
    found->speaking = speaking;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::upsert_presentation_prop(const CompiledProject& project,
                                                                 DesiredPresentationProp value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const bool resources_valid = !value.asset || project.find_asset(*value.asset) != nullptr;
    const bool placement_valid = !value.placement || valid_room_placement(*this, *value.placement);
    if (!owner || !resources_valid || !placement_valid || !valid_prop_bounds(value.bounds) ||
        !valid_plane(value.plane))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_prop",
            "Presentation prop contains an invalid owner, resource, placement, bounds, or plane"));
    const auto found =
        std::find_if(m_presentation_props.begin(), m_presentation_props.end(),
                     [&value](const DesiredPresentationProp& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_presentation_props.end())
        m_presentation_props.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_prop(const PresentationPropInstanceId& instance,
                                       const PresentationOwner& owner)
{
    std::erase_if(m_presentation_props, [&instance, &owner](const DesiredPresentationProp& value) {
        return value.instance == instance && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::upsert_presentation_environment(const CompiledProject& project,
                                              DesiredPresentationEnvironment value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const auto* asset = value.asset ? project.find_asset(*value.asset) : nullptr;
    const bool asset_valid =
        !value.asset || (asset != nullptr && asset->kind == compiled::AssetKind::Image);
    const bool environment_plane = value.plane >= PresentationPlane::WorldBackground &&
                                   value.plane <= PresentationPlane::WorldOverlay;
    if (!owner || !asset_valid || !valid_prop_bounds(value.bounds) || !environment_plane ||
        value.clock > LayoutClockDomain::UnscaledPresentation ||
        !std::isfinite(value.scroll_per_second.x) || !std::isfinite(value.scroll_per_second.y) ||
        !std::isfinite(value.opacity) || value.opacity < 0.0 || value.opacity > 1.0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presentation_environment",
            "Presentation environment contains an invalid owner, resource, bounds, plane, clock, "
            "scroll rate, or opacity"));
    const auto found =
        std::find_if(m_presentation_environments.begin(), m_presentation_environments.end(),
                     [&value](const DesiredPresentationEnvironment& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_presentation_environments.end())
        m_presentation_environments.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_environment(const PresentationEnvironmentInstanceId& instance,
                                              const PresentationOwner& owner)
{
    std::erase_if(m_presentation_environments,
                  [&instance, &owner](const DesiredPresentationEnvironment& value) {
                      return value.instance == instance && value.owner == owner;
                  });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_presentation_environments(const PresentationEnvironmentStopKey& stop_key,
                                               const PresentationOwner& owner)
{
    std::erase_if(m_presentation_environments,
                  [&stop_key, &owner](const DesiredPresentationEnvironment& value) {
                      return value.stop_key == stop_key && value.owner == owner;
                  });
    return Result<void, Diagnostics>::success();
}

const DesiredMaterialParameter*
SessionState::material_parameter(const MaterialOccurrence& occurrence,
                                 const PresentationOwner& owner, const MaterialId& material,
                                 std::string_view parameter) const noexcept
{
    const auto found = std::find_if(m_material_parameters.begin(), m_material_parameters.end(),
                                    [&](const DesiredMaterialParameter& value) {
                                        return value.occurrence == occurrence &&
                                               value.owner == owner && value.material == material &&
                                               value.parameter == parameter;
                                    });
    return found == m_material_parameters.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::upsert_material_parameter(const CompiledProject& project,
                                                                  DesiredMaterialParameter value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    if (!owner)
        return owner;
    const auto* material = project.find_material_interface(value.material);
    if (material == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.material_parameter_unknown_material",
            "Material Parameter references a Material without a compiled runtime interface"));
    const auto declaration = std::find_if(material->parameters.begin(), material->parameters.end(),
                                          [&](const compiled::MaterialParameterDeclaration& item) {
                                              return item.name == value.parameter;
                                          });
    if (declaration == material->parameters.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.material_parameter_unknown_uniform",
                          "Material Parameter does not name a declared Shader uniform"));
    if (declaration->renderer_binding)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.material_parameter_renderer_bound",
                          "Renderer-bound Shader uniforms cannot be controlled by occurrence "
                          "Material Parameters"));
    if (value.value.has_value() == value.binding.has_value())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.material_parameter_invalid_source",
            "Material Parameter must have exactly one literal value or binding authority"));
    if (value.value && (!material_parameter_value_matches(declaration->type, *value.value) ||
                        !material_parameter_value_finite(*value.value)))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.material_parameter_type_mismatch",
            "Material Parameter value does not match the declared Shader uniform type"));
    if (value.binding) {
        const bool binding_valid = std::visit(
            [&](const auto& binding) {
                using B = std::decay_t<decltype(binding)>;
                if constexpr (std::is_same_v<B, MaterialPropertyBinding>) {
                    const auto* property = project.find_property(binding.property);
                    if (property == nullptr || property->nullable() ||
                        !property_can_drive_material_parameter(*property, declaration->type))
                        return false;
                    if (std::holds_alternative<GlobalPropertyTarget>(binding.target))
                        return property->is_global();
                    const auto target_kind = property_target_owner_kind(binding.target);
                    return !property->is_global() && target_kind &&
                           std::binary_search(property->allowed_owners().begin(),
                                              property->allowed_owners().end(), *target_kind);
                } else {
                    return declaration->type == compiled::MaterialParameterType::Float &&
                           binding.facet <= MaterialStandardFacet::CameraZoom;
                }
            },
            *value.binding);
        if (!binding_valid)
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.material_parameter_invalid_binding",
                "Material Parameter binding is incompatible with the declared uniform type"));
    }

    const bool occurrence_valid = std::visit(
        [&](const auto& occurrence) {
            using O = std::decay_t<decltype(occurrence)>;
            if constexpr (std::is_same_v<O, BackgroundMaterialOccurrence>) {
                const auto background =
                    std::find_if(m_background_overrides.begin(), m_background_overrides.end(),
                                 [&](const DesiredBackgroundOverride& item) {
                                     return item.owner == value.owner;
                                 });
                if (background == m_background_overrides.end() ||
                    background->background.material != std::optional<MaterialId>{value.material})
                    return false;
                return material->role == compiled::MaterialRole::Engine2D;
            } else if constexpr (std::is_same_v<O, ActorMaterialOccurrence>) {
                const auto* desired_actor = actor(occurrence.key, value.owner);
                if (desired_actor == nullptr)
                    return false;
                const auto* character = runtime_character(*this, desired_actor->character);
                if (character == nullptr)
                    return false;
                const auto selected =
                    resolved_actor_layer_material(*character, *desired_actor, occurrence.layer);
                return selected == std::optional<MaterialId>{value.material} &&
                       material->role == compiled::MaterialRole::Engine2D;
            } else if constexpr (std::is_same_v<O, PropMaterialOccurrence>) {
                const auto found = std::ranges::find_if(
                    m_presentation_props, [&](const DesiredPresentationProp& item) {
                        return item.instance == occurrence.instance && item.owner == value.owner;
                    });
                return found != m_presentation_props.end() &&
                       found->material == std::optional<MaterialId>{value.material} &&
                       material->role == compiled::MaterialRole::Engine2D;
            } else if constexpr (std::is_same_v<O, EnvironmentMaterialOccurrence>) {
                const auto found = std::ranges::find_if(
                    m_presentation_environments, [&](const DesiredPresentationEnvironment& item) {
                        return item.instance == occurrence.instance && item.owner == value.owner;
                    });
                return found != m_presentation_environments.end() &&
                       found->material == value.material &&
                       material->role == compiled::MaterialRole::Engine2D;
            } else if constexpr (std::is_same_v<O, LayoutMaterialOccurrence>) {
                const auto found =
                    std::ranges::find_if(m_mounted_layouts, [&](const DesiredMountedLayout& item) {
                        return item.key == occurrence.key && item.owner == value.owner;
                    });
                if (found == m_mounted_layouts.end() || occurrence.material != value.material)
                    return false;
                const auto* layout = project.find_layout(found->layout);
                return layout != nullptr &&
                       std::ranges::find(layout->dependencies.materials, value.material) !=
                           layout->dependencies.materials.end() &&
                       material->role == compiled::MaterialRole::RmlUiDecorator;
            } else {
                const auto found = std::ranges::find_if(
                    m_postprocess_effects, [&](const DesiredPostprocessEffect& item) {
                        return item.instance == occurrence.instance && item.owner == value.owner;
                    });
                return found != m_postprocess_effects.end() && found->material == value.material &&
                       material->role == compiled::MaterialRole::Postprocess;
            }
        },
        value.occurrence);
    if (!occurrence_valid)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.material_parameter_invalid_occurrence",
            "Material Parameter target does not own the selected Material with a compatible role"));

    const auto found = std::find_if(m_material_parameters.begin(), m_material_parameters.end(),
                                    [&](const DesiredMaterialParameter& current) {
                                        return current.occurrence == value.occurrence &&
                                               current.owner == value.owner &&
                                               current.material == value.material &&
                                               current.parameter == value.parameter;
                                    });
    if (found != m_material_parameters.end() && found->binding && value.value)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.material_parameter_binding_authoritative",
                          "Remove the Material Parameter binding before assigning a direct value"));
    if (found == m_material_parameters.end())
        m_material_parameters.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_material_parameter(const MaterialOccurrence& occurrence,
                                        const PresentationOwner& owner, const MaterialId& material,
                                        std::string_view parameter)
{
    std::erase_if(m_material_parameters, [&](const DesiredMaterialParameter& value) {
        return value.occurrence == occurrence && value.owner == owner &&
               value.material == material && value.parameter == parameter;
    });
    return Result<void, Diagnostics>::success();
}

const DesiredPostprocessEffect*
SessionState::postprocess_effect(const PostprocessEffectInstanceId& instance,
                                 const PresentationOwner& owner) const noexcept
{
    const auto found =
        std::ranges::find_if(m_postprocess_effects, [&](const DesiredPostprocessEffect& value) {
            return value.instance == instance && value.owner == owner;
        });
    return found == m_postprocess_effects.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::upsert_postprocess_effect(const CompiledProject& project,
                                                                  DesiredPostprocessEffect value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    if (!owner)
        return owner;
    const auto* material = project.find_material_interface(value.material);
    if (material == nullptr || material->role != compiled::MaterialRole::Postprocess ||
        material->postprocess_scope != value.scope ||
        value.clock > MaterialClockPolicy::UnscaledPresentation)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_postprocess_effect", "Postprocess Effect requires a postprocess "
                                                  "Material with matching scope and valid clock"));
    const auto existing =
        std::ranges::find_if(m_postprocess_effects, [&](const DesiredPostprocessEffect& item) {
            return item.instance == value.instance && item.owner == value.owner;
        });
    const auto count =
        std::ranges::count_if(m_postprocess_effects, [&](const DesiredPostprocessEffect& item) {
            return item.scope == value.scope &&
                   (existing == m_postprocess_effects.end() || &item != &*existing);
        });
    if (count >= static_cast<std::ptrdiff_t>(max_postprocess_effects_per_scope))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.postprocess_stack_limit",
                          "Postprocess Effect exceeds the bounded stack for this scope"));
    if (existing == m_postprocess_effects.end())
        m_postprocess_effects.push_back(std::move(value));
    else
        *existing = std::move(value);
    std::stable_sort(
        m_postprocess_effects.begin(), m_postprocess_effects.end(),
        [](const DesiredPostprocessEffect& left, const DesiredPostprocessEffect& right) {
            if (left.scope != right.scope)
                return left.scope < right.scope;
            if (left.order != right.order)
                return left.order < right.order;
            return left.instance.text() < right.instance.text();
        });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_postprocess_effect(const PostprocessEffectInstanceId& instance,
                                        const PresentationOwner& owner)
{
    std::erase_if(m_postprocess_effects, [&](const DesiredPostprocessEffect& value) {
        return value.instance == instance && value.owner == owner;
    });
    std::erase_if(m_material_parameters, [&](const DesiredMaterialParameter& value) {
        const auto* target = std::get_if<PostprocessMaterialOccurrence>(&value.occurrence);
        return target != nullptr && target->instance == instance && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

const DesiredAudioInstance*
SessionState::desired_audio(const DesiredAudioInstanceId& instance,
                            const PresentationOwner& owner) const noexcept
{
    const auto found = std::find_if(m_desired_audio.begin(), m_desired_audio.end(),
                                    [&instance, &owner](const DesiredAudioInstance& value) {
                                        return value.instance == instance && value.owner == owner;
                                    });
    return found == m_desired_audio.end() ? nullptr : &*found;
}

Result<void, Diagnostics> SessionState::upsert_desired_audio(const CompiledProject& project,
                                                             DesiredAudioInstance value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const auto* asset = project.find_asset(value.asset);
    const bool purpose_valid = value.purpose == compiled::AudioPurpose::Music ||
                               value.purpose == compiled::AudioPurpose::Ambience;
    const bool pan_source_valid =
        !value.pan_source ||
        std::visit(
            [&](const auto& source) {
                using T = std::decay_t<decltype(source)>;
                if constexpr (std::is_same_v<T, compiled::SceneActorAudioPanSource>) {
                    const auto* scene_owner = std::get_if<ScenePresentationOwner>(&value.owner);
                    return scene_owner && std::ranges::any_of(
                                              m_actors, [&](const DesiredActorPresentation& actor) {
                                                  const auto* key =
                                                      std::get_if<SceneActorKey>(&actor.key);
                                                  return key && key->owner == *scene_owner &&
                                                         key->slot == source.slot;
                                              });
                } else {
                    const auto* room = project.find_room(source.room);
                    return room && std::ranges::any_of(room->anchors,
                                                       [&](const compiled::RoomAnchor& anchor) {
                                                           return anchor.id == source.anchor;
                                                       });
                }
            },
            *value.pan_source);
    if (!owner || !purpose_valid || asset == nullptr || asset->kind != compiled::AssetKind::Audio ||
        !std::isfinite(value.gain) || value.gain < 0.0 || value.gain > 1.0 ||
        !std::isfinite(value.pan) || value.pan < -1.0 || value.pan > 1.0 || !pan_source_valid ||
        value.pause_policy > compiled::AudioPausePolicy::Unscaled || value.fade_in.count() < 0 ||
        value.fade_out.count() < 0)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_desired_audio",
            "Desired audio requires an active owner, Music or Ambience Purpose, Audio Asset, valid "
            "Pause Policy/gain/pan/Pan Source, and nonnegative fade policy"));

    if (value.replacement_key) {
        std::erase_if(m_desired_audio, [&value](const DesiredAudioInstance& current) {
            return current.owner == value.owner &&
                   current.replacement_key == value.replacement_key &&
                   current.instance != value.instance;
        });
    }
    const auto found =
        std::find_if(m_desired_audio.begin(), m_desired_audio.end(),
                     [&value](const DesiredAudioInstance& current) {
                         return current.instance == value.instance && current.owner == value.owner;
                     });
    if (found == m_desired_audio.end())
        m_desired_audio.push_back(std::move(value));
    else
        *found = std::move(value);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_desired_audio(const DesiredAudioInstanceId& instance,
                                                             const PresentationOwner& owner)
{
    std::erase_if(m_desired_audio, [&instance, &owner](const DesiredAudioInstance& value) {
        return value.instance == instance && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::remove_desired_audio_purpose(compiled::AudioPurpose purpose,
                                                                     const PresentationOwner& owner)
{
    if (purpose != compiled::AudioPurpose::Music && purpose != compiled::AudioPurpose::Ambience)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_desired_audio_purpose",
                          "Only Music and Ambience are persistent desired-audio Purposes"));
    std::erase_if(m_desired_audio, [&purpose, &owner](const DesiredAudioInstance& value) {
        return value.purpose == purpose && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<double, Diagnostics>
SessionState::resolve_audio_pan(const CompiledProject& project, const PresentationOwner& owner,
                                double fixed_pan,
                                const std::optional<compiled::AudioPanSource>& source) const
{
    if (!std::isfinite(fixed_pan) || fixed_pan < -1.0 || fixed_pan > 1.0)
        return Result<double, Diagnostics>::failure(feature_error(
            "runtime.invalid_audio_pan", "Audio pan must be finite and between -1 and 1"));
    if (!source)
        return Result<double, Diagnostics>::success(fixed_pan);

    const auto source_pan = std::visit(
        [&](const auto& value) -> std::optional<double> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::SceneActorAudioPanSource>) {
                const auto* scene_owner = std::get_if<ScenePresentationOwner>(&owner);
                if (scene_owner == nullptr)
                    return std::nullopt;
                const auto actor =
                    std::find_if(m_actors.begin(), m_actors.end(),
                                 [&](const DesiredActorPresentation& candidate) {
                                     const auto* key = std::get_if<SceneActorKey>(&candidate.key);
                                     return key != nullptr && key->owner == *scene_owner &&
                                            key->slot == value.slot;
                                 });
                if (actor == m_actors.end())
                    return std::nullopt;
                double normalized_x = 0.5;
                switch (actor->placement.position) {
                case compiled::ActorPosition::Left:
                    normalized_x = 0.25;
                    break;
                case compiled::ActorPosition::Right:
                    normalized_x = 0.75;
                    break;
                case compiled::ActorPosition::Center:
                case compiled::ActorPosition::Custom:
                    break;
                }
                normalized_x += actor->placement.offset.x;
                return std::clamp(normalized_x * 2.0 - 1.0, -1.0, 1.0);
            } else {
                const auto* room = runtime_room(*this, value.room);
                if (room == nullptr)
                    room = project.find_room(value.room);
                if (room == nullptr)
                    return std::nullopt;
                const auto anchor = std::find_if(room->anchors.begin(), room->anchors.end(),
                                                 [&](const compiled::RoomAnchor& candidate) {
                                                     return candidate.id == value.anchor;
                                                 });
                if (anchor == room->anchors.end())
                    return std::nullopt;
                const double normalized_x = anchor->bounds.x + anchor->bounds.width * 0.5;
                return std::clamp(normalized_x * 2.0 - 1.0, -1.0, 1.0);
            }
        },
        *source);
    if (!source_pan)
        return Result<double, Diagnostics>::failure(feature_error(
            "runtime.audio_pan_source_unavailable",
            "Audio Pan Source is stale, unavailable, or incompatible with its Owner"));
    return Result<double, Diagnostics>::success(std::clamp(fixed_pan + *source_pan, -1.0, 1.0));
}

const InteractableState* SessionState::interactable(const InteractableInstanceId& id) const noexcept
{
    const auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    return found == m_interactables.end() ? nullptr : &*found;
}

const CharacterWorldState* SessionState::character_world(const CharacterId& id) const noexcept
{
    const auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    return found == m_character_world.end() ? nullptr : &*found;
}

std::optional<RoomId> SessionState::effective_room(const CompiledProject& project,
                                                   const CharacterId& id) const noexcept
{
    if (runtime_character(*this, id) == nullptr)
        return std::nullopt;
    const auto* state = character_world(id);
    if (state == nullptr)
        return std::nullopt;
    const auto* room = std::get_if<compiled::RoomLocation>(&state->location);
    return room ? std::optional<RoomId>{room->room} : std::nullopt;
}

std::optional<RoomId> SessionState::effective_room(const CompiledProject& project,
                                                   const InteractableInstanceId& id) const noexcept
{
    if (runtime_interactable(*this, id) == nullptr)
        return std::nullopt;
    std::vector<InteractableInstanceId> visited;
    InteractableInstanceId current = id;
    while (std::find(visited.begin(), visited.end(), current) == visited.end()) {
        visited.push_back(current);
        const auto* state = interactable(current);
        if (state == nullptr)
            return std::nullopt;
        if (const auto* room = std::get_if<compiled::RoomLocation>(&state->location))
            return room->room;
        const auto* inventory = std::get_if<compiled::InventoryLocation>(&state->location);
        if (inventory == nullptr)
            return std::nullopt;
        std::optional<RoomId> resolved_room;
        std::optional<InteractableInstanceId> next_interactable;
        std::visit(
            [&](const auto& owner) {
                using T = std::decay_t<decltype(owner)>;
                if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>)
                    resolved_room = effective_room(project, owner.character);
                else if constexpr (std::is_same_v<T, RoomFeatureRef>)
                    resolved_room = owner.room;
                else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>)
                    next_interactable = owner.interactable;
                else if constexpr (std::is_same_v<T, InteractableFeatureRef>)
                    next_interactable = owner.interactable;
            },
            inventory->inventory.owner);
        if (resolved_room)
            return resolved_room;
        if (!next_interactable)
            return std::nullopt;
        current = *next_interactable;
    }
    return std::nullopt;
}

std::vector<InteractableInstanceId>
SessionState::inventory_members(const compiled::InventoryRef& inventory) const
{
    std::vector<InteractableInstanceId> members;
    for (const auto& state : m_interactables) {
        const auto* location = std::get_if<compiled::InventoryLocation>(&state.location);
        if (location && location->inventory == inventory)
            members.push_back(state.interactable);
    }
    return members;
}

Result<void, Diagnostics> SessionState::move_character(const CompiledProject& project,
                                                       const CharacterId& id,
                                                       CharacterWorldLocation location)
{
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (runtime_character(*this, id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    if (const auto* room = std::get_if<compiled::RoomLocation>(&location);
        room && runtime_room(*this, room->room) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_character_location", "Character Room Location is unresolved"));
    found->location = std::move(location);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_character_enabled(const CompiledProject& project,
                                                              const CharacterId& id, bool enabled)
{
    (void)project;
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (runtime_character(*this, id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    found->enabled = enabled;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_character_visible(const CompiledProject& project,
                                                              const CharacterId& id, bool visible)
{
    (void)project;
    auto found =
        std::find_if(m_character_world.begin(), m_character_world.end(),
                     [&id](const CharacterWorldState& value) { return value.character == id; });
    if (runtime_character(*this, id) == nullptr || found == m_character_world.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_character", "Character has no definition or live world state"));
    found->visible = visible;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::move_interactable(const CompiledProject& project,
                                                          const InteractableInstanceId& id,
                                                          compiled::InteractableLocation location)
{
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (runtime_interactable(*this, id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    if (!valid_interactable_location(project, *this, location))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_interactable_location", "Interactable Location is unresolved"));
    if (const auto* inventory = std::get_if<compiled::InventoryLocation>(&location)) {
        std::vector<InteractableInstanceId> visited{id};
        auto owner = inventory_interactable_owner(inventory->inventory);
        while (owner) {
            if (std::find(visited.begin(), visited.end(), *owner) != visited.end())
                return Result<void, Diagnostics>::failure(
                    feature_error("runtime.inventory_containment_cycle",
                                  "Inventory containment must be acyclic"));
            visited.push_back(*owner);
            const auto* owner_state = interactable(*owner);
            if (owner_state == nullptr)
                return Result<void, Diagnostics>::failure(
                    feature_error("runtime.invalid_inventory_owner",
                                  "Inventory owner has no live Interactable state"));
            const auto* owner_inventory =
                std::get_if<compiled::InventoryLocation>(&owner_state->location);
            owner = owner_inventory ? inventory_interactable_owner(owner_inventory->inventory)
                                    : std::nullopt;
        }
    }
    found->location = std::move(location);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_interactable_enabled(const CompiledProject& project,
                                                                 const InteractableInstanceId& id,
                                                                 bool enabled)
{
    (void)project;
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (runtime_interactable(*this, id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    found->enabled = enabled;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_interactable_visible(const CompiledProject& project,
                                                                 const InteractableInstanceId& id,
                                                                 bool visible)
{
    (void)project;
    auto found =
        std::find_if(m_interactables.begin(), m_interactables.end(),
                     [&id](const InteractableState& value) { return value.interactable == id; });
    if (runtime_interactable(*this, id) == nullptr || found == m_interactables.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.unknown_interactable", "Interactable has no definition or live state"));
    found->visible = visible;
    return Result<void, Diagnostics>::success();
}

std::uint64_t SessionState::room_visits(const RoomId& room) const noexcept
{
    const auto found = m_room_visits.find(room);
    return found == m_room_visits.end() ? 0 : found->second;
}

Result<void, Diagnostics> SessionState::record_room_visit(const CompiledProject& project,
                                                          const RoomId& room)
{
    if (runtime_room(*this, room) == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Room visit target does not exist"));
    auto found = m_room_visits.find(room);
    if (found == m_room_visits.end()) {
        m_room_visits.emplace(room, 1);
        return Result<void, Diagnostics>::success();
    }
    if (found->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.history_overflow", "Room visit counter cannot be incremented"));
    ++found->second;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::commit_room_entry(const CompiledProject& project, const RoomId& room,
                                std::optional<compiled::RoomExitRef> entry_exit)
{
    const auto* definition = runtime_room(*this, room);
    if (definition == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Room entry target does not exist"));
    if (!valid_background(project, definition->background))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_background",
                          "Room entry background contains an invalid Asset reference"));

    const auto visit = m_room_visits.find(room);
    if (visit != m_room_visits.end() && visit->second == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.history_overflow", "Room visit counter cannot be incremented"));
    if (m_room_entry_sequence == std::numeric_limits<std::uint64_t>::max())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.history_overflow", "Room entry sequence cannot be incremented"));

    SessionState candidate = *this;
    for (const auto& overlay : definition->overlays) {
        auto mounted = candidate.upsert_mounted_layout(
            project, DesiredMountedLayout{RoomOverlayLayoutMountKey{room, overlay.id},
                                          RoomPresentationOwner{room},
                                          overlay.layout,
                                          room_overlay_policy(overlay.order, overlay.visible),
                                          {},
                                          PresentationCompositionGroup::World,
                                          std::nullopt,
                                          {},
                                          {}});
        if (!mounted)
            return mounted;
    }

    const auto* previous_mode = std::get_if<RoomMode>(&candidate.m_mode);
    const std::optional<RoomId> source_room = previous_mode ? std::optional(previous_mode->room)
                                              : entry_exit  ? std::optional(entry_exit->room)
                                                            : std::nullopt;
    if (entry_exit) {
        const auto* source = runtime_room(*this, entry_exit->room);
        const auto* exit = source == nullptr ? nullptr : [&]() -> const compiled::RoomExit* {
            const auto found = std::find_if(source->exits.begin(), source->exits.end(),
                                            [&entry_exit](const compiled::RoomExit& candidate) {
                                                return candidate.id == entry_exit->exit_id;
                                            });
            return found == source->exits.end() ? nullptr : &*found;
        }();
        if (source == nullptr || exit == nullptr || exit->target != room || !source_room ||
            *source_room != entry_exit->room)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_visit_context",
                              "Room entry exit does not match the source and target Rooms"));
    }
    auto visit_instance = candidate.allocate_room_visit_instance_id();
    if (!visit_instance)
        return Result<void, Diagnostics>::failure(visit_instance.error());
    auto candidate_visit = candidate.m_room_visits.find(room);
    if (candidate_visit == candidate.m_room_visits.end())
        candidate.m_room_visits.emplace(room, 1);
    else
        ++candidate_visit->second;
    if (const auto current_owner = candidate.current_room_presentation_owner())
        candidate.remove_presentation_owned_by(*current_owner);
    ++candidate.m_room_entry_sequence;
    candidate.m_room_visit = RoomVisitContext{room,
                                              source_room,
                                              std::move(entry_exit),
                                              RoomEntryCause::DirectedRoomChange,
                                              candidate.m_room_entry_sequence,
                                              candidate.room_visits(room)};
    candidate.m_room_visit_instance = *visit_instance.value_if();
    candidate.m_presented_text.reset();
    candidate.m_active_choice.reset();
    *this = std::move(candidate);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::commit_room_navigation(const CompiledProject& project,
                                     const RoomPresentationResolution& target)
{
    const auto& target_visit = target.presentation.visit;
    const auto* definition = runtime_room(*this, target_visit.room);
    if (definition == nullptr)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.unknown_room", "Prepared Room target does not exist"));
    if (!valid_background(project, target.presentation.background))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_background",
                          "Prepared Room background contains an invalid Asset reference"));
    const auto expected_visit = room_visits(target_visit.room);
    if (expected_visit == std::numeric_limits<std::uint64_t>::max() ||
        target_visit.visit_index != expected_visit + 1 ||
        m_room_entry_sequence == std::numeric_limits<std::uint64_t>::max() ||
        target_visit.entry_sequence != m_room_entry_sequence + 1)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_room_visit_context",
                          "Prepared Room navigation context does not follow committed history"));

    if (target_visit.entry_exit) {
        const auto* source = runtime_room(*this, target_visit.entry_exit->room);
        const auto* exit = source == nullptr ? nullptr : [&]() -> const compiled::RoomExit* {
            const auto found =
                std::find_if(source->exits.begin(), source->exits.end(),
                             [&target_visit](const compiled::RoomExit& candidate) {
                                 return candidate.id == target_visit.entry_exit->exit_id;
                             });
            return found == source->exits.end() ? nullptr : &*found;
        }();
        if (!target_visit.source_room || source == nullptr || exit == nullptr ||
            *target_visit.source_room != target_visit.entry_exit->room ||
            exit->target != target_visit.room)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_visit_context",
                              "Prepared Room exit does not match the source and target Rooms"));
    }

    SessionState candidate = *this;
    auto visit_instance = candidate.allocate_room_visit_instance_id();
    if (!visit_instance)
        return Result<void, Diagnostics>::failure(visit_instance.error());
    auto visit = candidate.m_room_visits.find(target_visit.room);
    if (visit == candidate.m_room_visits.end())
        candidate.m_room_visits.emplace(target_visit.room, target_visit.visit_index);
    else
        visit->second = target_visit.visit_index;
    if (const auto current_owner = candidate.current_room_presentation_owner())
        candidate.remove_presentation_owned_by(*current_owner);

    for (const auto& overlay : target.presentation.overlays) {
        const auto authored = std::find_if(
            definition->overlays.begin(), definition->overlays.end(),
            [&overlay](const compiled::RoomOverlay& value) { return value.id == overlay.overlay; });
        if (authored == definition->overlays.end() || authored->layout != overlay.layout)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.invalid_room_overlay",
                              "Prepared Room overlay does not match the compiled Room definition"));
        auto mounted = candidate.upsert_mounted_layout(
            project,
            DesiredMountedLayout{RoomOverlayLayoutMountKey{target_visit.room, overlay.overlay},
                                 RoomPresentationOwner{target_visit.room},
                                 overlay.layout,
                                 room_overlay_policy(authored->order, overlay.visible),
                                 {},
                                 PresentationCompositionGroup::World,
                                 std::nullopt,
                                 {},
                                 {}});
        if (!mounted)
            return mounted;
    }

    candidate.m_room_entry_sequence = target_visit.entry_sequence;
    candidate.m_room_visit = target_visit;
    candidate.m_room_visit_instance = *visit_instance.value_if();
    candidate.m_presented_text.reset();
    candidate.m_active_choice.reset();
    if (!candidate.m_room_visit || *candidate.m_room_visit != target_visit)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_visit_context",
            "Committed Room navigation did not reproduce the prepared visit context"));
    *this = std::move(candidate);
    return Result<void, Diagnostics>::success();
}

std::uint64_t SessionState::dialogue_line_visits(const DialogueLineHistoryKey& key) const noexcept
{
    return history_count(m_dialogue_line_history, key);
}

std::uint64_t
SessionState::dialogue_choice_visits(const DialogueChoiceHistoryKey& key) const noexcept
{
    return history_count(m_dialogue_choice_history, key);
}

Result<void, Diagnostics> SessionState::record_dialogue_line(const CompiledProject& project,
                                                             const DialogueLineHistoryKey& key)
{
    const auto* dialogue = project.find_dialogue(key.dialogue);
    if (dialogue == nullptr || find_dialogue_line(*dialogue, key.segment) == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_dialogue_line", "Dialogue line history target does not exist"));
    return increment_history(m_dialogue_line_history, key);
}

Result<void, Diagnostics> SessionState::record_dialogue_choice(const CompiledProject& project,
                                                               const DialogueChoiceHistoryKey& key)
{
    const auto* dialogue = project.find_dialogue(key.dialogue);
    if (dialogue == nullptr || !has_dialogue_choice_edge(*dialogue, key.edge))
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_dialogue_choice", "Dialogue choice history target does not exist"));
    return increment_history(m_dialogue_choice_history, key);
}

Result<void, Diagnostics> SessionState::append_text_log(const CompiledProject& project,
                                                        TextLogEntry entry)
{
    if (entry.kind > TextLogEntryKind::Notification ||
        !text_log_kind_matches_origin(entry.kind, entry.origin) ||
        (entry.speaker && runtime_character(*this, *entry.speaker) == nullptr) ||
        !valid_text_log_origin(project, entry.origin))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_text_log_entry",
                          "Text-log entry contains an invalid typed reference"));
    m_text_log.push_back(std::move(entry));
    return Result<void, Diagnostics>::success();
}

Result<std::optional<LayoutId>, Diagnostics> SessionState::layout(compiled::LayoutSlot slot) const
{
    if (slot > compiled::LayoutSlot::Custom)
        return Result<std::optional<LayoutId>, Diagnostics>::failure(
            feature_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    const MountedLayoutPresentationKey key = ReservedLayoutMountKey{slot};
    const auto found =
        std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                     [&key](const DesiredMountedLayout& state) {
                         return state.key == key && presentation_authority(state.owner) ==
                                                        PresentationAuthority::Gameplay;
                     });
    return Result<std::optional<LayoutId>, Diagnostics>::success(
        found == m_mounted_layouts.end() ? std::nullopt : std::optional<LayoutId>{found->layout});
}

Result<void, Diagnostics> SessionState::upsert_mounted_layout(const CompiledProject& project,
                                                              DesiredMountedLayout value)
{
    auto owner = validate_presentation_owner(project, value.owner);
    const auto* layout_definition = project.find_layout(value.layout);
    bool key_valid = false;
    std::visit(
        [&](const auto& key) {
            using T = std::decay_t<decltype(key)>;
            if constexpr (std::is_same_v<T, ReservedLayoutMountKey>) {
                key_valid = key.slot <= compiled::LayoutSlot::Custom;
            } else if constexpr (std::is_same_v<T, RoomOverlayLayoutMountKey>) {
                const auto* room = runtime_room(*this, key.room);
                const auto found = room == nullptr
                                       ? static_cast<const compiled::RoomOverlay*>(nullptr)
                                       : [&]() -> const compiled::RoomOverlay* {
                    const auto item = std::find_if(room->overlays.begin(), room->overlays.end(),
                                                   [&key](const compiled::RoomOverlay& overlay) {
                                                       return overlay.id == key.overlay;
                                                   });
                    return item == room->overlays.end() ? nullptr : &*item;
                }();
                const auto* room_owner = std::get_if<RoomPresentationOwner>(&value.owner);
                key_valid = found != nullptr && found->layout == value.layout &&
                            room_owner != nullptr && room_owner->room == key.room &&
                            value.policy.plane == PresentationPlane::WorldOverlay &&
                            value.composition_group == PresentationCompositionGroup::World;
            } else {
                key_valid = true;
            }
        },
        value.key);
    if (!owner || layout_definition == nullptr || !key_valid ||
        !valid_layout_policy(value.policy) ||
        !valid_layout_scale_overrides(value.scale_overrides) ||
        value.composition_group > PresentationCompositionGroup::Debug)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_mounted_layout",
            "Mounted Layout contains an invalid owner, key, Layout, policy, or composition group"));

    for (const auto& slot : m_layout_state_slots) {
        if (slot.key != value.key || !layout_state_slot_applies_to_mount(*this, slot, value.owner))
            continue;
        if (!layout_definition->contract.state ||
            !persistable_value_matches(*layout_definition->contract.state, slot.value))
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.layout_state_reconstruction_failed",
                "Persisted Layout Slot state does not match the Mount's declared State Shape"));
    }

    std::vector<LayoutInputId> assigned_inputs;
    assigned_inputs.reserve(value.inputs.size());
    for (const auto& assignment : value.inputs) {
        if (std::find(assigned_inputs.begin(), assigned_inputs.end(), assignment.input) !=
            assigned_inputs.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.duplicate_layout_input",
                              "Mounted Layout assigns one input more than once"));
        const auto input = std::find_if(layout_definition->contract.inputs.begin(),
                                        layout_definition->contract.inputs.end(),
                                        [&](const LayoutInputDefinition& definition) {
                                            return definition.id == assignment.input;
                                        });
        if (input == layout_definition->contract.inputs.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.undeclared_layout_input",
                              "Mounted Layout input is not declared by the Layout contract"));
        auto resolved = resolve_layout_input_source(project, *this, assignment.source);
        if (!resolved || !layout_contract_value_matches(input->shape, *resolved.value_if()))
            return Result<void, Diagnostics>::failure(
                !resolved ? std::move(resolved).error()
                          : feature_error("runtime.layout_input_type_mismatch",
                                          "Mounted Layout input does not match its declared type"));
        assigned_inputs.push_back(assignment.input);
    }
    for (const auto& input : layout_definition->contract.inputs) {
        if (!input.default_value && std::find(assigned_inputs.begin(), assigned_inputs.end(),
                                              input.id) == assigned_inputs.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.layout_input_required",
                              "Mounted Layout is missing a required contract input"));
    }

    std::vector<LayoutSignalId> connected_signals;
    connected_signals.reserve(value.connected_signals.size());
    for (const auto& signal : value.connected_signals) {
        if (std::find(connected_signals.begin(), connected_signals.end(), signal) !=
            connected_signals.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.duplicate_layout_signal_connection",
                              "Mounted Layout connects one signal more than once"));
        if (std::none_of(
                layout_definition->contract.signals.begin(),
                layout_definition->contract.signals.end(),
                [&](const LayoutSignalDefinition& definition) { return definition.id == signal; }))
            return Result<void, Diagnostics>::failure(feature_error(
                "runtime.undeclared_layout_signal",
                "Mounted Layout signal connection is not declared by the Layout contract"));
        connected_signals.push_back(signal);
    }

    const auto mounted_layout = value.layout;
    const auto mounted_key = value.key;
    const auto mounted_owner = value.owner;
    const auto found =
        std::find_if(m_mounted_layouts.begin(), m_mounted_layouts.end(),
                     [&value](const DesiredMountedLayout& current) {
                         return current.key == value.key && current.owner == value.owner;
                     });
    const auto allocate_occurrence = [&]() -> std::optional<LayoutMountOccurrenceId> {
        if (m_next_layout_mount_occurrence == 0)
            return std::nullopt;
        const auto occurrence =
            LayoutMountOccurrenceId::from_number(m_next_layout_mount_occurrence);
        m_next_layout_mount_occurrence =
            m_next_layout_mount_occurrence == std::numeric_limits<std::uint64_t>::max()
                ? 0
                : m_next_layout_mount_occurrence + 1;
        return occurrence;
    };
    if (found == m_mounted_layouts.end()) {
        auto occurrence = allocate_occurrence();
        if (!occurrence)
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.layout_mount_identity_exhausted",
                              "Layout Mount occurrence identity space is exhausted"));
        value.occurrence = *occurrence;
        m_mounted_layouts.push_back(std::move(value));
    } else {
        if (found->layout == value.layout) {
            value.occurrence = found->occurrence;
        } else {
            auto occurrence = allocate_occurrence();
            if (!occurrence)
                return Result<void, Diagnostics>::failure(
                    feature_error("runtime.layout_mount_identity_exhausted",
                                  "Layout Mount occurrence identity space is exhausted"));
            value.occurrence = *occurrence;
        }
        *found = std::move(value);
    }
    for (auto& slot : m_layout_state_slots) {
        if (slot.key == mounted_key &&
            layout_state_slot_applies_to_mount(*this, slot, mounted_owner))
            slot.layout = mounted_layout;
    }
    return Result<void, Diagnostics>::success();
}

Result<std::vector<LayoutResolvedInput>, Diagnostics>
SessionState::resolve_layout_inputs(const CompiledProject& project,
                                    const DesiredMountedLayout& value) const
{
    const auto* layout = project.find_layout(value.layout);
    if (!layout)
        return Result<std::vector<LayoutResolvedInput>, Diagnostics>::failure(
            feature_error("runtime.layout_contract_missing",
                          "Mounted Layout references a missing Layout contract"));

    std::vector<LayoutResolvedInput> resolved;
    resolved.reserve(layout->contract.inputs.size());
    for (const auto& definition : layout->contract.inputs) {
        const auto assignment =
            std::find_if(value.inputs.begin(), value.inputs.end(),
                         [&](const auto& candidate) { return candidate.input == definition.id; });
        RuntimeValue input_value;
        if (assignment != value.inputs.end()) {
            auto current = resolve_layout_input_source(project, const_cast<SessionState&>(*this),
                                                       assignment->source);
            if (!current)
                return Result<std::vector<LayoutResolvedInput>, Diagnostics>::failure(
                    std::move(current).error());
            input_value = std::move(*current.value_if());
        } else if (definition.default_value) {
            input_value = *definition.default_value;
        } else {
            return Result<std::vector<LayoutResolvedInput>, Diagnostics>::failure(feature_error(
                "runtime.layout_input_required", "Mounted Layout is missing a required input"));
        }
        if (!layout_contract_value_matches(definition.shape, input_value))
            return Result<std::vector<LayoutResolvedInput>, Diagnostics>::failure(
                feature_error("runtime.layout_input_type_mismatch",
                              "Resolved Layout input no longer matches its declared type"));
        resolved.push_back(LayoutResolvedInput{definition.id, std::move(input_value)});
    }
    return Result<std::vector<LayoutResolvedInput>, Diagnostics>::success(std::move(resolved));
}

Result<void, Diagnostics> SessionState::validate_layout_signal(
    const CompiledProject& project, const PresentationOwner& owner,
    const MountedLayoutPresentationKey& key, LayoutMountOccurrenceId occurrence,
    const LayoutSignalId& signal, const std::vector<LayoutSignalFieldValue>& fields) const
{
    const auto mounted = std::find_if(
        m_mounted_layouts.begin(), m_mounted_layouts.end(), [&](const DesiredMountedLayout& value) {
            return value.owner == owner && value.key == key && value.occurrence &&
                   *value.occurrence == occurrence;
        });
    if (mounted == m_mounted_layouts.end() || !presentation_owner_is_active(owner))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.stale_layout_signal",
                          "Layout Signal references a stale or retired Mount occurrence"));
    if (std::find(mounted->connected_signals.begin(), mounted->connected_signals.end(), signal) ==
        mounted->connected_signals.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.layout_signal_not_connected",
                          "Layout Signal is not connected for this Mount occurrence"));

    const auto* layout = project.find_layout(mounted->layout);
    if (!layout)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.layout_contract_missing",
                          "Mounted Layout references a missing Layout contract"));
    const auto definition = std::find_if(
        layout->contract.signals.begin(), layout->contract.signals.end(),
        [&](const LayoutSignalDefinition& candidate) { return candidate.id == signal; });
    if (definition == layout->contract.signals.end())
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.undeclared_layout_signal", "Layout Signal is not declared by the contract"));

    std::vector<LayoutSignalFieldId> seen;
    seen.reserve(fields.size());
    for (const auto& field : fields) {
        if (std::find(seen.begin(), seen.end(), field.field) != seen.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.duplicate_layout_signal_field",
                              "Layout Signal payload contains one field more than once"));
        const auto field_definition =
            std::find_if(definition->fields.begin(), definition->fields.end(),
                         [&](const LayoutSignalFieldDefinition& candidate) {
                             return candidate.id == field.field;
                         });
        if (field_definition == definition->fields.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.undeclared_layout_signal_field",
                              "Layout Signal payload contains an undeclared field"));
        if (!runtime_value_is_finite(field.value) ||
            !layout_contract_value_matches(field_definition->shape, field.value))
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.layout_signal_field_type_mismatch",
                              "Layout Signal field does not match its declared type"));
        seen.push_back(field.field);
    }
    for (const auto& field : definition->fields) {
        if (field.required && std::find(seen.begin(), seen.end(), field.id) == seen.end())
            return Result<void, Diagnostics>::failure(
                feature_error("runtime.layout_signal_field_required",
                              "Layout Signal payload is missing a required field"));
    }
    return Result<void, Diagnostics>::success();
}

Result<std::optional<PersistableValue>, Diagnostics>
SessionState::layout_state(const CompiledProject& project, const PresentationOwner& owner,
                           const MountedLayoutPresentationKey& key,
                           LayoutMountOccurrenceId occurrence, LayoutStateScope scope) const
{
    const auto mounted = std::find_if(
        m_mounted_layouts.begin(), m_mounted_layouts.end(), [&](const DesiredMountedLayout& value) {
            return value.owner == owner && value.key == key && value.occurrence &&
                   *value.occurrence == occurrence;
        });
    if (mounted == m_mounted_layouts.end())
        return Result<std::optional<PersistableValue>, Diagnostics>::failure(
            feature_error("runtime.layout_state_stale_mount",
                          "Layout state references a stale Mount occurrence"));
    const auto* layout = project.find_layout(mounted->layout);
    if (!layout || !layout->contract.state)
        return Result<std::optional<PersistableValue>, Diagnostics>::failure(feature_error(
            "runtime.layout_state_undeclared", "Layout does not declare a State Shape"));
    auto scope_owner = resolve_layout_state_scope_owner(*this, owner, scope);
    if (!scope_owner)
        return Result<std::optional<PersistableValue>, Diagnostics>::failure(scope_owner.error());
    const auto found = std::find_if(
        m_layout_state_slots.begin(), m_layout_state_slots.end(), [&](const LayoutStateSlot& slot) {
            return slot.scope_owner == *scope_owner.value_if() && slot.key == key;
        });
    if (found == m_layout_state_slots.end())
        return Result<std::optional<PersistableValue>, Diagnostics>::success(
            layout->contract.state->default_value);
    if (!persistable_value_matches(*layout->contract.state, found->value))
        return Result<std::optional<PersistableValue>, Diagnostics>::failure(
            feature_error("runtime.layout_state_reconstruction_failed",
                          "Persisted Layout Slot state does not match the declared State Shape"));
    return Result<std::optional<PersistableValue>, Diagnostics>::success(found->value);
}

Result<void, Diagnostics> SessionState::commit_layout_state(const CompiledProject& project,
                                                            const PresentationOwner& owner,
                                                            const MountedLayoutPresentationKey& key,
                                                            LayoutMountOccurrenceId occurrence,
                                                            LayoutStateScope scope,
                                                            PersistableValue state)
{
    const auto mounted = std::find_if(
        m_mounted_layouts.begin(), m_mounted_layouts.end(), [&](const DesiredMountedLayout& value) {
            return value.owner == owner && value.key == key && value.occurrence &&
                   *value.occurrence == occurrence;
        });
    if (mounted == m_mounted_layouts.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.layout_state_stale_mount",
                          "Layout state references a stale Mount occurrence"));
    const auto* layout = project.find_layout(mounted->layout);
    if (!layout || !layout->contract.state)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.layout_state_undeclared", "Layout does not declare a State Shape"));
    if (!persistable_value_matches(*layout->contract.state, state))
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.layout_state_shape_mismatch",
                          "Committed Layout state does not match the declared State Shape"));
    auto scope_owner = resolve_layout_state_scope_owner(*this, owner, scope);
    if (!scope_owner)
        return Result<void, Diagnostics>::failure(scope_owner.error());

    auto candidate = m_layout_state_slots;
    const auto found =
        std::find_if(candidate.begin(), candidate.end(), [&](const LayoutStateSlot& slot) {
            return slot.scope_owner == *scope_owner.value_if() && slot.key == key;
        });
    LayoutStateSlot replacement{*scope_owner.value_if(), key, mounted->layout, std::move(state)};
    if (found == candidate.end())
        candidate.push_back(std::move(replacement));
    else
        *found = std::move(replacement);
    m_layout_state_slots = std::move(candidate);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::clear_layout_state(const CompiledProject& project,
                                                           const PresentationOwner& owner,
                                                           const MountedLayoutPresentationKey& key,
                                                           LayoutMountOccurrenceId occurrence,
                                                           LayoutStateScope scope)
{
    const auto mounted = std::find_if(
        m_mounted_layouts.begin(), m_mounted_layouts.end(), [&](const DesiredMountedLayout& value) {
            return value.owner == owner && value.key == key && value.occurrence &&
                   *value.occurrence == occurrence;
        });
    if (mounted == m_mounted_layouts.end())
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.layout_state_stale_mount",
                          "Layout state references a stale Mount occurrence"));
    const auto* layout = project.find_layout(mounted->layout);
    if (!layout || !layout->contract.state)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.layout_state_undeclared", "Layout does not declare a State Shape"));
    auto scope_owner = resolve_layout_state_scope_owner(*this, owner, scope);
    if (!scope_owner)
        return Result<void, Diagnostics>::failure(scope_owner.error());
    std::erase_if(m_layout_state_slots, [&](const LayoutStateSlot& slot) {
        return slot.scope_owner == *scope_owner.value_if() && slot.key == key;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics>
SessionState::remove_mounted_layout(const MountedLayoutPresentationKey& key,
                                    const PresentationOwner& owner)
{
    std::erase_if(m_mounted_layouts, [&key, &owner](const DesiredMountedLayout& value) {
        return value.key == key && value.owner == owner;
    });
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_layout(const CompiledProject& project,
                                                   compiled::LayoutSlot slot, LayoutId layout,
                                                   LayoutScaleOverrides scale_overrides)
{
    return set_layout(project, session_presentation_owner(), slot, std::move(layout),
                      std::move(scale_overrides));
}

Result<void, Diagnostics> SessionState::set_layout(const CompiledProject& project,
                                                   PresentationOwner owner,
                                                   compiled::LayoutSlot slot, LayoutId layout,
                                                   LayoutScaleOverrides scale_overrides)
{
    auto policy = reserved_layout_policy(slot);
    return upsert_mounted_layout(project,
                                 DesiredMountedLayout{ReservedLayoutMountKey{slot},
                                                      std::move(owner),
                                                      std::move(layout),
                                                      std::move(policy),
                                                      std::move(scale_overrides),
                                                      slot == compiled::LayoutSlot::Overlay
                                                          ? PresentationCompositionGroup::World
                                                          : PresentationCompositionGroup::Interface,
                                                      std::nullopt,
                                                      {},
                                                      {}});
}

Result<void, Diagnostics> SessionState::clear_layout(compiled::LayoutSlot slot)
{
    return clear_layout(session_presentation_owner(), slot);
}

Result<void, Diagnostics> SessionState::clear_layout(const PresentationOwner& owner,
                                                     compiled::LayoutSlot slot)
{
    if (slot > compiled::LayoutSlot::Custom)
        return Result<void, Diagnostics>::failure(
            feature_error("runtime.invalid_layout_slot", "Layout slot is invalid"));
    return remove_mounted_layout(ReservedLayoutMountKey{slot}, owner);
}

Result<void, Diagnostics>
SessionState::apply_presentation_target(const CompiledProject& project,
                                        const PresentationTargetDraft& target)
{
    SessionState candidate = *this;
    candidate.m_background_overrides.clear();
    candidate.m_camera_views.clear();
    candidate.m_actors.clear();
    candidate.m_mounted_layouts.erase(
        std::remove_if(candidate.m_mounted_layouts.begin(), candidate.m_mounted_layouts.end(),
                       [&](const DesiredMountedLayout& mounted) {
                           return std::none_of(target.layouts.begin(), target.layouts.end(),
                                               [&](const DesiredMountedLayout& desired) {
                                                   return mounted.owner == desired.owner &&
                                                          mounted.key == desired.key;
                                               });
                       }),
        candidate.m_mounted_layouts.end());

    for (const auto& background : target.background_overrides) {
        auto applied = candidate.upsert_background_override(project, background);
        if (!applied)
            return applied;
    }
    for (const auto& camera : target.camera_views) {
        auto applied = candidate.set_camera_view(project, camera);
        if (!applied)
            return applied;
    }
    for (const auto& actor : target.actors) {
        auto applied = candidate.set_actor(project, actor);
        if (!applied)
            return applied;
    }
    for (const auto& layout : target.layouts) {
        auto applied = candidate.upsert_mounted_layout(project, layout);
        if (!applied)
            return applied;
    }

    m_background_overrides = std::move(candidate.m_background_overrides);
    m_camera_views = std::move(candidate.m_camera_views);
    m_actors = std::move(candidate.m_actors);
    m_mounted_layouts = std::move(candidate.m_mounted_layouts);
    m_next_layout_mount_occurrence = candidate.m_next_layout_mount_occurrence;
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::set_overlay(const CompiledProject& project, RoomId room,
                                                    RoomOverlayId overlay, bool visible)
{
    const auto* definition = runtime_room(*this, room);
    const auto found = definition == nullptr ? static_cast<const compiled::RoomOverlay*>(nullptr)
                                             : [&]() -> const compiled::RoomOverlay* {
        const auto item = std::find_if(
            definition->overlays.begin(), definition->overlays.end(),
            [&overlay](const compiled::RoomOverlay& candidate) { return candidate.id == overlay; });
        return item == definition->overlays.end() ? nullptr : &*item;
    }();
    if (found == nullptr)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_room_overlay", "Room overlay state references a missing overlay"));
    return upsert_mounted_layout(project,
                                 DesiredMountedLayout{RoomOverlayLayoutMountKey{room, overlay},
                                                      RoomPresentationOwner{room},
                                                      found->layout,
                                                      room_overlay_policy(found->order, visible),
                                                      {},
                                                      PresentationCompositionGroup::World,
                                                      std::nullopt,
                                                      {},
                                                      {}});
}

Result<void, Diagnostics> SessionState::present_text(const CompiledProject& project,
                                                     PresentedTextState text)
{
    if ((text.speaker && runtime_character(*this, *text.speaker) == nullptr) ||
        text.markup > TextMarkup::ActiveText)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_presented_text", "Presented text contains invalid typed state"));
    m_presented_text = std::move(text);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> SessionState::present_choice(const CompiledProject& project,
                                                       ActiveChoiceState choice)
{
    const bool valid = std::visit(
        [&project](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SceneChoiceState>)
                return valid_scene_choice(project, value);
            else
                return valid_dialogue_choice(project, value);
        },
        choice);
    if (!valid)
        return Result<void, Diagnostics>::failure(feature_error(
            "runtime.invalid_choice", "Choice state does not match its compiled program"));
    m_active_choice = std::move(choice);
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
