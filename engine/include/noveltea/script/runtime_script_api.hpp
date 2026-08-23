#pragma once

#include "noveltea/core/runtime_capability_types.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/runtime/runtime_capabilities.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>

namespace noveltea::script {

struct EnvironmentLoopCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
    std::optional<core::AssetId> asset;
    core::PresentationEnvironmentStopKey stop_key;
    core::compiled::NormalizedRect bounds{0.0, 0.0, 1.0, 1.0};
    core::PresentationPlane plane = core::PresentationPlane::WorldContent;
    std::int32_t order = 0;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::compiled::Vector2 scroll_per_second{0.0, 0.0};
    double opacity = 1.0;
    bool visible = true;
};

struct DesiredAudioCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::Session;
    std::optional<core::RoomId> room;
    double volume = 1.0;
    std::chrono::milliseconds fade_in{0};
    std::chrono::milliseconds fade_out{0};
    std::optional<core::DesiredAudioReplacementKey> replacement_key;
};

struct LayoutTransitionCommandOptions {
    std::chrono::milliseconds duration{0};
    bool skippable = true;
};

struct CustomLayoutCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
    core::PresentationPlane plane = core::PresentationPlane::GameUi;
    core::LayoutScaleOverrides scale_overrides;
    std::int32_t order = 0;
    core::LayoutClockDomain clock = core::LayoutClockDomain::Gameplay;
    core::LayoutInputMode input = core::LayoutInputMode::Normal;
    core::GameplayPausePolicy gameplay_pause = core::GameplayPausePolicy::Continue;
    core::LayoutVisibility visibility = core::LayoutVisibility::Visible;
    core::EscapeDismissalPolicy escape_dismissal = core::EscapeDismissalPolicy::Ignore;
    core::PresentationCompositionGroup composition_group =
        core::PresentationCompositionGroup::Interface;
    std::optional<LayoutTransitionCommandOptions> entrance;
    std::vector<core::LayoutInputAssignment> inputs;
    std::vector<core::LayoutSignalId> connected_signals;
};

struct BackgroundCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
    std::optional<core::AssetId> asset;
    std::optional<std::string> color;
    core::compiled::BackgroundFit fit = core::compiled::BackgroundFit::Cover;
    std::optional<core::MaterialId> material;
};

struct ScopedActorCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
    std::optional<core::CharacterIdleId> idle;
    core::compiled::ActorPosition position = core::compiled::ActorPosition::Center;
    core::compiled::Vector2 offset{0.0, 0.0};
    double scale = 1.0;
    bool visible = true;
};

struct PresentationPropCommandOptions {
    runtime::RuntimePresentationOwnerScope owner_scope =
        runtime::RuntimePresentationOwnerScope::CurrentRoom;
    std::optional<core::RoomId> room;
    std::optional<core::AssetId> asset;
    std::optional<core::MaterialId> material;
    std::optional<core::compiled::RoomPlacementRef> placement;
    core::compiled::NormalizedRect bounds{0.0, 0.0, 0.0, 0.0};
    core::PresentationPlane plane = core::PresentationPlane::WorldContent;
    std::int32_t order = 0;
    bool visible = true;
};

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
    create_room(runtime::RuntimeInstanceConfigurationRequest source);
    [[nodiscard]] core::Result<core::CharacterId, core::Diagnostics>
    create_character(runtime::RuntimeInstanceConfigurationRequest source,
                     core::CharacterWorldLocation location = core::compiled::UnplacedLocation{},
                     bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<core::InteractableId, core::Diagnostics> create_interactable(
        runtime::RuntimeInstanceConfigurationRequest source,
        core::compiled::InteractableLocation location = core::compiled::UnplacedLocation{},
        bool enabled = true, bool visible = true);
    [[nodiscard]] core::Result<core::ItemStackState, core::Diagnostics>
    item_stack(const core::ItemStackId& id) const;
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    split_item_stack(core::ItemStackId source, std::uint64_t quantity);
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    merge_item_stacks(core::ItemStackId receiver, core::ItemStackId donor);
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    transfer_item_quantity(
        core::ItemStackId source, std::uint64_t quantity,
        core::compiled::ItemStackLocation location,
        runtime::ItemStackPlacementPolicy policy = runtime::ItemStackPlacementPolicy::Coalesce);
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics> grant_item_quantity(
        core::ItemDefinitionId definition, std::uint64_t quantity,
        core::compiled::ItemStackLocation location,
        runtime::ItemStackPlacementPolicy policy = runtime::ItemStackPlacementPolicy::Coalesce);
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    consume_item_quantity(core::ItemStackId stack, std::uint64_t quantity);
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    consume_item_quantity(runtime::ItemStackFilter filter, std::uint64_t quantity);
    [[nodiscard]] core::Result<std::uint64_t, core::Diagnostics>
    aggregate_item_quantity(const runtime::ItemStackFilter& filter) const;
    [[nodiscard]] core::Result<runtime::ItemStackMutation, core::Diagnostics>
    set_item_stack_traits(core::ItemStackId stack, std::vector<core::TraitId> traits);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    replace_instance_configuration(core::GameplayInstanceRef instance,
                                   runtime::RuntimeInstanceConfigurationRequest source);
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
    [[nodiscard]] core::Result<core::CharacterWorldLocation, core::Diagnostics>
    character_location(const core::CharacterId& character) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_interactable_location(core::InteractableId interactable,
                                  core::compiled::InteractableLocation target);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_character_location(core::CharacterId character, core::CharacterWorldLocation target);
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
    activate_map_connection(core::MapId map, core::MapConnectionId connection);
    [[nodiscard]] core::Result<std::optional<core::LayoutId>, core::Diagnostics>
    layout(core::compiled::LayoutSlot slot) const;
    [[nodiscard]] core::Result<void, core::Diagnostics> set_layout(core::compiled::LayoutSlot slot,
                                                                   core::LayoutId layout);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_layout(core::compiled::LayoutSlot slot);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_custom_layout(core::ScopedLayoutInstanceId instance, core::LayoutId layout,
                      CustomLayoutCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_custom_layout(core::ScopedLayoutInstanceId instance,
                        runtime::RuntimePresentationOwnerScope owner_scope,
                        std::optional<core::RoomId> room = std::nullopt,
                        std::optional<LayoutTransitionCommandOptions> exit = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>
    custom_layout(core::ScopedLayoutInstanceId instance,
                  runtime::RuntimePresentationOwnerScope owner_scope,
                  std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_background(BackgroundCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_background(runtime::RuntimePresentationOwnerScope owner_scope,
                     std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredBackgroundOverride>, core::Diagnostics>
    background(runtime::RuntimePresentationOwnerScope owner_scope,
               std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_scoped_actor(core::ScopedActorKey key, core::CharacterId character,
                     core::CharacterPoseId pose, core::CharacterExpressionId expression,
                     ScopedActorCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_scoped_actor(core::ScopedActorKey key, runtime::RuntimePresentationOwnerScope owner_scope,
                       std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredActorPresentation>, core::Diagnostics>
    scoped_actor(core::ScopedActorKey key, runtime::RuntimePresentationOwnerScope owner_scope,
                 std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_presentation_prop(core::PresentationPropInstanceId instance,
                          PresentationPropCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_presentation_prop(core::PresentationPropInstanceId instance,
                            runtime::RuntimePresentationOwnerScope owner_scope,
                            std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredPresentationProp>, core::Diagnostics>
    presentation_prop(core::PresentationPropInstanceId instance,
                      runtime::RuntimePresentationOwnerScope owner_scope,
                      std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_environment(core::PresentationEnvironmentInstanceId instance, core::MaterialId material,
                    EnvironmentLoopCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_environment(core::PresentationEnvironmentInstanceId instance,
                      runtime::RuntimePresentationOwnerScope owner_scope,
                      std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    stop_environments(core::PresentationEnvironmentStopKey stop_key,
                      runtime::RuntimePresentationOwnerScope owner_scope,
                      std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredPresentationEnvironment>,
                               core::Diagnostics>
    environment(core::PresentationEnvironmentInstanceId instance,
                runtime::RuntimePresentationOwnerScope owner_scope,
                std::optional<core::RoomId> room = std::nullopt) const;
    [[nodiscard]] core::Result<bool, core::Diagnostics> gameplay_paused() const;
    [[nodiscard]] core::Result<void, core::Diagnostics> set_gameplay_paused(bool paused);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_audio(core::compiled::AudioAction action, core::compiled::AudioChannel channel,
                  std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop,
                  double volume, bool await_completion,
                  core::AudioOperationPurpose purpose = core::AudioOperationPurpose::Gameplay);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    set_desired_audio(core::DesiredAudioInstanceId instance, core::compiled::AudioChannel bus,
                      core::AssetId asset, DesiredAudioCommandOptions options);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_desired_audio(core::DesiredAudioInstanceId instance,
                        runtime::RuntimePresentationOwnerScope owner_scope,
                        std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<void, core::Diagnostics>
    clear_desired_audio_bus(core::compiled::AudioChannel bus,
                            runtime::RuntimePresentationOwnerScope owner_scope,
                            std::optional<core::RoomId> room = std::nullopt);
    [[nodiscard]] core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>
    desired_audio(core::DesiredAudioInstanceId instance,
                  runtime::RuntimePresentationOwnerScope owner_scope,
                  std::optional<core::RoomId> room = std::nullopt) const;
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
