#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <variant>

namespace noveltea::core {

using RuntimeValue = std::variant<std::monostate, bool, std::int64_t, double, std::string>;

enum class RuntimeValueType {
    Null,
    Boolean,
    Integer,
    Number,
    String,
};

[[nodiscard]] constexpr RuntimeValueType runtime_value_type(const RuntimeValue& value) noexcept
{
    switch (value.index()) {
    case 0:
        return RuntimeValueType::Null;
    case 1:
        return RuntimeValueType::Boolean;
    case 2:
        return RuntimeValueType::Integer;
    case 3:
        return RuntimeValueType::Number;
    case 4:
        return RuntimeValueType::String;
    default:
        return RuntimeValueType::Null;
    }
}

[[nodiscard]] constexpr std::string_view runtime_value_type_name(RuntimeValueType type) noexcept
{
    switch (type) {
    case RuntimeValueType::Null:
        return "null";
    case RuntimeValueType::Boolean:
        return "boolean";
    case RuntimeValueType::Integer:
        return "integer";
    case RuntimeValueType::Number:
        return "number";
    case RuntimeValueType::String:
        return "string";
    }
    return "null";
}

} // namespace noveltea::core
