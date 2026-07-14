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
