#include <noveltea/core/compiled_project.hpp>
#include <noveltea/core/presentation_contracts.hpp>

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

#include <type_traits>
#include <utility>

using namespace noveltea::core;
namespace compiled = noveltea::core::compiled;
using Catch::Approx;

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

template<class T>
concept ExposesItemDefinitions = requires(const T& value) { value.item_definitions(); };

template<class T>
concept ExposesItemStacks = requires(const T& value) { value.item_stacks(); };

TextContent text(std::string value)
{
    return TextContent{InlineText{std::move(value)}, TextMarkup::Plain};
}

compiled::RoomDefinition room(RoomId room_id, std::vector<TraitId> traits = {},
                              std::vector<PropertyAssignment> assignments = {})
{
    return compiled::RoomDefinition{
        .identity = {std::move(room_id), std::move(traits), std::move(assignments)},
        .display_name = "Room",
        .description = text("Room description"),
        .background = {std::nullopt, std::nullopt, compiled::BackgroundFit::Cover, std::nullopt},
        .lifecycle = {Always{}, Always{}},
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
        .scope = PropertyScope::Identity,
        .allowed_owners = {PropertyOwnerKind::Room},
        .label = "Ambient light",
        .description = "Room lighting intensity.",
    });
    const auto base_id = id<RoomId>("area");
    const auto child_id = id<RoomId>("atrium");
    const auto trait_id = id<TraitId>("dimly-lit");
    std::vector<compiled::RoomDefinition> rooms;
    rooms.push_back(room(base_id));
    rooms.push_back(room(child_id, {trait_id}));

    std::vector<PropertyDefinition> properties;
    properties.push_back(std::move(property).value());
    std::vector<compiled::TraitDefinition> traits;
    traits.push_back(compiled::TraitDefinition{
        trait_id,
        "Dimly lit",
        "Provides a dim ambient-light value.",
        {PropertyOwnerKind::Room},
        {{id<PropertyId>("ambient-light"),
          NumberPropertyType{},
          false,
          {},
          RuntimeValue{0.5},
          "Ambient light",
          "Room lighting intensity."}},
    });
    return compiled::CompiledProjectInput{
        .identity = {id<ProjectId>("sample-project"), "Sample", "1.0", "Author", "Description"},
        .settings = {{compiled::ReferenceResolution{1920, 1080}, "#000000",
                      compiled::WorldRasterPolicy::Capped},
                     {{true, 1.0, 2.0}, {true, 1.0, 2.0}},
                     {},
                     {std::nullopt},
                     {true, true, "Start", "", std::nullopt}},
        .entrypoint = child_id,
        .bootstrap_module = id<ScriptId>("bootstrap"),
        .save_contract = "sc1:00000000000000000000000000000000",
        .localization = {"en", std::nullopt, {compiled::LocalizationCatalog{"en", {}}}},
        .properties = std::move(properties),
        .traits = std::move(traits),
        .assets = {},
        .layouts = {},
        .scripts = {{id<ScriptId>("bootstrap"), compiled::InlineLuaSource{"return {}"}}},
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
    STATIC_REQUIRE(!std::is_same_v<InteractableDefinitionId, InteractableInstanceId>);
    STATIC_REQUIRE(!std::is_convertible_v<InteractableDefinitionId, InteractableInstanceId>);
    STATIC_REQUIRE(!std::is_convertible_v<InteractableInstanceId, InteractableDefinitionId>);
    STATIC_REQUIRE(!std::is_convertible_v<MaterialId, AssetId>);
    STATIC_REQUIRE(!std::is_convertible_v<CharacterPoseId, CharacterExpressionId>);
    STATIC_REQUIRE(!std::is_convertible_v<RoomOverlayId, RoomPlacementId>);
    STATIC_REQUIRE(!std::is_convertible_v<SceneBranchId, SceneChoiceOptionId>);
    STATIC_REQUIRE(!std::is_convertible_v<InteractionRuleId, InteractionInstructionId>);
    STATIC_REQUIRE(!std::is_convertible_v<VerbSlotId, InteractionRuleId>);
    STATIC_REQUIRE(!std::is_convertible_v<MapLocationId, MapConnectionId>);
}

TEST_CASE("compiled project vocabulary exposes every closed wire family")
{
    STATIC_REQUIRE(std::variant_size_v<compiled::Entrypoint> == 3);
    STATIC_REQUIRE(std::variant_size_v<compiled::LayoutSource> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::ScriptSource> == 2);
    STATIC_REQUIRE(std::variant_size_v<compiled::InteractableLocation> == 3);
    STATIC_REQUIRE(std::variant_size_v<GameplayCommand::Value> == 26);
    STATIC_REQUIRE(std::is_same_v<decltype(compiled::InteractionRule::guard), Condition>);
    STATIC_REQUIRE(std::is_same_v<decltype(compiled::InteractionRule::priority), std::int64_t>);
    STATIC_REQUIRE(std::variant_size_v<compiled::SubjectSelector> == 7);
    STATIC_REQUIRE(std::variant_size_v<compiled::SceneInstruction> == 26);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueSegment> == 4);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueBlock> == 3);
    STATIC_REQUIRE(std::variant_size_v<compiled::DialogueEdge> == 2);
    STATIC_REQUIRE(std::is_same_v<decltype(compiled::MapLocation::regions),
                                  std::vector<compiled::MapPolygon>>);

    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::Entrypoint>, RoomId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::Entrypoint>, SceneId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::Entrypoint>, DialogueId>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::SceneInstruction>,
                                  compiled::SetBackgroundInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::SceneInstruction>,
                                  compiled::ActorCueInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::SceneInstruction>,
                                  compiled::CallSceneSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<3, compiled::SceneInstruction>,
                                  compiled::StartDetachedSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<4, compiled::SceneInstruction>,
                                  compiled::CallDialogueSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<5, compiled::SceneInstruction>,
                                  compiled::ResumeDialogueSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<6, compiled::SceneInstruction>,
                                  compiled::ShowTextInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<7, compiled::SceneInstruction>,
                                  compiled::AudioCueInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<8, compiled::SceneInstruction>,
                                  compiled::GameplayEffectBatchSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<9, compiled::SceneInstruction>,
                                  compiled::RuntimeWorldTransactionSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<10, compiled::SceneInstruction>,
                                  compiled::DirectedRoomChangeSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<11, compiled::SceneInstruction>,
                                  compiled::NavigationAttemptSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<12, compiled::SceneInstruction>,
                                  compiled::CallInteractionSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<13, compiled::SceneInstruction>,
                                  compiled::RunLuaSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<14, compiled::SceneInstruction>,
                                  compiled::WaitDurationInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<15, compiled::SceneInstruction>,
                                  compiled::WaitInputInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<16, compiled::SceneInstruction>,
                                  compiled::WaitConditionInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<17, compiled::SceneInstruction>,
                                  compiled::WaitOperationInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<18, compiled::SceneInstruction>,
                                  compiled::WaitAudioInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<19, compiled::SceneInstruction>,
                                  compiled::WaitLayoutSignalInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<20, compiled::SceneInstruction>,
                                  compiled::ConditionalBranchInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<21, compiled::SceneInstruction>,
                                  compiled::ChoiceSceneInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<22, compiled::SceneInstruction>,
                                  compiled::SetLayoutInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<23, compiled::SceneInstruction>,
                                  compiled::MaterialParameterInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<24, compiled::SceneInstruction>,
                                  compiled::PostprocessEffectInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<25, compiled::SceneInstruction>,
                                  compiled::TransitionGroupInstruction>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::DialogueSegment>,
                                  compiled::DialogueLineSegment>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::DialogueSegment>,
                                  compiled::DialogueRunLuaSegment>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::DialogueSegment>,
                                  compiled::DialogueCallSceneSegment>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<3, compiled::DialogueSegment>,
                                  compiled::DialogueHandoffSegment>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, GameplayCommand::Value>,
                                  SetGlobalPropertyCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<8, GameplayCommand::Value>, MoveInstanceCommand>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<18, GameplayCommand::Value>,
                                  PresentInventoryCommand>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<19, GameplayCommand::Value>,
                                  NavigateExitCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<20, GameplayCommand::Value>, ChangeRoomCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<21, GameplayCommand::Value>, CallSceneCommand>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<22, GameplayCommand::Value>,
                                  CallDialogueCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<23, GameplayCommand::Value>, NotifyCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<24, GameplayCommand::Value>, RunLuaCommand>);
    STATIC_REQUIRE(
        std::is_same_v<std::variant_alternative_t<25, GameplayCommand::Value>, IfGameplayCommand>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, compiled::DialogueBlock>,
                                  compiled::DialogueSequenceBlock>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, compiled::DialogueBlock>,
                                  compiled::DialogueChoiceBlock>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, compiled::DialogueBlock>,
                                  compiled::DialogueRedirectBlock>);
}

TEST_CASE(
    "contextual anchoring resolves immutable normalized activation geometry in receiver space")
{
    const TriggerContext trigger{
        .pointer = TriggerPoint{0.9, 0.95},
        .source_bounds = TriggerRect{0.7, 0.7, 0.2, 0.2},
    };
    const auto logical = resolve_layout_trigger_context(trigger, 1000.0, 500.0);
    REQUIRE(logical.pointer);
    REQUIRE(logical.source_bounds);
    CHECK(logical.pointer->x == Approx(900.0));
    CHECK(logical.pointer->y == Approx(475.0));
    CHECK(logical.source_bounds->x == Approx(700.0));
    CHECK(logical.source_bounds->y == Approx(350.0));
    CHECK(logical.source_bounds->width == Approx(200.0));
    CHECK(logical.source_bounds->height == Approx(100.0));

    const auto pointer_anchor = resolve_contextual_anchor(
        logical, ContextualAnchorRequest{.source = ContextualAnchorSource::Pointer,
                                         .side = ContextualAnchorSide::Bottom,
                                         .alignment = ContextualAnchorAlignment::Start,
                                         .popup_width = 200.0,
                                         .popup_height = 100.0,
                                         .gap = 8.0,
                                         .viewport_padding = 16.0,
                                         .viewport_safe = true});
    CHECK(pointer_anchor.x == Approx(784.0));
    CHECK(pointer_anchor.y == Approx(384.0));

    const auto source_anchor = resolve_contextual_anchor(
        logical, ContextualAnchorRequest{.source = ContextualAnchorSource::SourceBounds,
                                         .side = ContextualAnchorSide::Left,
                                         .alignment = ContextualAnchorAlignment::Center,
                                         .popup_width = 120.0,
                                         .popup_height = 60.0,
                                         .gap = 10.0,
                                         .viewport_padding = 0.0,
                                         .viewport_safe = false});
    CHECK(source_anchor.x == Approx(570.0));
    CHECK(source_anchor.y == Approx(370.0));

    const LayoutLogicalTriggerContext nearest_context{
        .pointer = TriggerPoint{900.0, 50.0},
        .source_bounds = TriggerRect{200.0, 100.0, 300.0, 200.0},
        .viewport = TriggerRect{0.0, 0.0, 1000.0, 500.0},
    };
    const auto nearest_anchor = resolve_contextual_anchor(
        nearest_context,
        ContextualAnchorRequest{.source = ContextualAnchorSource::NearestSourcePoint,
                                .side = ContextualAnchorSide::Bottom,
                                .alignment = ContextualAnchorAlignment::Center,
                                .popup_width = 100.0,
                                .popup_height = 40.0,
                                .gap = 6.0,
                                .viewport_padding = 0.0,
                                .viewport_safe = false});
    CHECK(nearest_anchor.x == Approx(450.0));
    CHECK(nearest_anchor.y == Approx(106.0));
}

TEST_CASE("compiled project publishes immutable collections and checked indexes")
{
    STATIC_REQUIRE(!std::is_default_constructible_v<CompiledProject>);
    STATIC_REQUIRE(!ExposesItemDefinitions<CompiledProject>);
    STATIC_REQUIRE(!ExposesItemStacks<CompiledProject>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().rooms()),
                                  const std::vector<compiled::RoomDefinition>&>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_property(
                                      std::declval<const PropertyId&>())),
                                  const PropertyDefinition*>);
    STATIC_REQUIRE(std::is_same_v<decltype(std::declval<const CompiledProject&>().find_trait(
                                      std::declval<const TraitId&>())),
                                  const compiled::TraitDefinition*>);
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
    STATIC_REQUIRE(
        std::is_same_v<decltype(std::declval<const CompiledProject&>().find_interactable_definition(
                           std::declval<const InteractableDefinitionId&>())),
                       const compiled::InteractableDefinition*>);
    STATIC_REQUIRE(
        std::is_same_v<decltype(std::declval<const CompiledProject&>().find_interactable_instance(
                           std::declval<const InteractableInstanceId&>())),
                       const compiled::InteractableInstanceDeclaration*>);
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
    const auto* dimly_lit = project.find_trait(id<TraitId>("dimly-lit"));
    REQUIRE(dimly_lit != nullptr);
    REQUIRE(dimly_lit->properties.size() == 1);
    CHECK(dimly_lit->properties[0].property_id == id<PropertyId>("ambient-light"));
    REQUIRE(project.rooms()[1].identity.traits.size() == 1);
    CHECK(project.rooms()[1].identity.traits[0] == id<TraitId>("dimly-lit"));
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
    invalid_display.settings.display.reference_resolution.width = 0;
    auto invalid_display_result = CompiledProject::create(std::move(invalid_display));
    REQUIRE_FALSE(invalid_display_result);
    CHECK(invalid_display_result.error().front().code == "compiled.invalid_model");

    auto oversized_display = project_input();
    oversized_display.settings.display.reference_resolution.width =
        compiled::max_reference_resolution_dimension + 1;
    auto oversized_display_result = CompiledProject::create(std::move(oversized_display));
    REQUIRE_FALSE(oversized_display_result);
    CHECK(oversized_display_result.error().front().code == "compiled.invalid_model");

    auto reserved_layout = project_input();
    reserved_layout.layouts.push_back(compiled::LayoutResource{
        id<LayoutId>(std::string(compiled::builtin_inventory_layout_id)),
        compiled::LayoutKind::Document,
        compiled::LayoutTarget::CustomOverlay,
        {},
        {},
        compiled::InlineLayoutSource{""},
        compiled::InlineLayoutSource{""},
        compiled::InlineLayoutSource{""},
        {},
        std::nullopt,
        true,
        false,
        std::nullopt,
    });
    auto reserved_layout_result = CompiledProject::create(std::move(reserved_layout));
    REQUIRE_FALSE(reserved_layout_result);
    CHECK(reserved_layout_result.error().front().code == "compiled.invalid_model");

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

    auto invalid_global = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("flag"),
        .value_type = BooleanPropertyType{},
        .nullable = false,
        .default_value = std::nullopt,
        .scope = PropertyScope::Global,
        .allowed_owners = {},
        .label = "Flag",
        .description = "Global flag.",
    });
    REQUIRE_FALSE(invalid_global);
    CHECK(invalid_global.error().front().code == "domain.invalid_property_definition");
}

TEST_CASE("compiled project construction rejects duplicate and invalid Trait attachments")
{
    auto duplicate = project_input();
    duplicate.rooms.push_back(room(id<RoomId>("area")));
    auto duplicate_result = CompiledProject::create(std::move(duplicate));
    REQUIRE_FALSE(duplicate_result);
    CHECK(duplicate_result.error().front().code == "compiled.duplicate_id");

    auto missing_trait = project_input();
    missing_trait.rooms[1].identity.traits = {id<TraitId>("missing-trait")};
    auto missing_result = CompiledProject::create(std::move(missing_trait));
    REQUIRE_FALSE(missing_result);
    CHECK(missing_result.error().front().code == "compiled_project.unresolved_reference");

    auto duplicate_trait = project_input();
    duplicate_trait.rooms[1].identity.traits = {id<TraitId>("dimly-lit"), id<TraitId>("dimly-lit")};
    auto duplicate_trait_result = CompiledProject::create(std::move(duplicate_trait));
    REQUIRE_FALSE(duplicate_trait_result);
    CHECK(duplicate_trait_result.error().front().code ==
          "compiled_project.duplicate_trait_attachment");
}

TEST_CASE("compiled project scopes exact-owner Property identity by owner and key")
{
    auto input = project_input();
    const auto area = id<RoomId>("area");
    const auto atrium = id<RoomId>("atrium");

    auto area_state = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("state"),
        .value_type = BooleanPropertyType{},
        .nullable = false,
        .default_value = std::nullopt,
        .scope = PropertyScope::Identity,
        .allowed_owners = {},
        .exact_owner = PropertyOwnerRef{area},
        .label = "Area state",
    });
    auto atrium_state = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("state"),
        .value_type = StringPropertyType{},
        .nullable = false,
        .default_value = std::nullopt,
        .scope = PropertyScope::Identity,
        .allowed_owners = {},
        .exact_owner = PropertyOwnerRef{atrium},
        .label = "Atrium state",
    });
    REQUIRE(area_state);
    REQUIRE(atrium_state);
    input.properties.push_back(std::move(area_state).value());
    input.properties.push_back(std::move(atrium_state).value());

    auto valid = CompiledProject::create(std::move(input));
    REQUIRE(valid);
    REQUIRE(valid.value().find_property(PropertyOwnerRef{area}, id<PropertyId>("state")) !=
            nullptr);
    REQUIRE(valid.value().find_property(PropertyOwnerRef{atrium}, id<PropertyId>("state")) !=
            nullptr);
    CHECK(std::holds_alternative<BooleanPropertyType>(
        valid.value()
            .find_property(PropertyOwnerRef{area}, id<PropertyId>("state"))
            ->value_type()));
    CHECK(std::holds_alternative<StringPropertyType>(
        valid.value()
            .find_property(PropertyOwnerRef{atrium}, id<PropertyId>("state"))
            ->value_type()));

    auto duplicate = project_input();
    auto first = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("state"),
        .value_type = BooleanPropertyType{},
        .nullable = false,
        .default_value = std::nullopt,
        .scope = PropertyScope::Identity,
        .allowed_owners = {},
        .exact_owner = PropertyOwnerRef{area},
        .label = "State",
    });
    auto second = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("state"),
        .value_type = NumberPropertyType{},
        .nullable = false,
        .default_value = std::nullopt,
        .scope = PropertyScope::Identity,
        .allowed_owners = {},
        .exact_owner = PropertyOwnerRef{area},
        .label = "Duplicate state",
    });
    REQUIRE(first);
    REQUIRE(second);
    duplicate.properties.push_back(std::move(first).value());
    duplicate.properties.push_back(std::move(second).value());
    auto duplicate_result = CompiledProject::create(std::move(duplicate));
    REQUIRE_FALSE(duplicate_result);
    CHECK(duplicate_result.error().front().code == "compiled.invalid_model");
}
