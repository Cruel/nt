#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/runtime_value.hpp"

#include <cstdint>
#include <string>
#include <variant>

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
using Condition = std::variant<Always, GlobalPropertyComparison, LuaPredicate>;

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
