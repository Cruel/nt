#pragma once

#include "noveltea/core/runtime_capability_types.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace noveltea::script {

class RuntimeScriptApi {
public:
    RuntimeScriptApi();
    ~RuntimeScriptApi();

    RuntimeScriptApi(const RuntimeScriptApi&) = delete;
    RuntimeScriptApi& operator=(const RuntimeScriptApi&) = delete;

    void replace_capabilities(runtime::RuntimeCapabilitySet capabilities) noexcept;
    void clear_capabilities() noexcept;
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
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_composed_character_visible(core::CharacterId character, bool visible);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_composed_interactable_visible(core::InteractableId interactable, bool visible);

    [[nodiscard]] core::Result<void, core::Diagnostics> continue_game();
    [[nodiscard]] core::Result<void, core::Diagnostics> choose(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics> navigate(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_interactable(core::InteractableId interactable);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_selection();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    run_interaction(core::VerbId verb, std::vector<core::compiled::InteractionSubject> operands);
    [[nodiscard]] core::Result<void, core::Diagnostics> save(core::TypedSaveSlotId slot);
    [[nodiscard]] core::Result<void, core::Diagnostics> load(core::TypedSaveSlotId slot);
    [[nodiscard]] core::Result<void, core::Diagnostics> autosave();

private:
    struct State;
    std::shared_ptr<State> m_state;
};

} // namespace noveltea::script
