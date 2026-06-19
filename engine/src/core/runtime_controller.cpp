#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/dialogue_controller.hpp>
#include <noveltea/core/cutscene_controller.hpp>
#include <noveltea/core/project_ids.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>

namespace noveltea::core {
namespace {

std::string project_string_or_empty(const ProjectModel& project, std::string_view key)
{
    const auto& root = project.document_root();
    auto it = root.find(std::string(key));
    if (it == root.end() || !it->is_string()) {
        return {};
    }
    return it->get<std::string>();
}

bool action_objects_match(const ActionModel& action, const std::vector<std::string>& object_ids)
{
    if (action.object_ids.size() != object_ids.size()) {
        return false;
    }

    for (std::size_t i = 0; i < action.object_ids.size(); ++i) {
        const auto& expected = action.object_ids[i];
        if (action.position_dependent) {
            if (object_ids[i] != expected) {
                return false;
            }
        } else if (std::find(object_ids.begin(), object_ids.end(), expected) == object_ids.end()) {
            return false;
        }
    }
    return true;
}

} // namespace

RuntimeController::RuntimeController(GameSession& session)
    : m_session(&session), m_dialogue_controller(std::make_unique<DialogueController>(session)),
      m_cutscene_controller(std::make_unique<CutsceneController>(session))
{
    m_notification_listener = m_session->events().listen(
        RuntimeEventType::Notification, [this](const RuntimeEvent& event) {
            emit_command(ControllerCommand{
                ControllerCommandType::Notification,
                std::nullopt,
                event.text,
                {{"duration_ms", event.number_value}, {"data", event.data}},
            });
            return true;
        });
    m_text_log_listener =
        m_session->events().listen(RuntimeEventType::TextLogged, [this](const RuntimeEvent& event) {
            emit_command(ControllerCommand{
                ControllerCommandType::TextLogged,
                std::nullopt,
                event.text,
                {{"data", event.data}},
            });
            return true;
        });
}

RuntimeController::~RuntimeController()
{
    if (m_session != nullptr) {
        if (m_notification_listener != 0) {
            (void)m_session->events().remove(m_notification_listener);
        }
        if (m_text_log_listener != 0) {
            (void)m_session->events().remove(m_text_log_listener);
        }
    }
}

void RuntimeController::tick(double delta_seconds)
{
    m_session->tick(delta_seconds);

    if (!m_startup_handled && m_mode == Mode::None) {
        m_startup_handled = true;
        if (auto ep = m_session->startup_entrypoint(); ep.has_value()) {
            if (ep->type == EntityType::Room) {
                enter_room(ep->id);
                return;
            }
            m_session->queue_entity(*ep);
        }
    }

    if (m_mode == Mode::Dialogue) {
        m_dialogue_controller->tick(delta_seconds);
        if (m_dialogue_controller->is_complete()) {
            process_dialogue_commands();
        }
    } else if (m_mode == Mode::Cutscene) {
        m_cutscene_controller->tick(delta_seconds);
        if (m_cutscene_controller->is_complete()) {
            process_cutscene_commands();
        }
    } else if (m_mode != Mode::Room) {
        drain_next();
    }
}

void RuntimeController::drain_next()
{
    auto ref = m_session->pop_next_entity();
    if (!ref.has_value()) {
        if (m_mode == Mode::None) {
            m_idle = true;
        }
        return;
    }

    m_idle = false;

    if (m_mode != Mode::None) {
        exit_current_mode();
    }

    switch (ref->type) {
    case EntityType::Room:
        enter_room(ref->id);
        break;
    case EntityType::Dialogue:
        m_dialogue_controller->start(ref->id);
        m_mode = Mode::Dialogue;
        m_mode_entity_id = ref->id;
        emit_command(ControllerCommand{
            ControllerCommandType::ModeChanged,
            EntityRef{EntityType::Dialogue, ref->id},
            "dialogue",
            {{"entering", true}},
        });
        break;
    case EntityType::Cutscene:
        m_cutscene_controller->start(ref->id);
        m_mode = Mode::Cutscene;
        m_mode_entity_id = ref->id;
        emit_command(ControllerCommand{
            ControllerCommandType::ModeChanged,
            EntityRef{EntityType::Cutscene, ref->id},
            "cutscene",
            {{"entering", true}},
        });
        break;
    case EntityType::Script:
    case EntityType::CustomScript:
        process_script_entity(*ref);
        break;
    default:
        emit_command(ControllerCommand{
            ControllerCommandType::ScriptDeferred,
            *ref,
            ref->id,
            {
                {"entity_type", to_integer(ref->type)},
                {"message", "scripting required to process this entity type"},
            },
        });
        break;
    }
}

void RuntimeController::enter_room(const std::string& room_id)
{
    m_mode = Mode::Room;
    m_mode_entity_id = room_id;
    m_idle = false;

    const auto* project = m_session->project();
    const RoomModel* room = nullptr;
    if (project) {
        if (auto it = project->rooms().find(room_id); it != project->rooms().end()) {
            room = &it->second;
        }
    }

    const bool first_visit = (m_visit_counts[room_id] == 0);

    nlohmann::json mode_data = nlohmann::json::object();
    mode_data["entering"] = true;
    mode_data["first_visit"] = first_visit;
    if (room) {
        mode_data["room_name"] = room->name;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ModeChanged,
        EntityRef{EntityType::Room, room_id},
        "room",
        std::move(mode_data),
    });

    emit_room_enter_hooks(room);

    emit_command(ControllerCommand{
        ControllerCommandType::RoomEntry,
        EntityRef{EntityType::Room, room_id},
        room_id,
        {{"first_visit", first_visit}, {"name", room ? room->name : ""}},
    });

    emit_command(ControllerCommand{
        ControllerCommandType::RoomDescription,
        EntityRef{EntityType::Room, room_id},
        room ? room->description_raw : "",
        {{"name", room ? room->name : ""}, {"first_visit", first_visit}},
    });

    nlohmann::json paths_json = nlohmann::json::array();
    if (room) {
        for (const auto& path : room->paths) {
            nlohmann::json p = nlohmann::json::object();
            p["enabled"] = path.enabled;
            if (path.target) {
                p["target_type"] = to_integer(path.target->type);
                p["target_id"] = path.target->id;
            } else {
                p["target_type"] = -1;
                p["target_id"] = nullptr;
            }
            paths_json.push_back(std::move(p));
        }
    }

    emit_command(ControllerCommand{
        ControllerCommandType::NavigationUpdate,
        EntityRef{EntityType::Room, room_id},
        room_id,
        {{"paths", std::move(paths_json)}},
    });
}

void RuntimeController::dialogue_continue()
{
    if (m_mode == Mode::Dialogue) {
        m_dialogue_controller->continue_to_next();
    }
}

bool RuntimeController::dialogue_select_option(int option_index)
{
    if (m_mode == Mode::Dialogue) {
        return m_dialogue_controller->select_option(option_index);
    }
    return false;
}

void RuntimeController::cutscene_click()
{
    if (m_mode == Mode::Cutscene) {
        m_cutscene_controller->click();
    }
}

void RuntimeController::process_dialogue_commands()
{
    auto commands = m_dialogue_controller->take_commands();
    for (auto& cmd : commands) {
        if (cmd.type == ControllerCommandType::DialogueComplete) {
            if (cmd.data.contains("next_entity_type") && cmd.data.contains("next_entity_id")) {
                auto type_opt = entity_type_from_integer(cmd.data["next_entity_type"].get<int>());
                if (type_opt.has_value()) {
                    auto type = type_opt.value();
                    auto id = cmd.data["next_entity_id"].get<std::string>();
                    if (is_known_entity_type(type) && !id.empty()) {
                        m_session->queue_entity(EntityRef{type, id});
                    }
                }
            }
            m_commands.push_back(std::move(cmd));
        }
    }

    if (m_mode == Mode::Dialogue) {
        exit_current_mode();
    }

    drain_next();
}

void RuntimeController::process_cutscene_commands()
{
    auto commands = m_cutscene_controller->take_commands();
    for (auto& cmd : commands) {
        if (cmd.type == ControllerCommandType::CutsceneComplete) {
            if (cmd.data.contains("next_entity_type") && cmd.data.contains("next_entity_id")) {
                auto type_opt = entity_type_from_integer(cmd.data["next_entity_type"].get<int>());
                if (type_opt.has_value()) {
                    auto type = type_opt.value();
                    auto id = cmd.data["next_entity_id"].get<std::string>();
                    if (is_known_entity_type(type) && !id.empty()) {
                        m_session->queue_entity(EntityRef{type, id});
                    }
                }
            }
            m_commands.push_back(std::move(cmd));
        }
    }

    if (m_mode == Mode::Cutscene) {
        exit_current_mode();
    }

    drain_next();
}

void RuntimeController::exit_current_mode()
{
    if (m_mode == Mode::None) {
        return;
    }

    auto exited_type = EntityType::Invalid;
    switch (m_mode) {
    case Mode::Room:
        exited_type = EntityType::Room;
        break;
    case Mode::Dialogue:
        exited_type = EntityType::Dialogue;
        break;
    case Mode::Cutscene:
        exited_type = EntityType::Cutscene;
        break;
    case Mode::Script:
        exited_type = EntityType::Script;
        break;
    case Mode::None:
        break;
    }

    if (m_mode == Mode::Room) {
        const RoomModel* room = nullptr;
        if (const auto* project = m_session->project()) {
            if (auto it = project->rooms().find(m_mode_entity_id); it != project->rooms().end()) {
                room = &it->second;
            }
        }
        emit_room_leave_hooks(room);
        m_visit_counts[m_mode_entity_id]++;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ModeChanged,
        EntityRef{exited_type, m_mode_entity_id},
        std::string(current_mode_name()),
        {{"entering", false}},
    });

    m_mode = Mode::None;
    m_mode_entity_id.clear();
}

void RuntimeController::emit_room_hook_script(const RoomModel& room, std::string_view hook_context,
                                              const std::string& script)
{
    if (script.empty()) {
        return;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ScriptDeferred,
        EntityRef{EntityType::Room, room.metadata.entity.id},
        script,
        {{"context", std::string(hook_context)}, {"room_id", room.metadata.entity.id}},
    });
}

void RuntimeController::emit_room_enter_hooks(const RoomModel* room)
{
    if (!room) {
        return;
    }

    const auto* project = m_session->project();
    if (project) {
        emit_room_hook_script(*room, "project_before_enter",
                              project_string_or_empty(*project, project_ids::script_before_enter));
    }
    emit_room_hook_script(*room, "room_before_enter", room->script_before_enter);
    if (project) {
        emit_room_hook_script(*room, "project_after_enter",
                              project_string_or_empty(*project, project_ids::script_after_enter));
    }
    emit_room_hook_script(*room, "room_after_enter", room->script_after_enter);
}

void RuntimeController::emit_room_leave_hooks(const RoomModel* room)
{
    if (!room) {
        return;
    }

    const auto* project = m_session->project();
    if (project) {
        emit_room_hook_script(*room, "project_before_leave",
                              project_string_or_empty(*project, project_ids::script_before_leave));
    }
    emit_room_hook_script(*room, "room_before_leave", room->script_before_leave);
    if (project) {
        emit_room_hook_script(*room, "project_after_leave",
                              project_string_or_empty(*project, project_ids::script_after_leave));
    }
    emit_room_hook_script(*room, "room_after_leave", room->script_after_leave);
}

void RuntimeController::process_script_entity(const EntityRef& ref)
{
    m_mode = Mode::Script;
    m_mode_entity_id = ref.id;

    emit_command(ControllerCommand{
        ControllerCommandType::ModeChanged,
        ref,
        "script",
        {{"entering", true}},
    });

    std::string script = ref.id;
    if (ref.type == EntityType::Script) {
        if (const auto* project = m_session->project()) {
            if (auto it = project->scripts().find(ref.id); it != project->scripts().end()) {
                script = it->second.content;
            }
        }
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ScriptDeferred,
        ref,
        script,
        {{"context", ref.type == EntityType::CustomScript ? "custom_script" : "script"},
         {"script_id", ref.id}},
    });

    exit_current_mode();
}

std::string_view RuntimeController::current_mode_name() const noexcept
{
    switch (m_mode) {
    case Mode::Room:
        return "room";
    case Mode::Dialogue:
        return "dialogue";
    case Mode::Cutscene:
        return "cutscene";
    case Mode::Script:
        return "script";
    case Mode::None:
        return "none";
    }
    return "none";
}

int RuntimeController::visit_count(const std::string& room_id) const
{
    if (auto it = m_visit_counts.find(room_id); it != m_visit_counts.end()) {
        return it->second;
    }
    return 0;
}

void RuntimeController::navigate_path(int direction)
{
    if (m_mode != Mode::Room) {
        return;
    }

    const auto* project = m_session->project();
    if (!project) {
        return;
    }

    auto room_it = project->rooms().find(m_mode_entity_id);
    if (room_it == project->rooms().end()) {
        return;
    }

    const auto& paths = room_it->second.paths;
    if (direction < 0 || direction >= static_cast<int>(paths.size())) {
        return;
    }

    const auto& path = paths[static_cast<std::size_t>(direction)];
    if (!path.enabled || !path.target) {
        return;
    }

    m_session->queue_entity(*path.target);
    exit_current_mode();
}

bool RuntimeController::process_action(const std::string& verb_id,
                                       const std::vector<std::string>& object_ids)
{
    if (m_mode != Mode::Room) {
        return false;
    }

    const auto* project = m_session->project();
    if (!project) {
        return false;
    }

    auto verb_it = project->verbs().find(verb_id);
    if (verb_it == project->verbs().end()) {
        emit_command(ControllerCommand{
            ControllerCommandType::ActionRejected,
            std::nullopt,
            verb_id,
            {{"reason", "unknown verb"}, {"verb_id", verb_id}},
        });
        return false;
    }

    if (verb_it->second.object_count != static_cast<int>(object_ids.size())) {
        emit_command(ControllerCommand{
            ControllerCommandType::ActionRejected,
            std::nullopt,
            verb_id,
            {{"reason", "object count mismatch"},
             {"verb_id", verb_id},
             {"expected_count", verb_it->second.object_count},
             {"actual_count", object_ids.size()}},
        });
        return false;
    }

    nlohmann::json objects_json = nlohmann::json::array();
    for (const auto& object_id : object_ids) {
        objects_json.push_back(object_id);
        if (!object_available_for_action(object_id)) {
            emit_command(ControllerCommand{
                ControllerCommandType::ActionRejected,
                std::nullopt,
                verb_id,
                {{"reason", "object unavailable"}, {"verb_id", verb_id}, {"object_id", object_id}},
            });
            return false;
        }
    }

    emit_action_script(project_string_or_empty(*project, project_ids::script_before_action),
                       "project_before_action", verb_id, object_ids);

    const auto* action = find_action(verb_id, object_ids);
    if (action) {
        emit_action_script_chain(*action, verb_id, object_ids);
        emit_command(ControllerCommand{
            ControllerCommandType::ActionResolved,
            EntityRef{EntityType::Action, action->metadata.entity.id},
            action->metadata.entity.id,
            {{"verb_id", verb_id}, {"object_ids", objects_json}, {"used_default", false}},
        });
    } else {
        emit_action_script(verb_it->second.default_script, "verb_default_action", verb_id,
                           object_ids);
        emit_command(ControllerCommand{
            ControllerCommandType::ActionResolved,
            EntityRef{EntityType::Verb, verb_id},
            verb_id,
            {{"verb_id", verb_id}, {"object_ids", objects_json}, {"used_default", true}},
        });
    }

    emit_action_script(project_string_or_empty(*project, project_ids::script_after_action),
                       "project_after_action", verb_id, object_ids);
    return true;
}

std::vector<ControllerCommand> RuntimeController::take_commands()
{
    if (m_mode == Mode::Dialogue) {
        if (m_dialogue_controller->is_complete()) {
            process_dialogue_commands();
        } else {
            auto sub = m_dialogue_controller->take_commands();
            m_commands.insert(m_commands.end(), sub.begin(), sub.end());
        }
    } else if (m_mode == Mode::Cutscene) {
        if (m_cutscene_controller->is_complete()) {
            process_cutscene_commands();
        } else {
            auto sub = m_cutscene_controller->take_commands();
            m_commands.insert(m_commands.end(), sub.begin(), sub.end());
        }
    }

    auto commands = std::move(m_commands);
    m_commands.clear();
    return commands;
}

void RuntimeController::emit_command(ControllerCommand cmd)
{
    m_commands.push_back(std::move(cmd));
}

nlohmann::json RuntimeController::save_state() const
{
    nlohmann::json state = nlohmann::json::object();
    state["mode"] = std::string(current_mode_name());
    state["mode_entity_id"] = m_mode_entity_id;
    state["idle"] = m_idle;
    state["startup_handled"] = m_startup_handled;

    nlohmann::json visits = nlohmann::json::object();
    for (const auto& [room_id, count] : m_visit_counts) {
        visits[room_id] = count;
    }
    state["visit_counts"] = std::move(visits);

    if (m_mode == Mode::Dialogue) {
        state["dialogue"] = m_dialogue_controller->save_state();
    } else if (m_mode == Mode::Cutscene) {
        state["cutscene"] = m_cutscene_controller->save_state();
    }

    return state;
}

void RuntimeController::restore_state(const nlohmann::json& state)
{
    m_dialogue_controller->reset();
    m_cutscene_controller->reset();
    m_commands.clear();
    m_mode = Mode::None;
    m_mode_entity_id.clear();
    m_idle = state.value("idle", true);
    m_startup_handled = state.value("startup_handled", true);
    m_visit_counts.clear();

    if (auto it = state.find("visit_counts"); it != state.end() && it->is_object()) {
        for (auto visit_it = it->begin(); visit_it != it->end(); ++visit_it) {
            if (visit_it.value().is_number_integer()) {
                m_visit_counts[visit_it.key()] = visit_it.value().get<int>();
            }
        }
    }

    const auto mode = state.value("mode", std::string("none"));
    m_mode_entity_id = state.value("mode_entity_id", std::string());
    if (mode == "room" && !m_mode_entity_id.empty()) {
        m_mode = Mode::Room;
        m_idle = false;
        m_session->set_current_room(m_mode_entity_id);
        enter_room(m_mode_entity_id);
        return;
    }
    if (mode == "dialogue" && state.contains("dialogue")) {
        m_mode = Mode::Dialogue;
        m_dialogue_controller->restore_state(state["dialogue"]);
        if (m_mode_entity_id.empty()) {
            m_mode_entity_id = m_dialogue_controller->current_dialogue_id();
        }
        m_idle = false;
        emit_command(ControllerCommand{
            ControllerCommandType::ModeChanged,
            EntityRef{EntityType::Dialogue, m_mode_entity_id},
            "dialogue",
            {{"entering", true}, {"restored", true}},
        });
        return;
    }
    if (mode == "cutscene" && state.contains("cutscene")) {
        m_mode = Mode::Cutscene;
        m_cutscene_controller->restore_state(state["cutscene"]);
        if (m_mode_entity_id.empty()) {
            m_mode_entity_id = m_cutscene_controller->current_cutscene_id();
        }
        m_idle = false;
        emit_command(ControllerCommand{
            ControllerCommandType::ModeChanged,
            EntityRef{EntityType::Cutscene, m_mode_entity_id},
            "cutscene",
            {{"entering", true}, {"restored", true}},
        });
        return;
    }

    m_mode_entity_id.clear();
    m_mode = Mode::None;
}

bool RuntimeController::object_available_for_action(const std::string& object_id) const
{
    const auto* project = m_session->project();
    if (!project || !project->objects().contains(object_id)) {
        return false;
    }

    if (m_mode_entity_id.empty()) {
        return false;
    }

    auto room_it = project->rooms().find(m_mode_entity_id);
    if (room_it != project->rooms().end()) {
        for (const auto& object : room_it->second.objects) {
            if (object.object_id == object_id) {
                return true;
            }
        }
    }

    const auto& root = project->document_root();
    auto inv_it = root.find(std::string(project_ids::starting_inventory));
    if (inv_it != root.end() && inv_it->is_array()) {
        for (const auto& item : *inv_it) {
            if (item.is_string() && item.get<std::string>() == object_id) {
                return true;
            }
        }
    }

    return false;
}

const ActionModel* RuntimeController::find_action(const std::string& verb_id,
                                                  const std::vector<std::string>& object_ids) const
{
    const auto* project = m_session->project();
    if (!project) {
        return nullptr;
    }

    for (const auto& [id, action] : project->actions()) {
        (void)id;
        if (action.verb_id == verb_id && action_objects_match(action, object_ids)) {
            return &action;
        }
    }
    return nullptr;
}

void RuntimeController::emit_action_script_chain(const ActionModel& action,
                                                 const std::string& verb_id,
                                                 const std::vector<std::string>& object_ids)
{
    const auto* project = m_session->project();
    if (project && !action.metadata.parent_id.empty()) {
        auto parent_it = project->actions().find(action.metadata.parent_id);
        if (parent_it != project->actions().end()) {
            emit_action_script_chain(parent_it->second, verb_id, object_ids);
        }
    }

    emit_action_script(action.script, "action", verb_id, object_ids, action.metadata.entity.id);
}

void RuntimeController::emit_action_script(const std::string& script, const std::string& context,
                                           const std::string& verb_id,
                                           const std::vector<std::string>& object_ids,
                                           const std::optional<std::string>& action_id)
{
    if (script.empty()) {
        return;
    }

    nlohmann::json objects_json = nlohmann::json::array();
    for (const auto& object_id : object_ids) {
        objects_json.push_back(object_id);
    }

    nlohmann::json data = nlohmann::json::object();
    data["context"] = context;
    data["verb_id"] = verb_id;
    data["object_ids"] = std::move(objects_json);
    if (action_id.has_value()) {
        data["action_id"] = *action_id;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ScriptDeferred,
        action_id.has_value() ? std::optional<EntityRef>{EntityRef{EntityType::Action, *action_id}}
                              : std::nullopt,
        script,
        std::move(data),
    });
}

} // namespace noveltea::core
