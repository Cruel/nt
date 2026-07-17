#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/feature_view.hpp>
#include <noveltea/core/flow_executor.hpp>
#include <noveltea/core/property_resolver.hpp>
#include <noveltea/core/session_state.hpp>
#include <noveltea/runtime/runtime_command_gateway.hpp>

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <string_view>
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

CompiledProject load_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
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

CompiledProject project()
{
    auto mood = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("mood"),
        .value_type = EnumPropertyType{{"calm", "tense", "bright"}},
        .nullable = false,
        .default_value = RuntimeValue{std::string{"calm"}},
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Save,
    });
    auto note = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("note"),
        .value_type = StringPropertyType{},
        .nullable = true,
        .default_value = std::nullopt,
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    auto light = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("light"),
        .value_type = NumberPropertyType{},
        .nullable = false,
        .default_value = RuntimeValue{1.0},
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    REQUIRE(mood);
    REQUIRE(note);
    REQUIRE(light);

    auto root_mood = make_property_assignment(PropertyOwnerKind::Room, mood.value(),
                                              RuntimeValue{std::string{"tense"}});
    auto root_light =
        make_property_assignment(PropertyOwnerKind::Room, light.value(), RuntimeValue{0.5});
    auto leaf_mood = make_property_assignment(PropertyOwnerKind::Room, mood.value(),
                                              RuntimeValue{std::string{"calm"}});
    REQUIRE(root_mood);
    REQUIRE(root_light);
    REQUIRE(leaf_mood);

    const auto root = id<RoomId>("area");
    const auto child = id<RoomId>("hall");
    const auto leaf = id<RoomId>("tower");
    std::vector<PropertyAssignment> root_assignments;
    root_assignments.push_back(std::move(root_mood).value());
    root_assignments.push_back(std::move(root_light).value());
    std::vector<PropertyAssignment> leaf_assignments;
    leaf_assignments.push_back(std::move(leaf_mood).value());

    std::vector<PropertyDefinition> properties;
    properties.push_back(std::move(mood).value());
    properties.push_back(std::move(note).value());
    properties.push_back(std::move(light).value());

    std::vector<compiled::RoomDefinition> rooms;
    rooms.push_back(room(root, std::nullopt, std::move(root_assignments)));
    rooms.push_back(room(child, root));
    rooms.push_back(room(leaf, child, std::move(leaf_assignments)));
    rooms.push_back(room(id<RoomId>("garden")));

    compiled::CompiledProjectInput input{
        .identity = {id<ProjectId>("session-test"), "Session", "1.0", "", ""},
        .settings = {{compiled::AspectRatio{16, 9}, "#000000",
                      compiled::DisplayOrientation::Landscape},
                     {},
                     {std::nullopt},
                     {false, true, "Start", "", std::nullopt}},
        .entrypoint = child,
        .startup_hook = std::nullopt,
        .localization = {"en", std::nullopt, {compiled::LocalizationCatalog{"en", {}}}},
        .variables = {{id<VariableId>("flag"), BooleanPropertyType{}, RuntimeValue{false}},
                      {id<VariableId>("count"), IntegerPropertyType{},
                       RuntimeValue{std::int64_t{2}}},
                      {id<VariableId>("weather"), EnumPropertyType{{"calm", "tense"}},
                       RuntimeValue{std::string{"calm"}}}},
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
    auto result = CompiledProject::create(std::move(input));
    REQUIRE(result);
    return std::move(result).value();
}

const RuntimeValue& resolved_value(const Result<PropertyLookupResult, Diagnostics>& result)
{
    REQUIRE(result);
    const auto* value = std::get_if<RuntimeValue>(&result.value());
    REQUIRE(value != nullptr);
    return *value;
}
} // namespace

TEST_CASE("session state initializes declared variables and enforces their types")
{
    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();

    CHECK(std::holds_alternative<FlowMode>(state.mode()));
    REQUIRE(state.flow_stack().size() == 1);
    const auto* transition = std::get_if<RoomTransitionFrame>(&state.flow_stack().front());
    REQUIRE(transition != nullptr);
    CHECK_FALSE(transition->source_room);
    CHECK(transition->target_room == id<RoomId>("hall"));
    CHECK(transition->position.stage == RoomTransitionStage::TargetCanEnter);
    CHECK(state.variable(compiled_project, id<VariableId>("flag")).value() == RuntimeValue{false});
    CHECK(state.variable(compiled_project, id<VariableId>("count")).value() ==
          RuntimeValue{std::int64_t{2}});

    CHECK(state.set_variable(compiled_project, id<VariableId>("flag"), RuntimeValue{true}));
    CHECK(state.variable(compiled_project, id<VariableId>("flag")).value() == RuntimeValue{true});
    CHECK_FALSE(state.set_variable(compiled_project, id<VariableId>("flag"),
                                   RuntimeValue{std::int64_t{1}}));
    CHECK(state.set_variable(compiled_project, id<VariableId>("weather"),
                             RuntimeValue{std::string{"tense"}}));
    CHECK_FALSE(state.set_variable(compiled_project, id<VariableId>("weather"),
                                   RuntimeValue{std::string{"rain"}}));
    CHECK_FALSE(
        state.set_variable(compiled_project, id<VariableId>("missing"), RuntimeValue{true}));
}

TEST_CASE("property resolution follows local authored ancestor default and missing order")
{
    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    PropertyResolver resolver(compiled_project, state);

    const auto mood = id<PropertyId>("mood");
    const auto light = id<PropertyId>("light");
    CHECK(resolved_value(resolver.get(PropertyOwnerRef{id<RoomId>("hall")}, mood)) ==
          RuntimeValue{std::string{"tense"}});
    CHECK(resolved_value(resolver.get(PropertyOwnerRef{id<RoomId>("tower")}, mood)) ==
          RuntimeValue{std::string{"calm"}});
    CHECK(resolved_value(resolver.get(PropertyOwnerRef{id<RoomId>("hall")}, light)) ==
          RuntimeValue{0.5});
    CHECK(resolved_value(resolver.get(PropertyOwnerRef{id<RoomId>("garden")}, light)) ==
          RuntimeValue{1.0});

    auto missing = resolver.get(PropertyOwnerRef{id<RoomId>("garden")}, id<PropertyId>("note"));
    REQUIRE(missing);
    const auto* missing_value = std::get_if<MissingPropertyValue>(&missing.value());
    REQUIRE(missing_value != nullptr);
    CHECK(missing_value->owner == PropertyOwnerRef{id<RoomId>("garden")});
    CHECK(missing_value->property_id == id<PropertyId>("note"));
    CHECK(state.property_override_count() == 0);
}

TEST_CASE("sparse property overrides update inheritance immediately and unset resumes fallback")
{
    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    PropertyResolver resolver(compiled_project, state);
    const auto mood = id<PropertyId>("mood");
    const PropertyOwnerRef root{id<RoomId>("area")};
    const PropertyOwnerRef child{id<RoomId>("hall")};
    const PropertyOwnerRef leaf{id<RoomId>("tower")};

    REQUIRE(resolver.set(root, mood, RuntimeValue{std::string{"bright"}}));
    CHECK(resolved_value(resolver.get(child, mood)) == RuntimeValue{std::string{"bright"}});
    CHECK(resolved_value(resolver.get(leaf, mood)) == RuntimeValue{std::string{"calm"}});
    CHECK(state.property_override_count() == 1);

    REQUIRE(resolver.set(child, mood, RuntimeValue{std::string{"tense"}}));
    REQUIRE(resolver.set(root, mood, RuntimeValue{std::string{"calm"}}));
    CHECK(resolved_value(resolver.get(child, mood)) == RuntimeValue{std::string{"tense"}});
    CHECK(state.property_override_count() == 2);

    REQUIRE(resolver.unset(child, mood));
    CHECK(resolved_value(resolver.get(child, mood)) == RuntimeValue{std::string{"calm"}});
    CHECK(state.property_override_count() == 1);
    REQUIRE(resolver.unset(root, mood));
    CHECK(resolved_value(resolver.get(child, mood)) == RuntimeValue{std::string{"tense"}});
    CHECK(state.property_override_count() == 0);
}

TEST_CASE("property mutations enforce declaration owner nullability enum and scalar constraints")
{
    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    PropertyResolver resolver(compiled_project, state);
    const PropertyOwnerRef room{id<RoomId>("hall")};

    CHECK(resolver.set(room, id<PropertyId>("note"), RuntimeValue{}));
    CHECK(std::holds_alternative<std::monostate>(
        resolved_value(resolver.get(room, id<PropertyId>("note")))));
    CHECK_FALSE(resolver.set(room, id<PropertyId>("mood"), RuntimeValue{}));
    CHECK_FALSE(resolver.set(room, id<PropertyId>("mood"), RuntimeValue{std::string{"rain"}}));
    CHECK_FALSE(resolver.set(room, id<PropertyId>("light"), RuntimeValue{std::string{"bright"}}));
    CHECK_FALSE(resolver.set(room, id<PropertyId>("light"),
                             RuntimeValue{std::numeric_limits<double>::infinity()}));
    CHECK_FALSE(resolver.get(PropertyOwnerRef{id<SceneId>("opening")}, id<PropertyId>("mood")));
    CHECK_FALSE(resolver.get(PropertyOwnerRef{id<RoomId>("missing-room")}, id<PropertyId>("mood")));
    CHECK_FALSE(resolver.get(room, id<PropertyId>("missing-property")));
    CHECK_FALSE(
        resolver.unset(PropertyOwnerRef{id<RoomId>("missing-room")}, id<PropertyId>("mood")));
}

TEST_CASE("session state exposes closed runtime mode and session-owned flow state read-only")
{
    STATIC_REQUIRE(std::variant_size_v<RuntimeMode> == 3);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, RuntimeMode>, RoomMode>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, RuntimeMode>, FlowMode>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, RuntimeMode>, EndedMode>);
    STATIC_REQUIRE(std::variant_size_v<FlowFrame> == 4);

    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    const auto state = std::move(state_result).value();
    CHECK(std::holds_alternative<FlowMode>(state.mode()));
    CHECK(state.flow_stack().size() == 1);
    CHECK_FALSE(state.blocker());
    CHECK_FALSE(state.execution_fault());
}

TEST_CASE("session state initializes and validates unique Interactable live state")
{
    const auto compiled_project = load_fixture("comprehensive.json");
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    const auto coin = id<InteractableId>("coin");
    const auto key = id<InteractableId>("key");

    REQUIRE(state.interactables().size() == compiled_project.interactables().size());
    REQUIRE(state.interactable(coin) != nullptr);
    CHECK(std::holds_alternative<compiled::InventoryLocation>(state.interactable(coin)->location));
    REQUIRE(state.interactable(key) != nullptr);
    const auto* initial_placement =
        std::get_if<compiled::RoomPlacementRef>(&state.interactable(key)->location);
    REQUIRE(initial_placement != nullptr);
    CHECK(initial_placement->room == id<RoomId>("start"));

    REQUIRE(state.move_interactable(compiled_project, key, compiled::InventoryLocation{}));
    REQUIRE(state.set_interactable_enabled(compiled_project, key, false));
    REQUIRE(state.set_interactable_visible(compiled_project, key, false));
    CHECK(std::holds_alternative<compiled::InventoryLocation>(state.interactable(key)->location));
    CHECK_FALSE(state.interactable(key)->enabled);
    CHECK_FALSE(state.interactable(key)->visible);

    REQUIRE(state.move_interactable(
        compiled_project, key,
        compiled::RoomPlacementRef{id<RoomId>("hall"), id<RoomPlacementId>("coin-placement")}));
    REQUIRE(state.move_interactable(compiled_project, key, compiled::InventoryLocation{}));
    CHECK_FALSE(state.move_interactable(compiled_project, id<InteractableId>("missing"),
                                        compiled::NowhereLocation{}));
    CHECK_FALSE(
        state.set_interactable_enabled(compiled_project, id<InteractableId>("missing"), true));
    CHECK_FALSE(
        state.set_interactable_visible(compiled_project, id<InteractableId>("missing"), true));

    noveltea::runtime::RuntimeCommandGateway gateway(
        compiled_project, state, *noveltea::runtime::CapabilityGeneration::from_number(1));
    REQUIRE(gateway.interactable_location(key));
    CHECK(std::holds_alternative<compiled::InventoryLocation>(
        gateway.interactable_location(key).value()));
}

TEST_CASE("session state validates actors and shared Scene presentation state")
{
    const auto compiled_project = load_fixture("scene-program.json");
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    const auto& frame = std::get<SceneFrame>(state.flow_stack().back());
    const ScenePresentationOwner owner{frame.frame_id, frame.scene};
    const ActorPresentationKey actor_key = SceneActorKey{owner, id<ActorSlotId>("hero-slot")};
    DesiredActorPresentation actor{
        .key = actor_key,
        .owner = owner,
        .character = id<CharacterId>("hero"),
        .pose = id<CharacterPoseId>("default"),
        .expression = id<CharacterExpressionId>("neutral"),
        .placement = {compiled::ActorPosition::Custom, {0.25, -0.1}, 1.25},
        .visible = true,
        .presentation_complete = false};

    REQUIRE(state.set_actor(compiled_project, actor));
    REQUIRE(state.actor(actor_key, owner) != nullptr);
    CHECK(state.actor(actor_key, owner)->character == id<CharacterId>("hero"));
    REQUIRE(state.set_actor_presentation_complete(compiled_project, actor_key, owner, true));
    CHECK(state.actor(actor_key, owner)->presentation_complete);

    actor.pose = id<CharacterPoseId>("missing");
    CHECK_FALSE(state.set_actor(compiled_project, actor));
    CHECK_FALSE(state.set_actor_presentation_complete(
        compiled_project, SceneActorKey{owner, id<ActorSlotId>("missing-slot")}, owner, true));

    REQUIRE(state.set_background(
        compiled_project, compiled::BackgroundPresentation{
                              id<AssetId>("image-main"), std::string{"#223344"},
                              compiled::BackgroundFit::Center, id<MaterialId>("sprite-material")}));
    REQUIRE(state.set_layout(compiled_project, compiled::LayoutSlot::Custom,
                             id<LayoutId>("hud-assets")));
    REQUIRE(
        state.present_text(compiled_project, PresentedTextState{id<CharacterId>("hero"), "Hello",
                                                                TextMarkup::ActiveText}));
    REQUIRE(state.present_choice(
        compiled_project,
        SceneChoiceState{id<SceneId>("opening"),
                         id<SceneStepId>("choice"),
                         "Choose",
                         {{id<SceneChoiceOptionId>("layout-option"), "Layout", true},
                          {id<SceneChoiceOptionId>("transition-option"), "Transition", false}}}));
    REQUIRE(state.set_audio_channel(
        compiled_project, AudioChannelState{compiled::AudioChannel::Voice,
                                            id<AssetId>("audio-voice"), 0.8, false, true}));

    CHECK(state.background_overrides().size() == 1);
    CHECK(state.mounted_layouts().size() == 1);
    CHECK(state.presented_text()->text == "Hello");
    CHECK(std::holds_alternative<SceneChoiceState>(*state.active_choice()));
    CHECK(state.audio_channels().size() == 1);

    CHECK_FALSE(state.set_background(
        compiled_project,
        compiled::BackgroundPresentation{id<AssetId>("missing"), std::nullopt,
                                         compiled::BackgroundFit::Cover, std::nullopt}));
    CHECK_FALSE(
        state.set_layout(compiled_project, compiled::LayoutSlot::Hud, id<LayoutId>("missing")));
    CHECK_FALSE(state.present_text(compiled_project, PresentedTextState{id<CharacterId>("missing"),
                                                                        "Bad", TextMarkup::Plain}));
    CHECK_FALSE(state.present_choice(
        compiled_project, SceneChoiceState{id<SceneId>("opening"),
                                           id<SceneStepId>("choice"),
                                           std::nullopt,
                                           {{id<SceneChoiceOptionId>("missing"), "Bad", true}}}));
    CHECK_FALSE(state.set_audio_channel(
        compiled_project,
        AudioChannelState{compiled::AudioChannel::Voice, std::nullopt, 1.0, false, true}));

    REQUIRE(state.clear_layout(compiled::LayoutSlot::Custom));
    state.clear_presented_text();
    state.clear_choice();
    CHECK(state.mounted_layouts().empty());
    CHECK_FALSE(state.presented_text());
    CHECK_FALSE(state.active_choice());
    REQUIRE(state.remove_actor(compiled_project, actor_key, owner));
    CHECK(state.actors().empty());
    CHECK_FALSE(state.remove_actor(compiled_project, actor_key, owner));
}

TEST_CASE("desired presentation ownership isolates nested Scene invocations and authorities")
{
    const auto project = load_fixture("scene-program.json");
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    auto second_created = SessionState::create(project);
    REQUIRE(second_created);
    CHECK(second_created.value().presentation_session_id() != state.presentation_session_id());
    CHECK(second_created.value().shell_presentation_owner() != state.shell_presentation_owner());
    FlowExecutor flow(project, state);

    const auto root = std::get<SceneFrame>(state.flow_stack().back());
    const ScenePresentationOwner root_owner{root.frame_id, root.scene};
    const ActorPresentationKey root_key = SceneActorKey{root_owner, id<ActorSlotId>("hero-slot")};
    REQUIRE(state.set_actor(project, DesiredActorPresentation{root_key,
                                                              root_owner,
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              {},
                                                              true,
                                                              true}));

    REQUIRE(flow.call_child(root.scene, FlowFramePosition{root.position}));
    const auto child = std::get<SceneFrame>(state.flow_stack().back());
    const ScenePresentationOwner child_owner{child.frame_id, child.scene};
    const ActorPresentationKey child_key = SceneActorKey{child_owner, id<ActorSlotId>("hero-slot")};
    CHECK(child_key != root_key);
    REQUIRE(state.set_actor(project, DesiredActorPresentation{child_key,
                                                              child_owner,
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              {},
                                                              true,
                                                              true}));
    REQUIRE(state.actors().size() == 2);

    REQUIRE(flow.return_from_flow());
    REQUIRE(state.actor(root_key, root_owner) != nullptr);
    CHECK(state.actor(child_key, child_owner) == nullptr);

    const ActorPresentationKey persistent_key = CharacterActorKey{id<CharacterId>("hero")};
    REQUIRE(state.set_actor(project, DesiredActorPresentation{persistent_key,
                                                              state.session_presentation_owner(),
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              {},
                                                              true,
                                                              true}));
    REQUIRE(state.set_actor(project, DesiredActorPresentation{persistent_key,
                                                              state.shell_presentation_owner(),
                                                              id<CharacterId>("hero"),
                                                              id<CharacterPoseId>("default"),
                                                              id<CharacterExpressionId>("neutral"),
                                                              {},
                                                              true,
                                                              true}));
    CHECK(state.actor(persistent_key, state.session_presentation_owner()) != nullptr);
    CHECK(state.actor(persistent_key, state.shell_presentation_owner()) != nullptr);

    const auto environment_id = id<PresentationEnvironmentInstanceId>("shared-loop");
    REQUIRE(state.upsert_presentation_environment(
        project, {environment_id, state.session_presentation_owner(), "session-loop"}));
    const PresentationOwner named_room = RoomPresentationOwner{id<RoomId>("start")};
    REQUIRE(
        state.upsert_presentation_environment(project, {environment_id, named_room, "room-loop"}));
    REQUIRE(state.presentation_environments().size() == 2);
    REQUIRE(state.upsert_presentation_environment(
        project, {environment_id, state.shell_presentation_owner(), "shell-loop"}));
    CHECK(state.presentation_environments().size() == 3);

    noveltea::runtime::RuntimeCommandGateway gateway(
        project, state, *noveltea::runtime::CapabilityGeneration::from_number(1));
    CHECK_FALSE(gateway.upsert_presentation_environment(
        {id<PresentationEnvironmentInstanceId>("forbidden-shell"), state.shell_presentation_owner(),
         "shell-only"}));
    CHECK(gateway.command_queue().size() == 0);
    CHECK_FALSE(gateway.upsert_presentation_environment(
        {id<PresentationEnvironmentInstanceId>("missing-room"),
         RoomPresentationOwner{id<RoomId>("missing")}, "invalid-loop"}));
    CHECK(gateway.command_queue().size() == 0);
    REQUIRE(gateway.upsert_presentation_environment(
        {id<PresentationEnvironmentInstanceId>("queued-gameplay"),
         state.session_presentation_owner(), "gameplay-loop"}));
    CHECK(gateway.command_queue().size() == 1);

    CHECK_FALSE(state.validate_presentation_owner(child_owner));
}

TEST_CASE("current Room presentation cleans up per visit while named Room state reactivates")
{
    const auto project = load_fixture("comprehensive.json");
    auto created = SessionState::create(project);
    REQUIRE(created);
    auto state = std::move(created).value();
    const auto start = id<RoomId>("start");
    const auto hall = id<RoomId>("hall");

    REQUIRE(state.commit_room_entry(project, start, std::nullopt));
    const auto first_visit = state.current_room_presentation_owner();
    REQUIRE(first_visit);
    REQUIRE(state.upsert_presentation_environment(
        project, {id<PresentationEnvironmentInstanceId>("visit-fog"), *first_visit, "fog"}));
    const PresentationOwner named_start = RoomPresentationOwner{start};
    REQUIRE(state.upsert_presentation_environment(
        project, {id<PresentationEnvironmentInstanceId>("room-loop"), named_start, "rain-loop"}));

    REQUIRE(state.commit_room_entry(project, hall, std::nullopt));
    CHECK(state.presentation_environments().size() == 1);
    CHECK_FALSE(state.presentation_owner_is_active(named_start));
    CHECK_FALSE(state.validate_presentation_owner(*first_visit));

    REQUIRE(state.commit_room_entry(project, start, std::nullopt));
    const auto second_visit = state.current_room_presentation_owner();
    REQUIRE(second_visit);
    CHECK(second_visit->visit != first_visit->visit);
    CHECK(state.presentation_owner_is_active(named_start));
    REQUIRE(state.presentation_environments().size() == 1);
    CHECK(state.presentation_environments().front().instance ==
          id<PresentationEnvironmentInstanceId>("room-loop"));
}

TEST_CASE("session random state is deterministic and invalid ranges are failure-atomic")
{
    const auto compiled_project = load_fixture("minimal.json");
    auto left_result = SessionState::create(compiled_project);
    auto right_result = SessionState::create(compiled_project);
    REQUIRE(left_result);
    REQUIRE(right_result);
    auto left = std::move(left_result).value();
    auto right = std::move(right_result).value();

    left.seed_random(123456789);
    right.seed_random(123456789);
    const auto first = left.next_random_u64();
    CHECK(first == 2466975172287755897ULL);
    CHECK(first == right.next_random_u64());
    CHECK(left.next_random_unit() == right.next_random_unit());
    REQUIRE(left.next_random_integer(-10, 10));
    REQUIRE(right.next_random_integer(-10, 10));
    CHECK(left.next_random_integer(-10, 10).value() == right.next_random_integer(-10, 10).value());

    const auto before = left.random_state();
    auto invalid = left.next_random_integer(5, 4);
    REQUIRE_FALSE(invalid);
    CHECK(invalid.error().front().code == "runtime.invalid_random_range");
    CHECK(left.random_state() == before);
}

TEST_CASE("session state owns Dialogue history show-once choices and typed text log")
{
    const auto compiled_project = load_fixture("dialogue-program.json");
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    const DialogueLineHistoryKey line{id<DialogueId>("intro"),
                                      id<DialogueSegmentId>("inline-line")};
    const DialogueChoiceHistoryKey choice{id<DialogueId>("intro"),
                                          id<DialogueEdgeId>("choice-redirect")};

    CHECK(state.dialogue_line_visits(line) == 0);
    REQUIRE(state.record_dialogue_line(compiled_project, line));
    REQUIRE(state.record_dialogue_line(compiled_project, line));
    CHECK(state.dialogue_line_visits(line) == 2);
    REQUIRE(state.record_dialogue_choice(compiled_project, choice));
    CHECK(state.dialogue_choice_visits(choice) == 1);
    CHECK_FALSE(state.record_dialogue_line(
        compiled_project,
        DialogueLineHistoryKey{id<DialogueId>("intro"), id<DialogueSegmentId>("missing")}));
    CHECK_FALSE(state.record_dialogue_choice(
        compiled_project,
        DialogueChoiceHistoryKey{id<DialogueId>("intro"), id<DialogueEdgeId>("start-choice")}));

    REQUIRE(state.present_choice(
        compiled_project,
        DialogueChoiceState{id<DialogueId>("intro"),
                            id<DialogueBlockId>("choice"),
                            {{id<DialogueEdgeId>("choice-redirect"), "Continue", true},
                             {id<DialogueEdgeId>("choice-final"), "Finish", false}}}));
    CHECK(std::holds_alternative<DialogueChoiceState>(*state.active_choice()));
    CHECK_FALSE(state.present_choice(
        compiled_project,
        DialogueChoiceState{id<DialogueId>("intro"),
                            id<DialogueBlockId>("start"),
                            {{id<DialogueEdgeId>("choice-redirect"), "Bad", true}}}));

    REQUIRE(state.append_text_log(
        compiled_project,
        TextLogEntry{TextLogEntryKind::Line,
                     DialogueLineTextLogOrigin{id<DialogueId>("intro"),
                                               id<DialogueSegmentId>("inline-line")},
                     id<CharacterId>("hero"), "Inline dialogue.", TextMarkup::Plain}));
    REQUIRE(state.append_text_log(
        compiled_project,
        TextLogEntry{TextLogEntryKind::Choice,
                     DialogueChoiceTextLogOrigin{id<DialogueId>("intro"),
                                                 id<DialogueEdgeId>("choice-redirect")},
                     std::nullopt, "Continue", TextMarkup::Plain}));
    CHECK(state.text_log().size() == 2);
    CHECK_FALSE(state.append_text_log(
        compiled_project, TextLogEntry{TextLogEntryKind::Line,
                                       DialogueLineTextLogOrigin{id<DialogueId>("intro"),
                                                                 id<DialogueSegmentId>("missing")},
                                       std::nullopt, "Bad", TextMarkup::Plain}));
    CHECK_FALSE(state.append_text_log(
        compiled_project,
        TextLogEntry{TextLogEntryKind::Notification,
                     DialogueLineTextLogOrigin{id<DialogueId>("intro"),
                                               id<DialogueSegmentId>("inline-line")},
                     std::nullopt, "Wrong kind", TextMarkup::Plain}));
}

TEST_CASE("session state validates Room visits overlays and Map presentation")
{
    const auto compiled_project = load_fixture("comprehensive.json");
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    const auto start = id<RoomId>("start");

    REQUIRE(state.record_room_visit(compiled_project, start));
    REQUIRE(state.record_room_visit(compiled_project, start));
    CHECK(state.room_visits(start) == 2);
    CHECK_FALSE(state.record_room_visit(compiled_project, id<RoomId>("missing")));
    REQUIRE(state.set_overlay(compiled_project, start, id<RoomOverlayId>("start-overlay"), false));
    REQUIRE(state.mounted_layouts().size() == 1);
    CHECK_FALSE(state.mounted_layouts().front().policy.visibility == LayoutVisibility::Visible);
    CHECK_FALSE(state.set_overlay(compiled_project, start, id<RoomOverlayId>("missing"), true));

    REQUIRE(state.set_map_presentation(compiled_project,
                                       MapPresentationState{id<MapId>("house"),
                                                            compiled::InitialMapMode::FullMap, true,
                                                            id<MapLocationId>("hall-location")}));
    REQUIRE(state.map_presentation());
    CHECK(state.map_presentation()->focused_location == id<MapLocationId>("hall-location"));
    CHECK_FALSE(state.set_map_presentation(
        compiled_project,
        MapPresentationState{id<MapId>("house"), compiled::InitialMapMode::Minimap, true,
                             id<MapLocationId>("missing")}));
    CHECK_FALSE(state.set_map_presentation(compiled_project,
                                           MapPresentationState{id<MapId>("missing"),
                                                                compiled::InitialMapMode::Minimap,
                                                                true, std::nullopt}));
}

TEST_CASE("feature views are a closed typed vocabulary without mutable state ownership")
{
    STATIC_REQUIRE(std::variant_size_v<FeatureView> == 6);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, FeatureView>, SceneView>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, FeatureView>, DialogueView>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, FeatureView>, RoomView>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<3, FeatureView>, InteractionView>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<4, FeatureView>, InventoryView>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<5, FeatureView>, MapView>);

    FeatureView scene = SceneView{.scene = id<SceneId>("opening")};
    FeatureView dialogue = DialogueView{.dialogue = id<DialogueId>("intro")};
    FeatureView interaction = InteractionView{.verb = id<VerbId>("look")};
    FeatureView inventory = InventoryView{};
    FeatureView map = MapView{
        .map = id<MapId>("house"), .mode = compiled::InitialMapMode::Minimap, .visible = true};
    CHECK(std::holds_alternative<SceneView>(scene));
    CHECK(std::holds_alternative<DialogueView>(dialogue));
    CHECK(std::holds_alternative<InteractionView>(interaction));
    CHECK(std::holds_alternative<InventoryView>(inventory));
    CHECK(std::holds_alternative<MapView>(map));
}
