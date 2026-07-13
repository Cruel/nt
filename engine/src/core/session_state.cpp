#include "noveltea/core/session_state.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics variable_error(std::string code, const VariableId& id, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code),
                                  .message = "Variable '" + id.text() + "' " + std::move(message)}};
}

bool variable_value_matches(const compiled::VariableDefinition& definition,
                            const RuntimeValue& value) noexcept
{
    if (!runtime_value_is_finite(value) || std::holds_alternative<std::monostate>(value))
        return false;
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
                const auto* text = std::get_if<std::string>(&value);
                return text != nullptr && std::find(type.values.begin(), type.values.end(),
                                                    *text) != type.values.end();
            }
        },
        definition.value_type);
}

RuntimeMode initial_mode(const compiled::Entrypoint& entrypoint)
{
    return std::visit(
        [](const auto& id) -> RuntimeMode {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, RoomId>)
                return RoomMode{id};
            else
                return FlowMode{};
        },
        entrypoint);
}

} // namespace

Result<SessionState, Diagnostics> SessionState::create(const CompiledProject& project)
{
    std::unordered_map<VariableId, RuntimeValue> variables;
    variables.reserve(project.variables().size());
    for (const auto& declaration : project.variables()) {
        const bool inserted = variables.emplace(declaration.id, declaration.default_value).second;
        if (!inserted)
            return Result<SessionState, Diagnostics>::failure(variable_error(
                "runtime.duplicate_variable", declaration.id, "was initialized more than once"));
    }
    return Result<SessionState, Diagnostics>::success(
        SessionState(initial_mode(project.entrypoint()), std::move(variables)));
}

Result<RuntimeValue, Diagnostics> SessionState::variable(const CompiledProject& project,
                                                         const VariableId& id) const
{
    if (project.find_variable(id) == nullptr)
        return Result<RuntimeValue, Diagnostics>::failure(
            variable_error("runtime.unknown_variable", id, "is not declared"));
    const auto found = m_variables.find(id);
    if (found == m_variables.end())
        return Result<RuntimeValue, Diagnostics>::failure(
            variable_error("runtime.missing_variable", id, "has no session value"));
    return Result<RuntimeValue, Diagnostics>::success(found->second);
}

Result<void, Diagnostics> SessionState::set_variable(const CompiledProject& project,
                                                     const VariableId& id, RuntimeValue value)
{
    const auto* declaration = project.find_variable(id);
    if (declaration == nullptr)
        return Result<void, Diagnostics>::failure(
            variable_error("runtime.unknown_variable", id, "is not declared"));
    if (!variable_value_matches(*declaration, value))
        return Result<void, Diagnostics>::failure(variable_error(
            "runtime.invalid_variable_value", id, "cannot be assigned that runtime value"));

    const auto found = m_variables.find(id);
    if (found == m_variables.end())
        return Result<void, Diagnostics>::failure(
            variable_error("runtime.missing_variable", id, "has no session value"));
    found->second = std::move(value);
    return Result<void, Diagnostics>::success();
}

const RuntimeValue* SessionState::property_override(const PropertyOwnerRef& owner,
                                                    const PropertyId& property) const noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&owner, &property](const PropertyOverride& value) {
                         return value.owner() == owner && value.property_id() == property;
                     });
    return found == m_property_overrides.end() ? nullptr : &found->value();
}

void SessionState::store_property_override(PropertyOverride value)
{
    const auto found = std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                                    [&value](const PropertyOverride& current) {
                                        return current.owner() == value.owner() &&
                                               current.property_id() == value.property_id();
                                    });
    if (found == m_property_overrides.end())
        m_property_overrides.push_back(std::move(value));
    else
        *found = std::move(value);
}

void SessionState::erase_property_override(const PropertyOwnerRef& owner,
                                           const PropertyId& property) noexcept
{
    const auto found =
        std::find_if(m_property_overrides.begin(), m_property_overrides.end(),
                     [&owner, &property](const PropertyOverride& value) {
                         return value.owner() == owner && value.property_id() == property;
                     });
    if (found != m_property_overrides.end())
        m_property_overrides.erase(found);
}

} // namespace noveltea::core
