#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/runtime_capability_types.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::runtime {

enum class RuntimePresentationOwnerScope : std::uint8_t {
    Scene,
    Session,
    CurrentRoom,
    Room,
};

class RuntimeCommandGatewayServices {
public:
    virtual ~RuntimeCommandGatewayServices() = default;

    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode, bool visible,
                std::optional<core::MapLocationId> focused_location) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics> hide_map() = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    select_map_location(core::MapLocationId location) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    activate_map_connection(core::MapConnectionId connection) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop,
                  double volume, bool await_completion, core::AudioOperationPurpose purpose) = 0;
    [[nodiscard]] virtual const core::TypedRuntimeUIViewState& current_view() const noexcept = 0;
    virtual void queue_input(core::RuntimeInputMessage input) = 0;
};

class RuntimeCommandGateway final {
public:
    RuntimeCommandGateway(const core::CompiledProject& project, core::SessionState& state,
                          CapabilityGeneration generation) noexcept;

    RuntimeCommandGateway(const RuntimeCommandGateway&) = delete;
    RuntimeCommandGateway& operator=(const RuntimeCommandGateway&) = delete;

    void bind_services(RuntimeCommandGatewayServices* services) noexcept { m_services = services; }
    void invalidate() noexcept { m_active = false; }
    [[nodiscard]] bool active(CapabilityGeneration generation) const noexcept
    {
        return m_active && generation == m_generation;
    }
    [[nodiscard]] CapabilityGeneration generation() const noexcept { return m_generation; }
    [[nodiscard]] RuntimeSourceContext current_source_context() const { return source_context(); }

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
    [[nodiscard]] core::Result<core::InteractableState, core::Diagnostics>
    interactable_state(const core::InteractableId& interactable) const;
    [[nodiscard]] core::Result<core::CharacterWorldState, core::Diagnostics>
    character_world_state(const core::CharacterId& character) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_interactable_location(core::InteractableId interactable,
                                  core::compiled::InteractableLocation target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_interactable_state(core::InteractableId interactable,
                               std::optional<core::compiled::InteractableLocation> location,
                               std::optional<bool> enabled, std::optional<bool> visible);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_character_world_state(core::CharacterId character,
                                  std::optional<core::CharacterWorldLocation> location,
                                  std::optional<bool> enabled, std::optional<bool> visible);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_navigation(core::compiled::RoomExitRef exit);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_transient(core::SceneId scene);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_transient(core::DialogueId dialogue);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_child(core::SceneId scene);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_child(core::DialogueId dialogue,
                  std::optional<core::DialogueBlockId> start_block = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_tail_replacement(core::FlowTarget target);
    [[nodiscard]] core::Result<void, core::Diagnostics> request_notification(std::string message);

    [[nodiscard]] core::Result<void, core::Diagnostics> seed_random(std::uint64_t seed);
    [[nodiscard]] core::Result<std::int64_t, core::Diagnostics>
    random_integer(std::int64_t minimum, std::int64_t maximum);
    [[nodiscard]] core::Result<double, core::Diagnostics> random_unit();

    [[nodiscard]] core::Result<void, core::Diagnostics>
    present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode, bool visible,
                std::optional<core::MapLocationId> focused_location);
    [[nodiscard]] core::Result<void, core::Diagnostics> hide_map();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_map_location(core::MapLocationId location);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    activate_map_connection(core::MapConnectionId connection);
    [[nodiscard]] core::Result<core::MapPresentationState, core::Diagnostics> map_state() const;

    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_background_override(core::DesiredBackgroundOverride value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_background_override(core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredBackgroundOverride>, core::Diagnostics>
    background_override(const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_actor_presentation(core::DesiredActorPresentation value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_actor_presentation(core::ActorPresentationKey key, core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredActorPresentation>, core::Diagnostics>
    actor_presentation(const core::ActorPresentationKey& key,
                       const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_presentation_prop(core::DesiredPresentationProp value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_presentation_prop(core::PresentationPropInstanceId instance,
                             core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredPresentationProp>, core::Diagnostics>
    presentation_prop(const core::PresentationPropInstanceId& instance,
                      const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_presentation_environment(core::DesiredPresentationEnvironment value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_presentation_environment(core::PresentationEnvironmentInstanceId instance,
                                    core::PresentationOwner owner);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_presentation_environments(core::PresentationEnvironmentStopKey stop_key,
                                     core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredPresentationEnvironment>,
                               core::Diagnostics>
    presentation_environment(const core::PresentationEnvironmentInstanceId& instance,
                             const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_desired_audio(core::DesiredAudioInstance value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_desired_audio(core::DesiredAudioInstanceId instance, core::PresentationOwner owner);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_desired_audio_bus(core::compiled::AudioChannel bus, core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>
    desired_audio(const core::DesiredAudioInstanceId& instance,
                  const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<core::PresentationOwner, core::Diagnostics>
    presentation_owner(RuntimePresentationOwnerScope scope,
                       std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_mounted_layout(core::DesiredMountedLayout value,
                          std::optional<LayoutFadeRequest> entrance = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_mounted_layout(core::MountedLayoutPresentationKey key, core::PresentationOwner owner,
                          std::optional<LayoutFadeRequest> exit = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>
    mounted_layout(const core::MountedLayoutPresentationKey& key,
                   const core::PresentationOwner& owner) const;

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
                  double volume, bool await_completion,
                  core::AudioOperationPurpose purpose = core::AudioOperationPurpose::Gameplay);
    [[nodiscard]] core::Result<void, core::Diagnostics> append_text_log(core::TextLogEntry entry);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_text_log();

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

    void request_autosave_safe_point();

    [[nodiscard]] DeferredRuntimeCommandQueue& command_queue() noexcept { return m_commands; }
    [[nodiscard]] const DeferredRuntimeCommandQueue& command_queue() const noexcept
    {
        return m_commands;
    }
    [[nodiscard]] std::vector<RuntimeEvent> take_events() noexcept;
    [[nodiscard]] const std::vector<RuntimeEvent>& events() const noexcept { return m_events; }
    [[nodiscard]] MutationImpactJournal take_mutation_impacts() noexcept;
    [[nodiscard]] bool has_frame_sensitive_command() const noexcept;
    void clear_transient_state() noexcept;

private:
    [[nodiscard]] core::Result<void, core::Diagnostics>
    require_services(std::string operation) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    require_room_mode(std::string operation) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    require_flow_mode(std::string operation) const;
    [[nodiscard]] RuntimeSourceContext source_context() const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    enqueue(DeferredRuntimeCommandPayload payload);
    void record_structural_mutation() noexcept;

    const core::CompiledProject& m_project;
    core::SessionState& m_state;
    RuntimeCommandGatewayServices* m_services = nullptr;
    DeferredRuntimeCommandQueue m_commands;
    std::vector<RuntimeEvent> m_events;
    MutationImpactJournal m_mutations;
    CapabilityGeneration m_generation;
    bool m_active = true;
};

} // namespace noveltea::runtime
