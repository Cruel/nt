#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/flow.hpp"
#include "noveltea/core/property.hpp"
#include "noveltea/core/result.hpp"

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

// Typed kernel state remains intentionally separate from feature state and persistence, which are
// added by their owning phases rather than mirrored from the transitional GameSession.
class SessionState {
public:
    SessionState() = delete;

    [[nodiscard]] static Result<SessionState, Diagnostics> create(const CompiledProject& project);

    [[nodiscard]] const RuntimeMode& mode() const noexcept { return m_mode; }
    [[nodiscard]] const FlowStack& flow_stack() const noexcept { return m_flow_stack; }
    [[nodiscard]] const std::optional<FlowBlocker>& blocker() const noexcept { return m_blocker; }
    [[nodiscard]] const std::optional<Diagnostics>& execution_fault() const noexcept
    {
        return m_execution_fault;
    }

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

private:
    friend class FlowExecutor;
    friend class PropertyResolver;

    SessionState(RuntimeMode mode, FlowStack flow_stack,
                 std::unordered_map<VariableId, RuntimeValue> variables,
                 std::uint64_t next_frame_id)
        : m_mode(std::move(mode)), m_flow_stack(std::move(flow_stack)),
          m_variables(std::move(variables)), m_next_frame_id(next_frame_id)
    {
    }

    void store_property_override(PropertyOverride value);
    void erase_property_override(const PropertyOwnerRef& owner,
                                 const PropertyId& property) noexcept;

    RuntimeMode m_mode;
    FlowStack m_flow_stack;
    std::optional<FlowBlocker> m_blocker;
    std::optional<Diagnostics> m_execution_fault;
    std::unordered_map<VariableId, RuntimeValue> m_variables;
    std::vector<PropertyOverride> m_property_overrides;
    std::uint64_t m_next_frame_id;
    std::uint64_t m_next_blocker_handle = 1;
    bool m_flow_running = false;
};

} // namespace noveltea::core
