#include <noveltea/core/game_session.hpp>

#include <nlohmann/json.hpp>

#include <utility>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {
namespace {

SessionDiagnostic validation_to_session(const ValidationIssue& issue)
{
    return SessionDiagnostic{SessionDiagnosticSeverity::Error, issue.path, issue.message};
}

SessionDiagnostic document_to_session(const DocumentError& error)
{
    return SessionDiagnostic{SessionDiagnosticSeverity::Error, error.path, error.message};
}

void add_info(std::vector<SessionDiagnostic>& diagnostics, std::string path, std::string message)
{
    diagnostics.push_back(
        SessionDiagnostic{SessionDiagnosticSeverity::Info, std::move(path), std::move(message)});
}

void add_error(std::vector<SessionDiagnostic>& diagnostics, std::string path, std::string message)
{
    diagnostics.push_back(
        SessionDiagnostic{SessionDiagnosticSeverity::Error, std::move(path), std::move(message)});
}

void add_warning(std::vector<SessionDiagnostic>& diagnostics, std::string path, std::string message)
{
    diagnostics.push_back(
        SessionDiagnostic{SessionDiagnosticSeverity::Warning, std::move(path), std::move(message)});
}

std::string key(std::string_view value) { return std::string(value); }

bool model_has_entity(const ProjectModel& model, const EntityRef& ref)
{
    if (ref.type == EntityType::CustomScript) {
        return ref.has_id();
    }
    return model.metadata(ref.type, ref.id).has_value();
}

} // namespace

GameSession::GameSession() = default;

GameSessionLoadResult GameSession::load(ProjectDocument project, SaveDocument save)
{
    reset();

    GameSessionLoadResult result;

    std::vector<ValidationIssue> project_issues;
    auto model = ProjectModel::from_document(project, project_issues);
    for (const auto& issue : project_issues) {
        result.diagnostics.push_back(validation_to_session(issue));
    }

    std::vector<DocumentError> save_errors;
    if (!save.validate(save_errors)) {
        for (const auto& error : save_errors) {
            result.diagnostics.push_back(document_to_session(error));
        }
    }

    if (!model.has_value() || !save_errors.empty()) {
        result.success = false;
        return result;
    }

    auto entrypoint = resolve_startup_entrypoint(project, save, result.diagnostics);
    if (!entrypoint.has_value()) {
        result.success = false;
        return result;
    }

    m_project = std::move(model);
    m_save = std::move(save);
    m_startup_entrypoint = std::move(entrypoint);
    m_play_time = m_save->play_time();
    restore_runtime_state(*m_save, result.diagnostics);

    RuntimeEvent event;
    event.type = RuntimeEventType::GameLoaded;
    event.number_value = m_play_time;
    event.text = m_startup_entrypoint->id;
    event.data = m_startup_entrypoint->to_json();
    m_events.push(std::move(event));

    emit_command(SessionCommand{SessionCommandType::StartupResolved, m_startup_entrypoint,
                                m_startup_entrypoint->id, true});
    add_info(result.diagnostics, "/entrypoint", "session startup entrypoint resolved");
    result.success = true;
    return result;
}

void GameSession::reset()
{
    m_project.reset();
    m_save.reset();
    m_events.clear();
    m_timers.reset();
    m_startup_entrypoint.reset();
    m_current_entity.reset();
    m_current_room_id.reset();
    m_current_map_id.reset();
    m_navigation_enabled = true;
    m_map_enabled = true;
    m_entity_queue.clear();
    m_commands.clear();
    m_play_time = 0.0;
}

void GameSession::tick(double delta_seconds)
{
    if (delta_seconds < 0.0) {
        delta_seconds = 0.0;
    }
    m_play_time += delta_seconds;
    (void)m_timers.update(delta_seconds, &m_events);
    (void)m_events.dispatch_queued();
}

const ProjectModel* GameSession::project() const noexcept
{
    return m_project ? &*m_project : nullptr;
}

const SaveDocument* GameSession::save() const noexcept { return m_save ? &*m_save : nullptr; }

RuntimeStateSnapshot GameSession::runtime_state() const
{
    RuntimeStateSnapshot snapshot;
    snapshot.current_entity = m_current_entity;
    snapshot.current_room_id = m_current_room_id;
    snapshot.current_map_id = m_current_map_id;
    snapshot.navigation_enabled = m_navigation_enabled;
    snapshot.map_enabled = m_map_enabled;
    snapshot.queued_entity_count = m_entity_queue.size();
    return snapshot;
}

void GameSession::queue_entity(EntityRef ref)
{
    m_entity_queue.push_back(ref);
    emit_command(SessionCommand{SessionCommandType::EntityQueued, std::move(ref),
                                m_entity_queue.back().id, true});
}

std::optional<EntityRef> GameSession::pop_next_entity()
{
    if (m_entity_queue.empty()) {
        return std::nullopt;
    }
    auto next = m_entity_queue.front();
    m_entity_queue.pop_front();
    m_current_entity = next;
    emit_command(SessionCommand{SessionCommandType::EntityDequeued, next, next.id, true});
    if (next.type == EntityType::Room) {
        set_current_room(next.id);
    }
    return next;
}

void GameSession::set_current_room(std::string room_id)
{
    m_current_room_id = room_id;
    emit_command(SessionCommand{SessionCommandType::CurrentRoomChanged,
                                EntityRef{EntityType::Room, room_id}, room_id, true});
}

void GameSession::set_current_map(std::string map_id)
{
    m_current_map_id = map_id;
    emit_command(SessionCommand{SessionCommandType::CurrentMapChanged,
                                EntityRef{EntityType::Map, map_id}, map_id, true});
}

std::vector<SessionCommand> GameSession::take_commands()
{
    auto commands = std::move(m_commands);
    m_commands.clear();
    return commands;
}

std::optional<EntityRef>
GameSession::resolve_startup_entrypoint(const ProjectDocument& project, const SaveDocument& save,
                                        std::vector<SessionDiagnostic>& diagnostics) const
{
    if (const auto save_entrypoint = save.entrypoint();
        save_entrypoint.has_value() && save_entrypoint->has_id()) {
        add_info(diagnostics, "/entrypoint", "using save entrypoint");
        return save_entrypoint;
    }

    if (!project.has_valid_entrypoint()) {
        add_error(diagnostics, "/" + std::string(project_ids::entrypoint_entity),
                  "project has no valid startup entrypoint");
        return std::nullopt;
    }

    const auto parsed =
        EntityRef::from_json(project.root().at(std::string(project_ids::entrypoint_entity)));
    if (!parsed.has_value() || !parsed->has_id()) {
        add_error(diagnostics, "/" + std::string(project_ids::entrypoint_entity),
                  "project has no valid startup entrypoint");
        return std::nullopt;
    }
    add_info(diagnostics, "/entrypoint", "using project entrypoint");
    return parsed;
}

void GameSession::restore_runtime_state(const SaveDocument& save,
                                        std::vector<SessionDiagnostic>& diagnostics)
{
    m_current_entity = m_startup_entrypoint;
    m_navigation_enabled = save.navigation_enabled();
    m_map_enabled = save.map_enabled();
    emit_command(SessionCommand{SessionCommandType::NavigationStateChanged, std::nullopt,
                                "navigation", m_navigation_enabled});
    emit_command(SessionCommand{SessionCommandType::NavigationStateChanged, std::nullopt, "map",
                                m_map_enabled});

    if (m_startup_entrypoint && m_startup_entrypoint->type == EntityType::Room) {
        m_current_room_id = m_startup_entrypoint->id;
        emit_command(SessionCommand{SessionCommandType::CurrentRoomChanged, m_startup_entrypoint,
                                    m_startup_entrypoint->id, true});
    }

    if (const auto map_id = save.current_map_id(); !map_id.empty()) {
        if (m_project && m_project->maps().contains(map_id)) {
            m_current_map_id = map_id;
            emit_command(SessionCommand{SessionCommandType::CurrentMapChanged,
                                        EntityRef{EntityType::Map, map_id}, map_id, true});
        } else {
            add_warning(diagnostics, "/map",
                        "saved current map '" + map_id + "' does not exist in project");
        }
    }

    const auto& root = save.root();
    const auto queue_it = root.find(key(project_ids::entity_queue));
    if (queue_it == root.end()) {
        return;
    }
    if (!queue_it->is_array()) {
        add_warning(diagnostics, "/entityQueue", "expected array; saved entity queue ignored");
        return;
    }
    for (std::size_t i = 0; i < queue_it->size(); ++i) {
        const auto path = "/entityQueue/" + std::to_string(i);
        auto ref = EntityRef::from_json((*queue_it)[i]);
        if (!ref.has_value() || !ref->has_id()) {
            add_warning(diagnostics, path,
                        "expected selected-entity array [type, id]; entry ignored");
            continue;
        }
        if (m_project && !model_has_entity(*m_project, *ref)) {
            add_warning(diagnostics, path,
                        "queued entity '" + ref->id + "' does not exist in project; entry ignored");
            continue;
        }
        queue_entity(*ref);
    }
}

void GameSession::emit_command(SessionCommand command) { m_commands.push_back(std::move(command)); }

} // namespace noveltea::core
