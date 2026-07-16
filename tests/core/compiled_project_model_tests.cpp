#include <noveltea/core/compiled_project.hpp>

#include <catch2/catch_test_macros.hpp>

#include <type_traits>
#include <utility>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

TextContent text(std::string value)
{
    return TextContent{InlineText{std::move(value)}, TextMarkup::Plain};
}

compiled::RoomDefinition room(RoomId room_id, std::optional<RoomId> parent = std::nullopt,
                              std::vector<PropertyAssignment> assignments = {})
{
    return compiled::RoomDefinition{
        .identity = {std::move(room_id), std::move(parent), std::move(assignments)},
        .display_name = "Room",
        .description = text("Room description"),
        .background = {std::nullopt, std::nullopt, compiled::BackgroundFit::Cover, std::nullopt},
        .lifecycle = {Always{}, Always{}, {}},
        .overlays = {},
        .placements = {},
        .exits = {},
    };
}

compiled::CompiledProjectInput project_input()
{
    auto property = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("ambient-light"),
        .value_type = NumberPropertyType{},
        .nullable = false,
        .default_value = RuntimeValue{1.0},
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Save,
        .label = "Ambient light",
        .description = "Room lighting intensity.",
    });
    auto assignment =
        make_property_assignment(PropertyOwnerKind::Room, property.value(), RuntimeValue{0.5});
    std::vector<PropertyAssignment> assignments;
    assignments.push_back(std::move(assignment).value());

    const auto base_id = id<RoomId>("area");
    const auto child_id = id<RoomId>("atrium");
    std::vector<compiled::RoomDefinition> rooms;
    rooms.push_back(room(base_id, std::nullopt, std::move(assignments)));
    rooms.push_back(room(child_id, base_id));

    std::vector<PropertyDefinition> properties;
    properties.push_back(std::move(property).value());
    return compiled::CompiledProjectInput{
        .identity = {id<ProjectId>("sample-project"), "Sample", "1.0", "Author", "Description"},
        .settings = {{compiled::AspectRatio{16, 9}, "#000000",
                      compiled::DisplayOrientation::Landscape},
                     {},
                     {std::nullopt},
                     {true, true, "Start", "", std::nullopt}},
        .entrypoint = child_id,
        .startup_hook = std::nullopt,
        .localization = {"en", std::nullopt, {compiled::LocalizationCatalog{"en", {}}}},
        .variables = {},
        .properties = std::move(properties),
        .assets = {},
        .layouts = {},
        .scripts = {},
        .characters = {},
        .rooms = std::move(rooms),
        .interactables = {},
        .verbs = {},
        .interactions = {},
        .scenes = {},
        .dialogues = {},
        .maps = {},
    };
}
} // namespace

TEST_CASE("compiled wire identity families remain strongly separated")
{
    STATIC_REQUIRE(!std::is_convertible_v<MaterialId, AssetId>);
    STATIC_REQUIRE(!std::is_convertible_v<CharacterPoseId, CharacterExpressionId>);
    STATIC_REQUIRE(!std::is_convertible_v<RoomOverlayId, RoomPlacementId>);
    STATIC_REQUIRE(!std::is_convertible_v<SceneBranchId, SceneChoiceOptionId>);
    STATIC_REQUIRE(!std::is_convertible_v<InteractionRuleId, InteractionInstructionId>);
    STATIC_REQUIRE(!std::is_convertible_v<MapLocationId, MapConnectionId>);
}

TEST_CASE("compiled project vocabulary exposes every closed wire family")
{
    STATIC_REQUIRE(std::variant_size_v<compiled::Entrypoint> == 3);
    STATIC_REQUIRE(std::variant_size_v<compiled::LayoutSource> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::ScriptSource> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::InteractableLocation> == 3);
    STATIC_REQUIRE(std::variant_size_v<compiled::InteractionInstruction> == 6);
    STATIC_REQUIRE(std::variant_size_v<compiled::InteractionContext> == 4);
    STATIC_REQUIRE(std::variant_size_v<compiled::InteractionOperand> == 4);
    STATIC_REQUIRE(std::variant_size_v<compiled::SceneInstruction> == 13);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueSegment> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueBlock> == 3);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueEdge> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::MapShape> == 3);

    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::Entrypoint>, RoomId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::Entrypoint>, SceneId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::Entrypoint>, DialogueId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::SceneInstruction>,
                                  compiled::SetBackgroundInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::SceneInstruction>,
                                  compiled::ActorCueInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::SceneInstruction>,
                                  compiled::CallDialogueSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<3, compiled::SceneInstruction>,
                                  compiled::ShowTextInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<4, compiled::SceneInstruction>,
                                  compiled::AudioCueInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<5, compiled::SceneInstruction>,
                                  compiled::SetVariableSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<6, compiled::SceneInstruction>,
                                  compiled::RunLuaSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<7, compiled::SceneInstruction>,
                                  compiled::WaitDurationInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<8, compiled::SceneInstruction>,
                                  compiled::WaitInputInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<9, compiled::SceneInstruction>,
                                  compiled::ConditionalBranchInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<10, compiled::SceneInstruction>,
                                  compiled::ChoiceSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<11, compiled::SceneInstruction>,
                                  compiled::SetLayoutInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<12, compiled::SceneInstruction>,
                                  compiled::TransitionGroupInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::InteractionInstruction>,
                                  compiled::ApplyEffectInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::InteractionInstruction>,
                                  compiled::MoveInteractableInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::InteractionInstruction>,
                                  compiled::SetInteractableStateInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<3, compiled::InteractionInstruction>,
                                  compiled::NotifyInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<4, compiled::InteractionInstruction>,
                                  compiled::CallSceneInteractionInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<5, compiled::InteractionInstruction>,
                                  compiled::CallDialogueInteractionInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::DialogueBlock>,
                                  compiled::DialogueSequenceBlock>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::DialogueBlock>,
                                  compiled::DialogueChoiceBlock>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::DialogueBlock>,
                                  compiled::DialogueRedirectBlock>);
}

TEST_CASE("compiled project publishes immutable collections and checked indexes")
{
    STATIC_REQUIRE(!std::is_default_constructible_v<CompiledProject>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().rooms()),
                                  const std::vector<compiled::RoomDefinition>&>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_variable(
                                      std::declval<const VariableId&>())),
                                  const compiled::VariableDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_property(
                                      std::declval<const PropertyId&>())),
                                  const PropertyDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_asset(
                                      std::declval<const AssetId&>())),
                                  const compiled::AssetResource*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_layout(
                                      std::declval<const LayoutId&>())),
                                  const compiled::LayoutResource*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_script(
                                      std::declval<const ScriptId&>())),
                                  const compiled::ScriptResource*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_character(
                                      std::declval<const CharacterId&>())),
                                  const compiled::CharacterDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_room(
                                      std::declval<const RoomId&>())),
                                  const compiled::RoomDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_interactable(
                                      std::declval<const InteractableId&>())),
                                  const compiled::InteractableDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_verb(
                                      std::declval<const VerbId&>())),
                                  const compiled::VerbDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_interaction(
                                      std::declval<const InteractionId&>())),
                                  const compiled::InteractionDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_scene(
                                      std::declval<const SceneId&>())),
                                  const compiled::SceneDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_dialogue(
                                      std::declval<const DialogueId&>())),
                                  const compiled::DialogueDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_map(
                                      std::declval<const MapId&>())),
                                  const compiled::MapDefinition*>);

    auto result = CompiledProject::create(project_input());
    REQUIRE(result);
    const CompiledProject& project = result.value();

    const auto area = id<RoomId>("area");
    const auto atrium = id<RoomId>("atrium");
    REQUIRE(project.find_room(area) != nullptr);
    REQUIRE(project.find_room(atrium) != nullptr);
    CHECK(project.find_room(id<RoomId>("missing")) == nullptr);
    REQUIRE(project.find_property(id<PropertyId>("ambient-light")) != nullptr);
    CHECK(project.find_property(id<PropertyId>("ambient-light"))->label() == "Ambient light");
    CHECK(project.find_property(id<PropertyId>("ambient-light"))->description() ==
          "Room lighting intensity.");
    CHECK(project.find_asset(id<AssetId>("missing-asset")) == nullptr);

    CHECK_FALSE(project.room_parent_index(area));
    REQUIRE(project.room_parent_index(atrium));
    CHECK(*project.room_parent_index(atrium) == 0);
    REQUIRE(project.rooms()[0].identity.property_assignments.size() == 1);
    CHECK(project.rooms()[0].identity.property_assignments[0].property_id() ==
          id<PropertyId>("ambient-light"));
}

TEST_CASE("compiled project rejects an invalid project default Room transition")
{
    auto input = project_input();
    input.settings.room_navigation_transition = {compiled::TransitionKind::Cut, 250, std::nullopt,
                                                 true};
    auto result = CompiledProject::create(std::move(input));
    REQUIRE_FALSE(result);
    CHECK(result.error().front().code == "compiled_project.invalid_navigation_transition");
}

TEST_CASE("compiled project construction rejects structurally invalid public input")
{
    auto invalid_display = project_input();
    invalid_display.settings.display.aspect_ratio.width = 0;
    auto invalid_display_result = CompiledProject::create(std::move(invalid_display));
    REQUIRE_FALSE(invalid_display_result);
    CHECK(invalid_display_result.error().front().code == "compiled.invalid_model");

    auto invalid_room = project_input();
    invalid_room.rooms[0].placements.push_back(compiled::RoomPlacement{
        .id = id<RoomPlacementId>("bad-placement"),
        .bounds = {-0.1, 0.0, 0.5, 0.5},
        .order = 0,
        .presentation = {std::nullopt, std::nullopt},
    });
    auto invalid_room_result = CompiledProject::create(std::move(invalid_room));
    REQUIRE_FALSE(invalid_room_result);
    CHECK(invalid_room_result.error().front().code == "compiled.invalid_model");

    auto invalid_variable = project_input();
    invalid_variable.variables.push_back(compiled::VariableDefinition{
        .id = id<VariableId>("flag"),
        .value_type = BooleanPropertyType{},
        .default_value = RuntimeValue{std::string("not-a-boolean")},
    });
    auto invalid_variable_result = CompiledProject::create(std::move(invalid_variable));
    REQUIRE_FALSE(invalid_variable_result);
    CHECK(invalid_variable_result.error().front().code == "compiled.invalid_model");
}

TEST_CASE("compiled project construction rejects duplicate and invalid inheritance indexes")
{
    auto duplicate = project_input();
    duplicate.rooms.push_back(room(id<RoomId>("area")));
    auto duplicate_result = CompiledProject::create(std::move(duplicate));
    REQUIRE_FALSE(duplicate_result);
    CHECK(duplicate_result.error().front().code == "compiled.duplicate_id");

    auto missing_parent = project_input();
    missing_parent.rooms[1].identity.extends = id<RoomId>("missing-parent");
    auto missing_result = CompiledProject::create(std::move(missing_parent));
    REQUIRE_FALSE(missing_result);
    CHECK(missing_result.error().front().code == "compiled.invalid_inheritance");

    auto cycle = project_input();
    cycle.rooms[0].identity.extends = id<RoomId>("atrium");
    auto cycle_result = CompiledProject::create(std::move(cycle));
    REQUIRE_FALSE(cycle_result);
    CHECK(cycle_result.error().front().code == "compiled.invalid_inheritance");
}
