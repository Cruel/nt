#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/wait.hpp"

#include <cstddef>
#include <optional>
#include <unordered_map>
#include <variant>
#include <vector>

namespace noveltea::core {

struct RoomMode {
    RoomId room;
};
struct FlowMode {};
struct EndedMode {};
using RuntimeMode = std::variant<RoomMode, FlowMode, EndedMode>;

// Phase 6A state is intentionally limited to execution-kernel state. Feature state and persistence
// are added by their owning phases rather than mirrored from the transitional GameSession.
class SessionState {
public:
    SessionState() = delete;

    [[nodiscard]] static Result<SessionState, Diagnostics> create(const CompiledProject& project);

    [[nodiscard]] const RuntimeMode& mode() const noexcept { return m_mode; }
    void set_mode(RuntimeMode mode) { m_mode = std::move(mode); }

    [[nodiscard]] Result<RuntimeValue, Diagnostics> variable(const CompiledProject& project,
                                                             const VariableId& id) const;
    [[nodiscard]] Result<void, Diagnostics> set_variable(const CompiledProject& project,
                                                         const VariableId& id, RuntimeValue value);

    [[nodiscard]] const RuntimeValue* property_override(const PropertyOwnerRef& owner,
                                                        const PropertyId& property) const noexcept;
    [[nodiscard]] std::size_t property_override_count() const noexcept
    {
        return m_property_overrides.size();
    }

    [[nodiscard]] const std::optional<ActiveWait>& active_wait() const noexcept
    {
        return m_active_wait;
    }
    void set_active_wait(ActiveWait wait) { m_active_wait = std::move(wait); }
    void clear_active_wait() noexcept { m_active_wait.reset(); }

private:
    friend class PropertyResolver;

    SessionState(RuntimeMode mode, std::unordered_map<VariableId, RuntimeValue> variables)
        : m_mode(std::move(mode)), m_variables(std::move(variables))
    {
    }

    void store_property_override(PropertyOverride value);
    void erase_property_override(const PropertyOwnerRef& owner,
                                 const PropertyId& property) noexcept;

    RuntimeMode m_mode;
    std::unordered_map<VariableId, RuntimeValue> m_variables;
    std::vector<PropertyOverride> m_property_overrides;
    std::optional<ActiveWait> m_active_wait;
};

} // namespace noveltea::core
