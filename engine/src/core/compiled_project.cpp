#include "noveltea/core/compiled_project.hpp"

#include "compiled_project_validation.hpp"

#include <cmath>
#include <functional>
#include <limits>
#include <string_view>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics duplicate_id(std::string_view collection, std::string_view id)
{
    return Diagnostics{Diagnostic{.code = "compiled.duplicate_id",
                                  .message = "Duplicate " + std::string(collection) + " ID '" +
                                             std::string(id) + "'"}};
}

Diagnostics invalid_parent(std::string_view collection, std::string_view id,
                           std::string_view reason)
{
    return Diagnostics{Diagnostic{.code = "compiled.invalid_inheritance",
                                  .message = std::string(collection) + " definition '" +
                                             std::string(id) + "' " + std::string(reason)}};
}

Diagnostics invalid_model(std::string message)
{
    return Diagnostics{Diagnostic{.code = "compiled.invalid_model", .message = std::move(message)}};
}

template<class Enum> bool enum_at_most(Enum value, Enum maximum) noexcept
{
    using Underlying = std::underlying_type_t<Enum>;
    return static_cast<Underlying>(value) >= 0 &&
           static_cast<Underlying>(value) <= static_cast<Underlying>(maximum);
}

bool finite(double value) noexcept { return std::isfinite(value); }

bool valid_vector(const compiled::Vector2& value) noexcept
{
    return finite(value.x) && finite(value.y);
}

bool valid_rect(const compiled::NormalizedRect& value) noexcept
{
    return finite(value.x) && finite(value.y) && finite(value.width) && finite(value.height) &&
           value.x >= 0.0 && value.x <= 1.0 && value.y >= 0.0 && value.y <= 1.0 &&
           value.width > 0.0 && value.width <= 1.0 && value.height > 0.0 && value.height <= 1.0;
}

bool valid_background(const compiled::BackgroundPresentation& value) noexcept
{
    return enum_at_most(value.fit, compiled::BackgroundFit::Center);
}

bool valid_variable(const compiled::VariableDefinition& variable) noexcept
{
    if (!runtime_value_is_finite(variable.default_value) ||
        std::holds_alternative<std::monostate>(variable.default_value))
        return false;
    return std::visit(
        [&variable](const auto& type) {
            using T = std::decay_t<decltype(type)>;
            if constexpr (std::is_same_v<T, BooleanPropertyType>)
                return std::holds_alternative<bool>(variable.default_value);
            else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                return std::holds_alternative<std::int64_t>(variable.default_value);
            else if constexpr (std::is_same_v<T, NumberPropertyType>)
                return std::holds_alternative<std::int64_t>(variable.default_value) ||
                       std::holds_alternative<double>(variable.default_value);
            else if constexpr (std::is_same_v<T, StringPropertyType>)
                return std::holds_alternative<std::string>(variable.default_value);
            else {
                const auto* string = std::get_if<std::string>(&variable.default_value);
                return string != nullptr && !type.values.empty() &&
                       std::find(type.values.begin(), type.values.end(), *string) !=
                           type.values.end();
            }
        },
        variable.value_type);
}

bool valid_interactable_location(const compiled::InteractableLocation&) noexcept { return true; }

bool valid_interaction_program(const compiled::InteractionProgram& program) noexcept
{
    if (!enum_at_most(program.outcome, compiled::InteractionOutcome::Unhandled))
        return false;
    return std::all_of(
        program.instructions.begin(), program.instructions.end(),
        [](const compiled::InteractionInstruction& instruction) {
            return std::visit(
                [](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, compiled::SetInteractableStateInstruction>)
                        return value.enabled.has_value() || value.visible.has_value();
                    else if constexpr (std::is_same_v<T, compiled::MoveInteractableInstruction>)
                        return valid_interactable_location(value.target);
                    else
                        return true;
                },
                instruction);
        });
}

bool valid_scene_instruction(const compiled::SceneInstruction& instruction) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::SetBackgroundInstruction>) {
                if (!valid_background(value.background) ||
                    !enum_at_most(value.transition, compiled::BackgroundTransition::Cut))
                    return false;
                return value.transition == compiled::BackgroundTransition::Fade
                           ? value.duration_ms > 0
                           : value.duration_ms == 0 &&
                                 std::holds_alternative<ImmediateWait>(value.wait);
            } else if constexpr (std::is_same_v<T, compiled::ActorCueInstruction>) {
                if (!enum_at_most(value.action, compiled::ActorCueAction::Expression) ||
                    !enum_at_most(value.position, compiled::ActorPosition::Custom) ||
                    !enum_at_most(value.transition, compiled::ActorTransition::Slide) ||
                    !valid_vector(value.offset) || !finite(value.scale) || value.scale <= 0.0)
                    return false;
                if (value.transition == compiled::ActorTransition::Slide &&
                    value.action != compiled::ActorCueAction::Show &&
                    value.action != compiled::ActorCueAction::Hide &&
                    value.action != compiled::ActorCueAction::Move)
                    return false;
                return value.transition == compiled::ActorTransition::None
                           ? value.duration_ms == 0 &&
                                 std::holds_alternative<ImmediateWait>(value.wait)
                           : value.duration_ms > 0;
            } else if constexpr (std::is_same_v<T, compiled::AudioCueInstruction>)
                return enum_at_most(value.action, compiled::AudioAction::FadeOut) &&
                       enum_at_most(value.channel, compiled::AudioChannel::Ambient) &&
                       finite(value.volume) && value.volume >= 0.0 && value.volume <= 1.0;
            else if constexpr (std::is_same_v<T, compiled::ConditionalBranchInstruction>)
                return true;
            else if constexpr (std::is_same_v<T, compiled::ChoiceSceneInstruction>)
                return !value.options.empty();
            else if constexpr (std::is_same_v<T, compiled::SetLayoutInstruction>) {
                if (!enum_at_most(value.action, compiled::LayoutAction::Swap) ||
                    !enum_at_most(value.slot, compiled::LayoutSlot::Custom) ||
                    !enum_at_most(value.transition, compiled::LayoutTransition::Fade) ||
                    ((value.action == compiled::LayoutAction::Hide) != !value.layout.has_value()))
                    return false;
                return value.transition == compiled::LayoutTransition::None
                           ? value.duration_ms == 0 &&
                                 std::holds_alternative<ImmediateWait>(value.wait)
                           : value.duration_ms > 0;
            } else if constexpr (std::is_same_v<T, compiled::TransitionGroupInstruction>) {
                if (!enum_at_most(value.transition_kind, compiled::TransitionKind::Dissolve) ||
                    value.children.empty())
                    return false;
                if (value.transition_kind == compiled::TransitionKind::Cut) {
                    if (value.duration_ms != 0 ||
                        !std::holds_alternative<ImmediateWait>(value.wait) || value.color)
                        return false;
                } else if (value.duration_ms == 0 ||
                           (value.transition_kind == compiled::TransitionKind::Dissolve &&
                            value.color)) {
                    return false;
                }
                return std::all_of(
                    value.children.begin(), value.children.end(),
                    [](const compiled::TransitionGroupMutation& child) {
                        return std::visit(
                            [](const auto& mutation) {
                                using M = std::decay_t<decltype(mutation)>;
                                if constexpr (std::is_same_v<
                                                  M,
                                                  compiled::TransitionGroupSetBackgroundMutation>)
                                    return valid_background(mutation.background);
                                else if constexpr (std::is_same_v<
                                                       M, compiled::TransitionGroupActorMutation>)
                                    return enum_at_most(mutation.action,
                                                        compiled::ActorCueAction::Expression) &&
                                           enum_at_most(mutation.position,
                                                        compiled::ActorPosition::Custom) &&
                                           valid_vector(mutation.offset) &&
                                           finite(mutation.scale) && mutation.scale > 0.0;
                                else if constexpr (std::is_same_v<
                                                       M, compiled::TransitionGroupLayoutMutation>)
                                    return enum_at_most(mutation.action,
                                                        compiled::LayoutAction::Swap) &&
                                           (mutation.slot == compiled::LayoutSlot::Overlay ||
                                            mutation.slot == compiled::LayoutSlot::Custom) &&
                                           ((mutation.action == compiled::LayoutAction::Hide) ==
                                            !mutation.layout.has_value());
                                else
                                    return true;
                            },
                            child);
                    });
            } else
                return true;
        },
        instruction);
}

bool validate_structural_model(const compiled::CompiledProjectInput& input,
                               Diagnostics& diagnostics)
{
    if (input.identity.name.empty()) {
        diagnostics = invalid_model("Project name cannot be empty");
        return false;
    }
    if (input.settings.display.aspect_ratio.width == 0 ||
        input.settings.display.aspect_ratio.height == 0 ||
        !enum_at_most(input.settings.display.orientation, compiled::DisplayOrientation::Portrait)) {
        diagnostics = invalid_model("Runtime display settings are invalid");
        return false;
    }
    for (const auto& layout : input.settings.system_layouts) {
        if (!enum_at_most(layout.role, compiled::SystemLayoutRole::TextLog)) {
            diagnostics = invalid_model("System layout role is invalid");
            return false;
        }
    }
    if (input.localization.default_locale.empty()) {
        diagnostics = invalid_model("Default locale cannot be empty");
        return false;
    }
    for (const auto& catalog : input.localization.catalogs) {
        if (catalog.locale.empty() || std::any_of(catalog.entries.begin(), catalog.entries.end(),
                                                  [](const compiled::LocalizationEntry& entry) {
                                                      return entry.key.empty();
                                                  })) {
            diagnostics = invalid_model("Localization catalog is invalid");
            return false;
        }
    }
    for (const auto& variable : input.variables) {
        if (!valid_variable(variable)) {
            diagnostics = invalid_model("Variable declaration has an invalid default value");
            return false;
        }
    }
    for (const auto& asset : input.assets) {
        if (!enum_at_most(asset.kind, compiled::AssetKind::Binary) || asset.path.empty() ||
            std::any_of(asset.aliases.begin(), asset.aliases.end(),
                        [](const std::string& alias) { return alias.empty(); })) {
            diagnostics = invalid_model("Asset resource is invalid");
            return false;
        }
    }
    for (const auto& layout : input.layouts) {
        if (!enum_at_most(layout.kind, compiled::LayoutKind::Fragment) ||
            !enum_at_most(layout.target, compiled::LayoutTarget::CustomOverlay) ||
            !enum_at_most(layout.scale_policy.ui, LayoutScaleInheritance::Ignore) ||
            !enum_at_most(layout.scale_policy.text, LayoutScaleInheritance::Ignore)) {
            diagnostics = invalid_model("Layout resource is invalid");
            return false;
        }
    }
    for (const auto& character : input.characters) {
        for (const auto& pose : character.poses) {
            if (!valid_vector(pose.anchor) || !valid_vector(pose.offset) || !finite(pose.scale) ||
                pose.scale <= 0.0) {
                diagnostics = invalid_model("Character pose is invalid");
                return false;
            }
        }
    }
    for (const auto& room : input.rooms) {
        if (!valid_background(room.background) ||
            std::any_of(room.placements.begin(), room.placements.end(),
                        [](const compiled::RoomPlacement& placement) {
                            return !valid_rect(placement.bounds);
                        }) ||
            std::any_of(room.exits.begin(), room.exits.end(),
                        [](const compiled::RoomExit& exit) {
                            return !enum_at_most(exit.direction,
                                                 compiled::RoomExitDirection::Custom);
                        }) ||
            std::any_of(room.lifecycle.hooks.begin(), room.lifecycle.hooks.end(),
                        [](const compiled::RoomHookProgram& hook) {
                            return !enum_at_most(hook.hook, compiled::RoomHookKind::AfterLeave);
                        })) {
            diagnostics = invalid_model("Room definition is invalid");
            return false;
        }
    }
    for (const auto& interaction : input.interactions) {
        for (const auto& rule : interaction.rules) {
            if (rule.operands.size() > 2 || !valid_interaction_program(rule.program)) {
                diagnostics = invalid_model("Interaction rule is invalid");
                return false;
            }
        }
    }
    for (const auto& verb : input.verbs) {
        if (verb.arity > 2 || verb.operand_roles.size() > 2 ||
            verb.operand_roles.size() != verb.arity ||
            std::any_of(verb.operand_roles.begin(), verb.operand_roles.end(),
                        [](const std::string& role) { return role.empty(); }) ||
            !valid_interaction_program(verb.default_program)) {
            diagnostics = invalid_model("Verb definition is invalid");
            return false;
        }
    }
    for (const auto& scene : input.scenes) {
        if (!valid_background(scene.default_background) ||
            std::any_of(scene.program.instructions.begin(), scene.program.instructions.end(),
                        [](const compiled::SceneInstruction& instruction) {
                            return !valid_scene_instruction(instruction);
                        })) {
            diagnostics = invalid_model("Scene definition is invalid");
            return false;
        }
    }
    for (const auto& dialogue : input.dialogues) {
        if (!enum_at_most(dialogue.settings.log_mode, compiled::DialogueLogMode::OnlyLines)) {
            diagnostics = invalid_model("Dialogue settings are invalid");
            return false;
        }
    }
    for (const auto& map : input.maps) {
        if (!enum_at_most(map.presentation.initial_mode, compiled::InitialMapMode::FullMap)) {
            diagnostics = invalid_model("Map presentation is invalid");
            return false;
        }
        for (const auto& location : map.locations) {
            if (!valid_vector(location.position) ||
                !std::visit(
                    [](const auto& shape) {
                        using T = std::decay_t<decltype(shape)>;
                        if constexpr (std::is_same_v<T, compiled::CircleMapShape>)
                            return finite(shape.radius) && shape.radius > 0.0;
                        else if constexpr (std::is_same_v<T, compiled::RectMapShape>)
                            return finite(shape.width) && finite(shape.height) &&
                                   shape.width > 0.0 && shape.height > 0.0;
                        else
                            return true;
                    },
                    location.shape)) {
                diagnostics = invalid_model("Map location is invalid");
                return false;
            }
        }
    }
    return true;
}

template<class Id, class Value, class GetId>
bool build_index(const std::vector<Value>& values, std::unordered_map<Id, std::size_t>& index,
                 GetId get_id, std::string_view collection, Diagnostics& diagnostics)
{
    index.reserve(values.size());
    for (std::size_t position = 0; position < values.size(); ++position) {
        const Id& id = get_id(values[position]);
        const auto [unused, inserted] = index.emplace(id, position);
        if (!inserted) {
            diagnostics = duplicate_id(collection, id.text());
            return false;
        }
    }
    return true;
}

template<class Id, class Definition>
bool validate_parents(const std::vector<Definition>& definitions,
                      const std::unordered_map<Id, std::size_t>& index, std::string_view collection,
                      Diagnostics& diagnostics)
{
    enum class Visit : std::uint8_t {
        Unvisited,
        Visiting,
        Complete
    };
    std::vector<Visit> visits(definitions.size(), Visit::Unvisited);
    std::function<bool(std::size_t)> visit = [&](std::size_t position) {
        if (visits[position] == Visit::Complete)
            return true;
        if (visits[position] == Visit::Visiting) {
            diagnostics = invalid_parent(collection, definitions[position].identity.id.text(),
                                         "participates in an inheritance cycle");
            return false;
        }
        visits[position] = Visit::Visiting;
        const auto& parent = definitions[position].identity.extends;
        if (parent) {
            const auto found = index.find(*parent);
            if (found == index.end()) {
                diagnostics =
                    invalid_parent(collection, definitions[position].identity.id.text(),
                                   "references a missing parent '" + parent->text() + "'");
                return false;
            }
            if (found->second == position) {
                diagnostics = invalid_parent(collection, definitions[position].identity.id.text(),
                                             "cannot extend itself");
                return false;
            }
            if (!visit(found->second))
                return false;
        }
        visits[position] = Visit::Complete;
        return true;
    };
    for (std::size_t position = 0; position < definitions.size(); ++position) {
        if (!visit(position))
            return false;
    }
    return true;
}

template<class Id, class Definition>
void build_parent_index(const std::vector<Definition>& definitions,
                        const std::unordered_map<Id, std::size_t>& index,
                        std::unordered_map<Id, std::size_t>& parent_index)
{
    for (const auto& definition : definitions) {
        if (!definition.identity.extends)
            continue;
        const auto found = index.find(*definition.identity.extends);
        if (found != index.end())
            parent_index.emplace(definition.identity.id, found->second);
    }
}

template<class Id, class Value>
const Value* checked_find(const Id& id, const std::unordered_map<Id, std::size_t>& index,
                          const std::vector<Value>& values) noexcept
{
    const auto found = index.find(id);
    if (found == index.end() || found->second >= values.size())
        return nullptr;
    return &values[found->second];
}

template<class Id>
std::optional<std::size_t> checked_parent(const Id& id,
                                          const std::unordered_map<Id, std::size_t>& index) noexcept
{
    const auto found = index.find(id);
    if (found == index.end())
        return std::nullopt;
    return found->second;
}

} // namespace

Result<CompiledProject, Diagnostics> CompiledProject::create(compiled::CompiledProjectInput input)
{
    Diagnostics diagnostics;
    if (!validate_structural_model(input, diagnostics))
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));
#define BUILD_INDEX(id_type, member, expression, label)                                            \
    std::unordered_map<id_type, std::size_t> member##_index;                                       \
    if (!build_index(input.member, member##_index, expression, label, diagnostics))                \
    return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics))

    BUILD_INDEX(
        VariableId, variables,
        [](const compiled::VariableDefinition& value) -> const VariableId& { return value.id; },
        "variable");
    BUILD_INDEX(
        PropertyId, properties,
        [](const PropertyDefinition& value) -> const PropertyId& { return value.id(); },
        "property");
    BUILD_INDEX(
        AssetId, assets,
        [](const compiled::AssetResource& value) -> const AssetId& { return value.id; }, "asset");
    BUILD_INDEX(
        LayoutId, layouts,
        [](const compiled::LayoutResource& value) -> const LayoutId& { return value.id; },
        "layout");
    BUILD_INDEX(
        ScriptId, scripts,
        [](const compiled::ScriptResource& value) -> const ScriptId& { return value.id; },
        "script");
#define BUILD_DEFINITION_INDEX(id_type, member, type, label)                                       \
    BUILD_INDEX(                                                                                   \
        id_type, member,                                                                           \
        [](const compiled::type& value) -> const id_type& { return value.identity.id; }, label)
    BUILD_DEFINITION_INDEX(CharacterId, characters, CharacterDefinition, "character");
    BUILD_DEFINITION_INDEX(RoomId, rooms, RoomDefinition, "room");
    BUILD_DEFINITION_INDEX(InteractableId, interactables, InteractableDefinition, "interactable");
    BUILD_DEFINITION_INDEX(VerbId, verbs, VerbDefinition, "verb");
    BUILD_DEFINITION_INDEX(InteractionId, interactions, InteractionDefinition, "interaction");
    BUILD_DEFINITION_INDEX(SceneId, scenes, SceneDefinition, "scene");
    BUILD_DEFINITION_INDEX(DialogueId, dialogues, DialogueDefinition, "dialogue");
    BUILD_DEFINITION_INDEX(MapId, maps, MapDefinition, "map");
#undef BUILD_DEFINITION_INDEX
#undef BUILD_INDEX

#define VALIDATE_PARENTS(member, label)                                                            \
    if (!validate_parents(input.member, member##_index, label, diagnostics))                       \
    return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics))
    VALIDATE_PARENTS(characters, "character");
    VALIDATE_PARENTS(rooms, "room");
    VALIDATE_PARENTS(interactables, "interactable");
    VALIDATE_PARENTS(verbs, "verb");
    VALIDATE_PARENTS(interactions, "interaction");
    VALIDATE_PARENTS(scenes, "scene");
    VALIDATE_PARENTS(dialogues, "dialogue");
    VALIDATE_PARENTS(maps, "map");
#undef VALIDATE_PARENTS

    diagnostics = compiled::detail::validate_semantics(input);
    if (!diagnostics.empty())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    return Result<CompiledProject, Diagnostics>::success(CompiledProject(std::move(input)));
}

CompiledProject::CompiledProject(compiled::CompiledProjectInput input)
    : m_identity(std::move(input.identity)), m_settings(std::move(input.settings)),
      m_entrypoint(std::move(input.entrypoint)), m_startup_hook(std::move(input.startup_hook)),
      m_localization(std::move(input.localization)), m_variables(std::move(input.variables)),
      m_properties(std::move(input.properties)), m_assets(std::move(input.assets)),
      m_layouts(std::move(input.layouts)), m_scripts(std::move(input.scripts)),
      m_characters(std::move(input.characters)), m_rooms(std::move(input.rooms)),
      m_interactables(std::move(input.interactables)), m_verbs(std::move(input.verbs)),
      m_interactions(std::move(input.interactions)), m_scenes(std::move(input.scenes)),
      m_dialogues(std::move(input.dialogues)), m_maps(std::move(input.maps))
{
    Diagnostics unused;
#define INDEX(id_type, singular, plural, expression, label)                                        \
    build_index(m_##plural, m_##singular##_index, expression, label, unused)
    INDEX(
        VariableId, variable, variables,
        [](const compiled::VariableDefinition& value) -> const VariableId& { return value.id; },
        "variable");
    INDEX(
        PropertyId, property, properties,
        [](const PropertyDefinition& value) -> const PropertyId& { return value.id(); },
        "property");
    INDEX(
        AssetId, asset, assets,
        [](const compiled::AssetResource& value) -> const AssetId& { return value.id; }, "asset");
    INDEX(
        LayoutId, layout, layouts,
        [](const compiled::LayoutResource& value) -> const LayoutId& { return value.id; },
        "layout");
    INDEX(
        ScriptId, script, scripts,
        [](const compiled::ScriptResource& value) -> const ScriptId& { return value.id; },
        "script");
#define INDEX_DEFINITION(id_type, singular, plural, type, label)                                   \
    INDEX(                                                                                         \
        id_type, singular, plural,                                                                 \
        [](const compiled::type& value) -> const id_type& { return value.identity.id; }, label)
    INDEX_DEFINITION(CharacterId, character, characters, CharacterDefinition, "character");
    INDEX_DEFINITION(RoomId, room, rooms, RoomDefinition, "room");
    INDEX_DEFINITION(InteractableId, interactable, interactables, InteractableDefinition,
                     "interactable");
    INDEX_DEFINITION(VerbId, verb, verbs, VerbDefinition, "verb");
    INDEX_DEFINITION(InteractionId, interaction, interactions, InteractionDefinition,
                     "interaction");
    INDEX_DEFINITION(SceneId, scene, scenes, SceneDefinition, "scene");
    INDEX_DEFINITION(DialogueId, dialogue, dialogues, DialogueDefinition, "dialogue");
    INDEX_DEFINITION(MapId, map, maps, MapDefinition, "map");
#undef INDEX_DEFINITION
#undef INDEX

    build_parent_index(m_characters, m_character_index, m_character_parent_index);
    build_parent_index(m_rooms, m_room_index, m_room_parent_index);
    build_parent_index(m_interactables, m_interactable_index, m_interactable_parent_index);
    build_parent_index(m_verbs, m_verb_index, m_verb_parent_index);
    build_parent_index(m_interactions, m_interaction_index, m_interaction_parent_index);
    build_parent_index(m_scenes, m_scene_index, m_scene_parent_index);
    build_parent_index(m_dialogues, m_dialogue_index, m_dialogue_parent_index);
    build_parent_index(m_maps, m_map_index, m_map_parent_index);
}

#define FIND(name, plural, id_type, value_type)                                                    \
    const value_type* CompiledProject::find_##name(const id_type& id) const noexcept               \
    {                                                                                              \
        return checked_find(id, m_##name##_index, m_##plural);                                     \
    }
FIND(variable, variables, VariableId, compiled::VariableDefinition)
FIND(property, properties, PropertyId, PropertyDefinition)
FIND(asset, assets, AssetId, compiled::AssetResource)
FIND(layout, layouts, LayoutId, compiled::LayoutResource)
FIND(script, scripts, ScriptId, compiled::ScriptResource)
FIND(character, characters, CharacterId, compiled::CharacterDefinition)
FIND(room, rooms, RoomId, compiled::RoomDefinition)
FIND(interactable, interactables, InteractableId, compiled::InteractableDefinition)
FIND(verb, verbs, VerbId, compiled::VerbDefinition)
FIND(interaction, interactions, InteractionId, compiled::InteractionDefinition)
FIND(scene, scenes, SceneId, compiled::SceneDefinition)
FIND(dialogue, dialogues, DialogueId, compiled::DialogueDefinition)
FIND(map, maps, MapId, compiled::MapDefinition)
#undef FIND

#define PARENT(name, id_type)                                                                      \
    std::optional<std::size_t> CompiledProject::name##_parent_index(const id_type& id)             \
        const noexcept                                                                             \
    {                                                                                              \
        return checked_parent(id, m_##name##_parent_index);                                        \
    }
PARENT(character, CharacterId)
PARENT(room, RoomId)
PARENT(interactable, InteractableId)
PARENT(verb, VerbId)
PARENT(interaction, InteractionId)
PARENT(scene, SceneId)
PARENT(dialogue, DialogueId)
PARENT(map, MapId)
#undef PARENT

} // namespace noveltea::core
