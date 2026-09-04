#include "noveltea/runtime/flow_prediction.hpp"

#include <algorithm>
#include <cmath>
#include <functional>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace noveltea::runtime {
namespace {

enum class KnownCondition : std::uint8_t {
    False,
    True,
    Unknown,
};

struct ProjectedProperty {
    core::PropertyId property;
    core::RuntimeValue value;
};
struct ProjectedIdentityProperty {
    core::GameplayIdentityOperand owner;
    core::PropertyId property;
    core::RuntimeValue value;
};
struct ProjectedTraitPresence {
    core::GameplayIdentityOperand owner;
    core::TraitId trait;
    bool present = true;
};
struct ProjectedLocation {
    core::LocationSubjectOperand subject;
    core::LocationOperand location;
};
struct ProjectedProperties {
    std::optional<core::RoomId> current_room;
    std::vector<core::InteractionSubjectBinding> interaction_bindings;
    std::vector<core::CommandResultBinding> command_results;
    std::vector<ProjectedProperty> globals;
    std::vector<ProjectedIdentityProperty> identity_properties;
    std::vector<ProjectedTraitPresence> traits;
    std::vector<ProjectedLocation> locations;
    std::vector<core::Condition> invalidated_conditions;

    auto begin() noexcept { return globals.begin(); }
    auto end() noexcept { return globals.end(); }
    auto begin() const noexcept { return globals.begin(); }
    auto end() const noexcept { return globals.end(); }
    void reserve(std::size_t size) { globals.reserve(size); }
    void push_back(ProjectedProperty property) { globals.push_back(std::move(property)); }
    void clear() noexcept
    {
        current_room.reset();
        globals.clear();
        identity_properties.clear();
        traits.clear();
        locations.clear();
        invalidated_conditions.clear();
    }
    void clear_typed() noexcept
    {
        identity_properties.clear();
        traits.clear();
        locations.clear();
        invalidated_conditions.clear();
    }
};

std::optional<core::GameplayIdentityOperand>
identity_from_interaction_subject(const core::compiled::InteractionSubject& subject)
{
    return std::visit(
        [](const auto& value) -> std::optional<core::GameplayIdentityOperand> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                return core::GameplayIdentityOperand{value.character};
            else if constexpr (std::is_same_v<T, core::compiled::InteractableInteractionSubject>)
                return core::GameplayIdentityOperand{value.interactable};
            else
                return std::visit(
                    [](const auto& feature) -> std::optional<core::GameplayIdentityOperand> {
                        return core::GameplayIdentityOperand{feature};
                    },
                    value.feature);
        },
        subject);
}

std::optional<core::GameplayIdentityOperand>
identity_from_command_result(const core::GameplayOperandValue& result)
{
    return std::visit(
        [](const auto& value) -> std::optional<core::GameplayIdentityOperand> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomId> ||
                          std::is_same_v<T, core::CharacterId> ||
                          std::is_same_v<T, core::InteractableInstanceId> ||
                          std::is_same_v<T, core::RoomFeatureRef> ||
                          std::is_same_v<T, core::InteractableFeatureRef>)
                return core::GameplayIdentityOperand{value};
            else
                return std::nullopt;
        },
        result);
}

bool condition_invalidated(const ProjectedProperties& properties,
                           const core::Condition& condition) noexcept
{
    return std::find(properties.invalidated_conditions.begin(),
                     properties.invalidated_conditions.end(), condition) !=
           properties.invalidated_conditions.end();
}

void invalidate_condition(ProjectedProperties& properties, const core::Condition& condition)
{
    if (!condition_invalidated(properties, condition))
        properties.invalidated_conditions.push_back(condition);
}

void invalidate_inventory_quantity_facts(ProjectedProperties& properties,
                                         const FlowPredictionContext& context)
{
    for (const auto& fact : context.condition_facts) {
        if (std::holds_alternative<core::InventoryQuantityComparisonCondition>(fact.condition.value))
            invalidate_condition(properties, fact.condition);
    }
}

void invalidate_location_facts(ProjectedProperties& properties,
                               const FlowPredictionContext& context,
                               const core::LocationSubjectOperand& subject)
{
    for (const auto& fact : context.condition_facts) {
        const auto* location = std::get_if<core::LocationComparisonCondition>(&fact.condition.value);
        if (location != nullptr && location->subject == subject)
            invalidate_condition(properties, fact.condition);
    }
}

void invalidate_identity_property_facts(ProjectedProperties& properties,
                                        const FlowPredictionContext& context,
                                        const core::GameplayIdentityOperand& owner,
                                        const core::PropertyId& property)
{
    for (const auto& fact : context.condition_facts) {
        const auto* comparison = std::get_if<core::IdentityPropertyComparison>(&fact.condition.value);
        if (comparison == nullptr)
            continue;
        const bool matches = std::visit(
            [&](const auto& value) { return value.owner == owner && value.property_id == property; },
            *comparison);
        if (matches)
            invalidate_condition(properties, fact.condition);
    }
}

void invalidate_trait_facts(ProjectedProperties& properties,
                            const FlowPredictionContext& context,
                            const core::GameplayIdentityOperand& owner,
                            const core::TraitId& trait)
{
    for (const auto& fact : context.condition_facts) {
        const auto* comparison = std::get_if<core::TraitPresenceCondition>(&fact.condition.value);
        if (comparison != nullptr && comparison->owner == owner && comparison->trait == trait)
            invalidate_condition(properties, fact.condition);
    }
}

void add_invalid_index(core::Diagnostics& diagnostics, std::string kind, std::size_t index)
{
    diagnostics.push_back({.code = "assets.flow_prediction_invalid_index",
                           .message = "Flow Prediction Index references invalid " +
                                      std::move(kind) + " index " + std::to_string(index),
                           .severity = core::ErrorSeverity::Warning});
}

const core::RuntimeValue* find_property(const ProjectedProperties& properties,
                                        const core::PropertyId& property) noexcept
{
    const auto found = std::find_if(properties.begin(), properties.end(),
                                    [&](const auto& item) { return item.property == property; });
    return found == properties.end() ? nullptr : &found->value;
}

void set_property(ProjectedProperties& properties, const core::PropertyId& property,
                  core::RuntimeValue value)
{
    const auto found = std::find_if(properties.begin(), properties.end(),
                                    [&](const auto& item) { return item.property == property; });
    if (found == properties.end())
        properties.push_back({property, std::move(value)});
    else
        found->value = std::move(value);
}

void invalidate_property(ProjectedProperties& properties, const core::PropertyId& property)
{
    std::erase_if(properties.globals, [&](const auto& item) { return item.property == property; });
}

bool numeric(const core::RuntimeValue& value) noexcept
{
    return std::holds_alternative<std::int64_t>(value) || std::holds_alternative<double>(value);
}

long double numeric_value(const core::RuntimeValue& value) noexcept
{
    if (const auto* integer = std::get_if<std::int64_t>(&value))
        return static_cast<long double>(*integer);
    return static_cast<long double>(*std::get_if<double>(&value));
}

KnownCondition compare_values(const core::RuntimeValue& current,
                              core::ValueComparisonOperator operation,
                              const core::RuntimeValue& expected) noexcept
{
    if (const auto* number = std::get_if<double>(&current);
        number != nullptr && !std::isfinite(*number))
        return KnownCondition::Unknown;
    if (const auto* number = std::get_if<double>(&expected);
        number != nullptr && !std::isfinite(*number))
        return KnownCondition::Unknown;

    const bool equality = numeric(current) && numeric(expected)
                              ? numeric_value(current) == numeric_value(expected)
                              : current == expected;
    if (operation == core::ValueComparisonOperator::Equal)
        return equality ? KnownCondition::True : KnownCondition::False;
    if (operation == core::ValueComparisonOperator::NotEqual)
        return equality ? KnownCondition::False : KnownCondition::True;

    int order = 0;
    if (numeric(current) && numeric(expected)) {
        const auto left = numeric_value(current);
        const auto right = numeric_value(expected);
        order = left < right ? -1 : (left > right ? 1 : 0);
    } else if (const auto* left = std::get_if<std::string>(&current)) {
        const auto* right = std::get_if<std::string>(&expected);
        if (right == nullptr)
            return KnownCondition::Unknown;
        order = *left < *right ? -1 : (*left > *right ? 1 : 0);
    } else {
        return KnownCondition::Unknown;
    }

    bool result = false;
    switch (operation) {
    case core::ValueComparisonOperator::Less:
        result = order < 0;
        break;
    case core::ValueComparisonOperator::LessEqual:
        result = order <= 0;
        break;
    case core::ValueComparisonOperator::Greater:
        result = order > 0;
        break;
    case core::ValueComparisonOperator::GreaterEqual:
        result = order >= 0;
        break;
    default:
        return KnownCondition::Unknown;
    }
    return result ? KnownCondition::True : KnownCondition::False;
}

const bool* find_condition_fact(const FlowPredictionContext& context,
                                const core::Condition& condition) noexcept
{
    const auto found = std::find_if(context.condition_facts.begin(), context.condition_facts.end(),
                                    [&](const auto& item) { return item.condition == condition; });
    return found == context.condition_facts.end() ? nullptr : &found->value;
}

KnownCondition compare_truthiness(const core::RuntimeValue& current,
                                  core::TruthinessOperator operation) noexcept
{
    const auto* boolean = std::get_if<bool>(&current);
    if (boolean == nullptr)
        return KnownCondition::Unknown;
    const bool expected = operation == core::TruthinessOperator::Truthy;
    return *boolean == expected ? KnownCondition::True : KnownCondition::False;
}

void collect_context_requirements(const core::Condition& condition,
                                  FlowPredictionContextRequirements& requirements)
{
    std::visit(
        [&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::Always> ||
                          std::is_same_v<T, core::LuaPredicate>) {
                return;
            } else if constexpr (std::is_same_v<T, core::AllCondition> ||
                                 std::is_same_v<T, core::AnyCondition>) {
                for (const auto& child : value.conditions)
                    collect_context_requirements(child, requirements);
            } else if constexpr (std::is_same_v<T, core::NotCondition>) {
                for (const auto& child : value.condition)
                    collect_context_requirements(child, requirements);
            } else if constexpr (std::is_same_v<T, core::GlobalPropertyComparison>) {
                std::visit(
                    [&](const auto& comparison) {
                        if (std::find(requirements.global_properties.begin(),
                                      requirements.global_properties.end(),
                                      comparison.property_id) ==
                            requirements.global_properties.end())
                            requirements.global_properties.push_back(comparison.property_id);
                    },
                    value);
            } else {
                if (std::find(requirements.condition_facts.begin(),
                              requirements.condition_facts.end(), condition) ==
                    requirements.condition_facts.end())
                    requirements.condition_facts.push_back(condition);
            }
        },
        condition.value);
}

KnownCondition evaluate_condition(const core::Condition& condition,
                                  const ProjectedProperties& properties,
                                  const FlowPredictionContext& context,
                                  bool condition_facts_valid);

bool condition_may_execute_opaque(const core::Condition& condition,
                                  const ProjectedProperties& properties,
                                  const FlowPredictionContext& context,
                                  bool condition_facts_valid)
{
    return std::visit(
        [&](const auto& value) -> bool {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::LuaPredicate>) {
                return true;
            } else if constexpr (std::is_same_v<T, core::AllCondition>) {
                for (const auto& child : value.conditions) {
                    if (condition_may_execute_opaque(child, properties, context,
                                                     condition_facts_valid))
                        return true;
                    if (evaluate_condition(child, properties, context, condition_facts_valid) ==
                        KnownCondition::False)
                        return false;
                }
                return false;
            } else if constexpr (std::is_same_v<T, core::AnyCondition>) {
                for (const auto& child : value.conditions) {
                    if (condition_may_execute_opaque(child, properties, context,
                                                     condition_facts_valid))
                        return true;
                    if (evaluate_condition(child, properties, context, condition_facts_valid) ==
                        KnownCondition::True)
                        return false;
                }
                return false;
            } else if constexpr (std::is_same_v<T, core::NotCondition>) {
                return value.condition.size() == 1 &&
                       condition_may_execute_opaque(value.condition.front(), properties, context,
                                                    condition_facts_valid);
            } else {
                return false;
            }
        },
        condition.value);
}

std::optional<core::GameplayIdentityOperand>
resolve_projected_identity(const core::GameplayIdentityOperand& owner,
                           const ProjectedProperties& properties)
{
    return std::visit(
        [&](const auto& value) -> std::optional<core::GameplayIdentityOperand> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::CurrentRoomOperand>) {
                return properties.current_room
                           ? std::optional<core::GameplayIdentityOperand>{*properties.current_room}
                           : std::nullopt;
            } else if constexpr (std::is_same_v<T, core::InteractionSlotOperand>) {
                const auto found = std::ranges::find_if(
                    properties.interaction_bindings,
                    [&](const auto& binding) { return binding.slot_id == value.slot_id; });
                return found == properties.interaction_bindings.end()
                           ? std::nullopt
                           : identity_from_interaction_subject(found->subject);
            } else if constexpr (std::is_same_v<T, core::CommandResultOperand>) {
                const auto found = std::ranges::find_if(
                    properties.command_results,
                    [&](const auto& binding) { return binding.binding_id == value.binding_id; });
                return found == properties.command_results.end()
                           ? std::nullopt
                           : identity_from_command_result(found->value);
            } else {
                return core::GameplayIdentityOperand{value};
            }
        },
        owner);
}

std::optional<core::LocationSubjectOperand>
resolve_projected_location_subject(const core::LocationSubjectOperand& subject,
                                   const ProjectedProperties& properties)
{
    return std::visit(
        [&](const auto& value) -> std::optional<core::LocationSubjectOperand> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::InteractionSlotOperand>) {
                const auto found = std::ranges::find_if(
                    properties.interaction_bindings,
                    [&](const auto& binding) { return binding.slot_id == value.slot_id; });
                if (found == properties.interaction_bindings.end())
                    return std::nullopt;
                return std::visit(
                    [](const auto& bound) -> std::optional<core::LocationSubjectOperand> {
                        using B = std::decay_t<decltype(bound)>;
                        if constexpr (std::is_same_v<B,
                                                     core::compiled::CharacterInteractionSubject>)
                            return core::LocationSubjectOperand{bound.character};
                        else if constexpr (std::is_same_v<
                                               B,
                                               core::compiled::InteractableInteractionSubject>)
                            return core::LocationSubjectOperand{bound.interactable};
                        else
                            return std::nullopt;
                    },
                    found->subject);
            } else if constexpr (std::is_same_v<T, core::CommandResultOperand>) {
                const auto found = std::ranges::find_if(
                    properties.command_results,
                    [&](const auto& binding) { return binding.binding_id == value.binding_id; });
                if (found == properties.command_results.end())
                    return std::nullopt;
                return std::visit(
                    [](const auto& bound) -> std::optional<core::LocationSubjectOperand> {
                        using B = std::decay_t<decltype(bound)>;
                        if constexpr (std::is_same_v<B, core::CharacterId> ||
                                      std::is_same_v<B, core::InteractableInstanceId>)
                            return core::LocationSubjectOperand{bound};
                        else
                            return std::nullopt;
                    },
                    found->value);
            } else {
                return core::LocationSubjectOperand{value};
            }
        },
        subject);
}

bool project_identity_property(ProjectedProperties& properties,
                               const core::GameplayIdentityOperand& owner,
                               const core::PropertyId& property, const core::RuntimeValue& value)
{
    const auto resolved_owner = resolve_projected_identity(owner, properties);
    if (!resolved_owner)
        return false;
    const auto found = std::find_if(properties.identity_properties.begin(),
                                    properties.identity_properties.end(), [&](const auto& item) {
                                        return item.owner == *resolved_owner && item.property == property;
                                    });
    if (found == properties.identity_properties.end())
        properties.identity_properties.push_back({*resolved_owner, property, value});
    else
        found->value = value;
    return true;
}

bool project_trait_presence(ProjectedProperties& properties,
                            const core::GameplayIdentityOperand& owner, const core::TraitId& trait,
                            bool present)
{
    const auto resolved_owner = resolve_projected_identity(owner, properties);
    if (!resolved_owner)
        return false;
    const auto found = std::find_if(properties.traits.begin(), properties.traits.end(),
                                    [&](const auto& item) {
                                        return item.owner == *resolved_owner && item.trait == trait;
                                    });
    if (found == properties.traits.end())
        properties.traits.push_back({*resolved_owner, trait, present});
    else
        found->present = present;
    return true;
}

std::optional<core::LocationOperand>
resolve_projected_location(const core::LocationOperand& location,
                           const ProjectedProperties& properties)
{
    return std::visit(
        [&](const auto& value) -> std::optional<core::LocationOperand> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomLocationOperand>) {
                return std::visit(
                    [&](const auto& room) -> std::optional<core::LocationOperand> {
                        using R = std::decay_t<decltype(room)>;
                        if constexpr (std::is_same_v<R, core::RoomId>) {
                            return core::LocationOperand{core::RoomLocationOperand{
                                core::RoomOperand{room}}};
                        } else if constexpr (std::is_same_v<R, core::CurrentRoomOperand>) {
                            if (!properties.current_room)
                                return std::nullopt;
                            return core::LocationOperand{core::RoomLocationOperand{
                                core::RoomOperand{*properties.current_room}}};
                        } else {
                            return std::nullopt;
                        }
                    },
                    value.room);
            } else if constexpr (std::is_same_v<T, core::InventoryLocationOperand>) {
                const auto inventory = std::visit(
                    [](const auto& operand) -> std::optional<core::InventoryOperand> {
                        using I = std::decay_t<decltype(operand)>;
                        if constexpr (std::is_same_v<I, core::CommandResultOperand>) {
                            return std::nullopt;
                        } else if constexpr (std::is_same_v<I, core::OwnerInventoryOperand>) {
                            const bool stable_owner = std::visit(
                                [](const auto& owner) {
                                    using O = std::decay_t<decltype(owner)>;
                                    return !std::is_same_v<O, core::InteractionSlotOperand> &&
                                           !std::is_same_v<O, core::CommandResultOperand>;
                                },
                                operand.owner);
                            return stable_owner
                                       ? std::optional<core::InventoryOperand>{operand}
                                       : std::nullopt;
                        } else {
                            return core::InventoryOperand{operand};
                        }
                    },
                    value.inventory);
                return inventory
                           ? std::optional<core::LocationOperand>{
                                 core::InventoryLocationOperand{std::move(*inventory)}}
                           : std::nullopt;
            } else {
                // Unplaced is a stable semantic location.
                return core::LocationOperand{value};
            }
        },
        location);
}

bool project_location(ProjectedProperties& properties, const core::LocationSubjectOperand& subject,
                      const core::LocationOperand& location)
{
    const auto resolved_subject = resolve_projected_location_subject(subject, properties);
    const auto resolved = resolve_projected_location(location, properties);
    const auto found = std::find_if(properties.locations.begin(), properties.locations.end(),
                                    [&](const auto& item) {
                                        return resolved_subject && item.subject == *resolved_subject;
                                    });
    if (!resolved_subject || !resolved) {
        if (found != properties.locations.end())
            properties.locations.erase(found);
        return false;
    }
    if (found == properties.locations.end())
        properties.locations.push_back({*resolved_subject, *resolved});
    else
        found->location = *resolved;
    return true;
}

KnownCondition evaluate_condition(const core::Condition& condition,
                                  const ProjectedProperties& properties,
                                  const FlowPredictionContext& context,
                                  bool condition_facts_valid = true)
{
    return std::visit(
        [&](const auto& value) -> KnownCondition {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::Always>) {
                return KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::AllCondition>) {
                bool unknown = false;
                for (const auto& child : value.conditions) {
                    const auto result =
                        evaluate_condition(child, properties, context, condition_facts_valid);
                    if (result == KnownCondition::False)
                        return KnownCondition::False;
                    unknown |= result == KnownCondition::Unknown;
                }
                return unknown ? KnownCondition::Unknown : KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::AnyCondition>) {
                bool unknown = false;
                for (const auto& child : value.conditions) {
                    const auto result =
                        evaluate_condition(child, properties, context, condition_facts_valid);
                    if (result == KnownCondition::True)
                        return KnownCondition::True;
                    unknown |= result == KnownCondition::Unknown;
                }
                return unknown ? KnownCondition::Unknown : KnownCondition::False;
            } else if constexpr (std::is_same_v<T, core::NotCondition>) {
                if (value.condition.size() != 1)
                    return KnownCondition::Unknown;
                const auto result = evaluate_condition(value.condition.front(), properties, context,
                                                       condition_facts_valid);
                if (result == KnownCondition::Unknown)
                    return result;
                return result == KnownCondition::True ? KnownCondition::False
                                                      : KnownCondition::True;
            } else if constexpr (std::is_same_v<T, core::GlobalPropertyComparison>) {
                return std::visit(
                    [&](const auto& comparison) -> KnownCondition {
                        const auto* current = find_property(properties, comparison.property_id);
                        if (current == nullptr)
                            return KnownCondition::Unknown;
                        using Comparison = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<Comparison, core::GlobalPropertyTruthiness>) {
                            const auto* boolean = std::get_if<bool>(current);
                            if (boolean == nullptr)
                                return KnownCondition::Unknown;
                            const bool expected =
                                comparison.operation == core::TruthinessOperator::Truthy;
                            return *boolean == expected ? KnownCondition::True
                                                        : KnownCondition::False;
                        } else {
                            return compare_values(*current, comparison.operation, comparison.value);
                        }
                    },
                    value);
            } else if constexpr (std::is_same_v<T, core::IdentityPropertyComparison>) {
                const auto projected = std::visit(
                    [&](const auto& comparison) -> KnownCondition {
                        const auto resolved_owner =
                            resolve_projected_identity(comparison.owner, properties);
                        if (!resolved_owner)
                            return KnownCondition::Unknown;
                        const auto found = std::find_if(
                            properties.identity_properties.begin(),
                            properties.identity_properties.end(), [&](const auto& item) {
                                return item.owner == *resolved_owner &&
                                       item.property == comparison.property_id;
                            });
                        if (found == properties.identity_properties.end())
                            return KnownCondition::Unknown;
                        using Comparison = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<Comparison,
                                                     core::IdentityPropertyTruthiness>)
                            return compare_truthiness(found->value, comparison.operation);
                        else
                            return compare_values(found->value, comparison.operation,
                                                  comparison.value);
                    },
                    value);
                if (projected != KnownCondition::Unknown)
                    return projected;
                if (!condition_facts_valid)
                    return KnownCondition::Unknown;
                if (condition_invalidated(properties, condition))
                    return KnownCondition::Unknown;
                const auto* fact = find_condition_fact(context, condition);
                return fact == nullptr ? KnownCondition::Unknown
                                       : (*fact ? KnownCondition::True : KnownCondition::False);
            } else if constexpr (std::is_same_v<T, core::TraitPresenceCondition>) {
                const auto resolved_owner = resolve_projected_identity(value.owner, properties);
                if (!resolved_owner)
                    return KnownCondition::Unknown;
                const auto found =
                    std::find_if(properties.traits.begin(), properties.traits.end(),
                                 [&](const auto& item) {
                                     return item.owner == *resolved_owner && item.trait == value.trait;
                                 });
                if (found != properties.traits.end())
                    return found->present == value.present ? KnownCondition::True
                                                           : KnownCondition::False;
                if (!condition_facts_valid)
                    return KnownCondition::Unknown;
                if (condition_invalidated(properties, condition))
                    return KnownCondition::Unknown;
                const auto* fact = find_condition_fact(context, condition);
                return fact == nullptr ? KnownCondition::Unknown
                                       : (*fact ? KnownCondition::True : KnownCondition::False);
            } else if constexpr (std::is_same_v<T, core::LocationComparisonCondition>) {
                const auto resolved_subject =
                    resolve_projected_location_subject(value.subject, properties);
                const auto found =
                    std::find_if(properties.locations.begin(), properties.locations.end(),
                                 [&](const auto& item) {
                                     return resolved_subject && item.subject == *resolved_subject;
                                 });
                if (found != properties.locations.end()) {
                    const auto expected = resolve_projected_location(value.location, properties);
                    if (!expected)
                        return KnownCondition::Unknown;
                    const bool equal = found->location == *expected;
                    const bool matches = value.operation == core::EqualityComparisonOperator::Equal
                                             ? equal
                                             : !equal;
                    return matches ? KnownCondition::True : KnownCondition::False;
                }
                if (!condition_facts_valid)
                    return KnownCondition::Unknown;
                if (condition_invalidated(properties, condition))
                    return KnownCondition::Unknown;
                const auto* fact = find_condition_fact(context, condition);
                return fact == nullptr ? KnownCondition::Unknown
                                       : (*fact ? KnownCondition::True : KnownCondition::False);
            } else if constexpr (std::is_same_v<T, core::LuaPredicate>) {
                return KnownCondition::Unknown;
            } else {
                if (!condition_facts_valid)
                    return KnownCondition::Unknown;
                if (condition_invalidated(properties, condition))
                    return KnownCondition::Unknown;
                const auto* fact = find_condition_fact(context, condition);
                if (fact == nullptr)
                    return KnownCondition::Unknown;
                return *fact ? KnownCondition::True : KnownCondition::False;
            }
        },
        condition.value);
}

ProjectedProperties merge_properties(const ProjectedProperties& left,
                                     const ProjectedProperties& right)
{
    ProjectedProperties merged;
    if (left.current_room == right.current_room)
        merged.current_room = left.current_room;
    if (left.interaction_bindings == right.interaction_bindings)
        merged.interaction_bindings = left.interaction_bindings;
    if (left.command_results == right.command_results)
        merged.command_results = left.command_results;
    for (const auto& item : left) {
        const auto* other = find_property(right, item.property);
        if (other != nullptr && *other == item.value)
            merged.push_back(item);
    }
    for (const auto& item : left.identity_properties) {
        const auto found = std::find_if(
            right.identity_properties.begin(), right.identity_properties.end(),
            [&](const auto& other) {
                return other.owner == item.owner && other.property == item.property &&
                       other.value == item.value;
            });
        if (found != right.identity_properties.end())
            merged.identity_properties.push_back(item);
    }
    for (const auto& item : left.traits) {
        const auto found = std::find_if(right.traits.begin(), right.traits.end(),
                                        [&](const auto& other) {
                                            return other.owner == item.owner &&
                                                   other.trait == item.trait &&
                                                   other.present == item.present;
                                        });
        if (found != right.traits.end())
            merged.traits.push_back(item);
    }
    for (const auto& item : left.locations) {
        const auto found = std::find_if(right.locations.begin(), right.locations.end(),
                                        [&](const auto& other) {
                                            return other.subject == item.subject &&
                                                   other.location == item.location;
                                        });
        if (found != right.locations.end())
            merged.locations.push_back(item);
    }
    merged.invalidated_conditions = left.invalidated_conditions;
    for (const auto& condition : right.invalidated_conditions)
        invalidate_condition(merged, condition);
    return merged;
}

std::optional<std::size_t> find_slice(const core::compiled::FlowPredictionIndex& index,
                                      const core::compiled::FlowPredictionPoint& point)
{
    for (std::size_t slice_index = 0; slice_index < index.slices.size(); ++slice_index) {
        const auto& slice = index.slices[slice_index];
        if (slice.point == point ||
            std::ranges::find(slice.resume_points, point) != slice.resume_points.end())
            return slice_index;
    }
    return std::nullopt;
}

core::compiled::FlowPredictionPoint entry_point(const core::SceneId& scene)
{
    return core::compiled::SceneEntryPredictionPoint{scene};
}

core::compiled::FlowPredictionPoint entry_point(const core::DialogueId& dialogue)
{
    return core::compiled::DialogueEntryPredictionPoint{dialogue};
}

ProjectedProperties initial_properties(const FlowPredictionContext& context)
{
    ProjectedProperties properties;
    properties.current_room = context.current_room;
    properties.reserve(context.global_properties.size());
    for (const auto& value : context.global_properties)
        set_property(properties, value.property, value.value);
    return properties;
}

class PredictionTraversal {
public:
    static constexpr std::size_t recursion_safety_depth = 1024;

    PredictionTraversal(const core::compiled::FlowPredictionIndex& index,
                        FlowPredictionProjection& result,
                        const FlowPredictionContext& context,
                        std::size_t traversal_limit,
                        FlowPredictionRootKind root_kind = FlowPredictionRootKind::FlowExecution,
                        std::optional<core::RoomId> root_room = std::nullopt,
                        std::optional<core::RoomExitId> root_exit = std::nullopt)
        : m_index(index), m_result(result), m_context(context), m_traversal_limit(traversal_limit),
          m_root_kind(root_kind),
          m_root_room(std::move(root_room)), m_root_exit(std::move(root_exit))
    {
    }

    struct Result {
        ProjectedProperties properties;
        std::size_t max_distance = 0;
        bool condition_facts_valid = true;
    };

    void set_root_point_override(core::compiled::FlowPredictionPoint point)
    {
        m_root_point_override = std::move(point);
    }

    void append_root_opaque_frontier(core::compiled::FlowPredictionPoint point)
    {
        FlowPredictionOpaqueFrontier frontier{
            .attachment_point = point,
            .provenance = {.points = {point},
                           .root_kind = m_root_kind,
                           .room = m_root_room,
                           .exit = m_root_exit,
                           .supplemental_hint_id = m_supplemental_hint_id},
        };
        if (std::ranges::find(m_result.opaque_frontiers, frontier) ==
            m_result.opaque_frontiers.end())
            m_result.opaque_frontiers.push_back(std::move(frontier));
    }

    Result run_slice(std::size_t slice_index, std::size_t distance,
                     FlowPredictionConfidence confidence, ProjectedProperties properties,
                     bool detached_root = false, bool condition_facts_valid = true)
    {
        // The caller-supplied traversal limit is a semantic wave horizon, not a global DFS
        // budget. Apply it per active path so one deep alternative cannot consume the entire
        // first wave and starve an equally-near sibling branch. Keep the independent generous
        // structural ceiling as the global safety guard against pathological fan-out.
        if (m_active_slices.size() >= std::min(m_traversal_limit, recursion_safety_depth) ||
            m_traversal_steps >= FlowPredictor::structural_ceiling) {
            if (!m_structural_limit_reported) {
                m_result.diagnostics.push_back(
                    {.code = "assets.flow_prediction_structural_limit",
                     .message = "Flow prediction stopped after reaching the structural safety "
                                "ceiling",
                     .severity = core::ErrorSeverity::Warning});
                m_structural_limit_reported = true;
            }
            return {std::move(properties), distance, condition_facts_valid};
        }
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance, condition_facts_valid};
        }
        if (std::find(m_active_slices.begin(), m_active_slices.end(), slice_index) !=
            m_active_slices.end())
            return {std::move(properties), distance, condition_facts_valid};

        ++m_traversal_steps;
        m_active_slices.push_back(slice_index);
        const auto& slice = m_index.slices[slice_index];
        const bool opaque_condition =
            slice.condition && condition_may_execute_opaque(*slice.condition, properties, m_context,
                                                            condition_facts_valid);
        if (opaque_condition)
            append_opaque_frontier();
        const auto condition =
            slice.condition ? evaluate_known(*slice.condition, properties, condition_facts_valid)
                            : KnownCondition::True;
        if (opaque_condition) {
            properties.clear();
            condition_facts_valid = false;
        }
        if (condition == KnownCondition::False) {
            auto result = run_false_successor(slice, distance, confidence, std::move(properties),
                                              condition_facts_valid);
            m_active_slices.pop_back();
            return result;
        }

        const auto local_confidence = condition == KnownCondition::Unknown
                                          ? FlowPredictionConfidence::Alternative
                                          : confidence;
        const auto condition_properties = properties;
        const bool condition_facts_before_slice = condition_facts_valid;
        append_dependencies(slice, distance, local_confidence);
        run_point_hints(slice_index, distance, local_confidence, properties,
                        condition_facts_valid);
        auto program = run_program(slice.program, distance + 1, local_confidence,
                                   std::move(properties), condition_facts_valid);
        auto followed = run_control(slice, std::move(program), local_confidence, detached_root);

        if (condition == KnownCondition::Unknown && slice.condition_false_successor) {
            auto skipped = run_target(*slice.condition_false_successor, distance + 1,
                                      FlowPredictionConfidence::Alternative, condition_properties,
                                      false, condition_facts_before_slice);
            followed.max_distance = std::max(followed.max_distance, skipped.max_distance);
            followed.properties = merge_properties(followed.properties, skipped.properties);
            followed.condition_facts_valid &= skipped.condition_facts_valid;
        }
        m_active_slices.pop_back();
        return followed;
    }

    Result run_choice_effect(std::size_t slice_index, const core::SceneChoiceOptionId& option_id,
                             std::size_t next_effect, std::size_t distance,
                             FlowPredictionConfidence confidence, ProjectedProperties properties,
                             bool condition_facts_valid = true)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance, condition_facts_valid};
        }
        const auto* choice = std::get_if<core::compiled::FlowPredictionChoiceControl>(
            &m_index.slices[slice_index].control);
        if (choice == nullptr)
            return {std::move(properties), distance, condition_facts_valid};
        const auto option = std::ranges::find_if(
            choice->options, [&](const auto& candidate) { return candidate.option == option_id; });
        if (option == choice->options.end())
            return {std::move(properties), distance, condition_facts_valid};
        m_active_slices.push_back(slice_index);
        run_point_hints(slice_index, distance, confidence, properties, condition_facts_valid);
        auto program = run_programs(option->programs, next_effect, distance, confidence,
                                    std::move(properties), condition_facts_valid);
        auto result = run_target(option->target, program.next_distance, confidence,
                                 std::move(program.properties), false,
                                 program.condition_facts_valid);
        m_active_slices.pop_back();
        return result;
    }

    Result run_dialogue_effect(std::size_t slice_index,
                               const std::optional<core::InteractionInstructionId>& command_id,
                               bool awaiting_completion, std::size_t distance,
                               FlowPredictionConfidence confidence, ProjectedProperties properties,
                               bool condition_facts_valid = true)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance, condition_facts_valid};
        }
        const auto& slice = m_index.slices[slice_index];
        if (!command_id) {
            if (!awaiting_completion)
                return run_slice(slice_index, distance, confidence, std::move(properties), false,
                                 condition_facts_valid);
            m_active_slices.push_back(slice_index);
            run_point_hints(slice_index, distance, confidence, properties, condition_facts_valid);
            if (slice.frontier == core::compiled::FlowPredictionFrontier::Normal)
                distance += 3;
            auto result =
                run_control(slice, {std::move(properties), distance, condition_facts_valid},
                            FlowPredictionConfidence::Alternative, false);
            m_active_slices.pop_back();
            return result;
        }

        m_active_slices.push_back(slice_index);
        run_point_hints(slice_index, distance, confidence, properties, condition_facts_valid);
        auto resumed = run_program_from_command(slice.program, *command_id, awaiting_completion,
                                                distance, confidence, properties,
                                                condition_facts_valid);
        if (!resumed) {
            m_active_slices.pop_back();
            m_result.diagnostics.push_back(
                {.code = "assets.flow_prediction_missing_dialogue_command",
                 .message = "Flow Prediction Index cannot resume Dialogue effect command '" +
                            command_id->text() + "' from the active execution position",
                 .severity = core::ErrorSeverity::Warning});
            return {std::move(properties), distance, condition_facts_valid};
        }
        if (awaiting_completion) {
            if (slice.frontier == core::compiled::FlowPredictionFrontier::Normal)
                resumed->next_distance += 3;
            confidence = FlowPredictionConfidence::Alternative;
        }
        auto result = run_control(slice, std::move(*resumed), confidence, false);
        m_active_slices.pop_back();
        return result;
    }

    Result run_interaction_program(
        std::size_t slice_index, const std::optional<core::InteractionInstructionId>& command_id,
        bool awaiting_completion, std::size_t distance, FlowPredictionConfidence confidence,
        ProjectedProperties properties, bool condition_facts_valid = true)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance, condition_facts_valid};
        }
        const auto& slice = m_index.slices[slice_index];
        m_active_slices.push_back(slice_index);
        run_point_hints(slice_index, distance, confidence, properties, condition_facts_valid);

        std::optional<ProgramResult> resumed;
        if (command_id) {
            resumed = run_program_from_command(slice.program, *command_id, awaiting_completion,
                                               distance, confidence, properties,
                                               condition_facts_valid);
        } else {
            // Interaction completion targets are appended after the top-level instruction
            // summaries and intentionally carry no command id. When runtime has exhausted the
            // instruction cursor, resume from that generated completion suffix rather than
            // replaying already executed commands.
            std::size_t completion_start = 0;
            for (std::size_t index = 0; index < slice.program.size(); ++index) {
                if (slice.program[index].command_id)
                    completion_start = index + 1;
            }
            resumed = run_program_from(slice.program, completion_start, distance, confidence,
                                       properties, condition_facts_valid);
        }
        if (!resumed) {
            m_active_slices.pop_back();
            m_result.diagnostics.push_back(
                {.code = "assets.flow_prediction_missing_interaction_command",
                 .message = command_id
                                ? "Flow Prediction Index cannot resume Interaction command '" +
                                      command_id->text() + "' from the active execution position"
                                : "Flow Prediction Index cannot resume Interaction completion from "
                                  "the active execution position",
                 .severity = core::ErrorSeverity::Warning});
            return {std::move(properties), distance, condition_facts_valid};
        }
        if (awaiting_completion) {
            resumed->next_distance += 3;
            confidence = FlowPredictionConfidence::Alternative;
        }
        auto result = run_control(slice, std::move(*resumed), confidence, false);
        m_active_slices.pop_back();
        return result;
    }

    Result run_room_stage(std::size_t slice_index,
                          const std::optional<core::InteractionInstructionId>& command_id,
                          bool awaiting_completion, std::size_t distance,
                          FlowPredictionConfidence confidence, ProjectedProperties properties,
                          bool condition_facts_valid = true)
    {
        if (slice_index >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "slice", slice_index);
            return {std::move(properties), distance, condition_facts_valid};
        }
        const auto& slice = m_index.slices[slice_index];
        m_active_slices.push_back(slice_index);
        append_dependencies(slice, distance, confidence);
        run_point_hints(slice_index, distance, confidence, properties, condition_facts_valid);

        std::optional<ProgramResult> resumed;
        if (command_id) {
            resumed = run_program_from_command(slice.program, *command_id, awaiting_completion,
                                               distance + 1, confidence, properties,
                                               condition_facts_valid);
        } else {
            // Runtime has exhausted the typed lifecycle program and is about to execute the
            // optional Room script hook. Generated hook opacity is the command-id-free suffix.
            std::size_t completion_start = 0;
            for (std::size_t index = 0; index < slice.program.size(); ++index) {
                if (slice.program[index].command_id)
                    completion_start = index + 1;
            }
            resumed = run_program_from(slice.program, completion_start, distance + 1, confidence,
                                       properties, condition_facts_valid);
        }
        if (!resumed) {
            m_active_slices.pop_back();
            m_result.diagnostics.push_back(
                {.code = "assets.flow_prediction_missing_room_command",
                 .message = command_id
                                ? "Flow Prediction Index cannot resume Room lifecycle command '" +
                                      command_id->text() + "' from the active execution position"
                                : "Flow Prediction Index cannot resume the active Room lifecycle "
                                  "hook position",
                 .severity = core::ErrorSeverity::Warning});
            return {std::move(properties), distance, condition_facts_valid};
        }
        if (awaiting_completion) {
            resumed->next_distance += 3;
            confidence = FlowPredictionConfidence::Alternative;
        }
        m_active_slices.pop_back();
        return {std::move(resumed->properties), resumed->next_distance,
                resumed->condition_facts_valid};
    }

    Result run_room_entry(const core::RoomId& room, std::size_t distance,
                          FlowPredictionConfidence confidence, ProjectedProperties properties,
                          bool condition_facts_valid = true)
    {
        Result result{std::move(properties), distance, condition_facts_valid};
        const auto source_room = result.properties.current_room;

        // A semantic Room handoff uses the same entry-path hint semantics as an automatically
        // prospective Room root. Hints remain synthetic prediction edges: they inherit this
        // handoff's distance/confidence and the active-hint guard prevents recursive Room-hint
        // cycles from expanding indefinitely.
        run_room_hints(room, core::compiled::FlowPredictionRoomHintScope::EntryPath,
                       result.max_distance, confidence, result.properties,
                       result.condition_facts_valid);

        const auto run_stage = [&](const core::RoomId& stage_room,
                                   core::compiled::RoomLifecyclePredictionStage stage) {
            const auto slice = find_slice(
                m_index, core::compiled::RoomLifecyclePredictionPoint{stage_room, stage});
            if (slice) {
                result = run_slice(*slice, result.max_distance, confidence,
                                   std::move(result.properties), false,
                                   result.condition_facts_valid);
            }
            ++result.max_distance;
        };

        // Typed directed Room handoffs use the same successful lifecycle ordering as runtime.
        // Declarative/script guards have already been resolved by the authoritative execution
        // that reached this command; directed changes proceed through the lifecycle even when a
        // guard reports false, so prediction composes only the successful lifecycle slices here.
        if (source_room)
            run_stage(*source_room, core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
        run_stage(room, core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
        run_stage(room, core::compiled::RoomLifecyclePredictionStage::Presentation);

        // Committing Room presentation changes Current Room, so root-time non-global Condition
        // facts are no longer authoritative for post-commit Flow. Deterministic typed mutations
        // projected on this hypothetical path remain valid, however: the transition commit itself
        // does not undo identity-property, Trait, or explicit location writes. Opaque lifecycle
        // hooks already clear projection state through their own summaries.
        result.properties.current_room = room;
        result.condition_facts_valid = false;

        if (source_room)
            run_stage(*source_room, core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_stage(room, core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        return result;
    }

private:
    struct ProgramResult {
        ProjectedProperties properties;
        std::size_t next_distance = 0;
        bool condition_facts_valid = true;
    };

    KnownCondition evaluate_known(const core::Condition& condition,
                                  const ProjectedProperties& properties,
                                  bool condition_facts_valid)
    {
        const auto result =
            evaluate_condition(condition, properties, m_context, condition_facts_valid);
        // Only ask Runtime Session for authority that the disposable projection could not already
        // resolve. This keeps deterministic pre-condition mutations from widening the read-only
        // Prediction Context merely because the authored Condition mentions a runtime fact.
        if (result == KnownCondition::Unknown)
            collect_context_requirements(condition, m_result.context_requirements);
        return result;
    }

    void append_dependencies(const core::compiled::FlowPredictionSlice& slice, std::size_t distance,
                             FlowPredictionConfidence confidence)
    {
        const std::size_t execution_order = m_next_execution_order++;
        const auto provenance_points = this->provenance_points();
        std::size_t dependency_priority = 0;
        for (const std::size_t group_index : slice.dependency_groups) {
            if (group_index >= m_index.dependency_groups.size()) {
                add_invalid_index(m_result.diagnostics, "dependency-group", group_index);
                continue;
            }
            for (const auto& dependency : m_index.dependency_groups[group_index]) {
                m_result.entries.push_back(
                    {.dependency = dependency,
                     .execution_distance = distance,
                     .confidence = confidence,
                     .execution_order = execution_order,
                     .dependency_priority = dependency_priority++,
                     .provenance = {.points = provenance_points,
                                    .root_kind = m_root_kind,
                                    .room = m_root_room,
                                    .exit = m_root_exit,
                                    .supplemental_hint_id = m_supplemental_hint_id}});
            }
        }
    }

    std::vector<core::compiled::FlowPredictionPoint> provenance_points() const
    {
        std::vector<core::compiled::FlowPredictionPoint> points;
        points.reserve(m_active_slices.size());
        for (std::size_t index = 0; index < m_active_slices.size(); ++index) {
            const auto active = m_active_slices[index];
            if (active >= m_index.slices.size())
                continue;
            const auto& slice = m_index.slices[active];
            if (index == 0 && m_root_point_override &&
                (slice.point == *m_root_point_override ||
                 std::ranges::find(slice.resume_points, *m_root_point_override) !=
                     slice.resume_points.end()))
                points.push_back(*m_root_point_override);
            else
                points.push_back(slice.point);
        }
        return points;
    }

    void append_hint_dependency(core::compiled::FlowPredictionDependency dependency,
                                std::size_t distance, FlowPredictionConfidence confidence)
    {
        m_result.entries.push_back(
            {.dependency = std::move(dependency),
             .execution_distance = distance,
             .confidence = confidence,
             .execution_order = m_next_execution_order++,
             .dependency_priority = 0,
             .provenance = {.points = provenance_points(),
                            .root_kind = m_root_kind,
                            .room = m_root_room,
                            .exit = m_root_exit,
                            .supplemental_hint_id = m_supplemental_hint_id}});
    }

    void append_opaque_frontier()
    {
        if (m_active_slices.empty())
            return;
        const auto slice_index = m_active_slices.back();
        if (slice_index >= m_index.slices.size())
            return;
        FlowPredictionOpaqueFrontier frontier{
            .attachment_point = m_index.slices[slice_index].point,
            .provenance = {.points = provenance_points(),
                           .root_kind = m_root_kind,
                           .room = m_root_room,
                           .exit = m_root_exit,
                           .supplemental_hint_id = m_supplemental_hint_id},
        };
        if (std::ranges::find(m_result.opaque_frontiers, frontier) ==
            m_result.opaque_frontiers.end())
            m_result.opaque_frontiers.push_back(std::move(frontier));
    }

    bool hint_active(const core::compiled::FlowPredictionSupplementalHint& hint) const noexcept
    {
        return std::find(m_active_hints.begin(), m_active_hints.end(), &hint) !=
               m_active_hints.end();
    }

    void run_hint(const core::compiled::FlowPredictionSupplementalHint& hint, std::size_t distance,
                  FlowPredictionConfidence confidence, const ProjectedProperties& properties,
                  bool condition_facts_valid)
    {
        if (hint_active(hint))
            return;
        m_active_hints.push_back(&hint);
        const auto previous_hint = m_supplemental_hint_id;
        m_supplemental_hint_id = hint.id;
        std::visit(
            [&](const auto& target) {
                using T = std::decay_t<decltype(target)>;
                if constexpr (std::is_same_v<T, core::compiled::FlowPredictionHintAssetTarget>) {
                    append_hint_dependency(
                        core::compiled::FlowPredictionAssetDependency{target.asset}, distance,
                        confidence);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintLayoutTarget>) {
                    append_hint_dependency(
                        core::compiled::FlowPredictionLayoutDependency{target.layout}, distance,
                        confidence);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintSceneTarget>) {
                    (void)run_child(entry_point(target.scene), distance, confidence, properties,
                                    false, condition_facts_valid);
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::FlowPredictionHintDialogueTarget>) {
                    (void)run_child(entry_point(target.dialogue), distance, confidence, properties,
                                    false, condition_facts_valid);
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::FlowPredictionHintRoomTarget>) {
                    (void)run_room_entry(target.room, distance, confidence, properties,
                                         condition_facts_valid);
                }
            },
            hint.target);
        m_supplemental_hint_id = previous_hint;
        m_active_hints.pop_back();
    }

    void run_point_hints(std::size_t slice_index, std::size_t distance,
                         FlowPredictionConfidence confidence, const ProjectedProperties& properties,
                         bool condition_facts_valid)
    {
        for (const auto& hint : m_index.supplemental_hints) {
            const auto* attachment =
                std::get_if<core::compiled::FlowPredictionHintPointAttachment>(&hint.attachment);
            if (attachment != nullptr && attachment->slice == slice_index)
                run_hint(hint, distance, confidence, properties, condition_facts_valid);
        }
    }

public:
    void run_room_hints(const core::RoomId& room, core::compiled::FlowPredictionRoomHintScope scope,
                        std::size_t distance, FlowPredictionConfidence confidence,
                        const ProjectedProperties& properties, bool condition_facts_valid = true)
    {
        for (const auto& hint : m_index.supplemental_hints) {
            const auto* attachment =
                std::get_if<core::compiled::FlowPredictionHintRoomAttachment>(&hint.attachment);
            if (attachment != nullptr && attachment->room == room && attachment->scope == scope)
                run_hint(hint, distance, confidence, properties, condition_facts_valid);
        }
    }

private:
    ProgramResult
    run_program_from(const std::vector<core::compiled::FlowPredictionCommand>& program,
                     std::size_t start, std::size_t distance, FlowPredictionConfidence confidence,
                     ProjectedProperties properties, bool condition_facts_valid)
    {
        std::size_t next_distance = distance;
        for (std::size_t index = start; index < program.size(); ++index) {
            const auto& command = program[index];
            auto command_result = std::visit(
                [&](const auto& value) -> ProgramResult {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T,
                                                 core::compiled::FlowPredictionSetGlobalProperty>) {
                        set_property(properties, value.property, value.value);
                    } else if constexpr (std::is_same_v<
                                             T,
                                             core::compiled::FlowPredictionSetIdentityProperty>) {
                        if (!project_identity_property(properties, value.owner, value.property,
                                                       value.value))
                            invalidate_identity_property_facts(properties, m_context, value.owner,
                                                              value.property);
                        invalidate_inventory_quantity_facts(properties, m_context);
                    } else if constexpr (std::is_same_v<
                                             T,
                                             core::compiled::FlowPredictionSetTraitPresence>) {
                        if (!project_trait_presence(properties, value.owner, value.trait,
                                                    value.present))
                            invalidate_trait_facts(properties, m_context, value.owner, value.trait);
                        invalidate_inventory_quantity_facts(properties, m_context);
                    } else if constexpr (
                        std::is_same_v<T, core::compiled::FlowPredictionSetLocation>) {
                        if (!project_location(properties, value.subject, value.location))
                            invalidate_location_facts(properties, m_context, value.subject);
                        invalidate_inventory_quantity_facts(properties, m_context);
                    } else if constexpr (
                        std::is_same_v<T, core::compiled::FlowPredictionInvalidateGlobalProperty>) {
                        invalidate_property(properties, value.property);
                    } else if constexpr (std::is_same_v<
                                             T,
                                             core::compiled::FlowPredictionInvalidateConditionFacts>) {
                        properties.clear_typed();
                        condition_facts_valid = false;
                    } else if constexpr (
                        std::is_same_v<T, core::compiled::FlowPredictionInvalidateState>) {
                        properties.clear();
                        condition_facts_valid = false;
                    } else if constexpr (std::is_same_v<T, core::compiled::FlowPredictionOpaque>) {
                        // Arbitrary Lua can mutate any gameplay fact. Do not execute or analyze it;
                        // discard knowledge and continue through statically known Flow.
                        append_opaque_frontier();
                        properties.clear();
                        condition_facts_valid = false;
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::FlowPredictionCallScene>) {
                        auto child = run_child(entry_point(value.scene), next_distance, confidence,
                                               properties, false, condition_facts_valid);
                        next_distance = std::max(next_distance, child.max_distance + 1);
                        properties = std::move(child.properties);
                        condition_facts_valid = child.condition_facts_valid;
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::FlowPredictionStartDetachedScene>) {
                        (void)run_child(entry_point(value.scene), next_distance, confidence,
                                        properties, true, condition_facts_valid);
                        properties.clear();
                        condition_facts_valid = false;
                    } else if constexpr (std::is_same_v<
                                             T, core::compiled::FlowPredictionCallDialogue>) {
                        auto child = run_child(entry_point(value.dialogue), next_distance,
                                               confidence, properties, false,
                                               condition_facts_valid);
                        next_distance = std::max(next_distance, child.max_distance + 1);
                        properties = std::move(child.properties);
                        condition_facts_valid = child.condition_facts_valid;
                    } else if constexpr (std::is_same_v<T,
                                                        core::compiled::FlowPredictionEnterRoom>) {
                        auto room =
                            run_room_entry(value.room, next_distance, confidence, properties,
                                           condition_facts_valid);
                        next_distance = std::max(next_distance, room.max_distance);
                        properties = std::move(room.properties);
                        condition_facts_valid = room.condition_facts_valid;
                    } else if constexpr (std::is_same_v<T, core::compiled::FlowPredictionIf>) {
                        const bool opaque_condition = condition_may_execute_opaque(
                            value.condition, properties, m_context, condition_facts_valid);
                        if (opaque_condition)
                            append_opaque_frontier();
                        const auto evaluated =
                            evaluate_known(value.condition, properties, condition_facts_valid);
                        if (opaque_condition) {
                            properties.clear();
                            condition_facts_valid = false;
                        }
                        if (evaluated == KnownCondition::True) {
                            return run_program(value.then_commands, next_distance + 1, confidence,
                                               std::move(properties), condition_facts_valid);
                        }
                        if (evaluated == KnownCondition::False) {
                            return run_program(value.else_commands, next_distance + 1, confidence,
                                               std::move(properties), condition_facts_valid);
                        }
                        auto then_result =
                            run_program(value.then_commands, next_distance + 1,
                                        FlowPredictionConfidence::Alternative, properties,
                                        condition_facts_valid);
                        auto else_result =
                            run_program(value.else_commands, next_distance + 1,
                                        FlowPredictionConfidence::Alternative, properties,
                                        condition_facts_valid);
                        return {merge_properties(then_result.properties, else_result.properties),
                                std::max(then_result.next_distance, else_result.next_distance),
                                then_result.condition_facts_valid &&
                                    else_result.condition_facts_valid};
                    }
                    return {std::move(properties), next_distance, condition_facts_valid};
                },
                command.value);
            properties = std::move(command_result.properties);
            next_distance = command_result.next_distance;
            condition_facts_valid = command_result.condition_facts_valid;
        }
        return {std::move(properties), next_distance, condition_facts_valid};
    }

    ProgramResult run_program(const std::vector<core::compiled::FlowPredictionCommand>& program,
                              std::size_t distance, FlowPredictionConfidence confidence,
                              ProjectedProperties properties, bool condition_facts_valid = true)
    {
        return run_program_from(program, 0, distance, confidence, std::move(properties),
                                condition_facts_valid);
    }

    std::optional<ProgramResult>
    run_program_from_command(const std::vector<core::compiled::FlowPredictionCommand>& program,
                             const core::InteractionInstructionId& command_id, bool completed,
                             std::size_t distance, FlowPredictionConfidence confidence,
                             const ProjectedProperties& properties, bool condition_facts_valid)
    {
        for (std::size_t index = 0; index < program.size(); ++index) {
            const auto& command = program[index];
            if (command.command_id && *command.command_id == command_id)
                return run_program_from(program, index + (completed ? 1U : 0U), distance,
                                        confidence, properties, condition_facts_valid);

            const auto* branch = std::get_if<core::compiled::FlowPredictionIf>(&command.value);
            if (branch == nullptr)
                continue;
            if (auto nested = run_program_from_command(branch->then_commands, command_id, completed,
                                                       distance, confidence, properties,
                                                       condition_facts_valid))
                return run_program_from(program, index + 1, nested->next_distance, confidence,
                                        std::move(nested->properties),
                                        nested->condition_facts_valid);
            if (auto nested = run_program_from_command(branch->else_commands, command_id, completed,
                                                       distance, confidence, properties,
                                                       condition_facts_valid))
                return run_program_from(program, index + 1, nested->next_distance, confidence,
                                        std::move(nested->properties),
                                        nested->condition_facts_valid);
        }
        return std::nullopt;
    }

    ProgramResult
    run_programs(const std::vector<std::vector<core::compiled::FlowPredictionCommand>>& programs,
                 std::size_t start, std::size_t distance, FlowPredictionConfidence confidence,
                 ProjectedProperties properties, bool condition_facts_valid = true)
    {
        ProgramResult result{std::move(properties), distance, condition_facts_valid};
        for (std::size_t index = start; index < programs.size(); ++index) {
            result = run_program(programs[index], result.next_distance, confidence,
                                 std::move(result.properties), result.condition_facts_valid);
        }
        return result;
    }

    Result run_child(const core::compiled::FlowPredictionPoint& point, std::size_t distance,
                     FlowPredictionConfidence confidence, const ProjectedProperties& properties,
                     bool detached_root, bool condition_facts_valid)
    {
        const auto child = find_slice(m_index, point);
        if (child)
            return run_slice(*child, distance, confidence, properties, detached_root,
                             condition_facts_valid);
        return {properties, distance, condition_facts_valid};
    }

    Result run_target(std::size_t target, std::size_t distance, FlowPredictionConfidence confidence,
                      ProjectedProperties properties, bool detached_root = false,
                      bool condition_facts_valid = true)
    {
        if (target >= m_index.slices.size()) {
            add_invalid_index(m_result.diagnostics, "successor", target);
            return {std::move(properties), distance, condition_facts_valid};
        }
        return run_slice(target, distance, confidence, std::move(properties), detached_root,
                         condition_facts_valid);
    }

    Result run_false_successor(const core::compiled::FlowPredictionSlice& slice,
                               std::size_t distance, FlowPredictionConfidence confidence,
                               ProjectedProperties properties, bool condition_facts_valid)
    {
        if (!slice.condition_false_successor)
            return {std::move(properties), distance, condition_facts_valid};
        return run_target(*slice.condition_false_successor, distance + 1, confidence,
                          std::move(properties), false, condition_facts_valid);
    }

    Result run_control(const core::compiled::FlowPredictionSlice& slice, ProgramResult program,
                       FlowPredictionConfidence confidence, bool detached_root)
    {
        std::size_t distance = program.next_distance;
        auto continuation_confidence = confidence;
        switch (slice.frontier) {
        case core::compiled::FlowPredictionFrontier::Normal:
            break;
        case core::compiled::FlowPredictionFrontier::ShortWait:
            distance += 1;
            break;
        case core::compiled::FlowPredictionFrontier::StrongWait:
        case core::compiled::FlowPredictionFrontier::Decision:
            distance += 3;
            continuation_confidence = FlowPredictionConfidence::Alternative;
            break;
        }
        if (detached_root) {
            distance += 2;
            continuation_confidence = FlowPredictionConfidence::Alternative;
        }

        return std::visit(
            [&](const auto& control) -> Result {
                using T = std::decay_t<decltype(control)>;
                if constexpr (std::is_same_v<T, core::compiled::FlowPredictionSequentialControl>) {
                    if (!control.successor)
                        return {std::move(program.properties), distance,
                                program.condition_facts_valid};
                    return run_target(*control.successor, distance, continuation_confidence,
                                      std::move(program.properties), false,
                                      program.condition_facts_valid);
                } else if constexpr (std::is_same_v<T,
                                                    core::compiled::FlowPredictionBranchControl>) {
                    bool widened = false;
                    bool fallthrough_possible = true;
                    std::vector<Result> alternatives;
                    auto branch_properties = program.properties;
                    bool branch_condition_facts_valid = program.condition_facts_valid;
                    for (const auto& branch : control.branches) {
                        const bool opaque_condition = condition_may_execute_opaque(
                            branch.condition, branch_properties, m_context,
                            branch_condition_facts_valid);
                        if (opaque_condition)
                            append_opaque_frontier();
                        const auto evaluated = evaluate_known(branch.condition, branch_properties,
                                                              branch_condition_facts_valid);
                        if (opaque_condition) {
                            branch_properties.clear();
                            branch_condition_facts_valid = false;
                        }
                        if (evaluated == KnownCondition::False)
                            continue;
                        if (evaluated == KnownCondition::True) {
                            auto selected =
                                run_target(branch.target, distance,
                                           widened ? FlowPredictionConfidence::Alternative
                                                   : continuation_confidence,
                                           branch_properties, false,
                                           branch_condition_facts_valid);
                            if (!widened)
                                return selected;
                            alternatives.push_back(std::move(selected));
                            fallthrough_possible = false;
                            break;
                        }
                        widened = true;
                        alternatives.push_back(run_target(branch.target, distance,
                                                          FlowPredictionConfidence::Alternative,
                                                          branch_properties, false,
                                                          branch_condition_facts_valid));
                    }
                    if (fallthrough_possible)
                        alternatives.push_back(
                            run_target(control.fallback, distance,
                                       widened ? FlowPredictionConfidence::Alternative
                                               : continuation_confidence,
                                       branch_properties, false,
                                       branch_condition_facts_valid));
                    Result merged = std::move(alternatives.front());
                    for (std::size_t index = 1; index < alternatives.size(); ++index) {
                        merged.max_distance =
                            std::max(merged.max_distance, alternatives[index].max_distance);
                        merged.properties =
                            merge_properties(merged.properties, alternatives[index].properties);
                        merged.condition_facts_valid &= alternatives[index].condition_facts_valid;
                    }
                    return merged;
                } else {
                    std::vector<Result> alternatives;
                    auto choice_properties = program.properties;
                    bool choice_condition_facts_valid = program.condition_facts_valid;
                    for (const auto& option : control.options) {
                        const bool opaque_condition =
                            option.condition && condition_may_execute_opaque(
                                                    *option.condition, choice_properties, m_context,
                                                    choice_condition_facts_valid);
                        if (opaque_condition)
                            append_opaque_frontier();
                        if (option.condition) {
                            const auto evaluated = evaluate_known(*option.condition,
                                                                  choice_properties,
                                                                  choice_condition_facts_valid);
                            if (opaque_condition) {
                                choice_properties.clear();
                                choice_condition_facts_valid = false;
                            }
                            if (evaluated == KnownCondition::False)
                                continue;
                        }
                        auto option_program =
                            run_programs(option.programs, 0, distance,
                                         FlowPredictionConfidence::Alternative, choice_properties,
                                         choice_condition_facts_valid);
                        alternatives.push_back(run_target(option.target,
                                                          option_program.next_distance,
                                                          FlowPredictionConfidence::Alternative,
                                                          std::move(option_program.properties), false,
                                                          option_program.condition_facts_valid));
                    }
                    if (alternatives.empty())
                        return {std::move(program.properties), distance,
                                program.condition_facts_valid};
                    Result merged = std::move(alternatives.front());
                    for (std::size_t index = 1; index < alternatives.size(); ++index) {
                        merged.max_distance =
                            std::max(merged.max_distance, alternatives[index].max_distance);
                        merged.properties =
                            merge_properties(merged.properties, alternatives[index].properties);
                        merged.condition_facts_valid &= alternatives[index].condition_facts_valid;
                    }
                    return merged;
                }
            },
            slice.control);
    }

    const core::compiled::FlowPredictionIndex& m_index;
    FlowPredictionProjection& m_result;
    const FlowPredictionContext& m_context;
    std::size_t m_traversal_limit = FlowPredictor::structural_ceiling;
    FlowPredictionRootKind m_root_kind = FlowPredictionRootKind::FlowExecution;
    std::optional<core::RoomId> m_root_room;
    std::optional<core::RoomExitId> m_root_exit;
    std::optional<core::compiled::FlowPredictionPoint> m_root_point_override;
    std::vector<std::size_t> m_active_slices;
    std::vector<const core::compiled::FlowPredictionSupplementalHint*> m_active_hints;
    std::optional<std::string> m_supplemental_hint_id;
    std::size_t m_next_execution_order = 0;
    std::size_t m_traversal_steps = 0;
    bool m_structural_limit_reported = false;
};

std::optional<std::size_t> find_room_stage(const core::compiled::FlowPredictionIndex& index,
                                           const core::RoomId& room,
                                           core::compiled::RoomLifecyclePredictionStage stage)
{
    return find_slice(index, core::compiled::RoomLifecyclePredictionPoint{room, stage});
}

} // namespace

FlowPredictionProjection FlowPredictor::predict(const core::compiled::Entrypoint& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const core::compiled::Entrypoint& root,
                                                const FlowPredictionContext& context) const
{
    return std::visit(
        [&](const auto& value) -> FlowPredictionProjection {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RoomId>) {
                const auto* room = m_project->find_room(value);
                const bool can_enter_hook_opaque =
                    room != nullptr && std::ranges::any_of(room->script_hooks, [](const auto& hook) {
                        return hook.hook == core::compiled::RoomScriptHookKind::CanEnter;
                    });
                return predict(ProspectiveRoomEntryPredictionRoot{
                                   .source_room = std::nullopt,
                                   .target_room = value,
                                   .source_can_leave = std::nullopt,
                                   .exit_condition = std::nullopt,
                                   .target_can_enter = room ? std::optional<core::Condition>{
                                                                  room->lifecycle.can_enter}
                                                            : std::nullopt,
                                   .source_can_leave_hook_opaque = false,
                                   .target_can_enter_hook_opaque = can_enter_hook_opaque},
                               context);
            } else {
                FlowPredictionProjection result;
                const auto& optional_index = m_project->flow_prediction();
                if (!optional_index)
                    return result;
                result.diagnostics = optional_index->diagnostics;
                if (optional_index->slices.empty())
                    return result;
                const auto root_slice = find_slice(*optional_index, entry_point(value));
                if (!root_slice)
                    return result;
                PredictionTraversal traversal(*optional_index, result, context, m_traversal_limit);
                (void)traversal.run_slice(*root_slice, 0, FlowPredictionConfidence::Expected,
                                          initial_properties(context));
                return result;
            }
        },
        root);
}

FlowPredictionProjection
FlowPredictor::predict(const ProspectiveRoomEntryPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ProspectiveRoomEntryPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;
    PredictionTraversal traversal(index, result, context, m_traversal_limit,
                                  FlowPredictionRootKind::ProspectiveRoomEntry,
                                  root.target_room, root.source_exit);
    auto properties = initial_properties(context);
    if (root.source_room)
        properties.current_room = root.source_room;
    bool condition_facts_valid = true;
    auto confidence = FlowPredictionConfidence::Expected;
    const auto evaluate_guard = [&](const std::optional<core::Condition>& guard, bool opaque_hook,
                                    core::compiled::FlowPredictionPoint attachment_point) {
        const bool opaque_condition =
            guard && condition_may_execute_opaque(*guard, properties, context,
                                                  condition_facts_valid);
        if (opaque_condition || opaque_hook)
            traversal.append_root_opaque_frontier(std::move(attachment_point));
        if (guard) {
            const auto evaluated =
                evaluate_condition(*guard, properties, context, condition_facts_valid);
            if (evaluated == KnownCondition::Unknown)
                collect_context_requirements(*guard, result.context_requirements);
            if (evaluated == KnownCondition::False)
                return false;
            if (evaluated == KnownCondition::Unknown) {
                confidence = FlowPredictionConfidence::Alternative;
                if (opaque_condition) {
                    properties.clear();
                    condition_facts_valid = false;
                }
            }
        }
        if (opaque_hook) {
            confidence = FlowPredictionConfidence::Alternative;
            properties.clear();
            condition_facts_valid = false;
        }
        return true;
    };
    const auto source_guard_point = [&]() -> core::compiled::FlowPredictionPoint {
        if (root.source_room)
            return core::compiled::RoomLifecyclePredictionPoint{
                *root.source_room, core::compiled::RoomLifecyclePredictionStage::BeforeLeave};
        return core::compiled::RoomLifecyclePredictionPoint{
            root.target_room, core::compiled::RoomLifecyclePredictionStage::BeforeEnter};
    };
    const core::compiled::FlowPredictionPoint target_guard_point =
        core::compiled::RoomLifecyclePredictionPoint{
            root.target_room, core::compiled::RoomLifecyclePredictionStage::BeforeEnter};
    if (!evaluate_guard(root.source_can_leave, root.source_can_leave_hook_opaque,
                        source_guard_point()) ||
        !evaluate_guard(root.exit_condition, false, source_guard_point()) ||
        !evaluate_guard(root.target_can_enter, root.target_can_enter_hook_opaque,
                        target_guard_point))
        return result;

    std::size_t distance = 0;
    traversal.run_room_hints(root.target_room,
                             core::compiled::FlowPredictionRoomHintScope::EntryPath, distance,
                             confidence, properties, condition_facts_valid);

    auto run_stage = [&](const core::RoomId& room,
                         core::compiled::RoomLifecyclePredictionStage stage) {
        if (const auto slice = find_room_stage(index, room, stage)) {
            auto stage_result = traversal.run_slice(*slice, distance, confidence,
                                                    std::move(properties), false,
                                                    condition_facts_valid);
            properties = std::move(stage_result.properties);
            condition_facts_valid = stage_result.condition_facts_valid;
            distance = std::max(distance, stage_result.max_distance);
        }
        ++distance;
    };

    // Mirror the successful runtime transition sequence. Rejection programs deliberately have no
    // prospective-entry slices and therefore cannot leak into this normal-success prediction root.
    if (root.source_room)
        run_stage(*root.source_room, core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::Presentation);
    // The successful transition has now committed the target as Current Room. Root-time
    // non-global facts sampled in the source-room publication must not be reused beyond this
    // boundary, but deterministic typed mutations projected by successful lifecycle commands stay
    // valid unless an opaque summary already invalidated them.
    properties.current_room = root.target_room;
    condition_facts_valid = false;
    if (root.source_room)
        run_stage(*root.source_room, core::compiled::RoomLifecyclePredictionStage::AfterLeave);
    run_stage(root.target_room, core::compiled::RoomLifecyclePredictionStage::AfterEnter);
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ResidentRoomPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ResidentRoomPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;
    PredictionTraversal traversal(index, result, context, m_traversal_limit,
                                  FlowPredictionRootKind::ResidentRoomContext, root.room);
    const auto properties = initial_properties(context);
    traversal.run_room_hints(root.room, core::compiled::FlowPredictionRoomHintScope::Resident, 0,
                             FlowPredictionConfidence::Alternative, properties);
    for (const auto& program : root.programs) {
        const auto point = std::visit(
            [](const auto& value) -> core::compiled::FlowPredictionPoint {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::InteractionRuleProgramRef>) {
                    return core::compiled::InteractionRulePredictionPoint{value.interaction,
                                                                          value.rule};
                } else if constexpr (std::is_same_v<T, core::VerbDefaultProgramRef>) {
                    return core::compiled::VerbDefaultPredictionPoint{value.verb};
                } else {
                    return core::compiled::UndefinedInteractionPredictionPoint{};
                }
            },
            program);
        if (const auto slice = find_slice(index, point)) {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Alternative, properties);
        }
    }
    for (const auto& layout : root.layouts) {
        if (const auto slice =
                find_slice(index, core::compiled::ResidentLayoutPredictionPoint{layout})) {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Alternative, properties);
        }
    }
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ActiveScenePredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveScenePredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;
    PredictionTraversal traversal(index, result, context, m_traversal_limit);
    auto properties = initial_properties(context);

    if (!root.position.stage_initialized) {
        const core::compiled::FlowPredictionPoint entry_point_value =
            core::compiled::SceneEntryPredictionPoint{root.scene};
        if (const auto entry = find_slice(index, entry_point_value)) {
            traversal.set_root_point_override(entry_point_value);
            (void)traversal.run_slice(*entry, 0, FlowPredictionConfidence::Expected,
                                      std::move(properties));
        }
        return result;
    }

    const auto step_slice = [&](const core::SceneStepId& step) {
        return find_slice(index, core::compiled::SceneStepPredictionPoint{root.scene, step});
    };
    const auto run_position = [&](const std::optional<core::SceneStepId>& step,
                                  std::size_t distance, FlowPredictionConfidence confidence,
                                  ProjectedProperties projected) {
        const auto point =
            step ? core::compiled::FlowPredictionPoint{core::compiled::SceneStepPredictionPoint{
                       root.scene, *step}}
                 : core::compiled::FlowPredictionPoint{
                       core::compiled::SceneTerminalPredictionPoint{root.scene}};
        if (const auto slice = find_slice(index, point)) {
            traversal.set_root_point_override(point);
            (void)traversal.run_slice(*slice, distance, confidence, std::move(projected));
        }
    };

    if (const auto* effects =
            std::get_if<core::SceneChoiceEffectPosition>(&root.position.substate)) {
        if (root.position.next_step) {
            if (const auto slice = step_slice(*root.position.next_step)) {
                traversal.set_root_point_override(core::compiled::SceneStepPredictionPoint{
                    root.scene, *root.position.next_step});
                const auto next_effect =
                    effects->next_effect + (effects->awaiting_completion ? 1U : 0U);
                const auto distance = effects->awaiting_completion ? 3U : 0U;
                const auto confidence = effects->awaiting_completion
                                            ? FlowPredictionConfidence::Alternative
                                            : FlowPredictionConfidence::Expected;
                (void)traversal.run_choice_effect(*slice, effects->option, next_effect, distance,
                                                  confidence, std::move(properties));
            }
        }
        return result;
    }

    if (const auto* completion =
            std::get_if<core::SceneInstructionCompletionPosition>(&root.position.substate)) {
        std::size_t distance = 0;
        auto confidence = FlowPredictionConfidence::Expected;
        if (root.position.next_step) {
            if (const auto current = step_slice(*root.position.next_step)) {
                switch (index.slices[*current].frontier) {
                case core::compiled::FlowPredictionFrontier::Normal:
                    break;
                case core::compiled::FlowPredictionFrontier::ShortWait:
                    distance = 1;
                    break;
                case core::compiled::FlowPredictionFrontier::StrongWait:
                case core::compiled::FlowPredictionFrontier::Decision:
                    distance = 3;
                    confidence = FlowPredictionConfidence::Alternative;
                    break;
                }
            }
        }
        run_position(completion->next_step, distance, confidence, std::move(properties));
        return result;
    }

    if (const auto* pending =
            std::get_if<core::SceneAutosavePendingPosition>(&root.position.substate)) {
        run_position(pending->next_step, 0, FlowPredictionConfidence::Expected,
                     std::move(properties));
        return result;
    }

    run_position(root.position.next_step, 0, FlowPredictionConfidence::Expected,
                 std::move(properties));
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ActiveDialoguePredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveDialoguePredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;
    PredictionTraversal traversal(index, result, context, m_traversal_limit);

    core::compiled::FlowPredictionPoint point =
        core::compiled::DialogueTerminalPredictionPoint{root.dialogue};
    if (root.position.stage != core::DialogueFramePosition::Stage::Complete) {
        core::compiled::DialoguePredictionStage stage =
            core::compiled::DialoguePredictionStage::EnterBlock;
        std::size_t cursor = 0;
        switch (root.position.stage) {
        case core::DialogueFramePosition::Stage::EnterBlock:
            stage = core::compiled::DialoguePredictionStage::EnterBlock;
            break;
        case core::DialogueFramePosition::Stage::PresentSegment:
            stage = core::compiled::DialoguePredictionStage::PresentSegment;
            cursor = root.position.next_cue;
            break;
        case core::DialogueFramePosition::Stage::ApplySegmentEffects:
            stage = core::compiled::DialoguePredictionStage::ApplySegmentEffects;
            cursor = root.position.next_effect;
            break;
        case core::DialogueFramePosition::Stage::PresentChoices:
            stage = core::compiled::DialoguePredictionStage::PresentChoices;
            break;
        case core::DialogueFramePosition::Stage::ApplyChoiceEffects:
            stage = core::compiled::DialoguePredictionStage::ApplyChoiceEffects;
            cursor = root.position.next_effect;
            break;
        case core::DialogueFramePosition::Stage::FollowEdge:
            stage = core::compiled::DialoguePredictionStage::FollowEdge;
            break;
        case core::DialogueFramePosition::Stage::Complete:
            break;
        }
        point = core::compiled::DialoguePositionPredictionPoint{
            root.dialogue, root.position.block, root.position.segment, root.position.edge, stage,
            cursor};
    }
    if (const auto slice = find_slice(index, point)) {
        traversal.set_root_point_override(point);
        auto properties = initial_properties(context);
        if (root.position.stage == core::DialogueFramePosition::Stage::ApplySegmentEffects ||
            root.position.stage == core::DialogueFramePosition::Stage::ApplyChoiceEffects) {
            (void)traversal.run_dialogue_effect(
                *slice, root.position.effect_command, root.position.awaiting_completion, 0,
                FlowPredictionConfidence::Expected, std::move(properties));
        } else if (root.position.stage == core::DialogueFramePosition::Stage::PresentSegment &&
                   root.position.awaiting_completion) {
            (void)traversal.run_dialogue_effect(*slice, std::nullopt, true, 0,
                                                FlowPredictionConfidence::Expected,
                                                std::move(properties));
        } else {
            (void)traversal.run_slice(*slice, 0, FlowPredictionConfidence::Expected,
                                      std::move(properties));
        }
    }
    return result;
}

FlowPredictionProjection FlowPredictor::predict(const ActiveInteractionPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveInteractionPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;

    const auto point = std::visit(
        [](const auto& value) -> core::compiled::FlowPredictionPoint {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::InteractionRuleProgramRef>) {
                return core::compiled::InteractionRulePredictionPoint{value.interaction, value.rule};
            } else if constexpr (std::is_same_v<T, core::VerbDefaultProgramRef>) {
                return core::compiled::VerbDefaultPredictionPoint{value.verb};
            } else {
                return core::compiled::UndefinedInteractionPredictionPoint{};
            }
        },
        root.program);
    const auto slice = find_slice(index, point);
    if (!slice)
        return result;

    FlowPredictionContext interaction_context = context;
    interaction_context.condition_facts.insert(interaction_context.condition_facts.begin(),
                                               root.condition_facts.begin(),
                                               root.condition_facts.end());
    PredictionTraversal traversal(index, result, interaction_context, m_traversal_limit);
    traversal.set_root_point_override(point);
    auto properties = initial_properties(interaction_context);
    properties.interaction_bindings = root.interaction_bindings;
    properties.command_results = root.command_results;
    (void)traversal.run_interaction_program(
        *slice, root.position.next_instruction, root.position.awaiting_completion, 0,
        FlowPredictionConfidence::Expected, std::move(properties));
    return result;
}

FlowPredictionProjection
FlowPredictor::predict(const ActiveRoomTransitionPredictionRoot& root) const
{
    return predict(root, {});
}

FlowPredictionProjection FlowPredictor::predict(const ActiveRoomTransitionPredictionRoot& root,
                                                const FlowPredictionContext& context) const
{
    FlowPredictionProjection result;
    const auto& optional_index = m_project->flow_prediction();
    if (!optional_index)
        return result;
    const auto& index = *optional_index;
    result.diagnostics = index.diagnostics;
    if (index.slices.empty())
        return result;

    FlowPredictionContext transition_context = context;
    transition_context.condition_facts.insert(transition_context.condition_facts.begin(),
                                              root.condition_facts.begin(),
                                              root.condition_facts.end());
    PredictionTraversal traversal(index, result, transition_context, m_traversal_limit,
                                  FlowPredictionRootKind::FlowExecution, root.target_room,
                                  root.source_exit);
    auto properties = initial_properties(transition_context);
    properties.command_results = root.command_results;
    bool condition_facts_valid = true;
    std::size_t distance = 0;
    auto confidence = FlowPredictionConfidence::Expected;

    const auto run_future_stage = [&](const core::RoomId& room,
                                      core::compiled::RoomLifecyclePredictionStage stage) {
        if (const auto slice = find_room_stage(index, room, stage)) {
            auto stage_result = traversal.run_slice(
                *slice, distance, confidence, std::move(properties), false, condition_facts_valid);
            properties = std::move(stage_result.properties);
            condition_facts_valid = stage_result.condition_facts_valid;
            distance = std::max(distance, stage_result.max_distance);
        }
        ++distance;
    };
    const auto run_active_stage = [&](const core::RoomId& room,
                                      core::compiled::RoomLifecyclePredictionStage stage) {
        const core::compiled::FlowPredictionPoint point =
            core::compiled::RoomLifecyclePredictionPoint{room, stage};
        const auto slice = find_slice(index, point);
        if (!slice)
            return;
        traversal.set_root_point_override(point);
        auto stage_result =
            traversal.run_room_stage(*slice, root.command_id, root.awaiting_completion, distance,
                                     confidence, std::move(properties), condition_facts_valid);
        properties = std::move(stage_result.properties);
        condition_facts_valid = stage_result.condition_facts_valid;
        distance = std::max(distance, stage_result.max_distance);
        ++distance;
    };
    const auto commit_room = [&]() {
        properties.current_room = root.target_room;
        condition_facts_valid = false;
    };

    switch (root.stage) {
    case core::RoomTransitionStage::SourceCanLeave:
    case core::RoomTransitionStage::ExitCondition:
    case core::RoomTransitionStage::TargetCanEnter:
        // Guard evaluation itself is authoritative runtime work and has no prediction slice. A
        // publication at one of these transient stages therefore keeps the successful continuation
        // useful but uncertain until execution resolves the guard.
        confidence = FlowPredictionConfidence::Alternative;
        properties.current_room = root.source_room;
        if (root.source_room)
            run_future_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::Presentation);
        commit_room();
        if (root.source_room)
            run_future_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::BeforeLeave:
        properties.current_room = root.source_room;
        if (root.source_room)
            run_active_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::BeforeLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::Presentation);
        commit_room();
        if (root.source_room)
            run_future_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::BeforeEnter:
        properties.current_room = root.source_room;
        run_active_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::BeforeEnter);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::Presentation);
        commit_room();
        if (root.source_room)
            run_future_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::CommitRoomSwitch:
        if (!root.awaiting_completion) {
            properties.current_room = root.source_room;
            run_future_stage(root.target_room,
                             core::compiled::RoomLifecyclePredictionStage::Presentation);
            commit_room();
        } else {
            properties.current_room = root.target_room;
            distance += 3;
            confidence = FlowPredictionConfidence::Alternative;
        }
        if (root.source_room)
            run_future_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::AfterLeave:
        properties.current_room = root.target_room;
        if (root.source_room)
            run_active_stage(*root.source_room,
                             core::compiled::RoomLifecyclePredictionStage::AfterLeave);
        run_future_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::AfterEnter:
        properties.current_room = root.target_room;
        run_active_stage(root.target_room,
                         core::compiled::RoomLifecyclePredictionStage::AfterEnter);
        break;
    case core::RoomTransitionStage::RejectionProgram:
    case core::RoomTransitionStage::Complete:
        // Rejection programs are executable runtime behavior but are intentionally absent from the
        // successful Room lifecycle prediction index. Do not invent a second walker here.
        break;
    }
    return result;
}

} // namespace noveltea::runtime
