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
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_gameplay_paused(bool paused)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Game, "gameplay pause mutation",
                          gateway->set_gameplay_paused(paused));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_audio(core::compiled::AudioAction action,
                                core::compiled::AudioChannel channel,
                                std::optional<core::AssetId> asset, std::chrono::milliseconds fade,
                                bool loop, double volume, bool await_completion)
{
    NOVELTEA_WITH_COMMAND(runtime::RuntimeCapabilityGroup::Audio, "audio command",
                          gateway->request_audio(action, channel, std::move(asset), fade, loop,
                                                 volume, await_completion));
}
core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
RuntimeScriptApi::audio_channel(core::compiled::AudioChannel channel) const
{
    NOVELTEA_WITH_QUERY(runtime::RuntimeCapabilityGroup::Audio, "audio channel query",
                        gateway->audio_channel(channel));
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
RuntimeScriptApi::run_interaction(core::VerbId verb, std::vector<core::InteractableId> operands)
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
