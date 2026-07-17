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
    const auto* gateway = m_state->capabilities->gateway();
    return gateway != nullptr && gateway->active(m_state->capabilities->generation());
}

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
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Definitions, "definition query",
                        gateway->definition(kind, std::move(id)));
}
core::Result<core::RuntimeValue, core::Diagnostics>
RuntimeScriptApi::variable(const core::VariableId& id) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Variables, "Variable read",
                        gateway->variable(id));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_variable(const core::VariableId& id,
                                                                     core::RuntimeValue value)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Variables, "Variable write",
                          gateway->set_variable(id, std::move(value)));
}
core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeScriptApi::property(const core::PropertyOwnerRef& owner,
                           const core::PropertyId& property) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Properties, "property read",
                        gateway->property(owner, property));
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
core::Result<core::compiled::InteractableLocation, core::Diagnostics>
RuntimeScriptApi::interactable_location(const core::InteractableId& interactable) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Interactable,
                        "Interactable location query",
                        gateway->interactable_location(interactable));
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
            core::MountedLayoutPolicy{options.plane, options.order, options.clock, options.input,
                                      options.gameplay_pause, options.visibility,
                                      options.escape_dismissal, std::nullopt, std::nullopt},
            options.composition_group},
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
