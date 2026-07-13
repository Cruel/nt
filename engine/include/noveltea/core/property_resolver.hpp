#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/session_state.hpp"

namespace noveltea::core {

class PropertyResolver {
public:
    PropertyResolver(const CompiledProject& project, SessionState& state) noexcept
        : m_project(project), m_state(state)
    {
    }

    [[nodiscard]] Result<PropertyLookupResult, Diagnostics> get(const PropertyOwnerRef& owner,
                                                                const PropertyId& property) const;
    [[nodiscard]] Result<void, Diagnostics> set(PropertyOwnerRef owner, const PropertyId& property,
                                                RuntimeValue value);
    [[nodiscard]] Result<void, Diagnostics> unset(const PropertyOwnerRef& owner,
                                                  const PropertyId& property);

private:
    [[nodiscard]] Result<const PropertyDefinition*, Diagnostics>
    validate(const PropertyOwnerRef& owner, const PropertyId& property) const;
    [[nodiscard]] bool owner_exists(const PropertyOwnerRef& owner) const noexcept;

    const CompiledProject& m_project;
    SessionState& m_state;
};

} // namespace noveltea::core
