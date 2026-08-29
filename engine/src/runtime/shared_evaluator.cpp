#include "noveltea/core/shared_evaluator.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/runtime/runtime_world.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics evaluation_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool is_number(const RuntimeValue& value) noexcept
{
    return std::holds_alternative<std::int64_t>(value) || std::holds_alternative<double>(value);
}

bool finite_number(const RuntimeValue& value) noexcept
{
    const auto* number = std::get_if<double>(&value);
    return number == nullptr || std::isfinite(*number);
}

long double number_value(const RuntimeValue& value) noexcept
{
    if (const auto* integer = std::get_if<std::int64_t>(&value))
        return static_cast<long double>(*integer);
    return static_cast<long double>(*std::get_if<double>(&value));
}

bool values_match_declaration(const PropertyDefinition& declaration, const RuntimeValue& left,
                              const RuntimeValue& right) noexcept
{
    return finite_number(left) && finite_number(right) &&
           property_value_matches(declaration, left) && property_value_matches(declaration, right);
}

Result<bool, Diagnostics> compare_values(const PropertyDefinition& declaration,
                                         ValueComparisonOperator operation,
                                         const RuntimeValue& expected, const RuntimeValue& current)
{
    if (!values_match_declaration(declaration, current, expected))
        return Result<bool, Diagnostics>::failure(evaluation_error(
            "execution.invalid_comparison_value",
            "Property comparison contains a non-finite or type-incompatible value"));

    const bool equality = [&]() {
        if (is_number(current) && is_number(expected))
            return number_value(current) == number_value(expected);
        return current == expected;
    }();
    if (operation == ValueComparisonOperator::Equal)
        return Result<bool, Diagnostics>::success(equality);
    if (operation == ValueComparisonOperator::NotEqual)
        return Result<bool, Diagnostics>::success(!equality);

    if (std::holds_alternative<std::monostate>(current) ||
        std::holds_alternative<std::monostate>(expected) ||
        std::holds_alternative<BooleanPropertyType>(declaration.value_type()) ||
        std::holds_alternative<EnumPropertyType>(declaration.value_type()))
        return Result<bool, Diagnostics>::failure(evaluation_error(
            "execution.invalid_comparison_operator",
            "Ordered comparison is incompatible with the Global Property declaration"));

    int order = 0;
    if (is_number(current)) {
        const auto left = number_value(current);
        const auto right = number_value(expected);
        order = left < right ? -1 : (left > right ? 1 : 0);
    } else if (const auto* left = std::get_if<std::string>(&current)) {
        const auto& right = *std::get_if<std::string>(&expected);
        order = *left < right ? -1 : (*left > right ? 1 : 0);
    } else {
        return Result<bool, Diagnostics>::failure(evaluation_error(
            "execution.invalid_comparison_value", "Global Property values are not orderable"));
    }

    if (operation == ValueComparisonOperator::Less)
        return Result<bool, Diagnostics>::success(order < 0);
    if (operation == ValueComparisonOperator::LessEqual)
        return Result<bool, Diagnostics>::success(order <= 0);
    if (operation == ValueComparisonOperator::Greater)
        return Result<bool, Diagnostics>::success(order > 0);
    if (operation == ValueComparisonOperator::GreaterEqual)
        return Result<bool, Diagnostics>::success(order >= 0);
    return Result<bool, Diagnostics>::failure(evaluation_error(
        "execution.invalid_comparison_operator", "Global Property comparison operator is invalid"));
}

Result<bool, Diagnostics> compare_truthiness(const RuntimeValue& current,
                                             TruthinessOperator operation)
{
    const auto* boolean = std::get_if<bool>(&current);
    if (boolean == nullptr)
        return Result<bool, Diagnostics>::failure(
            evaluation_error("execution.invalid_truthiness_value",
                             "Truthy and Falsy conditions require a Boolean Property"));
    const bool expected = operation == TruthinessOperator::Truthy;
    return Result<bool, Diagnostics>::success(*boolean == expected);
}

Result<bool, Diagnostics> compare_quantity(std::uint64_t current, ValueComparisonOperator operation,
                                           std::uint64_t expected)
{
    switch (operation) {
    case ValueComparisonOperator::Equal:
        return Result<bool, Diagnostics>::success(current == expected);
    case ValueComparisonOperator::NotEqual:
        return Result<bool, Diagnostics>::success(current != expected);
    case ValueComparisonOperator::Less:
        return Result<bool, Diagnostics>::success(current < expected);
    case ValueComparisonOperator::LessEqual:
        return Result<bool, Diagnostics>::success(current <= expected);
    case ValueComparisonOperator::Greater:
        return Result<bool, Diagnostics>::success(current > expected);
    case ValueComparisonOperator::GreaterEqual:
        return Result<bool, Diagnostics>::success(current >= expected);
    }
    return Result<bool, Diagnostics>::failure(
        evaluation_error("execution.invalid_comparison_operator",
                         "Inventory quantity comparison operator is invalid"));
}

Result<GameplayOperandValue, Diagnostics>
resolve_command_result(const CommandResultOperand& operand, ConditionEvaluationContext context)
{
    const auto found = std::ranges::find_if(context.command_results, [&](const auto& binding) {
        return binding.binding_id == operand.binding_id;
    });
    if (found == context.command_results.end())
        return Result<GameplayOperandValue, Diagnostics>::failure(
            evaluation_error("execution.condition_result_unavailable",
                             "Condition references command result binding '" +
                                 operand.binding_id.text() + "' outside its scope"));
    return Result<GameplayOperandValue, Diagnostics>::success(found->value);
}

Result<GameplayOperandValue, Diagnostics>
resolve_interaction_slot(const InteractionSlotOperand& operand, ConditionEvaluationContext context)
{
    const auto found = std::ranges::find_if(context.interaction_bindings, [&](const auto& binding) {
        return binding.slot_id == operand.slot_id;
    });
    if (found == context.interaction_bindings.end())
        return Result<GameplayOperandValue, Diagnostics>::failure(
            evaluation_error("execution.condition_slot_unavailable",
                             "Condition references Interaction slot '" + operand.slot_id.text() +
                                 "' outside its bound context"));
    return std::visit(
        [](const auto& subject) -> Result<GameplayOperandValue, Diagnostics> {
            using T = std::decay_t<decltype(subject)>;
            if constexpr (std::is_same_v<T, compiled::CharacterInteractionSubject>)
                return Result<GameplayOperandValue, Diagnostics>::success(subject.character);
            else if constexpr (std::is_same_v<T, compiled::InteractableInteractionSubject>)
                return Result<GameplayOperandValue, Diagnostics>::success(subject.interactable);
            else
                return std::visit(
                    [](const auto& feature) -> Result<GameplayOperandValue, Diagnostics> {
                        return Result<GameplayOperandValue, Diagnostics>::success(feature);
                    },
                    subject.feature);
        },
        found->subject);
}

Result<GameplayOperandValue, Diagnostics>
resolve_identity_operand(const GameplayIdentityOperand& operand, const SessionState& state,
                         ConditionEvaluationContext context)
{
    return std::visit(
        [&](const auto& value) -> Result<GameplayOperandValue, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, CurrentRoomOperand>) {
                if (!state.room_visit())
                    return Result<GameplayOperandValue, Diagnostics>::failure(evaluation_error(
                        "execution.current_room_unavailable",
                        "Condition references Current Room while no Room is active"));
                return Result<GameplayOperandValue, Diagnostics>::success(state.room_visit()->room);
            } else if constexpr (std::is_same_v<T, InteractionSlotOperand>) {
                return resolve_interaction_slot(value, context);
            } else if constexpr (std::is_same_v<T, CommandResultOperand>) {
                return resolve_command_result(value, context);
            } else {
                return Result<GameplayOperandValue, Diagnostics>::success(value);
            }
        },
        operand);
}

Result<PropertyOwnerRef, Diagnostics> resolve_property_owner(const GameplayIdentityOperand& operand,
                                                             const SessionState& state,
                                                             ConditionEvaluationContext context)
{
    auto resolved = resolve_identity_operand(operand, state, context);
    const auto* value = resolved.value_if();
    if (value == nullptr)
        return Result<PropertyOwnerRef, Diagnostics>::failure(resolved.error());
    return std::visit(
        [](const auto& item) -> Result<PropertyOwnerRef, Diagnostics> {
            using T = std::decay_t<decltype(item)>;
            if constexpr (std::is_same_v<T, RoomId> || std::is_same_v<T, CharacterId> ||
                          std::is_same_v<T, InteractableInstanceId> ||
                          std::is_same_v<T, RoomFeatureRef> ||
                          std::is_same_v<T, InteractableFeatureRef>)
                return Result<PropertyOwnerRef, Diagnostics>::success(PropertyOwnerRef{item});
            else
                return Result<PropertyOwnerRef, Diagnostics>::failure(evaluation_error(
                    "execution.condition_operand_type_mismatch",
                    "Condition operand does not resolve to a Property-bearing identity"));
        },
        *value);
}

Result<InteractableInstanceId, Diagnostics>
resolve_interactable_operand(const InteractableOperand& operand, const SessionState& state,
                             ConditionEvaluationContext context)
{
    if (const auto* exact = std::get_if<InteractableInstanceId>(&operand))
        return Result<InteractableInstanceId, Diagnostics>::success(*exact);
    GameplayIdentityOperand identity =
        std::visit([](const auto& value) -> GameplayIdentityOperand { return value; }, operand);
    auto resolved = resolve_identity_operand(identity, state, context);
    const auto* value = resolved.value_if();
    if (value == nullptr)
        return Result<InteractableInstanceId, Diagnostics>::failure(resolved.error());
    const auto* interactable = std::get_if<InteractableInstanceId>(value);
    return interactable ? Result<InteractableInstanceId, Diagnostics>::success(*interactable)
                        : Result<InteractableInstanceId, Diagnostics>::failure(evaluation_error(
                              "execution.condition_operand_type_mismatch",
                              "Condition operand does not resolve to an Interactable Instance"));
}

Result<RoomId, Diagnostics> resolve_room_operand(const RoomOperand& operand,
                                                 const SessionState& state,
                                                 ConditionEvaluationContext context)
{
    if (const auto* room = std::get_if<RoomId>(&operand))
        return Result<RoomId, Diagnostics>::success(*room);
    if (std::holds_alternative<CurrentRoomOperand>(operand)) {
        if (!state.room_visit())
            return Result<RoomId, Diagnostics>::failure(
                evaluation_error("execution.current_room_unavailable",
                                 "Condition references Current Room while no Room is active"));
        return Result<RoomId, Diagnostics>::success(state.room_visit()->room);
    }
    auto resolved = resolve_command_result(std::get<CommandResultOperand>(operand), context);
    const auto* value = resolved.value_if();
    if (value == nullptr)
        return Result<RoomId, Diagnostics>::failure(resolved.error());
    const auto* room = std::get_if<RoomId>(value);
    return room ? Result<RoomId, Diagnostics>::success(*room)
                : Result<RoomId, Diagnostics>::failure(
                      evaluation_error("execution.condition_operand_type_mismatch",
                                       "Command result does not resolve to a Room"));
}

Result<compiled::InventoryOwnerRef, Diagnostics>
resolve_inventory_owner_operand(const InventoryOwnerOperand& operand, const SessionState& state,
                                ConditionEvaluationContext context)
{
    return std::visit(
        [&](const auto& value) -> Result<compiled::InventoryOwnerRef, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ProjectInventoryOwnerOperand>)
                return Result<compiled::InventoryOwnerRef, Diagnostics>::success(
                    compiled::ProjectInventoryOwner{});
            else if constexpr (std::is_same_v<T, CharacterId>)
                return Result<compiled::InventoryOwnerRef, Diagnostics>::success(
                    compiled::CharacterInventoryOwner{value});
            else if constexpr (std::is_same_v<T, InteractableInstanceId>)
                return Result<compiled::InventoryOwnerRef, Diagnostics>::success(
                    compiled::InteractableInventoryOwner{value});
            else if constexpr (std::is_same_v<T, RoomFeatureRef> ||
                               std::is_same_v<T, InteractableFeatureRef>)
                return Result<compiled::InventoryOwnerRef, Diagnostics>::success(value);
            else {
                GameplayIdentityOperand identity{value};
                auto resolved = resolve_identity_operand(identity, state, context);
                const auto* item = resolved.value_if();
                if (item == nullptr)
                    return Result<compiled::InventoryOwnerRef, Diagnostics>::failure(
                        resolved.error());
                return std::visit(
                    [](const auto& exact) -> Result<compiled::InventoryOwnerRef, Diagnostics> {
                        using E = std::decay_t<decltype(exact)>;
                        if constexpr (std::is_same_v<E, CharacterId>)
                            return Result<compiled::InventoryOwnerRef, Diagnostics>::success(
                                compiled::CharacterInventoryOwner{exact});
                        else if constexpr (std::is_same_v<E, InteractableInstanceId>)
                            return Result<compiled::InventoryOwnerRef, Diagnostics>::success(
                                compiled::InteractableInventoryOwner{exact});
                        else if constexpr (std::is_same_v<E, RoomFeatureRef> ||
                                           std::is_same_v<E, InteractableFeatureRef>)
                            return Result<compiled::InventoryOwnerRef, Diagnostics>::success(exact);
                        else
                            return Result<compiled::InventoryOwnerRef, Diagnostics>::failure(
                                evaluation_error("execution.condition_operand_type_mismatch",
                                                 "Condition operand cannot own an Inventory"));
                    },
                    *item);
            }
        },
        operand);
}

Result<compiled::InventoryRef, Diagnostics>
resolve_inventory_operand(const InventoryOperand& operand, const SessionState& state,
                          ConditionEvaluationContext context)
{
    return std::visit(
        [&](const auto& value) -> Result<compiled::InventoryRef, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ExactInventoryOperand>)
                return Result<compiled::InventoryRef, Diagnostics>::success(value.inventory);
            else if constexpr (std::is_same_v<T, PlayerInventoryOperand>)
                return Result<compiled::InventoryRef, Diagnostics>::failure(evaluation_error(
                    "execution.player_inventory_unconfigured",
                    "Player Inventory operand is unavailable until the Project designates one"));
            else if constexpr (std::is_same_v<T, OwnerInventoryOperand>) {
                auto owner = resolve_inventory_owner_operand(value.owner, state, context);
                const auto* exact = owner.value_if();
                return exact ? Result<compiled::InventoryRef, Diagnostics>::success(
                                   compiled::InventoryRef{*exact, value.inventory_id})
                             : Result<compiled::InventoryRef, Diagnostics>::failure(owner.error());
            } else {
                auto result = resolve_command_result(value, context);
                const auto* item = result.value_if();
                if (item == nullptr)
                    return Result<compiled::InventoryRef, Diagnostics>::failure(result.error());
                const auto* inventory = std::get_if<compiled::InventoryRef>(item);
                return inventory
                           ? Result<compiled::InventoryRef, Diagnostics>::success(*inventory)
                           : Result<compiled::InventoryRef, Diagnostics>::failure(evaluation_error(
                                 "execution.condition_operand_type_mismatch",
                                 "Command result does not resolve to an Inventory"));
            }
        },
        operand);
}

Result<compiled::InteractableLocation, Diagnostics>
resolve_location_operand(const LocationOperand& operand, const SessionState& state,
                         ConditionEvaluationContext context)
{
    return std::visit(
        [&](const auto& value) -> Result<compiled::InteractableLocation, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, compiled::UnplacedLocation>)
                return Result<compiled::InteractableLocation, Diagnostics>::success(value);
            else if constexpr (std::is_same_v<T, RoomLocationOperand>) {
                auto room = resolve_room_operand(value.room, state, context);
                const auto* exact = room.value_if();
                return exact ? Result<compiled::InteractableLocation, Diagnostics>::success(
                                   compiled::RoomLocation{*exact})
                             : Result<compiled::InteractableLocation, Diagnostics>::failure(
                                   room.error());
            } else {
                auto inventory = resolve_inventory_operand(value.inventory, state, context);
                const auto* exact = inventory.value_if();
                return exact ? Result<compiled::InteractableLocation, Diagnostics>::success(
                                   compiled::InventoryLocation{*exact})
                             : Result<compiled::InteractableLocation, Diagnostics>::failure(
                                   inventory.error());
            }
        },
        operand);
}

Result<GameplayOperandValue, Diagnostics>
resolve_location_subject(const LocationSubjectOperand& operand, const SessionState& state,
                         ConditionEvaluationContext context)
{
    if (const auto* character = std::get_if<CharacterId>(&operand))
        return Result<GameplayOperandValue, Diagnostics>::success(*character);
    if (const auto* interactable = std::get_if<InteractableInstanceId>(&operand))
        return Result<GameplayOperandValue, Diagnostics>::success(*interactable);
    GameplayIdentityOperand identity =
        std::visit([](const auto& value) -> GameplayIdentityOperand { return value; }, operand);
    auto resolved = resolve_identity_operand(identity, state, context);
    const auto* value = resolved.value_if();
    if (value == nullptr)
        return Result<GameplayOperandValue, Diagnostics>::failure(resolved.error());
    if (std::holds_alternative<CharacterId>(*value) ||
        std::holds_alternative<InteractableInstanceId>(*value))
        return Result<GameplayOperandValue, Diagnostics>::success(*value);
    return Result<GameplayOperandValue, Diagnostics>::failure(evaluation_error(
        "execution.condition_operand_type_mismatch",
        "Condition Location subject is neither a Character nor Interactable Instance"));
}

const std::vector<TraitId>* effective_traits(runtime::RuntimeWorld& world,
                                             const PropertyOwnerRef& owner)
{
    return std::visit(
        [&](const auto& exact) -> const std::vector<TraitId>* {
            using T = std::decay_t<decltype(exact)>;
            if constexpr (std::is_same_v<T, RoomId>) {
                const auto* configuration = world.resolved_configuration(exact);
                return configuration ? &configuration->identity.traits : nullptr;
            } else if constexpr (std::is_same_v<T, CharacterId>) {
                const auto* configuration = world.resolved_configuration(exact);
                return configuration ? &configuration->identity.traits : nullptr;
            } else if constexpr (std::is_same_v<T, InteractableInstanceId>) {
                const auto* configuration = world.resolved_configuration(exact);
                return configuration ? &configuration->identity.traits : nullptr;
            } else if constexpr (std::is_same_v<T, RoomFeatureRef>) {
                const auto* configuration = world.resolved_configuration(exact.room);
                if (!configuration)
                    return nullptr;
                const auto feature =
                    std::ranges::find_if(configuration->features, [&](const auto& f) {
                        return f.identity.id == exact.feature_id;
                    });
                return feature == configuration->features.end() ? nullptr
                                                                : &feature->identity.traits;
            } else {
                const auto* configuration = world.resolved_configuration(exact.interactable);
                if (!configuration)
                    return nullptr;
                const auto feature =
                    std::ranges::find_if(configuration->features, [&](const auto& f) {
                        return f.identity.id == exact.feature_id;
                    });
                return feature == configuration->features.end() ? nullptr
                                                                : &feature->identity.traits;
            }
        },
        owner);
}

const std::string* localized_value(const compiled::Localization& localization,
                                   std::string_view locale, std::string_view key) noexcept
{
    const auto catalog = std::find_if(
        localization.catalogs.begin(), localization.catalogs.end(),
        [locale](const compiled::LocalizationCatalog& value) { return value.locale == locale; });
    if (catalog == localization.catalogs.end())
        return nullptr;
    const auto entry =
        std::find_if(catalog->entries.begin(), catalog->entries.end(),
                     [key](const compiled::LocalizationEntry& value) { return value.key == key; });
    return entry == catalog->entries.end() ? nullptr : &entry->value;
}

} // namespace

Result<bool, Diagnostics>
SharedPrimitiveEvaluator::evaluate(const Condition& condition,
                                   ConditionEvaluationContext context) const
{
    return std::visit(
        [this, context](const auto& value) -> Result<bool, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, Always>) {
                return Result<bool, Diagnostics>::success(true);
            } else if constexpr (std::is_same_v<T, AllCondition>) {
                for (const auto& child : value.conditions) {
                    auto result = evaluate(child, context);
                    const auto* passed = result.value_if();
                    if (passed == nullptr)
                        return Result<bool, Diagnostics>::failure(result.error());
                    if (!*passed)
                        return Result<bool, Diagnostics>::success(false);
                }
                return Result<bool, Diagnostics>::success(true);
            } else if constexpr (std::is_same_v<T, AnyCondition>) {
                for (const auto& child : value.conditions) {
                    auto result = evaluate(child, context);
                    const auto* passed = result.value_if();
                    if (passed == nullptr)
                        return Result<bool, Diagnostics>::failure(result.error());
                    if (*passed)
                        return Result<bool, Diagnostics>::success(true);
                }
                return Result<bool, Diagnostics>::success(false);
            } else if constexpr (std::is_same_v<T, NotCondition>) {
                if (value.condition.size() != 1)
                    return Result<bool, Diagnostics>::failure(evaluation_error(
                        "execution.invalid_condition_shape",
                        "Not Condition must contain exactly one nested Condition"));
                auto result = evaluate(value.condition.front(), context);
                const auto* passed = result.value_if();
                return passed ? Result<bool, Diagnostics>::success(!*passed)
                              : Result<bool, Diagnostics>::failure(result.error());
            } else if constexpr (std::is_same_v<T, GlobalPropertyComparison>) {
                return std::visit(
                    [this](const auto& comparison) -> Result<bool, Diagnostics> {
                        const auto* declaration = m_project.find_property(comparison.property_id);
                        if (declaration == nullptr || !declaration->is_global())
                            return Result<bool, Diagnostics>::failure(evaluation_error(
                                "execution.unknown_global_property",
                                "Condition references an undeclared Global Property '" +
                                    comparison.property_id.text() + "'"));
                        PropertyResolver resolver(m_project, m_state);
                        auto current = resolver.get_global(comparison.property_id);
                        const auto* lookup = current.value_if();
                        if (lookup == nullptr)
                            return Result<bool, Diagnostics>::failure(current.error());
                        const auto* current_value = std::get_if<RuntimeValue>(lookup);
                        if (current_value == nullptr)
                            return Result<bool, Diagnostics>::failure(evaluation_error(
                                "execution.missing_global_property",
                                "Global Property unexpectedly resolved without a value"));
                        using C = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<C, GlobalPropertyValueComparison>) {
                            return compare_values(*declaration, comparison.operation,
                                                  comparison.value, *current_value);
                        } else {
                            return compare_truthiness(*current_value, comparison.operation);
                        }
                    },
                    value);
            } else if constexpr (std::is_same_v<T, IdentityPropertyComparison>) {
                return std::visit(
                    [this, context](const auto& comparison) -> Result<bool, Diagnostics> {
                        auto owner = resolve_property_owner(comparison.owner, m_state, context);
                        const auto* exact_owner = owner.value_if();
                        if (exact_owner == nullptr)
                            return Result<bool, Diagnostics>::failure(owner.error());
                        const auto* declaration =
                            m_project.find_property(*exact_owner, comparison.property_id);
                        if (declaration == nullptr || declaration->is_global())
                            return Result<bool, Diagnostics>::failure(evaluation_error(
                                "execution.unknown_identity_property",
                                "Condition references an unavailable identity Property '" +
                                    comparison.property_id.text() + "'"));
                        PropertyResolver resolver(m_project, m_state);
                        auto current = resolver.get(*exact_owner, comparison.property_id);
                        const auto* lookup = current.value_if();
                        if (lookup == nullptr)
                            return Result<bool, Diagnostics>::failure(current.error());
                        const auto* current_value = std::get_if<RuntimeValue>(lookup);
                        if (current_value == nullptr)
                            return Result<bool, Diagnostics>::failure(evaluation_error(
                                "execution.missing_identity_property",
                                "Identity Property unexpectedly resolved without a value"));
                        using C = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<C, IdentityPropertyValueComparison>)
                            return compare_values(*declaration, comparison.operation,
                                                  comparison.value, *current_value);
                        else
                            return compare_truthiness(*current_value, comparison.operation);
                    },
                    value);
            } else if constexpr (std::is_same_v<T, TraitPresenceCondition>) {
                auto owner = resolve_property_owner(value.owner, m_state, context);
                const auto* exact_owner = owner.value_if();
                if (exact_owner == nullptr)
                    return Result<bool, Diagnostics>::failure(owner.error());
                runtime::RuntimeWorld world(m_project, m_state);
                const auto* traits = effective_traits(world, *exact_owner);
                if (traits == nullptr)
                    return Result<bool, Diagnostics>::failure(
                        evaluation_error("execution.condition_owner_unresolved",
                                         "Trait Condition owner is not live"));
                const bool present = std::ranges::find(*traits, value.trait) != traits->end();
                return Result<bool, Diagnostics>::success(present == value.present);
            } else if constexpr (std::is_same_v<T, LocationComparisonCondition>) {
                auto subject = resolve_location_subject(value.subject, m_state, context);
                const auto* exact_subject = subject.value_if();
                if (exact_subject == nullptr)
                    return Result<bool, Diagnostics>::failure(subject.error());
                auto target = resolve_location_operand(value.location, m_state, context);
                const auto* exact_target = target.value_if();
                if (exact_target == nullptr)
                    return Result<bool, Diagnostics>::failure(target.error());
                bool matches = false;
                runtime::RuntimeWorld world(m_project, m_state);
                if (const auto* character = std::get_if<CharacterId>(exact_subject)) {
                    const auto* state = world.character_state(*character);
                    if (state == nullptr)
                        return Result<bool, Diagnostics>::failure(
                            evaluation_error("execution.condition_owner_unresolved",
                                             "Location Condition Character is not live"));
                    if (std::holds_alternative<compiled::InventoryLocation>(*exact_target))
                        return Result<bool, Diagnostics>::failure(evaluation_error(
                            "execution.condition_operand_type_mismatch",
                            "Character Location cannot be compared with an Inventory Location"));
                    if (const auto* unplaced =
                            std::get_if<compiled::UnplacedLocation>(exact_target))
                        matches =
                            std::holds_alternative<compiled::UnplacedLocation>(state->location);
                    else if (const auto* room = std::get_if<compiled::RoomLocation>(exact_target))
                        matches = state->location == core::CharacterWorldLocation{*room};
                } else if (const auto* interactable =
                               std::get_if<InteractableInstanceId>(exact_subject)) {
                    const auto* state = world.interactable_state(*interactable);
                    if (state == nullptr)
                        return Result<bool, Diagnostics>::failure(
                            evaluation_error("execution.condition_owner_unresolved",
                                             "Location Condition Interactable is not live"));
                    matches = state->location == *exact_target;
                } else {
                    return Result<bool, Diagnostics>::failure(evaluation_error(
                        "execution.condition_operand_type_mismatch",
                        "Location Condition subject is not a Character or Interactable"));
                }
                return Result<bool, Diagnostics>::success(
                    value.operation == EqualityComparisonOperator::Equal ? matches : !matches);
            } else if constexpr (std::is_same_v<T, InventoryQuantityComparisonCondition>) {
                auto inventory = resolve_inventory_operand(value.inventory, m_state, context);
                const auto* exact_inventory = inventory.value_if();
                if (exact_inventory == nullptr)
                    return Result<bool, Diagnostics>::failure(inventory.error());
                runtime::RuntimeWorld world(m_project, m_state);
                if (!world.has_inventory(*exact_inventory))
                    return Result<bool, Diagnostics>::failure(evaluation_error(
                        "execution.condition_inventory_unresolved",
                        "Inventory quantity Condition references an unavailable Inventory"));
                runtime::InteractableMatcher matcher;
                matcher.definition = value.matcher.definition;
                matcher.traits = value.matcher.traits;
                matcher.properties.reserve(value.matcher.properties.size());
                for (const auto& property : value.matcher.properties)
                    matcher.properties.push_back(
                        runtime::InteractablePropertyMatch{property.property_id, property.value});
                if (value.matcher.exact) {
                    auto exact =
                        resolve_interactable_operand(*value.matcher.exact, m_state, context);
                    const auto* instance = exact.value_if();
                    if (instance == nullptr)
                        return Result<bool, Diagnostics>::failure(exact.error());
                    matcher.instance = *instance;
                }
                runtime::InteractableQuantityFilter filter;
                filter.matcher = std::move(matcher);
                filter.location =
                    compiled::InteractableLocation{compiled::InventoryLocation{*exact_inventory}};
                auto quantity = world.aggregate_interactable_quantity(filter);
                const auto* current = quantity.value_if();
                return current ? compare_quantity(*current, value.operation, value.quantity)
                               : Result<bool, Diagnostics>::failure(quantity.error());
            } else {
                return Result<bool, Diagnostics>::failure(evaluation_error(
                    "execution.lua_condition_requires_script_runtime",
                    "LuaPredicate requires the immediate script evaluation boundary"));
            }
        },
        condition.value);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::apply(const Effect& effect)
{
    return std::visit(
        [this](const auto& value) -> Result<void, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SetGlobalProperty>) {
                const auto* declaration = m_project.find_property(value.property_id);
                if (declaration == nullptr || !declaration->is_global())
                    return Result<void, Diagnostics>::failure(
                        evaluation_error("execution.unknown_global_property",
                                         "Effect references an undeclared Global Property '" +
                                             value.property_id.text() + "'"));
                PropertyResolver resolver(m_project, m_state);
                return resolver.set_global(value.property_id, value.value);
            } else
                return Result<void, Diagnostics>::failure(evaluation_error(
                    "execution.lua_effect_requires_script_runtime",
                    "RunLuaEffect requires the yield-capable script invocation boundary"));
        },
        effect);
}

Result<std::string, Diagnostics>
SharedPrimitiveEvaluator::resolve(const TextSource& source, std::string_view runtime_locale) const
{
    return std::visit(
        [this, runtime_locale](const auto& value) -> Result<std::string, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, InlineText>) {
                return Result<std::string, Diagnostics>::success(value.value);
            } else if constexpr (std::is_same_v<T, LocalizedTextKey>) {
                const auto& localization = m_project.localization();
                if (!runtime_locale.empty()) {
                    if (const auto* resolved =
                            localized_value(localization, runtime_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                if (runtime_locale != localization.default_locale) {
                    if (const auto* resolved =
                            localized_value(localization, localization.default_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                if (localization.fallback_locale &&
                    runtime_locale != *localization.fallback_locale &&
                    localization.default_locale != *localization.fallback_locale) {
                    if (const auto* resolved = localized_value(
                            localization, *localization.fallback_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                return Result<std::string, Diagnostics>::failure(evaluation_error(
                    "execution.missing_localized_text",
                    "Localized text key '" + value.value + "' is unavailable for runtime locale '" +
                        std::string(runtime_locale) + "' and its configured fallbacks"));
            } else {
                return Result<std::string, Diagnostics>::failure(evaluation_error(
                    "execution.lua_text_requires_script_runtime",
                    "LuaTextExpression requires the immediate script evaluation boundary"));
            }
        },
        source);
}

Result<WaitEvaluation, Diagnostics> SharedPrimitiveEvaluator::begin(const WaitSpec& wait)
{
    return std::visit(
        [this](const auto& value) -> Result<WaitEvaluation, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ImmediateWait>) {
                return Result<WaitEvaluation, Diagnostics>::success(WaitCompleted{});
            } else if constexpr (std::is_same_v<T, InputWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Input);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, DurationWait>) {
                if (value.duration().count() == 0)
                    return Result<WaitEvaluation, Diagnostics>::success(WaitCompleted{});
                auto blocker = m_executor.block_duration(value);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, PresentationCompletionWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Presentation);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, AudioCompletionWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Audio);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, ChildFlowCompletionWait>) {
                return Result<WaitEvaluation, Diagnostics>::failure(evaluation_error(
                    "execution.child_flow_wait_requires_call",
                    "ChildFlow waits are created only by an atomic typed child call"));
            } else {
                return Result<WaitEvaluation, Diagnostics>::failure(
                    evaluation_error("execution.script_wait_requires_script_runtime",
                                     "Script waits require the script suspension boundary"));
            }
        },
        wait);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::complete(const FlowFrameId& owner,
                                                             const AnyFlowBlockerHandle& handle)
{
    return m_executor.resume_blocker(owner, handle);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::cancel(const FlowFrameId& owner,
                                                           const AnyFlowBlockerHandle& handle)
{
    return m_executor.cancel_blocker(owner, handle);
}

Result<bool, Diagnostics> SharedPrimitiveEvaluator::advance(const FlowFrameId& owner,
                                                            const DurationFlowBlockerHandle& handle,
                                                            std::chrono::milliseconds elapsed)
{
    return m_executor.advance_duration_blocker(owner, handle, elapsed);
}

} // namespace noveltea::core
