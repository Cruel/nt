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
struct VariableValueComparison {
    VariableId variable_id;
    ValueComparisonOperator operation;
    RuntimeValue value;
};
struct VariableTruthiness {
    VariableId variable_id;
    TruthinessOperator operation;
};
using VariableComparison = std::variant<VariableValueComparison, VariableTruthiness>;
struct Always {};
struct LuaPredicate {
    std::string source;
};
using Condition = std::variant<Always, VariableComparison, LuaPredicate>;

struct SetVariable {
    VariableId variable_id;
    RuntimeValue value;
};
struct RunLuaEffect {
    std::string source;
};
using Effect = std::variant<SetVariable, RunLuaEffect>;

struct ReturnFlow {};
struct EndFlow {};
using FlowTarget = std::variant<SceneId, DialogueId, RoomId, ReturnFlow, EndFlow>;

} // namespace noveltea::core
