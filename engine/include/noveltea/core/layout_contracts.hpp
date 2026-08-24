#pragma once

#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/runtime_value.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

struct PersistableValue {
    using Array = std::vector<PersistableValue>;
    using Object = std::vector<std::pair<std::string, PersistableValue>>;
    using Value =
        std::variant<std::monostate, bool, std::int64_t, double, std::string, Array, Object>;

    Value value;
    bool operator==(const PersistableValue&) const = default;
};

enum class LayoutStateShapeType : std::uint8_t {
    Boolean,
    Integer,
    Number,
    String,
    Array,
    Object,
};

struct LayoutStateShape;

struct LayoutStateObjectField {
    std::string id;
    bool required = true;
    std::vector<LayoutStateShape> shape;
    bool operator==(const LayoutStateObjectField&) const = default;
};

struct LayoutStateShape {
    LayoutStateShapeType type = LayoutStateShapeType::Object;
    bool nullable = false;
    std::optional<PersistableValue> default_value;
    std::vector<LayoutStateShape> items;
    std::vector<LayoutStateObjectField> fields;
    bool operator==(const LayoutStateShape&) const = default;
};

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
    std::optional<LayoutStateShape> state;
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

using LayoutInputSource = std::variant<LayoutLiteralInput, LayoutVariableBinding,
                                       LayoutPropertyBinding, LayoutStandardFacetBinding>;

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

[[nodiscard]] inline bool persistable_value_matches(const LayoutStateShape& shape,
                                                    const PersistableValue& value) noexcept
{
    if (std::holds_alternative<std::monostate>(value.value))
        return shape.nullable;
    switch (shape.type) {
    case LayoutStateShapeType::Boolean:
        return std::holds_alternative<bool>(value.value);
    case LayoutStateShapeType::Integer:
        return std::holds_alternative<std::int64_t>(value.value);
    case LayoutStateShapeType::Number:
        if (const auto* number = std::get_if<double>(&value.value))
            return std::isfinite(*number);
        return std::holds_alternative<std::int64_t>(value.value);
    case LayoutStateShapeType::String:
        return std::holds_alternative<std::string>(value.value);
    case LayoutStateShapeType::Array: {
        const auto* array = std::get_if<PersistableValue::Array>(&value.value);
        if (!array || shape.items.size() != 1)
            return false;
        for (const auto& item : *array) {
            if (!persistable_value_matches(shape.items.front(), item))
                return false;
        }
        return true;
    }
    case LayoutStateShapeType::Object: {
        const auto* object = std::get_if<PersistableValue::Object>(&value.value);
        if (!object)
            return false;
        for (std::size_t index = 0; index < object->size(); ++index) {
            const auto& [name, member] = (*object)[index];
            if (name.empty())
                return false;
            for (std::size_t other = index + 1; other < object->size(); ++other) {
                if ((*object)[other].first == name)
                    return false;
            }
            const auto field =
                std::find_if(shape.fields.begin(), shape.fields.end(), [&](const auto& candidate) {
                    return candidate.id == name && candidate.shape.size() == 1;
                });
            if (field == shape.fields.end() ||
                !persistable_value_matches(field->shape.front(), member))
                return false;
        }
        for (const auto& field : shape.fields) {
            if (!field.required)
                continue;
            const auto present =
                std::find_if(object->begin(), object->end(),
                             [&](const auto& member) { return member.first == field.id; });
            if (present == object->end())
                return false;
        }
        return true;
    }
    }
    return false;
}

[[nodiscard]] inline bool layout_state_shape_valid(const LayoutStateShape& shape) noexcept
{
    if (shape.default_value && !persistable_value_matches(shape, *shape.default_value))
        return false;
    if (shape.type == LayoutStateShapeType::Array) {
        return shape.fields.empty() && shape.items.size() == 1 &&
               layout_state_shape_valid(shape.items.front());
    }
    if (shape.type == LayoutStateShapeType::Object) {
        if (!shape.items.empty())
            return false;
        for (std::size_t index = 0; index < shape.fields.size(); ++index) {
            if (shape.fields[index].id.empty() || shape.fields[index].shape.size() != 1 ||
                !layout_state_shape_valid(shape.fields[index].shape.front()))
                return false;
            for (std::size_t other = index + 1; other < shape.fields.size(); ++other) {
                if (shape.fields[index].id == shape.fields[other].id)
                    return false;
            }
        }
        return true;
    }
    return shape.items.empty() && shape.fields.empty();
}

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
