#pragma once

#include "noveltea/runtime/runtime_query_provider.hpp"

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/property_resolver.hpp"
#include "noveltea/core/runtime_capability_types.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_commands.hpp"
#include "noveltea/runtime/runtime_contracts.hpp"
#include "noveltea/runtime/runtime_world.hpp"

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
    request_audio(core::compiled::AudioAction action, core::compiled::AudioPurpose purpose,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, double gain,
                  double pan, bool await_completion, core::compiled::AudioCausality causality,
                  core::compiled::AudioPausePolicy pause_policy,
                  core::compiled::AudioSkipBehavior skip_behavior) = 0;
    [[nodiscard]] virtual const core::TypedRuntimeUIViewState& current_view() const noexcept = 0;
    virtual void queue_input(core::RuntimeInputMessage input) = 0;
};

class RuntimeCommandGateway final : public RuntimeQueryProvider {
public:
    RuntimeCommandGateway(const core::CompiledProject& project, core::SessionState& state,
                          RuntimeWorld& world, CapabilityGeneration generation) noexcept;

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
    global_property(const core::PropertyId& id) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_global_property(const core::PropertyId& id, core::RuntimeValue value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    unset_global_property(const core::PropertyId& id);
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    property(const core::PropertyOwnerRef& owner, const core::PropertyId& property) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_property(core::PropertyOwnerRef owner, core::PropertyId property, core::RuntimeValue value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    unset_property(const core::PropertyOwnerRef& owner, const core::PropertyId& property);

    [[nodiscard]] core::Result<core::RoomId, core::Diagnostics>
    create_room(RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<core::CharacterId, core::Diagnostics>
    create_character(RuntimeInstanceConfigurationRequest source,
                     core::CharacterWorldLocation location = core::compiled::UnplacedLocation{},
                     bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<core::InteractableId, core::Diagnostics> create_interactable(
        RuntimeInstanceConfigurationRequest source,
        core::compiled::InteractableLocation location = core::compiled::UnplacedLocation{},
        bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<core::ItemStackState, core::Diagnostics>
    item_stack(const core::ItemStackId& id) const;
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    split_item_stack(core::ItemStackId source, std::uint64_t quantity);
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    merge_item_stacks(core::ItemStackId receiver, core::ItemStackId donor);
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    transfer_item_quantity(core::ItemStackId source, std::uint64_t quantity,
                           core::compiled::ItemStackLocation location,
                           ItemStackPlacementPolicy policy = ItemStackPlacementPolicy::Coalesce);
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    grant_item_quantity(core::ItemDefinitionId definition, std::uint64_t quantity,
                        core::compiled::ItemStackLocation location,
                        ItemStackPlacementPolicy policy = ItemStackPlacementPolicy::Coalesce);
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    consume_item_quantity(core::ItemStackId stack, std::uint64_t quantity);
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    consume_item_quantity(ItemStackFilter filter, std::uint64_t quantity);
    [[nodiscard]] core::Result<std::uint64_t, core::Diagnostics>
    aggregate_item_quantity(const ItemStackFilter& filter) const;
    [[nodiscard]] core::Result<ItemStackMutation, core::Diagnostics>
    set_item_stack_traits(core::ItemStackId stack, std::vector<core::TraitId> traits);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_instance_configuration(core::GameplayInstanceRef instance,
                                   RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_instance_configuration(core::GameplayInstanceRef instance);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    retarget_room_exit(core::RoomId room, core::RoomExitId exit, core::RoomId target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    destroy_instance(core::GameplayInstanceRef instance);
    [[nodiscard]] core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>
    instance_provenance(const core::GameplayInstanceRef& instance) const;

    [[nodiscard]] core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    interactable_location(const core::InteractableId& interactable) const;
    [[nodiscard]] core::Result<core::InteractableState, core::Diagnostics>
    interactable_state(const core::InteractableId& interactable) const;
    [[nodiscard]] core::Result<core::CharacterWorldLocation, core::Diagnostics>
    character_location(const core::CharacterId& character) const;
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
    request_detached(core::SceneId scene, std::vector<core::compiled::SceneInputBinding> inputs,
                     core::compiled::DetachedSceneOwner owner);
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
    activate_map_connection(core::MapId map, core::MapConnectionId connection);

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
    upsert_material_parameter(core::DesiredMaterialParameter value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_material_parameter(core::MaterialOccurrence occurrence, core::PresentationOwner owner,
                              core::MaterialId material, std::string parameter);
    [[nodiscard]] core::Result<std::optional<core::DesiredMaterialParameter>, core::Diagnostics>
    material_parameter(const core::MaterialOccurrence& occurrence,
                       const core::PresentationOwner& owner, const core::MaterialId& material,
                       std::string_view parameter) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_postprocess_effect(core::DesiredPostprocessEffect value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_postprocess_effect(core::PostprocessEffectInstanceId instance,
                              core::PresentationOwner owner);
    [[nodiscard]] core::Result<std::optional<core::DesiredPostprocessEffect>, core::Diagnostics>
    postprocess_effect(const core::PostprocessEffectInstanceId& instance,
                       const core::PresentationOwner& owner) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    upsert_desired_audio(core::DesiredAudioInstance value);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_desired_audio(core::DesiredAudioInstanceId instance, core::PresentationOwner owner);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    remove_desired_audio_purpose(core::compiled::AudioPurpose purpose,
                                 core::PresentationOwner owner);
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

    [[nodiscard]] core::Result<void, core::Diagnostics> request_audio(
        core::compiled::AudioAction action, core::compiled::AudioPurpose purpose,
        std::optional<core::AssetId> asset, std::chrono::milliseconds fade, double gain, double pan,
        bool await_completion,
        core::compiled::AudioCausality causality = core::compiled::AudioCausality::Causal,
        core::compiled::AudioPausePolicy pause_policy = core::compiled::AudioPausePolicy::Gameplay,
        core::compiled::AudioSkipBehavior skip_behavior =
            core::compiled::AudioSkipBehavior::Suppress);
    [[nodiscard]] core::Result<void, core::Diagnostics> append_text_log(core::TextLogEntry entry);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_text_log();

    [[nodiscard]] core::Result<void, core::Diagnostics> continue_game();
    [[nodiscard]] core::Result<void, core::Diagnostics> choose(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics> navigate(std::size_t zero_based_index);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    select_interactable(core::InteractableId interactable);
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_selection();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    run_interaction(core::VerbId verb, std::vector<core::InteractionSubjectBinding> bindings);
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
    void merge_mutation_impacts(const MutationImpactJournal& impacts) noexcept
    {
        m_mutations.merge(impacts);
    }
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
    RuntimeWorld& m_world;
    RuntimeCommandGatewayServices* m_services = nullptr;
    DeferredRuntimeCommandQueue m_commands;
    std::vector<RuntimeEvent> m_events;
    MutationImpactJournal m_mutations;
    CapabilityGeneration m_generation;
    bool m_active = true;
};

} // namespace noveltea::runtime
