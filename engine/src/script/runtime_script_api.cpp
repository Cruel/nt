#include "noveltea/script/runtime_script_api.hpp"

#include <mutex>

namespace noveltea::script {
namespace {

core::Diagnostics unavailable()
{
    return {
        core::Diagnostic{.code = "runtime.script_api_unavailable",
                         .message = "The runtime script API is not attached to a live session"}};
}

core::Diagnostics out_of_range(std::string operation)
{
    return {core::Diagnostic{.code = "runtime.script_index_out_of_range",
                             .message = std::move(operation) +
                                        " uses zero-based indices and the index is out of range"}};
}

} // namespace

struct RuntimeScriptApi::State {
    mutable std::mutex mutex;
    RuntimeScriptApiTarget* target = nullptr;
};

RuntimeScriptApi::RuntimeScriptApi() : m_state(std::make_shared<State>()) {}
RuntimeScriptApi::~RuntimeScriptApi() { clear_target(); }

void RuntimeScriptApi::replace_target(RuntimeScriptApiTarget* target) noexcept
{
    std::scoped_lock lock(m_state->mutex);
    m_state->target = target;
}

void RuntimeScriptApi::clear_target() noexcept
{
    std::scoped_lock lock(m_state->mutex);
    m_state->target = nullptr;
}

bool RuntimeScriptApi::available() const noexcept
{
    std::scoped_lock lock(m_state->mutex);
    return m_state->target != nullptr;
}

#define NOVELTEA_WITH_TARGET(expression)                                                           \
    std::scoped_lock lock(m_state->mutex);                                                         \
    if (m_state->target == nullptr)                                                                \
        return decltype(expression)::failure(unavailable());                                       \
    return expression

core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
RuntimeScriptApi::definition(core::ProjectDefinitionKind kind, std::string id) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_definition(kind, std::move(id)));
}
core::Result<core::RuntimeValue, core::Diagnostics>
RuntimeScriptApi::variable(const core::VariableId& id) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_variable(id));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_variable(const core::VariableId& id,
                                                                     core::RuntimeValue value)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_set_variable(id, std::move(value)));
}
core::Result<core::PropertyLookupResult, core::Diagnostics>
RuntimeScriptApi::property(const core::PropertyOwnerRef& owner,
                           const core::PropertyId& property) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_property(owner, property));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_property(core::PropertyOwnerRef owner,
                                                                     core::PropertyId property,
                                                                     core::RuntimeValue value)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_set_property(std::move(owner), std::move(property),
                                                              std::move(value)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::unset_property(const core::PropertyOwnerRef& owner,
                                 const core::PropertyId& property)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_unset_property(owner, property));
}
core::Result<core::compiled::InteractableLocation, core::Diagnostics>
RuntimeScriptApi::interactable_location(const core::InteractableId& interactable) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_interactable_location(interactable));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_interactable_location(core::InteractableId interactable,
                                                core::compiled::InteractableLocation target)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_interactable_location(
        std::move(interactable), std::move(target)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_navigation(core::compiled::RoomExitRef exit)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_navigation(std::move(exit)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_transient(core::SceneId scene)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_transient(std::move(scene)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_transient(core::DialogueId dialogue)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_transient(std::move(dialogue)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_child(core::SceneId scene)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_child(std::move(scene)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_child(core::DialogueId dialogue)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_child(std::move(dialogue)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_tail_replacement(core::FlowTarget target)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_tail_replacement(std::move(target)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::request_notification(std::string message)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_notification(std::move(message)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::seed_random(std::uint64_t seed)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_seed_random(seed));
}
core::Result<std::int64_t, core::Diagnostics> RuntimeScriptApi::random_integer(std::int64_t minimum,
                                                                               std::int64_t maximum)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_random_integer(minimum, maximum));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::present_map(core::MapId map, std::optional<core::compiled::InitialMapMode> mode,
                              bool visible, std::optional<core::MapLocationId> focused_location)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_present_map(std::move(map), mode, visible,
                                                             std::move(focused_location)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::hide_map()
{
    NOVELTEA_WITH_TARGET(m_state->target->script_hide_map());
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::select_map_location(core::MapLocationId location)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_select_map_location(std::move(location)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::activate_map_connection(core::MapConnectionId connection)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_activate_map_connection(std::move(connection)));
}
core::Result<core::MapPresentationState, core::Diagnostics> RuntimeScriptApi::map_state() const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_map_state());
}
core::Result<std::optional<core::LayoutId>, core::Diagnostics>
RuntimeScriptApi::layout(core::compiled::LayoutSlot slot) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_layout(slot));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_layout(core::compiled::LayoutSlot slot,
                                                                   core::LayoutId layout)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_set_layout(slot, std::move(layout)));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::clear_layout(core::compiled::LayoutSlot slot)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_clear_layout(slot));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::set_gameplay_paused(bool paused)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_set_gameplay_paused(paused));
}
core::Result<void, core::Diagnostics>
RuntimeScriptApi::request_audio(core::compiled::AudioAction action,
                                core::compiled::AudioChannel channel,
                                std::optional<core::AssetId> asset, std::chrono::milliseconds fade,
                                bool loop, double volume, bool await_completion)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_request_audio(
        action, channel, std::move(asset), fade, loop, volume, await_completion));
}
core::Result<std::optional<core::AudioChannelState>, core::Diagnostics>
RuntimeScriptApi::audio_channel(core::compiled::AudioChannel channel) const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_audio_channel(channel));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::append_text_log(core::TextLogEntry entry)
{
    NOVELTEA_WITH_TARGET(m_state->target->script_append_text_log(std::move(entry)));
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::clear_text_log()
{
    NOVELTEA_WITH_TARGET(m_state->target->script_clear_text_log());
}

core::Result<double, core::Diagnostics> RuntimeScriptApi::random_unit()
{
    NOVELTEA_WITH_TARGET(m_state->target->script_random_unit());
}

core::Result<bool, core::Diagnostics> RuntimeScriptApi::gameplay_paused() const
{
    NOVELTEA_WITH_TARGET(m_state->target->script_gameplay_paused());
}

#undef NOVELTEA_WITH_TARGET

core::Result<void, core::Diagnostics> RuntimeScriptApi::continue_game()
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(core::ContinueInput{});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::choose(std::size_t index)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    const auto& view = m_state->target->script_view();
    if (view.scene && view.scene->choice) {
        if (index >= view.scene->choice->options.size())
            return core::Result<void, core::Diagnostics>::failure(out_of_range("Game.choose"));
        m_state->target->queue_script_input(
            core::SelectSceneChoiceInput{view.scene->choice->options[index].option});
        return core::Result<void, core::Diagnostics>::success();
    }
    if (view.dialogue && view.dialogue->choice) {
        if (index >= view.dialogue->choice->options.size())
            return core::Result<void, core::Diagnostics>::failure(out_of_range("Game.choose"));
        m_state->target->queue_script_input(
            core::SelectDialogueChoiceInput{view.dialogue->choice->options[index].edge});
        return core::Result<void, core::Diagnostics>::success();
    }
    return core::Result<void, core::Diagnostics>::failure(out_of_range("Game.choose"));
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::navigate(std::size_t index)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    const auto& view = m_state->target->script_view();
    if (!view.room || index >= view.room->exits.size())
        return core::Result<void, core::Diagnostics>::failure(out_of_range("Game.navigate"));
    m_state->target->queue_script_input(core::NavigateRoomInput{view.room->exits[index].exit});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::select_interactable(core::InteractableId interactable)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(core::SelectInteractablesInput{{std::move(interactable)}});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::clear_selection()
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(core::ClearInteractableSelectionInput{});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeScriptApi::run_interaction(core::VerbId verb, std::vector<core::InteractableId> operands)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(
        core::InvokeInteractionInput{std::move(verb), std::move(operands)});
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeScriptApi::save(core::TypedSaveSlotId slot)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(core::SaveRuntimeInput{slot});
    return core::Result<void, core::Diagnostics>::success();
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::load(core::TypedSaveSlotId slot)
{
    std::scoped_lock lock(m_state->mutex);
    if (!m_state->target)
        return core::Result<void, core::Diagnostics>::failure(unavailable());
    m_state->target->queue_script_input(core::LoadRuntimeInput{slot});
    return core::Result<void, core::Diagnostics>::success();
}
core::Result<void, core::Diagnostics> RuntimeScriptApi::autosave()
{
    return save(core::TypedSaveSlotId::autosave());
}

} // namespace noveltea::script
