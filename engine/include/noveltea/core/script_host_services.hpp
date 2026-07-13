#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/session_state.hpp"

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

struct MoveInteractableRequest {
    InteractableId interactable;
    compiled::InteractableLocation target;
};

struct NavigationRequest {
    compiled::RoomExitRef exit;
    RoomId target;
};

struct StartTransientSceneRequest {
    SceneId scene;
};
struct StartTransientDialogueRequest {
    DialogueId dialogue;
};
struct CallChildSceneRequest {
    SceneId scene;
};
struct CallChildDialogueRequest {
    DialogueId dialogue;
    std::optional<DialogueBlockId> start_block;
};
struct TailReplaceFlowRequest {
    FlowTarget target;
};
struct NotificationRequest {
    std::string message;
};

using ScriptHostRequest =
    std::variant<MoveInteractableRequest, NavigationRequest, StartTransientSceneRequest,
                 StartTransientDialogueRequest, CallChildSceneRequest, CallChildDialogueRequest,
                 TailReplaceFlowRequest, NotificationRequest>;

// Typed, JSON-free services exposed to Lua running through the additive execution kernel. Requests
// are validated and queued for the owning Phase 7/9 adapters; this class does not implement feature
// frames, feature execution, persistence, or consumer cutover.
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

    [[nodiscard]] const std::vector<ScriptHostRequest>& requests() const noexcept
    {
        return m_requests;
    }
    [[nodiscard]] std::vector<ScriptHostRequest> take_requests() noexcept;

private:
    [[nodiscard]] Result<void, Diagnostics> require_room_mode(std::string operation) const;
    [[nodiscard]] Result<void, Diagnostics> require_flow_mode(std::string operation) const;

    const CompiledProject& m_project;
    SessionState& m_state;
    std::vector<ScriptHostRequest> m_requests;
};

} // namespace noveltea::core
