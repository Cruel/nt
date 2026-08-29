#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/gameplay_references.hpp"
#include "noveltea/core/runtime_value.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class ValueComparisonOperator : std::uint8_t {
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual
};
enum class TruthinessOperator : std::uint8_t {
    Truthy,
    Falsy
};
struct GlobalPropertyValueComparison {
    PropertyId property_id;
    ValueComparisonOperator operation;
    RuntimeValue value;
};
struct GlobalPropertyTruthiness {
    PropertyId property_id;
    TruthinessOperator operation;
};
using GlobalPropertyComparison =
    std::variant<GlobalPropertyValueComparison, GlobalPropertyTruthiness>;
struct Always {};
struct LuaPredicate {
    std::string source;
};

struct InteractablePropertyMatch {
    PropertyId property_id;
    RuntimeValue value;
    bool operator==(const InteractablePropertyMatch&) const = default;
};
struct ConditionInteractableMatcher {
    std::optional<InteractableDefinitionId> definition;
    std::vector<TraitId> traits;
    std::vector<InteractablePropertyMatch> properties;
    std::optional<InteractableOperand> exact;
    bool operator==(const ConditionInteractableMatcher&) const = default;
};

struct IdentityPropertyValueComparison {
    GameplayIdentityOperand owner;
    PropertyId property_id;
    ValueComparisonOperator operation;
    RuntimeValue value;
};
struct IdentityPropertyTruthiness {
    GameplayIdentityOperand owner;
    PropertyId property_id;
    TruthinessOperator operation;
};
using IdentityPropertyComparison =
    std::variant<IdentityPropertyValueComparison, IdentityPropertyTruthiness>;
struct TraitPresenceCondition {
    GameplayIdentityOperand owner;
    TraitId trait;
    bool present = true;
};
enum class EqualityComparisonOperator : std::uint8_t {
    Equal,
    NotEqual
};
struct LocationComparisonCondition {
    LocationSubjectOperand subject;
    EqualityComparisonOperator operation = EqualityComparisonOperator::Equal;
    LocationOperand location;
};
struct InventoryQuantityComparisonCondition {
    InventoryOperand inventory;
    ConditionInteractableMatcher matcher;
    ValueComparisonOperator operation = ValueComparisonOperator::Equal;
    std::uint64_t quantity = 0;
};

struct Condition;
struct AllCondition {
    std::vector<Condition> conditions;
};
struct AnyCondition {
    std::vector<Condition> conditions;
};
struct NotCondition {
    std::vector<Condition> condition;
};

struct Condition {
    using Value = std::variant<Always, AllCondition, AnyCondition, NotCondition,
                               GlobalPropertyComparison, IdentityPropertyComparison,
                               TraitPresenceCondition, LocationComparisonCondition,
                               InventoryQuantityComparisonCondition, LuaPredicate>;

    Condition() : value(Always{}) {}
    template<class T> Condition(T item) : value(std::move(item)) {}

    Value value;
};

struct SetGlobalProperty {
    PropertyId property_id;
    RuntimeValue value;
};
struct RunLuaEffect {
    std::string source;
};
using Effect = std::variant<SetGlobalProperty, RunLuaEffect>;

struct ReturnFlow {};
struct EndFlow {};
using FlowTarget = std::variant<SceneId, DialogueId, RoomId, ReturnFlow, EndFlow>;

} // namespace noveltea::core
