#include <noveltea/core/runtime_session_host.hpp>

#include <noveltea/core/project_ids.hpp>

#include <algorithm>

namespace noveltea::core {
namespace {

bool project_has_texture_key(const ProjectModel& project, const std::string& key)
{
    const auto& root = project.document_root();
    const auto textures = root.find(std::string(project_ids::textures));
    return textures != root.end() && textures->is_object() &&
           textures->find(key) != textures->end();
}

std::string normalize_visual_asset(const ProjectModel& project, const std::string& value)
{
    if (value.empty()) {
        return {};
    }
    if (value.find(":/") != std::string::npos) {
        return value;
    }
    if (value == "image") {
        return "project:/image";
    }
    if (value.rfind("textures/", 0) == 0) {
        return "project:/" + value;
    }
    if (project_has_texture_key(project, value)) {
        return "project:/textures/" + value;
    }
    return "project:/textures/" + value;
}

std::string object_visual_asset(const ProjectModel& project, const ObjectModel& object)
{
    for (const char* key : {"image", "texture"}) {
        const auto it = object.metadata.properties.find(key);
        if (it != object.metadata.properties.end() && it->is_string()) {
            return normalize_visual_asset(project, it->get<std::string>());
        }
    }
    return {};
}

} // namespace

RuntimeSessionHost::RuntimeSessionHost() = default;
RuntimeSessionHost::~RuntimeSessionHost() = default;

GameSessionLoadResult RuntimeSessionHost::load(ProjectDocument project, SaveDocument save)
{
    reset();
    m_loaded_project = project;
    auto result = m_session.load(std::move(project), std::move(save));
    if (!result.success) {
        return result;
    }

    m_controller = std::make_unique<RuntimeController>(m_session);
    if (const auto* session_save = m_session.save()) {
        m_view.set_saved_text_log(session_save->root()[project_ids::log]);
    }
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
    m_loaded_project.reset();
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
            return make_result(
                false, {},
                {make_input_diagnostic(input, "object-selection",
                                       "object selection input requires an object id")},
                input.step_index);
        }
        if (current_mode_name() != std::string_view("room")) {
            return make_result(
                false, {},
                {make_input_diagnostic(input, "object-selection",
                                       "object selection input is only valid in room mode")},
                input.step_index);
        }
        if (!visible_object_available(object_id)) {
            RuntimeDiagnostic diagnostic = make_input_diagnostic(
                input, "object-selection", "object is not available for selection");
            diagnostic.source = EntityRef{EntityType::Object, object_id};
            return make_result(false, {}, {std::move(diagnostic)}, input.step_index);
        }
        auto it = std::find(m_selected_object_ids.begin(), m_selected_object_ids.end(), object_id);
        if (it == m_selected_object_ids.end()) {
            m_selected_object_ids.push_back(object_id);
        } else {
            m_selected_object_ids.erase(it);
        }
        auto result = make_result(true, {}, {}, input.step_index);
        result.outputs.push_back(make_selection_observation(input.step_index));
        m_last_outputs = result.outputs;
        return result;
    }
    case RuntimeInputType::ClearObjectSelection: {
        m_selected_object_ids.clear();
        auto result = make_result(true, {}, {}, input.step_index);
        result.outputs.push_back(make_selection_observation(input.step_index));
        m_last_outputs = result.outputs;
        return result;
    }
    case RuntimeInputType::RunAction: {
        auto object_ids = input.object_ids.empty() ? m_selected_object_ids : input.object_ids;
        const bool processed = m_controller->process_action(input.verb_id, object_ids);
        auto commands = m_controller->take_commands();
        if (!processed) {
            RuntimeDiagnostic diagnostic =
                make_input_diagnostic(input, "action", "action input was not processed");
            if (!input.verb_id.empty()) {
                diagnostic.source = EntityRef{EntityType::Verb, input.verb_id};
            }
            return make_result(false, std::move(commands), {std::move(diagnostic)},
                               input.step_index);
        }
        m_selected_object_ids.clear();
        return make_result(true, std::move(commands), {}, input.step_index);
    }
    case RuntimeInputType::SetEntrypoint:
        return unsupported(
            "set-entrypoint input is handled by editor preview sessions in this phase");
    case RuntimeInputType::LoadSave:
        if (input.payload.contains("slot") && input.payload["slot"].is_number_integer()) {
            return load_save(SaveSlotId{input.payload["slot"].get<int>()});
        }
        if (input.payload.contains("save") && input.payload["save"].is_object()) {
            return load_save(SaveDocument(input.payload["save"]));
        }
        return unsupported("load-save input requires a slot or save payload");
    case RuntimeInputType::ApplyTestStep:
        return unsupported("apply-test-step input is defined for the runtime contract but has no "
                           "step executor yet");
    }

    return unsupported("unknown runtime input");
}

SaveDocument RuntimeSessionHost::snapshot_save() const
{
    auto save = m_session.snapshot_save();
    if (m_controller) {
        save.root()["_novelteaRuntime"]["controller"] = m_controller->save_state();
    }
    return save;
}

RuntimeInputResult RuntimeSessionHost::save(SaveSlotId slot)
{
    return finish_save(slot, slot.is_autosave(), make_save_hook_commands(true, slot.is_autosave()));
}

RuntimeInputResult RuntimeSessionHost::autosave() { return save(SaveSlotId::autosave()); }

RuntimeInputResult RuntimeSessionHost::load_save(SaveSlotId slot)
{
    if (!m_save_slots) {
        return make_result(false, {},
                           {RuntimeDiagnostic{RuntimeDiagnosticSeverity::Warning,
                                              "save-slot",
                                              std::nullopt,
                                              {},
                                              {},
                                              "no save slot store is bound",
                                              {},
                                              std::nullopt}});
    }
    auto loaded = m_save_slots->read_slot(slot);
    if (!loaded.success || !loaded.save.has_value()) {
        RuntimeDiagnostic diagnostic;
        diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
        diagnostic.category = "save-slot";
        diagnostic.message =
            loaded.errors.empty() ? "failed to read save slot" : loaded.errors.front().message;
        return make_result(false, {}, {std::move(diagnostic)});
    }
    return load_save(std::move(*loaded.save));
}

RuntimeInputResult RuntimeSessionHost::load_save(SaveDocument save)
{
    if (!m_loaded_project) {
        RuntimeDiagnostic diagnostic;
        diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
        diagnostic.category = "save-slot";
        diagnostic.message = "runtime session has no project to reload";
        return make_result(false, {}, {std::move(diagnostic)});
    }

    auto project = *m_loaded_project;
    auto result = load(std::move(project), std::move(save));
    std::vector<RuntimeDiagnostic> diagnostics;
    for (const auto& session_diag : result.diagnostics) {
        RuntimeDiagnostic diagnostic;
        diagnostic.severity = session_diag.severity == SessionDiagnosticSeverity::Error
                                  ? RuntimeDiagnosticSeverity::Error
                              : session_diag.severity == SessionDiagnosticSeverity::Warning
                                  ? RuntimeDiagnosticSeverity::Warning
                                  : RuntimeDiagnosticSeverity::Info;
        diagnostic.category = "save-load";
        diagnostic.message = session_diag.message;
        diagnostics.push_back(std::move(diagnostic));
    }
    if (!result.success) {
        return make_result(false, {}, std::move(diagnostics));
    }

    std::vector<ControllerCommand> commands;
    if (m_controller) {
        const auto& root = m_session.save()->root();
        if (auto rt = root.find("_novelteaRuntime");
            rt != root.end() && rt->is_object() && rt->contains("controller")) {
            m_controller->restore_state((*rt)["controller"]);
            auto restored = m_controller->take_commands();
            commands.insert(commands.end(), restored.begin(), restored.end());
        }
    }
    auto after = make_save_hook_commands(false, false);
    commands.insert(commands.end(), after.begin(), after.end());

    auto input_result = make_result(true, std::move(commands), std::move(diagnostics));
    RuntimeOutput output;
    output.type = RuntimeOutputType::SaveMutationRequest;
    output.payload = {{"operation", "load"}};
    input_result.outputs.push_back(output);
    m_last_outputs = input_result.outputs;
    return input_result;
}

RuntimeInputResult
RuntimeSessionHost::flush_pending_outputs(std::optional<std::uint64_t> step_index)
{
    RuntimeInputResult result;
    if (!m_controller) {
        result = make_result(false, {}, {}, step_index);
    } else {
        (void)m_session.events().dispatch_queued();
        result = make_result(true, m_controller->take_commands(), {}, step_index);
    }
    if (!m_pending_outputs.empty()) {
        for (auto& output : m_pending_outputs) {
            if (!output.step_index.has_value()) {
                output.step_index = step_index;
            }
            result.outputs.push_back(std::move(output));
        }
        m_pending_outputs.clear();
        m_last_outputs = result.outputs;
    }
    return result;
}

void RuntimeSessionHost::enqueue_audio_command(nlohmann::json payload,
                                               std::optional<std::uint64_t> step_index)
{
    RuntimeOutput output;
    output.type = RuntimeOutputType::AudioCommand;
    output.payload = std::move(payload);
    output.step_index = step_index;
    m_pending_outputs.push_back(std::move(output));
}

RuntimeInputResult RuntimeSessionHost::make_result(bool handled,
                                                   std::vector<ControllerCommand> commands,
                                                   std::vector<RuntimeDiagnostic> diagnostics,
                                                   std::optional<std::uint64_t> step_index)
{
    consume_commands(commands);
    if (m_session.loaded()) {
        m_view.sync_visuals(m_session);
        m_view.sync_map(m_session);
    }

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
    return make_input_diagnostic(input, "runtime-input", std::move(message));
}

RuntimeDiagnostic RuntimeSessionHost::make_input_diagnostic(const RuntimeInput& input,
                                                            std::string category,
                                                            std::string message) const
{
    RuntimeDiagnostic diagnostic;
    diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
    diagnostic.category = std::move(category);
    diagnostic.source = input.entity_ref;
    diagnostic.message = std::move(message);
    diagnostic.playback_step_index = input.step_index;
    return diagnostic;
}

std::vector<ControllerCommand> RuntimeSessionHost::make_save_hook_commands(bool before,
                                                                           bool autosave) const
{
    std::vector<ControllerCommand> commands;
    const auto* project = m_session.project();
    if (!project) {
        return commands;
    }
    const auto& root = project->document_root();
    const auto hook_key = before ? project_ids::script_before_save : project_ids::script_after_load;
    auto it = root.find(std::string(hook_key));
    if (it == root.end() || !it->is_string() || it->get<std::string>().empty()) {
        return commands;
    }

    ControllerCommand command;
    command.type = ControllerCommandType::ScriptDeferred;
    command.text = it->get<std::string>();
    command.data = {{"context", before ? "project_before_save" : "project_after_load"},
                    {"autosave", autosave}};
    commands.push_back(std::move(command));
    return commands;
}

RuntimeInputResult RuntimeSessionHost::finish_save(SaveSlotId slot, bool autosave,
                                                   std::vector<ControllerCommand> commands)
{
    if (!m_save_slots) {
        RuntimeDiagnostic diagnostic;
        diagnostic.severity = RuntimeDiagnosticSeverity::Warning;
        diagnostic.category = "save-slot";
        diagnostic.message = "no save slot store is bound";
        return make_result(false, std::move(commands), {std::move(diagnostic)});
    }

    auto saved = snapshot_save();
    auto write = m_save_slots->write_slot(slot, saved);
    std::vector<RuntimeDiagnostic> diagnostics;
    if (!write.success) {
        RuntimeDiagnostic diagnostic;
        diagnostic.severity = RuntimeDiagnosticSeverity::Error;
        diagnostic.category = "save-slot";
        diagnostic.message =
            write.errors.empty() ? "failed to write save slot" : write.errors.front().message;
        diagnostics.push_back(std::move(diagnostic));
        return make_result(false, std::move(commands), std::move(diagnostics));
    }

    auto result = make_result(true, std::move(commands), {});
    RuntimeOutput output;
    output.type = RuntimeOutputType::SaveMutationRequest;
    output.payload = {{"operation", "save"}, {"slot", slot.value}, {"autosave", autosave}};
    result.outputs.push_back(std::move(output));
    m_last_outputs = result.outputs;
    return result;
}

std::vector<RuntimeOutput>
RuntimeSessionHost::commands_to_outputs(const std::vector<ControllerCommand>& commands,
                                        std::optional<std::uint64_t> step_index) const
{
    std::vector<RuntimeOutput> outputs;
    outputs.reserve(commands.size());
    const auto text_command_count = static_cast<std::size_t>(
        std::count_if(commands.begin(), commands.end(), [](const auto& command) {
            return command.type == ControllerCommandType::TextLogged;
        }));
    const auto& text_log = m_view.state().text_log;
    const std::size_t first_text_index =
        text_log.size() >= text_command_count ? text_log.size() - text_command_count : 0;
    std::size_t text_output_index = 0;
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
            if (first_text_index + text_output_index < text_log.size()) {
                output.payload =
                    text_log_entry_to_json(text_log[first_text_index + text_output_index]);
            }
            ++text_output_index;
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
    sync_room_interactions();
}

void RuntimeSessionHost::sync_room_interactions()
{
    if (!m_controller || m_controller->current_mode_name() != std::string_view("room")) {
        return;
    }

    std::vector<RuntimeUIObject> objects;
    std::vector<RuntimeUIAction> actions;
    if (const auto* project = m_session.project()) {
        const auto room_id = std::string(m_controller->current_mode_entity_id());
        if (auto room_it = project->rooms().find(room_id); room_it != project->rooms().end()) {
            for (const auto& [object_id, object_model] : project->objects()) {
                auto location = m_session.effective_object_location(object_id);
                if (!location || location->type != EntityType::Room || location->id != room_id) {
                    continue;
                }
                RuntimeUIObject object;
                object.id = object_id;
                object.name = object_model.name.empty() ? object_id : object_model.name;
                object.image = object_visual_asset(*project, object_model);
                object.in_room = true;
                object.selected =
                    std::find(m_selected_object_ids.begin(), m_selected_object_ids.end(),
                              object_id) != m_selected_object_ids.end();
                objects.push_back(std::move(object));
            }
        }

        for (const auto& [id, object_model] : project->objects()) {
            auto location = m_session.effective_object_location(id);
            if (!location || location->type != EntityType::CustomScript ||
                location->id != project_ids::player) {
                continue;
            }
            const bool selected =
                std::find(m_selected_object_ids.begin(), m_selected_object_ids.end(), id) !=
                m_selected_object_ids.end();
            if (auto existing =
                    std::find_if(objects.begin(), objects.end(),
                                 [&](const RuntimeUIObject& object) { return object.id == id; });
                existing != objects.end()) {
                existing->in_inventory = true;
                existing->selected = selected;
                continue;
            }
            RuntimeUIObject object;
            object.id = id;
            object.name = object_model.name.empty() ? id : object_model.name;
            object.image = object_visual_asset(*project, object_model);
            object.in_inventory = true;
            object.selected = selected;
            objects.push_back(std::move(object));
        }

        const auto selected_count = static_cast<int>(m_selected_object_ids.size());
        const bool selected_available = selected_objects_available();
        for (const auto& [id, verb] : project->verbs()) {
            (void)id;
            RuntimeUIAction action;
            action.verb_id = verb.metadata.entity.id;
            action.label = verb.name.empty() ? verb.metadata.entity.id : verb.name;
            action.object_count = verb.object_count;
            action.selected_count = selected_count;
            action.enabled = selected_available && verb.object_count == selected_count;
            if (verb.object_count != selected_count) {
                action.reason = "requires " + std::to_string(verb.object_count) + " object";
                if (verb.object_count != 1) {
                    action.reason += "s";
                }
            } else if (!selected_available) {
                action.reason = "selected object unavailable";
            }
            actions.push_back(std::move(action));
        }
    }
    m_view.set_room_interactions(std::move(objects), std::move(actions));
}

bool RuntimeSessionHost::visible_object_available(const std::string& object_id) const
{
    const auto& objects = m_view.state().objects;
    return std::any_of(objects.begin(), objects.end(), [&](const RuntimeUIObject& object) {
        return object.id == object_id && object.enabled && (object.in_room || object.in_inventory);
    });
}

bool RuntimeSessionHost::selected_objects_available() const
{
    return std::all_of(
        m_selected_object_ids.begin(), m_selected_object_ids.end(),
        [&](const std::string& object_id) { return visible_object_available(object_id); });
}

RuntimeOutput
RuntimeSessionHost::make_selection_observation(std::optional<std::uint64_t> step_index) const
{
    RuntimeOutput output;
    output.type = RuntimeOutputType::TestObservation;
    output.payload = {{"selected_objects", m_selected_object_ids}};
    output.step_index = step_index;
    return output;
}

} // namespace noveltea::core
