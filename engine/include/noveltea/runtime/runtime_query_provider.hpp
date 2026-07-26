#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_capability_types.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_identity.hpp"

#include <string>

namespace noveltea::runtime {

class RuntimeQueryProvider {
public:
    virtual ~RuntimeQueryProvider() = default;
    virtual void close() noexcept {}

    [[nodiscard]] virtual bool active(CapabilityGeneration generation) const noexcept = 0;
    [[nodiscard]] virtual core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    definition(core::ProjectDefinitionKind kind, std::string id) const = 0;
    [[nodiscard]] virtual core::Result<core::RuntimeValue, core::Diagnostics>
    variable(const core::VariableId& id) const = 0;
    [[nodiscard]] virtual core::Result<core::PropertyLookupResult, core::Diagnostics>
    property(const core::PropertyOwnerRef& owner, const core::PropertyId& property) const = 0;
    [[nodiscard]] virtual core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    interactable_location(const core::InteractableId& interactable) const = 0;
};

} // namespace noveltea::runtime
