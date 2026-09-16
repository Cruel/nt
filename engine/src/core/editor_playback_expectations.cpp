#include "noveltea/core/editor_playback_expectations.hpp"

#include "noveltea/core/json_access.hpp"

#include <algorithm>
#include <cmath>
#include <optional>
#include <ranges>
#include <string>
#include <string_view>
#include <type_traits>
#include <variant>

namespace noveltea::core::editor {
namespace {

std::optional<double> numeric_runtime_value(const RuntimeValue& value)
{
    if (const auto* integer = std::get_if<std::int64_t>(&value))
        return static_cast<double>(*integer);
    if (const auto* number = std::get_if<double>(&value))
        return *number;
    return std::nullopt;
}

bool compare_runtime_values(const RuntimeValue& actual, const RuntimeValue& expected,
                            TypedPlaybackExpectationOperator op)
{
    const auto actual_number = numeric_runtime_value(actual);
    const auto expected_number = numeric_runtime_value(expected);
    if (actual_number && expected_number) {
        switch (op) {
        case TypedPlaybackExpectationOperator::Equal:
            return *actual_number == *expected_number;
        case TypedPlaybackExpectationOperator::NotEqual:
            return *actual_number != *expected_number;
        case TypedPlaybackExpectationOperator::Greater:
            return *actual_number > *expected_number;
        case TypedPlaybackExpectationOperator::GreaterEqual:
            return *actual_number >= *expected_number;
        case TypedPlaybackExpectationOperator::Less:
            return *actual_number < *expected_number;
        case TypedPlaybackExpectationOperator::LessEqual:
            return *actual_number <= *expected_number;
        default:
            return false;
        }
    }
    if (op == TypedPlaybackExpectationOperator::Equal)
        return actual == expected;
    if (op == TypedPlaybackExpectationOperator::NotEqual)
        return actual != expected;
    return false;
}

bool compare_number(double actual, double expected, TypedPlaybackExpectationOperator op)
{
    switch (op) {
    case TypedPlaybackExpectationOperator::Equal:
        return actual == expected;
    case TypedPlaybackExpectationOperator::NotEqual:
        return actual != expected;
    case TypedPlaybackExpectationOperator::Greater:
        return actual > expected;
    case TypedPlaybackExpectationOperator::GreaterEqual:
        return actual >= expected;
    case TypedPlaybackExpectationOperator::Less:
        return actual < expected;
    case TypedPlaybackExpectationOperator::LessEqual:
        return actual <= expected;
    default:
        return false;
    }
}

bool compare_presence(bool present, TypedPlaybackExpectationOperator op)
{
    return op == TypedPlaybackExpectationOperator::Present  ? present
           : op == TypedPlaybackExpectationOperator::Absent ? !present
                                                            : false;
}

std::optional<PropertyOwnerRef> playback_property_owner(std::string_view kind, std::string_view id)
{
    if (kind == "room") {
        auto value = RoomId::create(std::string(id));
        if (value)
            return PropertyOwnerRef{*value.value_if()};
    } else if (kind == "character") {
        auto value = CharacterId::create(std::string(id));
        if (value)
            return PropertyOwnerRef{*value.value_if()};
    } else if (kind == "interactable") {
        auto value = InteractableInstanceId::create(std::string(id));
        if (value)
            return PropertyOwnerRef{*value.value_if()};
    }
    return std::nullopt;
}

std::optional<RuntimeValue> expectation_runtime_value(const auto& fields)
{
    const auto value = fields.find("value");
    if (value == fields.end())
        return std::nullopt;
    auto decoded = decode_editor_runtime_value_text(value->dump());
    if (!decoded)
        return std::nullopt;
    return *decoded.value_if();
}

std::optional<PersistableValue> expectation_persistable_value(const auto& value)
{
    if (value.is_null())
        return PersistableValue{std::monostate{}};
    if (value.is_boolean())
        return PersistableValue{*json_access::get<bool>(value)};
    if (value.is_number_integer())
        return PersistableValue{*json_access::get<std::int64_t>(value)};
    if (value.is_number_float()) {
        const auto number = *json_access::get<double>(value);
        return std::isfinite(number) ? std::optional<PersistableValue>{PersistableValue{number}}
                                     : std::nullopt;
    }
    if (value.is_string())
        return PersistableValue{*json_access::get<std::string>(value)};
    if (value.is_array()) {
        PersistableValue::Array array;
        array.reserve(value.size());
        for (const auto& item : value) {
            auto decoded = expectation_persistable_value(item);
            if (!decoded)
                return std::nullopt;
            array.push_back(std::move(*decoded));
        }
        return PersistableValue{std::move(array)};
    }
    if (value.is_object()) {
        PersistableValue::Object object;
        object.reserve(value.size());
        for (auto item = value.begin(); item != value.end(); ++item) {
            auto decoded = expectation_persistable_value(item.value());
            if (!decoded)
                return std::nullopt;
            object.emplace_back(item.key(), std::move(*decoded));
        }
        return PersistableValue{std::move(object)};
    }
    return std::nullopt;
}

std::optional<double> numeric_persistable_value(const PersistableValue& value)
{
    if (const auto* integer = std::get_if<std::int64_t>(&value.value))
        return static_cast<double>(*integer);
    if (const auto* number = std::get_if<double>(&value.value))
        return *number;
    return std::nullopt;
}

bool persistable_values_equal(const PersistableValue& left, const PersistableValue& right)
{
    if (left.value.index() != right.value.index()) {
        const auto left_number = numeric_persistable_value(left);
        const auto right_number = numeric_persistable_value(right);
        return left_number && right_number && *left_number == *right_number;
    }
    if (const auto* left_array = std::get_if<PersistableValue::Array>(&left.value)) {
        const auto* right_array = std::get_if<PersistableValue::Array>(&right.value);
        return right_array != nullptr && left_array->size() == right_array->size() &&
               std::equal(left_array->begin(), left_array->end(), right_array->begin(),
                          persistable_values_equal);
    }
    if (const auto* left_object = std::get_if<PersistableValue::Object>(&left.value)) {
        const auto* right_object = std::get_if<PersistableValue::Object>(&right.value);
        if (right_object == nullptr || left_object->size() != right_object->size())
            return false;
        return std::ranges::all_of(*left_object, [&](const auto& field) {
            const auto found = std::ranges::find_if(*right_object, [&](const auto& candidate) {
                return candidate.first == field.first;
            });
            return found != right_object->end() &&
                   persistable_values_equal(field.second, found->second);
        });
    }
    return left == right;
}

std::string save_outcome_name(SaveOutcomeStatus status)
{
    switch (status) {
    case SaveOutcomeStatus::Saved:
        return "saved";
    case SaveOutcomeStatus::Loaded:
        return "loaded";
    case SaveOutcomeStatus::Deleted:
        return "deleted";
    case SaveOutcomeStatus::Failed:
        return "failed";
    }
    return "unknown";
}

bool location_matches(const compiled::InteractableLocation& actual, const auto& fields)
{
    const auto kind = json_access::value_or(fields, "locationKind", std::string{});
    if (kind == "unplaced")
        return std::holds_alternative<compiled::UnplacedLocation>(actual);
    if (kind == "room") {
        const auto* room = std::get_if<compiled::RoomLocation>(&actual);
        return room != nullptr &&
               room->room.text() == json_access::value_or(fields, "roomId", std::string{});
    }
    const auto* inventory = std::get_if<compiled::InventoryLocation>(&actual);
    if (inventory == nullptr || kind != "inventory")
        return false;
    const auto owner_kind = json_access::value_or(fields, "inventoryOwnerKind", std::string{});
    const auto owner_id = json_access::value_or(fields, "inventoryOwnerId", std::string{});
    const bool owner_matches = std::visit(
        [&](const auto& owner) {
            using T = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<T, compiled::ProjectInventoryOwner>)
                return owner_kind == "project";
            else if constexpr (std::is_same_v<T, compiled::CharacterInventoryOwner>)
                return owner_kind == "character" && owner.character.text() == owner_id;
            else if constexpr (std::is_same_v<T, compiled::InteractableInventoryOwner>)
                return owner_kind == "interactable" && owner.interactable.text() == owner_id;
            else
                return false;
        },
        inventory->inventory.owner);
    return owner_matches && inventory->inventory.inventory_id.text() ==
                                json_access::value_or(fields, "inventoryId", std::string{});
}

bool location_matches(const CharacterWorldLocation& actual, const auto& fields)
{
    const auto kind = json_access::value_or(fields, "locationKind", std::string{});
    if (kind == "unplaced")
        return std::holds_alternative<compiled::UnplacedLocation>(actual);
    const auto* room = std::get_if<compiled::RoomLocation>(&actual);
    return kind == "room" && room != nullptr &&
           room->room.text() == json_access::value_or(fields, "roomId", std::string{});
}

bool location_is_present(const compiled::InteractableLocation& actual)
{
    return !std::holds_alternative<compiled::UnplacedLocation>(actual);
}

bool location_is_present(const CharacterWorldLocation& actual)
{
    return !std::holds_alternative<compiled::UnplacedLocation>(actual);
}

} // namespace

TypedPlaybackExpectationReport evaluate_playback_expectation(
    const TypedPlaybackExpectation& expectation, const runtime::RuntimeSession& session,
    const runtime::RuntimePublication& publication,
    const std::vector<runtime::RuntimeEvent>& events, const Diagnostics& diagnostics)
{
    TypedPlaybackExpectationReport report{expectation.id, false, {}};
    const auto& fields = expectation.fields;
    auto fail = [&](std::string message) {
        report.message = std::move(message);
        return report;
    };
    auto pass = [&]() {
        report.passed = true;
        report.message = "Expectation passed.";
        return report;
    };
    const auto& gateway = session.gateway();

    switch (expectation.kind) {
    case TypedPlaybackExpectationKind::Property: {
        auto property =
            PropertyId::create(json_access::value_or(fields, "propertyId", std::string{}));
        if (!property)
            return fail("Property expectation references an invalid Property id.");
        Result<PropertyLookupResult, Diagnostics> actual =
            json_access::value_or(fields, "scope", std::string{}) == "global"
                ? gateway.global_property_lookup(*property.value_if())
                : [&]() -> Result<PropertyLookupResult, Diagnostics> {
            auto owner =
                playback_property_owner(json_access::value_or(fields, "scope", std::string{}),
                                        json_access::value_or(fields, "ownerId", std::string{}));
            if (!owner)
                return Result<PropertyLookupResult, Diagnostics>::failure({});
            return gateway.property(*owner, *property.value_if());
        }();
        if (!actual)
            return fail("Property expectation could not resolve its semantic target.");
        const auto* lookup = actual.value_if();
        const bool present = lookup != nullptr && std::holds_alternative<RuntimeValue>(*lookup);
        if (expectation.op == TypedPlaybackExpectationOperator::Present ||
            expectation.op == TypedPlaybackExpectationOperator::Absent)
            return compare_presence(present, expectation.op)
                       ? pass()
                       : fail("Property presence did not match.");
        if (!present)
            return fail("Property expectation required a value, but the Property is absent.");
        const auto expected = expectation_runtime_value(fields);
        return expected && compare_runtime_values(std::get<RuntimeValue>(*lookup), *expected,
                                                  expectation.op)
                   ? pass()
                   : fail("Property value did not match.");
    }
    case TypedPlaybackExpectationKind::CurrentRoom: {
        const auto expected = json_access::value_or(fields, "roomId", std::string{});
        const bool present = publication.prediction_context.current_room.has_value();
        if (expectation.op == TypedPlaybackExpectationOperator::Present ||
            expectation.op == TypedPlaybackExpectationOperator::Absent)
            return compare_presence(present, expectation.op)
                       ? pass()
                       : fail("Current Room presence did not match.");
        const bool equal =
            present && publication.prediction_context.current_room->text() == expected;
        return (expectation.op == TypedPlaybackExpectationOperator::Equal ? equal : !equal)
                   ? pass()
                   : fail("Current Room did not match.");
    }
    case TypedPlaybackExpectationKind::Location: {
        const auto entity_kind = json_access::value_or(fields, "entityKind", std::string{});
        const auto entity_id = json_access::value_or(fields, "entityId", std::string{});
        bool matched = false;
        bool present = false;
        bool resolved = false;
        if (entity_kind == "character") {
            auto id = CharacterId::create(entity_id);
            if (id) {
                auto actual = gateway.character_location(*id.value_if());
                if (actual) {
                    resolved = true;
                    matched = location_matches(*actual.value_if(), fields);
                    present = location_is_present(*actual.value_if());
                }
            }
        } else {
            auto id = InteractableInstanceId::create(entity_id);
            if (id) {
                auto actual = gateway.interactable_location(*id.value_if());
                if (actual) {
                    resolved = true;
                    matched = location_matches(*actual.value_if(), fields);
                    present = location_is_present(*actual.value_if());
                }
            }
        }
        if (!resolved)
            return fail("Location expectation could not resolve its semantic target.");
        if (expectation.op == TypedPlaybackExpectationOperator::Present ||
            expectation.op == TypedPlaybackExpectationOperator::Absent)
            return compare_presence(present, expectation.op)
                       ? pass()
                       : fail("Location presence did not match.");
        return (expectation.op == TypedPlaybackExpectationOperator::Equal ? matched : !matched)
                   ? pass()
                   : fail("Entity location did not match.");
    }
    case TypedPlaybackExpectationKind::Quantity: {
        auto id = InteractableInstanceId::create(
            json_access::value_or(fields, "interactableId", std::string{}));
        if (!id)
            return fail("Quantity expectation references an invalid Interactable Instance id.");
        auto actual = gateway.interactable_quantity(*id.value_if());
        if (!actual)
            return fail("Quantity expectation could not resolve its Interactable Instance.");
        const auto expected = json_access::value_or(fields, "value", 0.0);
        return compare_number(static_cast<double>(*actual.value_if()), expected, expectation.op)
                   ? pass()
                   : fail("Interactable quantity did not match.");
    }
    case TypedPlaybackExpectationKind::Trait: {
        auto owner =
            playback_property_owner(json_access::value_or(fields, "ownerKind", std::string{}),
                                    json_access::value_or(fields, "ownerId", std::string{}));
        auto trait = TraitId::create(json_access::value_or(fields, "traitId", std::string{}));
        if (!owner || !trait)
            return fail("Trait expectation references an invalid semantic target.");
        auto actual = gateway.has_trait(*owner, *trait.value_if());
        if (!actual)
            return fail("Trait expectation could not resolve its semantic target.");
        return compare_presence(*actual.value_if(), expectation.op)
                   ? pass()
                   : fail("Trait presence did not match.");
    }
    case TypedPlaybackExpectationKind::EntityState: {
        const auto entity_kind = json_access::value_or(fields, "entityKind", std::string{});
        const auto entity_id = json_access::value_or(fields, "entityId", std::string{});
        const auto field = json_access::value_or(fields, "field", std::string{});
        const bool expected = json_access::value_or(fields, "value", false);
        std::optional<bool> actual;
        if (entity_kind == "character") {
            auto id = CharacterId::create(entity_id);
            if (id) {
                auto state = gateway.character_world_state(*id.value_if());
                if (state)
                    actual =
                        field == "visible" ? state.value_if()->visible : state.value_if()->enabled;
            }
        } else {
            auto id = InteractableInstanceId::create(entity_id);
            if (id) {
                auto state = gateway.interactable_state(*id.value_if());
                if (state)
                    actual =
                        field == "visible" ? state.value_if()->visible : state.value_if()->enabled;
            }
        }
        if (!actual)
            return fail("Entity-state expectation could not resolve its semantic target.");
        const bool equal = *actual == expected;
        return (expectation.op == TypedPlaybackExpectationOperator::Equal ? equal : !equal)
                   ? pass()
                   : fail("Entity state did not match.");
    }
    case TypedPlaybackExpectationKind::ActiveFlow: {
        const auto kind = json_access::value_or(fields, "kind", std::string{});
        const auto id = json_access::value_or(fields, "flowId", std::string{});
        const bool present = kind == "dialogue" ? publication.active_dialogue.has_value()
                                                : publication.active_scene.has_value();
        if (expectation.op == TypedPlaybackExpectationOperator::Present ||
            expectation.op == TypedPlaybackExpectationOperator::Absent)
            return compare_presence(present, expectation.op)
                       ? pass()
                       : fail("Active flow presence did not match.");
        const bool equal = kind == "dialogue"
                               ? present && publication.active_dialogue->dialogue.text() == id
                               : present && publication.active_scene->scene.text() == id;
        return (expectation.op == TypedPlaybackExpectationOperator::Equal ? equal : !equal)
                   ? pass()
                   : fail("Active flow did not match.");
    }
    case TypedPlaybackExpectationKind::Layout: {
        auto layout = LayoutId::create(json_access::value_or(fields, "layoutId", std::string{}));
        if (!layout)
            return fail("Layout expectation references an invalid Layout id.");
        const auto field = json_access::value_or(fields, "field", std::string{});
        if (field == "mounted") {
            const bool present =
                std::ranges::any_of(publication.presentation.layouts, [&](const auto& value) {
                    return value.layout == *layout.value_if();
                });
            return compare_presence(present, expectation.op)
                       ? pass()
                       : fail("Mounted Layout presence did not match.");
        }
        const auto states = gateway.layout_states(*layout.value_if());
        if (states.size() != 1)
            return fail(
                "Layout state expectation requires exactly one live state slot for the Layout.");
        const auto value = fields.find("value");
        const auto expected =
            value == fields.end() ? std::nullopt : expectation_persistable_value(*value);
        if (!expected)
            return fail("Layout state expectation contains an invalid persistable value.");
        if (expectation.op == TypedPlaybackExpectationOperator::Equal ||
            expectation.op == TypedPlaybackExpectationOperator::NotEqual) {
            const bool equal = persistable_values_equal(states.front(), *expected);
            return (expectation.op == TypedPlaybackExpectationOperator::Equal ? equal : !equal)
                       ? pass()
                       : fail("Layout state did not match.");
        }
        const auto actual_number = numeric_persistable_value(states.front());
        const auto expected_number = numeric_persistable_value(*expected);
        return actual_number && expected_number &&
                       compare_number(*actual_number, *expected_number, expectation.op)
                   ? pass()
                   : fail("Layout state did not match.");
    }
    case TypedPlaybackExpectationKind::Event: {
        const auto kind = json_access::value_or(fields, "kind", std::string{});
        const auto expected = json_access::value_or(fields, "value", std::string{});
        const bool present = std::ranges::any_of(events, [&](const auto& event) {
            return std::visit(
                [&](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, runtime::NotificationEvent>)
                        return kind == "notification" && value.message == expected;
                    else if constexpr (std::is_same_v<T, runtime::SaveOutcomeEvent>)
                        return kind == "save-outcome" &&
                               save_outcome_name(value.outcome.status) == expected;
                    return false;
                },
                event);
        });
        return compare_presence(present, expectation.op)
                   ? pass()
                   : fail("Expected runtime event presence did not match.");
    }
    case TypedPlaybackExpectationKind::Diagnostic: {
        const auto code = json_access::value_or(fields, "code", std::string{});
        const bool present =
            std::ranges::any_of(diagnostics, [&](const auto& value) { return value.code == code; });
        return compare_presence(present, expectation.op)
                   ? pass()
                   : fail("Expected diagnostic presence did not match.");
    }
    }
    return fail("Unsupported expectation.");
}

} // namespace noveltea::core::editor
