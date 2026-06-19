#include <noveltea/core/runtime_session_host.hpp>

#include <noveltea/core/project_ids.hpp>

#include <algorithm>

namespace noveltea::core {

RuntimeSessionHost::RuntimeSessionHost() = default;
RuntimeSessionHost::~RuntimeSessionHost() = default;

GameSessionLoadResult RuntimeSessionHost::load(ProjectDocument project, SaveDocument save)
{
    reset();
    auto result = m_session.load(std::move(project), std::move(save));
    if (!result.success) {
        return result;
    }

    m_controller = std::make_unique<RuntimeController>(m_session);
    return result;
}

void RuntimeSessionHost::reset()
{
    m_controller.reset();
    m_session.reset();
    m_view.reset();
    m_last_commands.clear();
    m_last_outputs.clear();
    m_last_diagnostics.clear();
    m_selected_object_ids.clear();
}

void RuntimeSessionHost::tick(double delta_seconds)
{
    RuntimeInput input;
    input.type = RuntimeInputType::Tick;
    input.delta_seconds = delta_seconds;
    (void)apply_input(input);
}

std::string_view RuntimeSessionHost::current_mode_name() const noexcept
{
    return m_controller ? m_controller->current_mode_name() : std::string_view("none");
}

bool RuntimeSessionHost::navigate_path(int direction)
{
    RuntimeInput input;
    input.type = RuntimeInputType::Navigate;
    input.direction = direction;
    return apply_input(input).handled;
}

bool RuntimeSessionHost::select_dialogue_option(int option_index)
{
    RuntimeInput input;
    input.type = RuntimeInputType::SelectDialogueOption;
    input.index = option_index;
    return apply_input(input).handled;
}

bool RuntimeSessionHost::continue_active()
{
    RuntimeInput input;
    input.type = RuntimeInputType::Continue;
    return apply_input(input).handled;
}

bool RuntimeSessionHost::process_action(const std::string& verb_id,
                                        const std::vector<std::string>& object_ids)
{
    RuntimeInput input;
    input.type = RuntimeInputType::RunAction;
    input.verb_id = verb_id;
    input.object_ids = object_ids;
    return apply_input(input).handled;
}

RuntimeInputResult RuntimeSessionHost::apply_input(const RuntimeInput& input)
{
    std::vector<RuntimeDiagnostic> diagnostics;

    auto unsupported = [&](std::string message) {
        diagnostics.push_back(make_warning(input, std::move(message)));
        return make_result(false, {}, std::move(diagnostics), input.step_index);
    };

    if (!m_controller && input.type != RuntimeInputType::Reset &&
        input.type != RuntimeInputType::Start) {
        return unsupported("runtime session is not loaded");
    }

    switch (input.type) {
    case RuntimeInputType::Start:
        return make_result(true, {}, {}, input.step_index);
    case RuntimeInputType::Stop:
        return make_result(true, {}, {}, input.step_index);
    case RuntimeInputType::Reset:
        reset();
        return make_result(true, {}, {}, input.step_index);
    case RuntimeInputType::Tick:
        m_controller->tick(input.delta_seconds);
        return make_result(true, m_controller->take_commands(), {}, input.step_index);
    case RuntimeInputType::Continue: {
        const auto mode = current_mode_name();
        if (mode == std::string_view("dialogue")) {
            m_controller->dialogue_continue();
        } else if (mode == std::string_view("cutscene")) {
            m_controller->cutscene_click();
        } else {
            return unsupported("continue input is only valid in dialogue or cutscene mode");
        }
        return make_result(true, m_controller->take_commands(), {}, input.step_index);
    }
    case RuntimeInputType::SelectDialogueOption: {
        if (current_mode_name() != std::string_view("dialogue")) {
            return unsupported("dialogue option input is only valid in dialogue mode");
        }
        const bool selected = m_controller->dialogue_select_option(input.index);
        if (!selected) {
            return unsupported("dialogue option was not selectable");
        }
        return make_result(true, m_controller->take_commands(), {}, input.step_index);
    }
    case RuntimeInputType::Navigate:
        if (current_mode_name() != std::string_view("room")) {
            return unsupported("navigation input is only valid in room mode");
        }
        m_controller->navigate_path(input.direction);
        return make_result(true, m_controller->take_commands(), {}, input.step_index);
    case RuntimeInputType::SelectObject: {
        const std::string object_id = !input.object_ids.empty()
                                          ? input.object_ids.front()
                                          : input.payload.value("object_id", std::string{});
        if (object_id.empty()) {
            return unsupported("object selection input requires an object id");
        }
        auto it = std::find(m_selected_object_ids.begin(), m_selected_object_ids.end(), object_id);
        if (it == m_selected_object_ids.end()) {
            m_selected_object_ids.push_back(object_id);
        } else {
            m_selected_object_ids.erase(it);
        }
        RuntimeOutput output;
        output.type = RuntimeOutputType::TestObservation;
        output.payload = {{"selected_objects", m_selected_object_ids}};
        output.step_index = input.step_index;
        auto result = make_result(true, {}, {}, input.step_index);
        result.outputs.push_back(std::move(output));
        m_last_outputs = result.outputs;
        return result;
    }
    case RuntimeInputType::ClearObjectSelection: {
        m_selected_object_ids.clear();
        RuntimeOutput output;
        output.type = RuntimeOutputType::TestObservation;
        output.payload = {{"selected_objects", nlohmann::json::array()}};
        output.step_index = input.step_index;
        auto result = make_result(true, {}, {}, input.step_index);
        result.outputs.push_back(std::move(output));
        m_last_outputs = result.outputs;
        return result;
    }
    case RuntimeInputType::RunAction: {
        auto object_ids = input.object_ids.empty() ? m_selected_object_ids : input.object_ids;
        const bool processed = m_controller->process_action(input.verb_id, object_ids);
        if (!processed) {
            return unsupported("action input was not processed");
        }
        m_selected_object_ids.clear();
        return make_result(true, m_controller->take_commands(), {}, input.step_index);
    }
    case RuntimeInputType::SetEntrypoint:
        return unsupported(
            "set-entrypoint input is handled by editor preview sessions in this phase");
    case RuntimeInputType::LoadSave:
        return unsupported(
            "load-save input is defined for the runtime contract but awaits save-slot policy");
    case RuntimeInputType::ApplyTestStep:
        return unsupported("apply-test-step input is defined for the runtime contract but has no "
                           "step executor yet");
    }

    return unsupported("unknown runtime input");
}

RuntimeInputResult
RuntimeSessionHost::flush_pending_outputs(std::optional<std::uint64_t> step_index)
{
    if (!m_controller) {
        return make_result(false, {}, {}, step_index);
    }
    (void)m_session.events().dispatch_queued();
    return make_result(true, m_controller->take_commands(), {}, step_index);
}

RuntimeInputResult RuntimeSessionHost::make_result(bool handled,
                                                   std::vector<ControllerCommand> commands,
                                                   std::vector<RuntimeDiagnostic> diagnostics,
                                                   std::optional<std::uint64_t> step_index)
{
    consume_commands(commands);

    auto outputs = commands_to_outputs(commands, step_index);
    for (const auto& diagnostic : diagnostics) {
        RuntimeOutput output;
        output.type = RuntimeOutputType::Diagnostic;
        output.diagnostic = diagnostic;
        output.step_index = diagnostic.playback_step_index;
        outputs.push_back(std::move(output));
    }

    if (!commands.empty()) {
        RuntimeOutput view_output;
        view_output.type = RuntimeOutputType::ViewUpdated;
        view_output.view = m_view.state();
        view_output.step_index = step_index;
        outputs.push_back(std::move(view_output));
    }

    m_last_commands = std::move(commands);
    m_last_outputs = outputs;
    m_last_diagnostics = diagnostics;

    RuntimeInputResult result;
    result.handled = handled;
    result.view = m_view.state();
    result.outputs = std::move(outputs);
    result.diagnostics = std::move(diagnostics);
    return result;
}

RuntimeDiagnostic RuntimeSessionHost::make_warning(const RuntimeInput& input,
                                                   std::string message) const
{
    RuntimeDiagnostic diagnostic;
    diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
    diagnostic.category = "runtime-input";
    diagnostic.source = input.entity_ref;
    diagnostic.message = std::move(message);
    diagnostic.playback_step_index = input.step_index;
    return diagnostic;
}

std::vector<RuntimeOutput>
RuntimeSessionHost::commands_to_outputs(const std::vector<ControllerCommand>& commands,
                                        std::optional<std::uint64_t> step_index) const
{
    std::vector<RuntimeOutput> outputs;
    outputs.reserve(commands.size());
    for (const auto& command : commands) {
        RuntimeOutput output;
        output.command = command;
        output.step_index = step_index;
        output.payload = command.data;

        switch (command.type) {
        case ControllerCommandType::ModeChanged:
            output.type = RuntimeOutputType::ModeChanged;
            break;
        case ControllerCommandType::ScriptDeferred:
            output.type = RuntimeOutputType::ScriptRequest;
            break;
        case ControllerCommandType::Notification:
            output.type = RuntimeOutputType::Notification;
            break;
        case ControllerCommandType::TextLogged:
            output.type = RuntimeOutputType::TextLogEntry;
            break;
        default:
            output.type = RuntimeOutputType::Command;
            break;
        }

        outputs.push_back(std::move(output));
    }
    return outputs;
}

void RuntimeSessionHost::consume_commands(const std::vector<ControllerCommand>& commands)
{
    m_view.apply(commands);
    if (m_controller && m_controller->current_mode_name() == std::string_view("room")) {
        std::vector<RuntimeUIObject> objects;
        std::vector<RuntimeUIAction> actions;
        if (const auto* project = m_session.project()) {
            const auto room_id = std::string(m_controller->current_mode_entity_id());
            if (auto room_it = project->rooms().find(room_id); room_it != project->rooms().end()) {
                for (const auto& room_object : room_it->second.objects) {
                    auto object_it = project->objects().find(room_object.object_id);
                    RuntimeUIObject object;
                    object.id = room_object.object_id;
                    object.name = object_it != project->objects().end() ? object_it->second.name
                                                                        : room_object.object_id;
                    object.in_room = true;
                    objects.push_back(std::move(object));
                }
            }

            const auto& root = project->document_root();
            if (auto inv_it = root.find(std::string(project_ids::starting_inventory));
                inv_it != root.end() && inv_it->is_array()) {
                for (const auto& item : *inv_it) {
                    if (!item.is_string())
                        continue;
                    const auto id = item.get<std::string>();
                    auto object_it = project->objects().find(id);
                    if (auto existing = std::find_if(
                            objects.begin(), objects.end(),
                            [&](const RuntimeUIObject& object) { return object.id == id; });
                        existing != objects.end()) {
                        existing->in_inventory = true;
                        continue;
                    }
                    RuntimeUIObject object;
                    object.id = id;
                    object.name =
                        object_it != project->objects().end() ? object_it->second.name : id;
                    object.in_inventory = true;
                    objects.push_back(std::move(object));
                }
            }

            for (const auto& [id, verb] : project->verbs()) {
                (void)id;
                if (verb.object_count > 0 || verb.object_count == 0) {
                    RuntimeUIAction action;
                    action.verb_id = verb.metadata.entity.id;
                    action.label = verb.name.empty() ? verb.metadata.entity.id : verb.name;
                    action.object_count = verb.object_count;
                    actions.push_back(std::move(action));
                }
            }
        }
        m_view.set_room_interactions(std::move(objects), std::move(actions));
    }
}

} // namespace noveltea::core
