#pragma once

#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/script_host_services.hpp"

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
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
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_seed_random(std::uint64_t seed) = 0;
    [[nodiscard]] virtual core::Result<std::int64_t, core::Diagnostics>
    script_random_integer(std::int64_t minimum, std::int64_t maximum) = 0;
    [[nodiscard]] virtual core::Result<double, core::Diagnostics> script_random_unit() = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode,
                       bool visible, std::optional<core::MapLocationId> focused_location) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics> script_hide_map() = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_select_map_location(core::MapLocationId location) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_activate_map_connection(core::MapConnectionId connection) = 0;
    [[nodiscard]] virtual core::Result<core::MapPresentationState, core::Diagnostics>
    script_map_state() const = 0;
    [[nodiscard]] virtual core::Result<std::optional<core::LayoutId>, core::Diagnostics>
    script_layout(core::compiled::LayoutSlot slot) const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_set_layout(core::compiled::LayoutSlot slot, core::LayoutId layout) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_clear_layout(core::compiled::LayoutSlot slot) = 0;
    [[nodiscard]] virtual core::Result<bool, core::Diagnostics> script_gameplay_paused() const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_set_gameplay_paused(bool paused) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                         std::optional<core::AssetId> asset, std::chrono::milliseconds fade,
                         bool loop, double volume, bool await_completion) = 0;
    [[nodiscard]] virtual core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
    script_audio_channel(core::compiled::AudioChannel channel) const = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    script_append_text_log(core::TextLogEntry entry) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics> script_clear_text_log() = 0;
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
    [[nodiscard]] core::Result<void, core::Diagnostics> seed_random(std::uint64_t seed);
    [[nodiscard]] core::Result<std::int64_t, core::Diagnostics>
    random_integer(std::int64_t minimum, std::int64_t maximum);
    [[nodiscard]] core::Result<double, core::Diagnostics> random_unit();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode = std::nullopt,
                bool visible = true,
                std::optional<core::MapLocationId> focused_location = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics> hide_map();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_map_location(core::MapLocationId location);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    activate_map_connection(core::MapConnectionId connection);
    [[nodiscard]] core::Result<core::MapPresentationState, core::Diagnostics> map_state() const;
    [[nodiscard]] core::Result<std::optional<core::LayoutId>, core::Diagnostics>
    layout(core::compiled::LayoutSlot slot) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> set_layout(core::compiled::LayoutSlot slot,
                                                                   core::LayoutId layout);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_layout(core::compiled::LayoutSlot slot);
    [[nodiscard]] core::Result<bool, core::Diagnostics> gameplay_paused() const;
    [[nodiscard]] core::Result<void, core::Diagnostics> set_gameplay_paused(bool paused);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop,
                  double volume, bool await_completion);
    [[nodiscard]] core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
    audio_channel(core::compiled::AudioChannel channel) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> append_text_log(core::TextLogEntry entry);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_text_log();

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
