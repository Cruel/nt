#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/domain_ids.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_value.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class PropertyPersistence : std::uint8_t {
    Session,
    Save
};

struct BooleanPropertyType {};
struct IntegerPropertyType {};
struct NumberPropertyType {};
struct StringPropertyType {};
struct EnumPropertyType {
    std::vector<std::string> values;
};
using PropertyValueType = std::variant<BooleanPropertyType, IntegerPropertyType, NumberPropertyType,
                                       StringPropertyType, EnumPropertyType>;

struct PropertyDefinitionInput {
    PropertyId id;
    PropertyValueType value_type;
    bool nullable;
    std::optional<RuntimeValue> default_value;
    std::vector<PropertyOwnerKind> allowed_owners;
    PropertyPersistence persistence;
    std::string label{};
    std::string description{};
};

class PropertyDefinition {
public:
    PropertyDefinition() = delete;
    [[nodiscard]] const PropertyId& id() const noexcept { return m_id; }
    [[nodiscard]] const PropertyValueType& value_type() const noexcept { return m_value_type; }
    [[nodiscard]] bool nullable() const noexcept { return m_nullable; }
    [[nodiscard]] const std::optional<RuntimeValue>& default_value() const noexcept
    {
        return m_default_value;
    }
    [[nodiscard]] const std::vector<PropertyOwnerKind>& allowed_owners() const noexcept
    {
        return m_allowed_owners;
    }
    [[nodiscard]] PropertyPersistence persistence() const noexcept { return m_persistence; }
    [[nodiscard]] const std::string& label() const noexcept { return m_label; }
    [[nodiscard]] const std::string& description() const noexcept { return m_description; }

private:
    friend Result<PropertyDefinition, Diagnostics>
        make_property_definition(PropertyDefinitionInput);
    explicit PropertyDefinition(PropertyDefinitionInput input)
        : m_id(std::move(input.id)), m_value_type(std::move(input.value_type)),
          m_nullable(input.nullable), m_default_value(std::move(input.default_value)),
          m_allowed_owners(std::move(input.allowed_owners)), m_persistence(input.persistence),
          m_label(std::move(input.label)), m_description(std::move(input.description))
    {
    }
    PropertyId m_id;
    PropertyValueType m_value_type;
    bool m_nullable;
    std::optional<RuntimeValue> m_default_value;
    std::vector<PropertyOwnerKind> m_allowed_owners;
    PropertyPersistence m_persistence;
    std::string m_label;
    std::string m_description;
};

class PropertyAssignment {
public:
    PropertyAssignment() = delete;
    [[nodiscard]] const PropertyId& property_id() const noexcept { return m_property_id; }
    [[nodiscard]] const RuntimeValue& value() const noexcept { return m_value; }
    [[nodiscard]] const RuntimeValue& assigned_value() const noexcept { return m_value; }

private:
    friend Result<PropertyAssignment, Diagnostics>
    make_property_assignment(PropertyOwnerKind, const PropertyDefinition&, RuntimeValue);
    PropertyAssignment(PropertyId property_id, RuntimeValue value)
        : m_property_id(std::move(property_id)), m_value(std::move(value))
    {
    }
    PropertyId m_property_id;
    RuntimeValue m_value;
};

class PropertyOverride {
public:
    PropertyOverride() = delete;
    [[nodiscard]] const PropertyOwnerRef& owner() const noexcept { return m_owner; }
    [[nodiscard]] const PropertyId& property_id() const noexcept { return m_property_id; }
    [[nodiscard]] const RuntimeValue& value() const noexcept { return m_value; }

private:
    friend Result<PropertyOverride, Diagnostics>
    make_property_override(PropertyOwnerRef, const PropertyDefinition&, RuntimeValue);
    PropertyOverride(PropertyOwnerRef owner, PropertyId property_id, RuntimeValue value)
        : m_owner(std::move(owner)), m_property_id(std::move(property_id)),
          m_value(std::move(value))
    {
    }
    PropertyOwnerRef m_owner;
    PropertyId m_property_id;
    RuntimeValue m_value;
};

struct MissingPropertyValue {
    PropertyOwnerRef owner;
    PropertyId property_id;
};
using PropertyLookupResult = std::variant<RuntimeValue, MissingPropertyValue>;

[[nodiscard]] inline PropertyOwnerKind property_owner_kind(const PropertyOwnerRef& owner) noexcept
{
    return std::visit(
        [](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return PropertyOwnerKind::Room;
            else if constexpr (std::is_same_v<T, SceneId>)
                return PropertyOwnerKind::Scene;
            else if constexpr (std::is_same_v<T, DialogueId>)
                return PropertyOwnerKind::Dialogue;
            else if constexpr (std::is_same_v<T, CharacterId>)
                return PropertyOwnerKind::Character;
            else if constexpr (std::is_same_v<T, InteractableId>)
                return PropertyOwnerKind::Interactable;
            else if constexpr (std::is_same_v<T, VerbId>)
                return PropertyOwnerKind::Verb;
            else if constexpr (std::is_same_v<T, InteractionId>)
                return PropertyOwnerKind::Interaction;
            else if constexpr (std::is_same_v<T, MapId>)
                return PropertyOwnerKind::Map;
            else
                static_assert(std::is_same_v<T, void>, "Unhandled property owner type");
        },
        owner);
}

[[nodiscard]] inline bool runtime_value_is_finite(const RuntimeValue& value) noexcept
{
    const auto* number = std::get_if<double>(&value);
    return number == nullptr || std::isfinite(*number);
}

[[nodiscard]] inline bool property_value_matches(const PropertyDefinition& definition,
                                                 const RuntimeValue& value) noexcept
{
    if (!runtime_value_is_finite(value))
        return false;
    if (std::holds_alternative<std::monostate>(value))
        return definition.nullable();
    return std::visit(
        [&value](const auto& type) {
            using T = std::decay_t<decltype(type)>;
            if constexpr (std::is_same_v<T, BooleanPropertyType>)
                return std::holds_alternative<bool>(value);
            else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                return std::holds_alternative<std::int64_t>(value);
            else if constexpr (std::is_same_v<T, NumberPropertyType>)
                return std::holds_alternative<std::int64_t>(value) ||
                       std::holds_alternative<double>(value);
            else if constexpr (std::is_same_v<T, StringPropertyType>)
                return std::holds_alternative<std::string>(value);
            else {
                const auto* string = std::get_if<std::string>(&value);
                return string != nullptr && std::find(type.values.begin(), type.values.end(),
                                                      *string) != type.values.end();
            }
        },
        definition.value_type());
}

[[nodiscard]] inline Result<PropertyDefinition, Diagnostics>
make_property_definition(PropertyDefinitionInput input)
{
    if (input.allowed_owners.empty() || input.persistence > PropertyPersistence::Save)
        return Result<PropertyDefinition, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "domain.invalid_property_definition",
                       .message = "Property requires valid persistence and an owner kind"}});
    for (const auto owner : input.allowed_owners) {
        if (owner > PropertyOwnerKind::Map)
            return Result<PropertyDefinition, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_property_definition",
                                       .message = "Property owner kind is invalid"}});
    }
    std::sort(input.allowed_owners.begin(), input.allowed_owners.end());
    if (std::adjacent_find(input.allowed_owners.begin(), input.allowed_owners.end()) !=
        input.allowed_owners.end())
        return Result<PropertyDefinition, Diagnostics>::failure(
            Diagnostics{Diagnostic{.code = "domain.invalid_property_definition",
                                   .message = "Property owner kinds must be unique"}});

    if (auto* enumeration = std::get_if<EnumPropertyType>(&input.value_type)) {
        if (enumeration->values.empty() ||
            std::any_of(enumeration->values.begin(), enumeration->values.end(),
                        [](const std::string& value) { return value.empty(); }))
            return Result<PropertyDefinition, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_property_definition",
                                       .message = "Enum values cannot be empty"}});
        auto sorted_values = enumeration->values;
        std::sort(sorted_values.begin(), sorted_values.end());
        if (std::adjacent_find(sorted_values.begin(), sorted_values.end()) != sorted_values.end())
            return Result<PropertyDefinition, Diagnostics>::failure(
                Diagnostics{Diagnostic{.code = "domain.invalid_property_definition",
                                       .message = "Enum values must be unique"}});
    }

    PropertyDefinition definition(std::move(input));
    if (definition.default_value() &&
        !property_value_matches(definition, *definition.default_value()))
        return Result<PropertyDefinition, Diagnostics>::failure(
            Diagnostics{Diagnostic{.code = "domain.invalid_property_definition",
                                   .message = "Property default is invalid"}});
    return Result<PropertyDefinition, Diagnostics>::success(std::move(definition));
}

[[nodiscard]] inline Result<PropertyAssignment, Diagnostics>
make_property_assignment(PropertyOwnerKind owner_kind, const PropertyDefinition& definition,
                         RuntimeValue value)
{
    const bool owner_allowed = std::binary_search(definition.allowed_owners().begin(),
                                                  definition.allowed_owners().end(), owner_kind);
    if (!owner_allowed || !property_value_matches(definition, value))
        return Result<PropertyAssignment, Diagnostics>::failure(Diagnostics{
            Diagnostic{.code = "domain.invalid_property_assignment",
                       .message = "Property assignment does not match its declaration"}});
    return Result<PropertyAssignment, Diagnostics>::success(
        PropertyAssignment(definition.id(), std::move(value)));
}

[[nodiscard]] inline Result<PropertyOverride, Diagnostics>
make_property_override(PropertyOwnerRef owner, const PropertyDefinition& definition,
                       RuntimeValue value)
{
    if (!std::binary_search(definition.allowed_owners().begin(), definition.allowed_owners().end(),
                            property_owner_kind(owner)) ||
        !property_value_matches(definition, value))
        return Result<PropertyOverride, Diagnostics>::failure(
            Diagnostics{Diagnostic{.code = "domain.invalid_property_override",
                                   .message = "Property override does not match its declaration"}});
    return Result<PropertyOverride, Diagnostics>::success(
        PropertyOverride(std::move(owner), definition.id(), std::move(value)));
}

} // namespace noveltea::core
