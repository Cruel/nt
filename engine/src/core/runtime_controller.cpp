#include <noveltea/core/runtime_controller.hpp>

#include <nlohmann/json.hpp>

namespace noveltea::core {

RuntimeController::RuntimeController(GameSession& session)
    : m_session(&session)
{
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

    if (m_mode != Mode::Room) {
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
    default:
        emit_command(ControllerCommand{
            ControllerCommandType::ScriptDeferred,
            *ref, ref->id, {
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

void RuntimeController::exit_current_mode()
{
    if (m_mode == Mode::None) {
        return;
    }

    if (m_mode == Mode::Room) {
        m_visit_counts[m_mode_entity_id]++;
    }

    emit_command(ControllerCommand{
        ControllerCommandType::ModeChanged,
        EntityRef{EntityType::Room, m_mode_entity_id},
        std::string(current_mode_name()),
        {{"entering", false}},
    });

    m_mode = Mode::None;
    m_mode_entity_id.clear();
}

std::string_view RuntimeController::current_mode_name() const noexcept
{
    switch (m_mode) {
    case Mode::Room: return "room";
    case Mode::Dialogue: return "dialogue";
    case Mode::Cutscene: return "cutscene";
    case Mode::Script: return "script";
    case Mode::None: return "none";
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

std::vector<ControllerCommand> RuntimeController::take_commands()
{
    auto commands = std::move(m_commands);
    m_commands.clear();
    return commands;
}

void RuntimeController::emit_command(ControllerCommand cmd)
{
    m_commands.push_back(std::move(cmd));
}

} // namespace noveltea::core
