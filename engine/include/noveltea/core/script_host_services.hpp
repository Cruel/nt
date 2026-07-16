#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

enum class ProjectDefinitionKind : std::uint8_t {
    Room,
    Scene,
    Dialogue,
    Character,
    Interactable,
    Verb,
    Interaction,
    Map
};

struct ProjectDefinitionSummary {
    ProjectDefinitionKind kind;
    std::string id;
    std::optional<std::string> display_name;
};

using ScriptRuntimeAction =
    std::variant<runtime::DeferredRuntimeCommandRequest, runtime::RuntimeEvent>;

// Typed, JSON-free services exposed to Lua and the additive feature kernel. Structural commands are
// validated and staged until the owning runtime session transfers them to its deferred command
// queue at a safe execution boundary. This transitional class is removed by the capability-gateway
// cutover; it does not own command execution, external requests, or persistence.
class ScriptHostServices {
public:
    ScriptHostServices(const CompiledProject& project, SessionState& state) noexcept
        : m_project(project), m_state(state)
    {
    }

    [[nodiscard]] Result<ProjectDefinitionSummary, Diagnostics>
    definition(ProjectDefinitionKind kind, std::string id) const;
    [[nodiscard]] Result<RuntimeValue, Diagnostics> variable(const VariableId& id) const;
    [[nodiscard]] Result<void, Diagnostics> set_variable(const VariableId& id, RuntimeValue value);
    [[nodiscard]] Result<PropertyLookupResult, Diagnostics>
    property(const PropertyOwnerRef& owner, const PropertyId& property) const;
    [[nodiscard]] Result<void, Diagnostics>
    set_property(PropertyOwnerRef owner, const PropertyId& property, RuntimeValue value);
    [[nodiscard]] Result<void, Diagnostics> unset_property(const PropertyOwnerRef& owner,
                                                           const PropertyId& property);

    [[nodiscard]] Result<compiled::InteractableLocation, Diagnostics>
    interactable_location(const InteractableId& interactable) const;
    [[nodiscard]] Result<void, Diagnostics>
    request_interactable_location(InteractableId interactable,
                                  compiled::InteractableLocation target);
    [[nodiscard]] Result<void, Diagnostics> request_navigation(compiled::RoomExitRef exit);
    [[nodiscard]] Result<void, Diagnostics> request_transient(SceneId scene);
    [[nodiscard]] Result<void, Diagnostics> request_transient(DialogueId dialogue);
    [[nodiscard]] Result<void, Diagnostics> request_child(SceneId scene);
    [[nodiscard]] Result<void, Diagnostics>
    request_child(DialogueId dialogue, std::optional<DialogueBlockId> start_block = std::nullopt);
    [[nodiscard]] Result<void, Diagnostics> request_tail_replacement(FlowTarget target);
    [[nodiscard]] Result<void, Diagnostics> request_notification(std::string message);
    void request_autosave_safe_point(SceneId scene, SceneStepId step);
    void request_autosave_safe_point(DialogueId dialogue, DialogueSegmentId segment);
    void request_autosave_safe_point(DialogueId dialogue, DialogueEdgeId edge);

    [[nodiscard]] const std::vector<ScriptRuntimeAction>& actions() const noexcept
    {
        return m_actions;
    }
    [[nodiscard]] bool has_frame_sensitive_command() const noexcept;
    [[nodiscard]] std::vector<runtime::RuntimeEvent> take_events() noexcept;
    [[nodiscard]] std::vector<ScriptRuntimeAction> take_actions() noexcept;

private:
    [[nodiscard]] Result<void, Diagnostics> require_room_mode(std::string operation) const;
    [[nodiscard]] Result<void, Diagnostics> require_flow_mode(std::string operation) const;
    [[nodiscard]] runtime::RuntimeSourceContext source_context() const;
    void queue_command(runtime::DeferredRuntimeCommandPayload payload);

    const CompiledProject& m_project;
    SessionState& m_state;
    std::vector<ScriptRuntimeAction> m_actions;
};

} // namespace noveltea::core
