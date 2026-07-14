#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/script_host_services.hpp"

#include <memory>
#include <string>

namespace noveltea::script {

class RuntimeScriptApiTarget {
public:
    virtual ~RuntimeScriptApiTarget() = default;

    [[nodiscard]] virtual core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    script_definition(core::ProjectDefinitionKind kind, std::string id) const = 0;
    [[nodiscard]] virtual core::Result<core::RuntimeValue, core::Diagnostics>
    script_variable(const core::VariableId& id) const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_set_variable(const core::VariableId& id, core::RuntimeValue value) = 0;
    [[nodiscard]] virtual core::Result<core::PropertyLookupResult, core::Diagnostics>
    script_property(const core::PropertyOwnerRef& owner,
                    const core::PropertyId& property) const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_set_property(core::PropertyOwnerRef owner, core::PropertyId property,
                        core::RuntimeValue value) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_unset_property(const core::PropertyOwnerRef& owner,
                          const core::PropertyId& property) = 0;
    [[nodiscard]] virtual core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    script_interactable_location(const core::InteractableId& interactable) const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_interactable_location(core::InteractableId interactable,
                                         core::compiled::InteractableLocation target) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_navigation(core::compiled::RoomExitRef exit) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_transient(core::SceneId scene) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_transient(core::DialogueId dialogue) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_child(core::SceneId scene) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_child(core::DialogueId dialogue) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_tail_replacement(core::FlowTarget target) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_notification(std::string message) = 0;
    [[nodiscard]] virtual const core::TypedRuntimeUIViewState& script_view() const noexcept = 0;
    virtual void queue_script_input(core::RuntimeInputMessage input) = 0;
};

class RuntimeScriptApi {
public:
    RuntimeScriptApi();
    ~RuntimeScriptApi();

    RuntimeScriptApi(const RuntimeScriptApi&) = delete;
    RuntimeScriptApi& operator=(const RuntimeScriptApi&) = delete;

    void replace_target(RuntimeScriptApiTarget* target) noexcept;
    void clear_target() noexcept;
    [[nodiscard]] bool available() const noexcept;

    [[nodiscard]] core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    definition(core::ProjectDefinitionKind kind, std::string id) const;
    [[nodiscard]] core::Result<core::RuntimeValue, core::Diagnostics>
    variable(const core::VariableId& id) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> set_variable(const core::VariableId& id,
                                                                     core::RuntimeValue value);
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    property(const core::PropertyOwnerRef& owner, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_property(core::PropertyOwnerRef owner, core::PropertyId property, core::RuntimeValue value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    unset_property(const core::PropertyOwnerRef& owner, const core::PropertyId& property);
    [[nodiscard]] core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    interactable_location(const core::InteractableId& interactable) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_interactable_location(core::InteractableId interactable,
                                  core::compiled::InteractableLocation target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_navigation(core::compiled::RoomExitRef exit);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_transient(core::SceneId scene);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_transient(core::DialogueId dialogue);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_child(core::SceneId scene);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_child(core::DialogueId dialogue);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_tail_replacement(core::FlowTarget target);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_notification(std::string message);

    [[nodiscard]] core::Result<void, core::Diagnostics> continue_game();
    [[nodiscard]] core::Result<void, core::Diagnostics> choose(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics> navigate(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_interactable(core::InteractableId interactable);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_selection();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    run_interaction(core::VerbId verb, std::vector<core::InteractableId> operands);
    [[nodiscard]] core::Result<void, core::Diagnostics> save(core::TypedSaveSlotId slot);
    [[nodiscard]] core::Result<void, core::Diagnostics> load(core::TypedSaveSlotId slot);
    [[nodiscard]] core::Result<void, core::Diagnostics> autosave();

private:
    struct State;
    std::shared_ptr<State> m_state;
};

} // namespace noveltea::script
