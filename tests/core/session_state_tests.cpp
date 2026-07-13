#include <noveltea/core/property_resolver.hpp>
#include <noveltea/core/session_state.hpp>

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <limits>
#include <string>
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

    const auto* room_mode = std::get_if<RoomMode>(&state.mode());
    REQUIRE(room_mode != nullptr);
    CHECK(room_mode->room == id<RoomId>("hall"));
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

TEST_CASE("session state holds closed runtime mode and typed logical wait state")
{
    STATIC_REQUIRE(std::variant_size_v<RuntimeMode> == 3);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<0, RuntimeMode>, RoomMode>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<1, RuntimeMode>, FlowMode>);
    STATIC_REQUIRE(std::is_same_v<std::variant_alternative_t<2, RuntimeMode>, EndedMode>);

    const auto compiled_project = project();
    auto state_result = SessionState::create(compiled_project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    CHECK_FALSE(state.active_wait());

    auto duration = DurationWait::create(std::chrono::milliseconds{25});
    REQUIRE(duration);
    state.set_active_wait(DurationWaitState{std::move(duration).value()});
    REQUIRE(state.active_wait());
    CHECK(std::holds_alternative<DurationWaitState>(*state.active_wait()));
    state.clear_active_wait();
    CHECK_FALSE(state.active_wait());

    state.set_mode(EndedMode{});
    CHECK(std::holds_alternative<EndedMode>(state.mode()));
}
