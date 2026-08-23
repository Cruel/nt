#include "noveltea/script/runtime_script_api.hpp"

#include "noveltea/runtime/runtime_command_gateway.hpp"

#include <mutex>

namespace noveltea::script {
namespace {

core::Diagnostics unavailable()
{
    return {
        core::Diagnostic{.code = "runtime.script_api_unavailable",
                         .message = "The runtime script API is not attached to a live session"}};
}

core::Diagnostics denied(std::string operation)
{
    return {core::Diagnostic{.code = "runtime.script_capability_denied",
                             .message = std::move(operation) +
                                        " is not admitted by this script capability profile"}};
}

core::Diagnostics stale()
{
    return {core::Diagnostic{.code = "runtime.script_capability_stale",
                             .message = "The script capability generation is no longer active"}};
}

runtime::RuntimeCapabilityGroup instance_group(const core::GameplayInstanceRef& instance) noexcept
{
    return std::visit(
        [](const auto& id) {
            using T = std::decay_t<decltype(id)>;
            if constexpr (std::is_same_v<T, core::RoomId>)
                return runtime::RuntimeCapabilityGroup::Room;
            else if constexpr (std::is_same_v<T, core::CharacterId>)
                return runtime::RuntimeCapabilityGroup::Character;
            else
                return runtime::RuntimeCapabilityGroup::Interactable;
        },
        instance);
}

} // namespace

struct RuntimeScriptApi::State {
    mutable std::mutex mutex;
    std::optional<runtime::RuntimeCapabilitySet> capabilities;
};

RuntimeScriptApi::RuntimeScriptApi() : m_state(std::make_shared<State>()) {}
RuntimeScriptApi::~RuntimeScriptApi() { clear_capabilities(); }

void RuntimeScriptApi::replace_capabilities(runtime::RuntimeCapabilitySet capabilities) noexcept
{
    std::scoped_lock lock(m_state->mutex);
    m_state->capabilities = capabilities;
}

void RuntimeScriptApi::clear_capabilities() noexcept
{
    std::scoped_lock lock(m_state->mutex);
    m_state->capabilities.reset();
}

bool RuntimeScriptApi::available() const noexcept
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return false;
    const auto* provider =
        m_state->capabilities->query_provider(runtime::RuntimeCapabilityGroup::Definitions);
    return provider != nullptr && provider->active(m_state->capabilities->generation());
}

#define NOVELTEA_WITH_PROVIDER(group, operation, expression)                                       \
    std::scoped_lock lock(m_state->mutex);                                                         \
    const auto* provider =                                                                         \
        m_state->capabilities ? m_state->capabilities->query_provider(group) : nullptr;            \
    using Result = decltype(expression);                                                           \
    if (!m_state->capabilities)                                                                    \
        return Result::failure(unavailable());                                                     \
    if (provider == nullptr)                                                                       \
        return Result::failure(denied(operation));                                                 \
    if (!provider->active(m_state->capabilities->generation()))                                    \
        return Result::failure(stale());                                                           \
    return expression

#define NOVELTEA_WITH_QUERY(group, operation, expression)                                          \
    std::scoped_lock lock(m_state->mutex);                                                         \
    const auto* gateway =                                                                          \
        m_state->capabilities ? m_state->capabilities->query_gateway(group) : nullptr;             \
    using Result = decltype(expression);                                                           \
    if (!m_state->capabilities)                                                                    \
        return Result::failure(unavailable());                                                     \
    if (gateway == nullptr)                                                                        \
        return Result::failure(denied(operation));                                                 \
    if (!gateway->active(m_state->capabilities->generation()))                                     \
        return Result::failure(stale());                                                           \
    return expression

#define NOVELTEA_WITH_COMMAND(group, operation, expression)                                        \
    std::scoped_lock lock(m_state->mutex);                                                         \
    auto* gateway =                                                                                \
        m_state->capabilities ? m_state->capabilities->command_gateway(group) : nullptr;           \
    using Result = decltype(expression);                                                           \
    if (!m_state->capabilities)                                                                    \
        return Result::failure(unavailable());                                                     \
    if (gateway == nullptr)                                                                        \
        return Result::failure(denied(operation));                                                 \
    if (!gateway->active(m_state->capabilities->generation()))                                     \
        return Result::failure(stale());                                                           \
    return expression

core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
RuntimeScriptApi::definition(core::ProjectDefinitionKind kind, std::string id) const
{
    NOVELTEA_WITH_PROVIDER(runtime::RuntimeCapabilityGroup::Definitions, "definition query",
                           provider->definition(kind, std::move(id)));
}
core::Result<core::RuntimeValue, core::Diagnostics>
RuntimeScriptApi::global_property(const core::PropertyId& id) const
{
    NOVELTEA_WITH_PROVIDER(runtime::RuntimeCapabilityGroup::Properties, "Global Property read",
                           provider->global_property(id));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_global_property(const core::PropertyId& id, core::RuntimeValue value)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Properties, "Global Property write",
                          gateway->set_global_property(id, std::move(value)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::unset_global_property(const core::PropertyId& id)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Properties, "Global Property unset",
                          gateway->unset_global_property(id));
}
core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeScriptApi::property(const core::PropertyOwnerRef& owner,
                           const core::PropertyId& property) const
{
    NOVELTEA_WITH_PROVIDER(runtime::RuntimeCapabilityGroup::Properties, "property read",
                           provider->property(owner, property));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_property(core::PropertyOwnerRef owner,
                                                                     core::PropertyId property,
                                                                     core::RuntimeValue value)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Properties, "property write",
        gateway->set_property(std::move(owner), std::move(property), std::move(value)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::unset_property(const core::PropertyOwnerRef& owner,
                                 const core::PropertyId& property)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Properties, "property unset",
                          gateway->unset_property(owner, property));
}

core::Result<core::RoomId, core::Diagnostics>
RuntimeScriptApi::create_room(runtime::RuntimeInstanceConfigurationRequest source)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Room, "Room instance creation",
                          gateway->create_room(std::move(source)));
}

core::Result<core::CharacterId, core::Diagnostics>
RuntimeScriptApi::create_character(runtime::RuntimeInstanceConfigurationRequest source,
                                   core::CharacterWorldLocation location, bool enabled,
                                   bool visible)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Character, "Character instance creation",
        gateway->create_character(std::move(source), std::move(location), enabled, visible));
}

core::Result<core::InteractableId, core::Diagnostics>
RuntimeScriptApi::create_interactable(runtime::RuntimeInstanceConfigurationRequest source,
                                      core::compiled::InteractableLocation location, bool enabled,
                                      bool visible)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Interactable, "Interactable instance creation",
        gateway->create_interactable(std::move(source), std::move(location), enabled, visible));
}

core::Result<core::ItemStackState, core::Diagnostics>
RuntimeScriptApi::item_stack(const core::ItemStackId& id) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack query",
                        gateway->item_stack(id));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::split_item_stack(core::ItemStackId source, std::uint64_t quantity)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack split",
                          gateway->split_item_stack(std::move(source), quantity));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::merge_item_stacks(core::ItemStackId receiver, core::ItemStackId donor)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack merge",
                          gateway->merge_item_stacks(std::move(receiver), std::move(donor)));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::transfer_item_quantity(core::ItemStackId source, std::uint64_t quantity,
                                         core::compiled::ItemStackLocation location,
                                         runtime::ItemStackPlacementPolicy policy)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack transfer",
        gateway->transfer_item_quantity(std::move(source), quantity, std::move(location), policy));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::grant_item_quantity(core::ItemDefinitionId definition, std::uint64_t quantity,
                                      core::compiled::ItemStackLocation location,
                                      runtime::ItemStackPlacementPolicy policy)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack grant",
        gateway->grant_item_quantity(std::move(definition), quantity, std::move(location), policy));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::consume_item_quantity(core::ItemStackId stack, std::uint64_t quantity)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack consume",
                          gateway->consume_item_quantity(std::move(stack), quantity));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::consume_item_quantity(runtime::ItemStackFilter filter, std::uint64_t quantity)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::ItemStack,
                          "Item Stack aggregate consume",
                          gateway->consume_item_quantity(std::move(filter), quantity));
}

core::Result<std::uint64_t, core::Diagnostics>
RuntimeScriptApi::aggregate_item_quantity(const runtime::ItemStackFilter& filter) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack aggregate",
                        gateway->aggregate_item_quantity(filter));
}

core::Result<runtime::ItemStackMutation, core::Diagnostics>
RuntimeScriptApi::set_item_stack_traits(core::ItemStackId stack, std::vector<core::TraitId> traits)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::ItemStack, "Item Stack Trait mutation",
                          gateway->set_item_stack_traits(std::move(stack), std::move(traits)));
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::replace_instance_configuration(
    core::GameplayInstanceRef instance, runtime::RuntimeInstanceConfigurationRequest source)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(instance_group(instance));
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("Gameplay Instance configuration replacement"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->replace_instance_configuration(std::move(instance), std::move(source));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_instance_configuration(core::GameplayInstanceRef instance)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(instance_group(instance));
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("Gameplay Instance configuration clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->clear_instance_configuration(std::move(instance));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::retarget_room_exit(core::RoomId room, core::RoomExitId exit, core::RoomId target)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Room, "Room Exit retargeting",
        gateway->retarget_room_exit(std::move(room), std::move(exit), std::move(target)));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::destroy_instance(core::GameplayInstanceRef instance)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(instance_group(instance));
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("Gameplay Instance destruction"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->destroy_instance(std::move(instance));
}

core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>
RuntimeScriptApi::instance_provenance(const core::GameplayInstanceRef& instance) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>::failure(
            unavailable());
    const auto* gateway = m_state->capabilities->query_gateway(instance_group(instance));
    if (gateway == nullptr)
        return core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>::failure(
            denied("Gameplay Instance provenance query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<core::RuntimeInstanceProvenance, core::Diagnostics>::failure(stale());
    return gateway->instance_provenance(instance);
}

core::Result<core::compiled::InteractableLocation, core::Diagnostics>
RuntimeScriptApi::interactable_location(const core::InteractableId& interactable) const
{
    NOVELTEA_WITH_PROVIDER(runtime::RuntimeCapabilityGroup::Interactable,
                           "Interactable location query",
                           provider->interactable_location(interactable));
}
core::Result<core::CharacterWorldLocation, core::Diagnostics>
RuntimeScriptApi::character_location(const core::CharacterId& character) const
{
    NOVELTEA_WITH_PROVIDER(runtime::RuntimeCapabilityGroup::Character, "Character location query",
                           provider->character_location(character));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_interactable_location(core::InteractableId interactable,
                                                core::compiled::InteractableLocation target)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Interactable, "Interactable move",
        gateway->request_interactable_location(std::move(interactable), std::move(target)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_character_location(core::CharacterId character,
                                             core::CharacterWorldLocation target)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Character, "Character move",
                          gateway->request_character_world_state(
                              std::move(character), std::move(target), std::nullopt, std::nullopt));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_navigation(core::compiled::RoomExitRef exit)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Room, "Room navigation",
                          gateway->request_navigation(std::move(exit)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_transient(core::SceneId scene)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Flow, "transient Scene start",
                          gateway->request_transient(std::move(scene)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_transient(core::DialogueId dialogue)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Flow, "transient Dialogue start",
                          gateway->request_transient(std::move(dialogue)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_child(core::SceneId scene)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Flow, "child Scene call",
                          gateway->request_child(std::move(scene)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_child(core::DialogueId dialogue)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Flow, "child Dialogue call",
                          gateway->request_child(std::move(dialogue)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_tail_replacement(core::FlowTarget target)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Flow, "Flow tail replacement",
                          gateway->request_tail_replacement(std::move(target)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_notification(std::string message)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Game, "notification",
                          gateway->request_notification(std::move(message)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::seed_random(std::uint64_t seed)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Random, "random seed",
                          gateway->seed_random(seed));
}
core::Result<std::int64_t, core::Diagnostics> RuntimeScriptApi::random_integer(std::int64_t minimum,
                                                                               std::int64_t maximum)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Random, "random integer draw",
                          gateway->random_integer(minimum, maximum));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode,
                              bool visible, std::optional<core::MapLocationId> focused_location)
{
    NOVELTEA_WITH_COMMAND(
        runtime::RuntimeCapabilityGroup::Map, "Map presentation",
        gateway->present_map(std::move(map), mode, visible, std::move(focused_location)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::hide_map()
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Map, "Map hiding", gateway->hide_map());
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::select_map_location(core::MapLocationId location)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Map, "Map selection",
                          gateway->select_map_location(std::move(location)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::activate_map_connection(core::MapConnectionId connection)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Map, "Map activation",
                          gateway->activate_map_connection(std::move(connection)));
}
core::Result<core::MapPresentationState, core::Diagnostics> RuntimeScriptApi::map_state() const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Map, "Map state query",
                        gateway->map_state());
}
core::Result<std::optional<core::LayoutId>, core::Diagnostics>
RuntimeScriptApi::layout(core::compiled::LayoutSlot slot) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Presentation, "Layout query",
                        gateway->layout(slot));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_layout(core::compiled::LayoutSlot slot,
                                                                   core::LayoutId layout)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Presentation, "Layout mutation",
                          gateway->set_layout(slot, std::move(layout)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_layout(core::compiled::LayoutSlot slot)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Presentation, "Layout clearing",
                          gateway->clear_layout(slot));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_custom_layout(core::ScopedLayoutInstanceId instance, core::LayoutId layout,
                                    CustomLayoutCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("custom Layout mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    std::optional<runtime::LayoutFadeRequest> entrance;
    if (options.entrance)
        entrance =
            runtime::LayoutFadeRequest{options.entrance->duration, options.entrance->skippable};
    return gateway->upsert_mounted_layout(
        core::DesiredMountedLayout{
            core::ScopedLayoutMountKey{std::move(instance)}, std::move(*owner.value_if()),
            std::move(layout),
            core::MountedLayoutPolicy{.plane = options.plane,
                                      .local_order = options.order,
                                      .clock = options.clock,
                                      .input = options.input,
                                      .gameplay_pause = options.gameplay_pause,
                                      .visibility = options.visibility,
                                      .escape_dismissal = options.escape_dismissal,
                                      .entrance_operation = std::nullopt,
                                      .exit_operation = std::nullopt},
            options.scale_overrides, options.composition_group, std::nullopt,
            std::move(options.inputs), std::move(options.connected_signals)},
        entrance);
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::clear_custom_layout(
    core::ScopedLayoutInstanceId instance, runtime::RuntimePresentationOwnerScope owner_scope,
    std::optional<core::RoomId> room, std::optional<LayoutTransitionCommandOptions> exit)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("custom Layout clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    std::optional<runtime::LayoutFadeRequest> transition;
    if (exit)
        transition = runtime::LayoutFadeRequest{exit->duration, exit->skippable};
    return gateway->remove_mounted_layout(core::ScopedLayoutMountKey{std::move(instance)},
                                          std::move(*owner.value_if()), transition);
}

core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>
RuntimeScriptApi::custom_layout(core::ScopedLayoutInstanceId instance,
                                runtime::RuntimePresentationOwnerScope owner_scope,
                                std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>::failure(
            unavailable());
    const auto* gateway =
        m_state->capabilities->query_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>::failure(
            denied("custom Layout query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>::failure(
            stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredMountedLayout>, core::Diagnostics>::failure(
            std::move(owner.error()));
    return gateway->mounted_layout(core::ScopedLayoutMountKey{std::move(instance)},
                                   *owner.value_if());
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_background(BackgroundCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("background mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->upsert_background_override(core::DesiredBackgroundOverride{
        std::move(*owner.value_if()),
        core::compiled::BackgroundPresentation{std::move(options.asset), std::move(options.color),
                                               options.fit, std::move(options.material)}});
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_background(runtime::RuntimePresentationOwnerScope owner_scope,
                                   std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("background clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_background_override(std::move(*owner.value_if()));
}

core::Result<std::optional<core::DesiredBackgroundOverride>, core::Diagnostics>
RuntimeScriptApi::background(runtime::RuntimePresentationOwnerScope owner_scope,
                             std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredBackgroundOverride>,
                            core::Diagnostics>::failure(unavailable());
    const auto* gateway =
        m_state->capabilities->query_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredBackgroundOverride>,
                            core::Diagnostics>::failure(denied("background query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredBackgroundOverride>,
                            core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredBackgroundOverride>,
                            core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->background_override(*owner.value_if());
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::set_scoped_actor(
    core::ScopedActorKey key, core::CharacterId character, core::CharacterPoseId pose,
    core::CharacterExpressionId expression, ScopedActorCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("actor mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->upsert_actor_presentation(core::DesiredActorPresentation{
        std::move(key), std::move(*owner.value_if()), std::move(character), std::move(pose),
        std::move(expression), std::move(options.idle),
        core::ActorLogicalPlacement{options.position, options.offset, options.scale},
        options.visible, true});
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_scoped_actor(core::ScopedActorKey key,
                                     runtime::RuntimePresentationOwnerScope owner_scope,
                                     std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("actor clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_actor_presentation(std::move(key), std::move(*owner.value_if()));
}

core::Result<std::optional<core::DesiredActorPresentation>, core::Diagnostics>
RuntimeScriptApi::scoped_actor(core::ScopedActorKey key,
                               runtime::RuntimePresentationOwnerScope owner_scope,
                               std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredActorPresentation>,
                            core::Diagnostics>::failure(unavailable());
    const auto* gateway =
        m_state->capabilities->query_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredActorPresentation>,
                            core::Diagnostics>::failure(denied("actor query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredActorPresentation>,
                            core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredActorPresentation>,
                            core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->actor_presentation(key, *owner.value_if());
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_presentation_prop(core::PresentationPropInstanceId instance,
                                        PresentationPropCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("prop mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->upsert_presentation_prop(core::DesiredPresentationProp{
        std::move(instance), std::move(*owner.value_if()), std::move(options.asset),
        std::move(options.material), std::move(options.placement), options.bounds, options.plane,
        options.order, options.visible});
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_presentation_prop(core::PresentationPropInstanceId instance,
                                          runtime::RuntimePresentationOwnerScope owner_scope,
                                          std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("prop clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_presentation_prop(std::move(instance), std::move(*owner.value_if()));
}

core::Result<std::optional<core::DesiredPresentationProp>, core::Diagnostics>
RuntimeScriptApi::presentation_prop(core::PresentationPropInstanceId instance,
                                    runtime::RuntimePresentationOwnerScope owner_scope,
                                    std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredPresentationProp>,
                            core::Diagnostics>::failure(unavailable());
    const auto* gateway =
        m_state->capabilities->query_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredPresentationProp>,
                            core::Diagnostics>::failure(denied("prop query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredPresentationProp>,
                            core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredPresentationProp>,
                            core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->presentation_prop(instance, *owner.value_if());
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_environment(core::PresentationEnvironmentInstanceId instance,
                                  core::MaterialId material, EnvironmentLoopCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("environment loop mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->upsert_presentation_environment(core::DesiredPresentationEnvironment{
        std::move(instance), std::move(*owner.value_if()), std::move(options.stop_key),
        std::move(options.asset), std::move(material), options.bounds, options.plane, options.order,
        options.clock, options.scroll_per_second, options.opacity, options.visible});
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_environment(core::PresentationEnvironmentInstanceId instance,
                                    runtime::RuntimePresentationOwnerScope owner_scope,
                                    std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("environment loop clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_presentation_environment(std::move(instance),
                                                    std::move(*owner.value_if()));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::stop_environments(core::PresentationEnvironmentStopKey stop_key,
                                    runtime::RuntimePresentationOwnerScope owner_scope,
                                    std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("environment loop stop-key clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_presentation_environments(std::move(stop_key),
                                                     std::move(*owner.value_if()));
}

core::Result<std::optional<core::DesiredPresentationEnvironment>, core::Diagnostics>
RuntimeScriptApi::environment(core::PresentationEnvironmentInstanceId instance,
                              runtime::RuntimePresentationOwnerScope owner_scope,
                              std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredPresentationEnvironment>,
                            core::Diagnostics>::failure(unavailable());
    const auto* gateway =
        m_state->capabilities->query_gateway(runtime::RuntimeCapabilityGroup::Presentation);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredPresentationEnvironment>,
                            core::Diagnostics>::failure(denied("environment query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredPresentationEnvironment>,
                            core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredPresentationEnvironment>,
                            core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->presentation_environment(instance, *owner.value_if());
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_gameplay_paused(bool paused)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Game, "gameplay pause mutation",
                          gateway->set_gameplay_paused(paused));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_audio(
    core::compiled::AudioAction action, core::compiled::AudioChannel channel,
    std::optional<core::AssetId> asset, std::chrono::milliseconds fade, bool loop, double volume,
    bool await_completion, core::AudioOperationPurpose purpose)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Audio, "audio command",
                          gateway->request_audio(action, channel, std::move(asset), fade, loop,
                                                 volume, await_completion, purpose));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_desired_audio(core::DesiredAudioInstanceId instance,
                                    core::compiled::AudioChannel bus, core::AssetId asset,
                                    DesiredAudioCommandOptions options)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Audio);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("desired audio mutation"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(options.owner_scope, std::move(options.room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->upsert_desired_audio(core::DesiredAudioInstance{
        std::move(instance), std::move(*owner.value_if()), bus, std::move(asset), options.volume,
        options.fade_in, options.fade_out, std::move(options.replacement_key)});
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_desired_audio(core::DesiredAudioInstanceId instance,
                                      runtime::RuntimePresentationOwnerScope owner_scope,
                                      std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Audio);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("desired audio clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_desired_audio(std::move(instance), std::move(*owner.value_if()));
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_desired_audio_bus(core::compiled::AudioChannel bus,
                                          runtime::RuntimePresentationOwnerScope owner_scope,
                                          std::optional<core::RoomId> room)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Audio);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("desired audio bus clearing"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<void, core::Diagnostics>::failure(std::move(owner.error()));
    return gateway->remove_desired_audio_bus(bus, std::move(*owner.value_if()));
}

core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>
RuntimeScriptApi::desired_audio(core::DesiredAudioInstanceId instance,
                                runtime::RuntimePresentationOwnerScope owner_scope,
                                std::optional<core::RoomId> room) const
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>::failure(
            unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Audio);
    if (gateway == nullptr)
        return core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>::failure(
            denied("desired audio query"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>::failure(
            stale());
    auto owner = gateway->presentation_owner(owner_scope, std::move(room));
    if (!owner)
        return core::Result<std::optional<core::DesiredAudioInstance>, core::Diagnostics>::failure(
            std::move(owner.error()));
    return gateway->desired_audio(instance, *owner.value_if());
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::append_text_log(core::TextLogEntry entry)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::TextLog, "text-log append",
                          gateway->append_text_log(std::move(entry)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::clear_text_log()
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::TextLog, "text-log clearing",
                          gateway->clear_text_log());
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_composed_character_visible(core::CharacterId character, bool visible)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* draft = m_state->capabilities->room_composition_draft();
    if (draft == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("Room composition Character visibility"));
    return draft->set_character_visible(character, visible);
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::set_composed_interactable_visible(core::InteractableId interactable, bool visible)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* draft = m_state->capabilities->room_composition_draft();
    if (draft == nullptr)
        return core::Result<void, core::Diagnostics>::failure(
            denied("Room composition Interactable visibility"));
    return draft->set_interactable_visible(interactable, visible);
}

core::Result<double, core::Diagnostics> RuntimeScriptApi::random_unit()
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Random, "random unit draw",
                          gateway->random_unit());
}

core::Result<bool, core::Diagnostics> RuntimeScriptApi::gameplay_paused() const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Game, "gameplay pause query",
                        gateway->gameplay_paused());
}

#undef NOVELTEA_WITH_QUERY
#undef NOVELTEA_WITH_COMMAND

core::Result<void, core::Diagnostics> RuntimeScriptApi::continue_game()
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Game);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.continue"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->continue_game();
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::choose(std::size_t index)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Game);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.choose"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->choose(index);
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::navigate(std::size_t index)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Room);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.navigate"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->navigate(index);
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::select_interactable(core::InteractableId interactable)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Interactable);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.select_interactable"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->select_interactable(std::move(interactable));
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::clear_selection()
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Interactable);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.clear_selection"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->clear_selection();
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::run_interaction(core::VerbId verb,
                                  std::vector<core::compiled::InteractionSubject> operands)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway =
        m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Interactable);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.run_interaction"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->run_interaction(std::move(verb), std::move(operands));
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::save(core::TypedSaveSlotId slot)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Save);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.save"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->save(slot);
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::load(core::TypedSaveSlotId slot)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->capabilities)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    auto* gateway = m_state->capabilities->command_gateway(runtime::RuntimeCapabilityGroup::Save);
    if (gateway == nullptr)
        return core::Result<void, core::Diagnostics>::failure(denied("Game.load"));
    if (!gateway->active(m_state->capabilities->generation()))
        return core::Result<void, core::Diagnostics>::failure(stale());
    return gateway->load(slot);
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::autosave()
{
    return save(core::TypedSaveSlotId::autosave());
}

} // namespace noveltea::script
