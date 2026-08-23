#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/runtime_value.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class LayoutContractValueType : std::uint8_t {
    Boolean,
    Integer,
    Number,
    String,
};

struct LayoutContractValueShape {
    LayoutContractValueType type = LayoutContractValueType::String;
    bool nullable = false;
    auto operator<=>(const LayoutContractValueShape&) const = default;
};

struct LayoutInputDefinition {
    LayoutInputId id;
    LayoutContractValueShape shape;
    std::optional<RuntimeValue> default_value;
    bool operator==(const LayoutInputDefinition&) const = default;
};

struct LayoutSignalFieldDefinition {
    LayoutSignalFieldId id;
    LayoutContractValueShape shape;
    bool required = true;
    bool operator==(const LayoutSignalFieldDefinition&) const = default;
};

struct LayoutSignalDefinition {
    LayoutSignalId id;
    std::vector<LayoutSignalFieldDefinition> fields;
    bool operator==(const LayoutSignalDefinition&) const = default;
};

struct LayoutContract {
    std::vector<LayoutInputDefinition> inputs;
    std::vector<LayoutSignalDefinition> signals;
    bool operator==(const LayoutContract&) const = default;
};

enum class LayoutStandardFacet : std::uint8_t {
    RuntimeMode,
    CurrentRoom,
    GameplayPaused,
};

struct LayoutLiteralInput {
    RuntimeValue value;
    bool operator==(const LayoutLiteralInput&) const = default;
};

struct LayoutVariableBinding {
    PropertyId variable;
    bool operator==(const LayoutVariableBinding&) const = default;
};

struct LayoutPropertyBinding {
    PropertyTargetRef target;
    PropertyId property;
    bool operator==(const LayoutPropertyBinding&) const = default;
};

struct LayoutStandardFacetBinding {
    LayoutStandardFacet facet = LayoutStandardFacet::RuntimeMode;
    auto operator<=>(const LayoutStandardFacetBinding&) const = default;
};

using LayoutInputSource =
    std::variant<LayoutLiteralInput, LayoutVariableBinding, LayoutPropertyBinding,
                 LayoutStandardFacetBinding>;

struct LayoutInputAssignment {
    LayoutInputId input;
    LayoutInputSource source;
    bool operator==(const LayoutInputAssignment&) const = default;
};

struct LayoutResolvedInput {
    LayoutInputId input;
    RuntimeValue value;
    bool operator==(const LayoutResolvedInput&) const = default;
};

struct LayoutSignalFieldValue {
    LayoutSignalFieldId field;
    RuntimeValue value;
    bool operator==(const LayoutSignalFieldValue&) const = default;
};

[[nodiscard]] inline bool layout_contract_value_matches(const LayoutContractValueShape& shape,
                                                        const RuntimeValue& value) noexcept
{
    if (std::holds_alternative<std::monostate>(value))
        return shape.nullable;
    switch (shape.type) {
    case LayoutContractValueType::Boolean:
        return std::holds_alternative<bool>(value);
    case LayoutContractValueType::Integer:
        return std::holds_alternative<std::int64_t>(value);
    case LayoutContractValueType::Number:
        return std::holds_alternative<std::int64_t>(value) || std::holds_alternative<double>(value);
    case LayoutContractValueType::String:
        return std::holds_alternative<std::string>(value);
    }
    return false;
}

} // namespace noveltea::core
