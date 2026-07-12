#include <noveltea/core/diagnostic_context.hpp>
#include <noveltea/core/execution_primitives.hpp>
#include <noveltea/core/property.hpp>
#include <noveltea/core/text_content.hpp>
#include <noveltea/core/wait.hpp>
#include <noveltea/script/script_value.hpp>

#include <catch2/catch_test_macros.hpp>

#include <array>
#include <limits>
#include <type_traits>
#include <unordered_map>

using namespace noveltea::core;

namespace {
template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

PropertyDefinition number_property(bool nullable = false)
{
    auto result = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("ambient-light"),
        .value_type = NumberPropertyType{},
        .nullable = nullable,
        .default_value = RuntimeValue{1.0},
        .allowed_owners = {PropertyOwnerKind::Scene, PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Save,
    });
    return std::move(result).value();
}
} // namespace

TEST_CASE("strong domain IDs reject invalid text and remain type separated")
{
    STATIC_REQUIRE(!std::is_default_constructible_v<RoomId>);
    STATIC_REQUIRE(!std::is_convertible_v<RoomId, SceneId>);
    STATIC_REQUIRE(!std::is_convertible_v<SceneStepId, DialogueSegmentId>);
    STATIC_REQUIRE(std::is_same_v<noveltea::script::ScriptValue, RuntimeValue>);

    CHECK_FALSE(RoomId::create(""));
    CHECK_FALSE(RoomId::create("Upper"));
    CHECK_FALSE(RoomId::create("room--one"));
    CHECK_FALSE(RoomId::create("room-"));

    const auto room = id<RoomId>("room-one");
    std::unordered_map<RoomId, int> rooms;
    rooms.emplace(room, 7);
    const auto found = rooms.find(room);
    REQUIRE(found != rooms.end());
    CHECK(found->second == 7);
}

TEST_CASE("shared execution concepts are closed variants")
{
    STATIC_REQUIRE(std::variant_size_v<TextSource> == 3);
    STATIC_REQUIRE(std::variant_size_v<VariableComparison> == 2);
    STATIC_REQUIRE(std::variant_size_v<Condition> == 3);
    STATIC_REQUIRE(std::variant_size_v<Effect> == 2);
    STATIC_REQUIRE(std::variant_size_v<FlowTarget> == 5);
    STATIC_REQUIRE(std::variant_size_v<WaitSpec> == 7);
    STATIC_REQUIRE(std::variant_size_v<ActiveWait> == 6);
    STATIC_REQUIRE(std::variant_size_v<PropertyOwnerRef> == 8);
    STATIC_REQUIRE(std::variant_size_v<PropertyValueType> == 5);
    STATIC_REQUIRE(std::variant_size_v<NestedOwnerPath> == 8);
}

TEST_CASE("compiled wait intent is separate from typed active wait handles")
{
    STATIC_REQUIRE(!std::is_default_constructible_v<DurationWait>);
    STATIC_REQUIRE(!std::is_constructible_v<AudioInstructionWait, PresentationCompletionWait>);
    STATIC_REQUIRE(std::is_constructible_v<AudioInstructionWait, AudioCompletionWait>);
    STATIC_REQUIRE(!std::is_convertible_v<AudioHandle, PresentationHandle>);

    CHECK_FALSE(DurationWait::create(std::chrono::milliseconds{-1}));
    auto duration = DurationWait::create(std::chrono::milliseconds{10});
    REQUIRE(duration);
    CHECK(duration.value().duration() == std::chrono::milliseconds{10});
    CHECK_FALSE(AudioHandle::create(0));
    CHECK(AudioHandle::create(4));
}

TEST_CASE("variable truthiness cannot carry a comparison value")
{
    const auto variable = id<VariableId>("lights-on");
    VariableComparison truthiness = VariableTruthiness{variable, TruthinessOperator::Truthy};
    CHECK(std::holds_alternative<VariableTruthiness>(truthiness));
    VariableComparison equality =
        VariableValueComparison{variable, ValueComparisonOperator::Equal, RuntimeValue{true}};
    CHECK(std::holds_alternative<VariableValueComparison>(equality));
}

TEST_CASE("property owner mapping is exhaustive and independent of enum ordering")
{
    const std::array cases{
        std::pair{PropertyOwnerRef{id<RoomId>("room")}, PropertyOwnerKind::Room},
        std::pair{PropertyOwnerRef{id<SceneId>("scene")}, PropertyOwnerKind::Scene},
        std::pair{PropertyOwnerRef{id<DialogueId>("dialogue")}, PropertyOwnerKind::Dialogue},
        std::pair{PropertyOwnerRef{id<CharacterId>("character")}, PropertyOwnerKind::Character},
        std::pair{PropertyOwnerRef{id<InteractableId>("interactable")},
                  PropertyOwnerKind::Interactable},
        std::pair{PropertyOwnerRef{id<VerbId>("verb")}, PropertyOwnerKind::Verb},
        std::pair{PropertyOwnerRef{id<InteractionId>("interaction")},
                  PropertyOwnerKind::Interaction},
        std::pair{PropertyOwnerRef{id<MapId>("map")}, PropertyOwnerKind::Map},
    };
    for (const auto& [owner, expected] : cases)
        CHECK(property_owner_kind(owner) == expected);
}

TEST_CASE("property factories enforce owner scalar type nullability and finiteness")
{
    const auto definition = number_property();
    const auto room = PropertyOwnerRef{id<RoomId>("atrium")};
    const auto scene = PropertyOwnerRef{id<SceneId>("opening")};
    const auto map = PropertyOwnerRef{id<MapId>("world")};

    CHECK(make_property_assignment(PropertyOwnerKind::Room, definition,
                                   RuntimeValue{std::int64_t{2}}));
    CHECK_FALSE(make_property_assignment(PropertyOwnerKind::Map, definition, RuntimeValue{2.0}));
    CHECK(make_property_override(room, definition, RuntimeValue{2.0}));
    CHECK(make_property_override(scene, definition, RuntimeValue{std::int64_t{2}}));
    CHECK_FALSE(make_property_override(map, definition, RuntimeValue{2.0}));
    CHECK_FALSE(make_property_override(room, definition, RuntimeValue{std::string{"bright"}}));
    CHECK_FALSE(make_property_override(room, definition, RuntimeValue{}));
    CHECK_FALSE(make_property_override(room, definition,
                                       RuntimeValue{std::numeric_limits<double>::infinity()}));
    CHECK_FALSE(make_property_override(room, definition,
                                       RuntimeValue{std::numeric_limits<double>::quiet_NaN()}));

    const auto nullable = number_property(true);
    CHECK(make_property_assignment(PropertyOwnerKind::Room, nullable, RuntimeValue{}));
}

TEST_CASE("enum properties constrain and canonicalize string values")
{
    auto definition = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("weather"),
        .value_type = EnumPropertyType{{"rain", "clear"}},
        .nullable = false,
        .default_value = RuntimeValue{std::string{"clear"}},
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    REQUIRE(definition);
    const auto* enumeration = std::get_if<EnumPropertyType>(&definition.value().value_type());
    REQUIRE(enumeration != nullptr);
    CHECK(enumeration->values == std::vector<std::string>{"rain", "clear"});
    CHECK(make_property_assignment(PropertyOwnerKind::Room, definition.value(),
                                   RuntimeValue{std::string{"rain"}}));
    CHECK_FALSE(make_property_assignment(PropertyOwnerKind::Room, definition.value(),
                                         RuntimeValue{std::string{"snow"}}));
}

TEST_CASE("invalid property definitions fail through Result")
{
    auto duplicate_owners = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("duplicate-owner"),
        .value_type = BooleanPropertyType{},
        .nullable = false,
        .default_value = RuntimeValue{true},
        .allowed_owners = {PropertyOwnerKind::Room, PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    CHECK_FALSE(duplicate_owners);

    auto duplicate_enum = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("duplicate-enum"),
        .value_type = EnumPropertyType{{"same", "same"}},
        .nullable = false,
        .default_value = std::nullopt,
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    CHECK_FALSE(duplicate_enum);

    auto bad_default = make_property_definition(PropertyDefinitionInput{
        .id = id<PropertyId>("bad-default"),
        .value_type = BooleanPropertyType{},
        .nullable = false,
        .default_value = RuntimeValue{std::string{"yes"}},
        .allowed_owners = {PropertyOwnerKind::Room},
        .persistence = PropertyPersistence::Session,
    });
    CHECK_FALSE(bad_default);
}

TEST_CASE("diagnostic boundary values validate their representation")
{
    CHECK(DiagnosticCode::create("compiled.missing-reference"));
    CHECK(DiagnosticCode::create("domain.invalid_property_definition"));
    CHECK_FALSE(DiagnosticCode::create("Bad Code"));
    CHECK_FALSE(DiagnosticCode::create("."));
    CHECK_FALSE(DiagnosticCode::create("compiled."));
    CHECK_FALSE(DiagnosticCode::create("-.-"));
    CHECK(SourceLocation::create("project/game.json"));
    CHECK(SourceLocation::create("project/game.json", 4));
    CHECK(SourceLocation::create("project/game.json", 4, 12));
    CHECK_FALSE(SourceLocation::create(""));
    CHECK_FALSE(SourceLocation::create("project/game.json", 0, 12));
    CHECK(JsonPointer::create(""));
    CHECK(JsonPointer::create("/rooms/0/id"));
    CHECK(JsonPointer::create("/escaped~0value~1part"));
    CHECK_FALSE(JsonPointer::create("rooms/0"));
    CHECK_FALSE(JsonPointer::create("/bad~escape"));

    NestedOwnerPath scene_path = SceneStepActorSlotPath{
        id<SceneId>("opening"), id<SceneStepId>("first-step"), id<ActorSlotId>("hero")};
    CHECK(std::holds_alternative<SceneStepActorSlotPath>(scene_path));

    NestedOwnerPath dialogue_path =
        DialogueSegmentPath{id<DialogueId>("intro"), id<DialogueBlockId>("opening-block"),
                            id<DialogueSegmentId>("first-line")};
    CHECK(std::holds_alternative<DialogueSegmentPath>(dialogue_path));

    STATIC_REQUIRE(!std::is_constructible_v<DialogueSegmentPath, DialogueId, DialogueSegmentId>);
    STATIC_REQUIRE(
        !std::is_constructible_v<SceneStepActorSlotPath, SceneId, ActorSlotId, SceneStepId>);
}
