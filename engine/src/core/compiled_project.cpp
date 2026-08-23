#include "noveltea/core/compiled_project.hpp"

#include "compiled_project_validation.hpp"

#include <cmath>
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

Diagnostics invalid_model(std::string message)
{
    return Diagnostics{Diagnostic{.code = "compiled.invalid_model", .message = std::move(message)}};
}

bool valid_save_contract(std::string_view value) noexcept
{
    if (!value.starts_with("sc1:") || value.size() != 36)
        return false;
    for (const char character : value.substr(4))
        if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
            return false;
    return true;
}

template<class Enum> bool enum_at_most(Enum value, Enum maximum) noexcept
{
    using Underlying = std::underlying_type_t<Enum>;
    return static_cast<Underlying>(value) >= 0 &&
           static_cast<Underlying>(value) <= static_cast<Underlying>(maximum);
}

bool finite(double value) noexcept { return std::isfinite(value); }

bool valid_scale_overrides(const LayoutScaleOverrides& overrides) noexcept
{
    return (!overrides.ui || enum_at_most(*overrides.ui, LayoutScaleInheritance::Ignore)) &&
           (!overrides.text || enum_at_most(*overrides.text, LayoutScaleInheritance::Ignore));
}

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

bool valid_interactable_location(const compiled::InteractableLocation&) noexcept { return true; }

bool valid_subject_selector(const compiled::SubjectSelector& selector) noexcept
{
    return std::visit(
        [](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::FamilySubjectSelector> ||
                          std::is_same_v<T, compiled::QualifiedPatternSubjectSelector>) {
                if (!enum_at_most(value.family, compiled::SubjectFamily::ItemStack))
                    return false;
                if constexpr (std::is_same_v<T, compiled::QualifiedPatternSubjectSelector>)
                    return value.pattern.size() >= 2 && value.pattern.back() == '*' &&
                           value.pattern.substr(0, value.pattern.size() - 1).find('*') ==
                               std::string::npos;
            }
            return true;
        },
        selector);
}

bool valid_selector_union(const std::vector<compiled::SubjectSelector>& selectors) noexcept
{
    return !selectors.empty() &&
           std::all_of(selectors.begin(), selectors.end(), valid_subject_selector);
}

bool valid_interaction_program(const compiled::InteractionProgram& program) noexcept
{
    if (!enum_at_most(program.outcome, compiled::InteractionOutcome::Unhandled))
        return false;
    if (program.outcome == compiled::InteractionOutcome::Unhandled)
        return program.instructions.empty();

    std::size_t terminal_count = 0;
    for (std::size_t index = 0; index < program.instructions.size(); ++index) {
        const bool valid = std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, compiled::SetInteractableStateInstruction>)
                    return value.enabled.has_value() || value.visible.has_value();
                else if constexpr (std::is_same_v<T, compiled::MoveInteractableInstruction>)
                    return valid_interactable_location(value.target);
                else if constexpr (std::is_same_v<T, compiled::NotifyInstruction> ||
                                   std::is_same_v<T, compiled::CallSceneInteractionInstruction> ||
                                   std::is_same_v<T, compiled::CallDialogueInteractionInstruction>) {
                    ++terminal_count;
                    return index + 1 == program.instructions.size();
                } else if constexpr (std::is_same_v<T, compiled::ApplyEffectInstruction>) {
                    if (std::holds_alternative<RunLuaEffect>(value.effect)) {
                        ++terminal_count;
                        return index + 1 == program.instructions.size();
                    }
                    return true;
                } else
                    return true;
            },
            program.instructions[index]);
        if (!valid || terminal_count > 1)
            return false;
    }
    return terminal_count == 0 || std::holds_alternative<ReturnFlow>(program.completion);
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
                    !valid_scale_overrides(value.scale_overrides) ||
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
                                           valid_scale_overrides(mutation.scale_overrides) &&
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
    const auto& display = input.settings.display;
    const auto valid_accessibility_policy = [](const compiled::AccessibilityScalePolicy& policy) {
        return finite(policy.minimum) && finite(policy.maximum) && policy.minimum > 0.0 &&
               policy.maximum > 0.0 && policy.minimum <= policy.maximum &&
               (!policy.enabled || (policy.minimum <= 1.0 && policy.maximum >= 1.0));
    };
    if (display.reference_resolution.width == 0 || display.reference_resolution.height == 0 ||
        display.reference_resolution.width > compiled::max_reference_resolution_dimension ||
        display.reference_resolution.height > compiled::max_reference_resolution_dimension ||
        !enum_at_most(display.world_raster_policy, compiled::WorldRasterPolicy::Native) ||
        !valid_accessibility_policy(input.settings.accessibility.ui_scale) ||
        !valid_accessibility_policy(input.settings.accessibility.text_scale)) {
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
    for (const auto& asset : input.assets) {
        const bool sampling_matches_kind = asset.kind == compiled::AssetKind::Image
                                               ? asset.sampling.has_value()
                                               : !asset.sampling.has_value();
        if (!enum_at_most(asset.kind, compiled::AssetKind::Binary) || !sampling_matches_kind ||
            (asset.sampling && !enum_at_most(*asset.sampling, compiled::ImageSampling::Nearest)) ||
            asset.path.empty() ||
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
            std::any_of(room.script_hooks.begin(), room.script_hooks.end(),
                        [](const compiled::RoomScriptHookMapping& mapping) {
                            return !enum_at_most(mapping.hook,
                                                 compiled::RoomScriptHookKind::Compose) ||
                                   mapping.handler.export_name.empty();
                        })) {
            diagnostics = invalid_model("Room definition is invalid");
            return false;
        }
    }
    for (const auto& interaction : input.interactions) {
        for (const auto& rule : interaction.rules) {
            if (std::any_of(
                    rule.slots.begin(), rule.slots.end(),
                    [](const auto& slot) { return !valid_selector_union(slot.selectors); }) ||
                !valid_interaction_program(rule.program)) {
                diagnostics = invalid_model("Interaction rule is invalid");
                return false;
            }
        }
    }
    for (const auto& verb : input.verbs) {
        const auto valid_slots =
            std::all_of(verb.slots.begin(), verb.slots.end(),
                        [](const auto& slot) { return valid_selector_union(slot.selectors); });
        if (!valid_slots || verb.binding_order.size() != verb.slots.size() ||
            !valid_interaction_program(verb.default_program)) {
            diagnostics = invalid_model("Verb definition is invalid");
            return false;
        }
    }
    if (input.undefined_interaction_program &&
        !valid_interaction_program(*input.undefined_interaction_program)) {
        diagnostics = invalid_model("Project undefined Interaction behavior is invalid");
        return false;
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
        const auto valid_map_point = [](const compiled::Vector2& point) {
            return valid_vector(point) && point.x >= 0.0 && point.x <= 1.0 && point.y >= 0.0 &&
                   point.y <= 1.0;
        };
        const auto valid_polygon = [&](const compiled::MapPolygon& polygon) {
            return polygon.points.size() >= 3 &&
                   std::ranges::all_of(polygon.points, valid_map_point);
        };
        for (const auto& location : map.locations) {
            if (!std::ranges::all_of(location.regions, valid_polygon) ||
                (location.label_anchor && !valid_map_point(*location.label_anchor)) ||
                (location.connection_anchor && !valid_map_point(*location.connection_anchor))) {
                diagnostics = invalid_model("Map location is invalid");
                return false;
            }
        }
        for (const auto& connection : map.connections) {
            if (connection.exits.empty() || connection.exits.size() > 2 ||
                !std::ranges::all_of(connection.path, valid_map_point) ||
                !std::ranges::all_of(connection.hit_regions, valid_polygon)) {
                diagnostics = invalid_model("Map connection is invalid");
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

template<class Id, class Value>
const Value* checked_find(const Id& id, const std::unordered_map<Id, std::size_t>& index,
                          const std::vector<Value>& values) noexcept
{
    const auto found = index.find(id);
    if (found == index.end() || found->second >= values.size())
        return nullptr;
    return &values[found->second];
}

} // namespace

Result<CompiledProject, Diagnostics> CompiledProject::create(compiled::CompiledProjectInput input)
{
    Diagnostics diagnostics;
    if (!valid_save_contract(input.save_contract))
        return Result<CompiledProject, Diagnostics>::failure(
            invalid_model("Compiled Project Save Contract identity is invalid."));
    if (!validate_structural_model(input, diagnostics))
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));
#define BUILD_INDEX(id_type, member, expression, label)                                            \
    std::unordered_map<id_type, std::size_t> member##_index;                                       \
    if (!build_index(input.member, member##_index, expression, label, diagnostics))                \
    return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics))

    BUILD_INDEX(
        PropertyId, properties,
        [](const PropertyDefinition& value) -> const PropertyId& { return value.id(); },
        "property");
    BUILD_INDEX(
        TraitId, traits,
        [](const compiled::TraitDefinition& value) -> const TraitId& { return value.id; }, "trait");
    BUILD_INDEX(
        ArchetypeId, archetypes,
        [](const compiled::ArchetypeDefinition& value) -> const ArchetypeId& { return value.id; },
        "archetype");
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
    BUILD_DEFINITION_INDEX(ItemDefinitionId, item_definitions, ItemDefinition, "item definition");
    BUILD_INDEX(
        ItemStackId, item_stacks,
        [](const compiled::ItemStackDeclaration& value) -> const ItemStackId& { return value.id; },
        "item stack");
    BUILD_DEFINITION_INDEX(VerbId, verbs, VerbDefinition, "verb");
    BUILD_DEFINITION_INDEX(InteractionId, interactions, InteractionDefinition, "interaction");
    BUILD_DEFINITION_INDEX(SceneId, scenes, SceneDefinition, "scene");
    BUILD_DEFINITION_INDEX(DialogueId, dialogues, DialogueDefinition, "dialogue");
    BUILD_DEFINITION_INDEX(MapId, maps, MapDefinition, "map");
#undef BUILD_DEFINITION_INDEX
#undef BUILD_INDEX

    diagnostics = compiled::detail::validate_semantics(input);
    if (!diagnostics.empty())
        return Result<CompiledProject, Diagnostics>::failure(std::move(diagnostics));

    return Result<CompiledProject, Diagnostics>::success(CompiledProject(std::move(input)));
}

CompiledProject::CompiledProject(compiled::CompiledProjectInput input)
    : m_identity(std::move(input.identity)), m_settings(std::move(input.settings)),
      m_entrypoint(std::move(input.entrypoint)),
      m_bootstrap_module(std::move(input.bootstrap_module)),
      m_save_contract(std::move(input.save_contract)),
      m_localization(std::move(input.localization)), m_properties(std::move(input.properties)),
      m_traits(std::move(input.traits)), m_archetypes(std::move(input.archetypes)),
      m_inventories(std::move(input.inventories)), m_assets(std::move(input.assets)),
      m_layouts(std::move(input.layouts)), m_scripts(std::move(input.scripts)),
      m_characters(std::move(input.characters)), m_rooms(std::move(input.rooms)),
      m_interactables(std::move(input.interactables)),
      m_item_definitions(std::move(input.item_definitions)),
      m_item_stacks(std::move(input.item_stacks)), m_verbs(std::move(input.verbs)),
      m_interactions(std::move(input.interactions)),
      m_undefined_interaction_program(std::move(input.undefined_interaction_program)),
      m_scenes(std::move(input.scenes)),
      m_dialogues(std::move(input.dialogues)), m_maps(std::move(input.maps))
{
    Diagnostics unused;
#define INDEX(id_type, singular, plural, expression, label)                                        \
    build_index(m_##plural, m_##singular##_index, expression, label, unused)
    INDEX(
        PropertyId, property, properties,
        [](const PropertyDefinition& value) -> const PropertyId& { return value.id(); },
        "property");
    INDEX(
        TraitId, trait, traits,
        [](const compiled::TraitDefinition& value) -> const TraitId& { return value.id; }, "trait");
    INDEX(
        ArchetypeId, archetype, archetypes,
        [](const compiled::ArchetypeDefinition& value) -> const ArchetypeId& { return value.id; },
        "archetype");
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
    INDEX_DEFINITION(ItemDefinitionId, item_definition, item_definitions, ItemDefinition,
                     "item definition");
    INDEX(
        ItemStackId, item_stack, item_stacks,
        [](const compiled::ItemStackDeclaration& value) -> const ItemStackId& { return value.id; },
        "item stack");
    INDEX_DEFINITION(VerbId, verb, verbs, VerbDefinition, "verb");
    INDEX_DEFINITION(InteractionId, interaction, interactions, InteractionDefinition,
                     "interaction");
    INDEX_DEFINITION(SceneId, scene, scenes, SceneDefinition, "scene");
    INDEX_DEFINITION(DialogueId, dialogue, dialogues, DialogueDefinition, "dialogue");
    INDEX_DEFINITION(MapId, map, maps, MapDefinition, "map");
#undef INDEX_DEFINITION
#undef INDEX
}

#define FIND(name, plural, id_type, value_type)                                                    \
    const value_type* CompiledProject::find_##name(const id_type& id) const noexcept               \
    {                                                                                              \
        return checked_find(id, m_##name##_index, m_##plural);                                     \
    }
FIND(property, properties, PropertyId, PropertyDefinition)
FIND(trait, traits, TraitId, compiled::TraitDefinition)
FIND(archetype, archetypes, ArchetypeId, compiled::ArchetypeDefinition)
FIND(asset, assets, AssetId, compiled::AssetResource)
FIND(layout, layouts, LayoutId, compiled::LayoutResource)
FIND(script, scripts, ScriptId, compiled::ScriptResource)
FIND(character, characters, CharacterId, compiled::CharacterDefinition)
FIND(room, rooms, RoomId, compiled::RoomDefinition)
FIND(interactable, interactables, InteractableId, compiled::InteractableDefinition)
FIND(item_definition, item_definitions, ItemDefinitionId, compiled::ItemDefinition)
FIND(item_stack, item_stacks, ItemStackId, compiled::ItemStackDeclaration)

const compiled::FeatureDefinition*
CompiledProject::find_feature(const RoomFeatureRef& reference) const noexcept
{
    const auto* owner = find_room(reference.room);
    if (owner == nullptr)
        return nullptr;
    const auto found = std::ranges::find_if(owner->features, [&](const auto& feature) {
        return feature.identity.id == reference.feature_id;
    });
    return found == owner->features.end() ? nullptr : &*found;
}

const compiled::FeatureDefinition*
CompiledProject::find_feature(const InteractableFeatureRef& reference) const noexcept
{
    const auto* owner = find_interactable(reference.interactable);
    if (owner == nullptr)
        return nullptr;
    const auto found = std::ranges::find_if(owner->features, [&](const auto& feature) {
        return feature.identity.id == reference.feature_id;
    });
    return found == owner->features.end() ? nullptr : &*found;
}

const compiled::FeatureDefinition*
CompiledProject::find_feature(const FeatureRef& reference) const noexcept
{
    return std::visit([this](const auto& value) { return find_feature(value); }, reference);
}

const compiled::InventoryDefinition*
CompiledProject::find_inventory(const compiled::InventoryRef& reference) const noexcept
{
    const std::vector<compiled::InventoryDefinition>* values = std::visit(
        [this](const auto& owner) -> const std::vector<compiled::InventoryDefinition>* {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::ProjectInventoryOwner>)
                return &m_inventories;
            else if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>) {
                const auto* definition = find_character(owner.character);
                return definition ? &definition->inventories : nullptr;
            } else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>) {
                const auto* definition = find_interactable(owner.interactable);
                return definition ? &definition->inventories : nullptr;
            } else {
                const auto* definition = find_feature(owner);
                return definition ? &definition->inventories : nullptr;
            }
        },
        reference.owner);
    if (!values)
        return nullptr;
    const auto found =
        std::ranges::find_if(*values, [&](const compiled::InventoryDefinition& value) {
            return value.id == reference.inventory_id;
        });
    return found == values->end() ? nullptr : &*found;
}

FIND(verb, verbs, VerbId, compiled::VerbDefinition)
FIND(interaction, interactions, InteractionId, compiled::InteractionDefinition)
FIND(scene, scenes, SceneId, compiled::SceneDefinition)
FIND(dialogue, dialogues, DialogueId, compiled::DialogueDefinition)
FIND(map, maps, MapId, compiled::MapDefinition)
#undef FIND

} // namespace noveltea::core
