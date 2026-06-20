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

constexpr std::string_view entity_properties_key = "entityProperties";
constexpr std::string_view controller_state_key = "_novelteaRuntime";

bool model_has_entity(const ProjectModel& model, const EntityRef& ref)
{
    if (ref.type == EntityType::CustomScript) {
        return ref.has_id();
    }
    return model.metadata(ref.type, ref.id).has_value();
}

nlohmann::json& ensure_object(nlohmann::json& root, std::string_view field)
{
    auto& value = root[key(field)];
    if (!value.is_object()) {
        value = nlohmann::json::object();
    }
    return value;
}

nlohmann::json& ensure_entity_properties(nlohmann::json& root, EntityType type,
                                         const std::string& id)
{
    auto& overrides = ensure_object(root, entity_properties_key);
    const auto type_key = std::to_string(to_integer(type));
    auto& type_bucket = overrides[type_key];
    if (!type_bucket.is_object()) {
        type_bucket = nlohmann::json::object();
    }
    auto& entity_bucket = type_bucket[id];
    if (!entity_bucket.is_object()) {
        entity_bucket = nlohmann::json::object();
    }
    return entity_bucket;
}

const nlohmann::json* find_entity_properties(const nlohmann::json& root, EntityType type,
                                             const std::string& id)
{
    const auto overrides_it = root.find(key(entity_properties_key));
    if (overrides_it == root.end() || !overrides_it->is_object()) {
        return nullptr;
    }
    const auto type_it = overrides_it->find(std::to_string(to_integer(type)));
    if (type_it == overrides_it->end() || !type_it->is_object()) {
        return nullptr;
    }
    const auto entity_it = type_it->find(id);
    if (entity_it == type_it->end() || !entity_it->is_object()) {
        return nullptr;
    }
    return &*entity_it;
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

SaveDocument GameSession::snapshot_save() const
{
    nlohmann::json root = m_save ? m_save->root() : SaveDocument::new_save().root();
    root[key(project_ids::play_time)] = m_play_time;
    root[key(project_ids::navigation_enabled)] = m_navigation_enabled;
    root[key(project_ids::map_enabled)] = m_map_enabled;

    if (m_current_entity && m_current_entity->has_id()) {
        root[key(project_ids::entrypoint_entity)] = m_current_entity->to_json();
    } else if (m_startup_entrypoint && m_startup_entrypoint->has_id()) {
        root[key(project_ids::entrypoint_entity)] = m_startup_entrypoint->to_json();
    }

    if (m_current_map_id && !m_current_map_id->empty()) {
        root[key(project_ids::save_map)] = *m_current_map_id;
    } else {
        root.erase(key(project_ids::save_map));
    }

    nlohmann::json queue = nlohmann::json::array();
    for (const auto& ref : m_entity_queue) {
        queue.push_back(ref.to_json());
    }
    root[key(project_ids::entity_queue)] = std::move(queue);

    ensure_object(root, project_ids::properties);
    ensure_object(root, project_ids::room_descriptions);
    ensure_object(root, project_ids::visited_rooms);
    ensure_object(root, project_ids::object_locations);
    if (!root.contains(key(project_ids::log)) || !root[key(project_ids::log)].is_array()) {
        root[key(project_ids::log)] = nlohmann::json::array();
    }

    if (!root.contains(std::string(controller_state_key)) ||
        !root[std::string(controller_state_key)].is_object()) {
        root[std::string(controller_state_key)] = nlohmann::json::object();
    }

    return SaveDocument(std::move(root));
}

void GameSession::replace_save(SaveDocument save)
{
    std::vector<SessionDiagnostic> diagnostics;
    m_save = std::move(save);
    m_play_time = m_save->play_time();
    m_entity_queue.clear();
    restore_runtime_state(*m_save, diagnostics);
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

void GameSession::set_navigation_enabled(bool enabled)
{
    m_navigation_enabled = enabled;
    if (m_save) {
        m_save->root()[key(project_ids::navigation_enabled)] = enabled;
    }
    emit_command(SessionCommand{SessionCommandType::NavigationStateChanged, std::nullopt,
                                "navigation", enabled});
}

void GameSession::set_map_enabled(bool enabled)
{
    m_map_enabled = enabled;
    if (m_save) {
        m_save->root()[key(project_ids::map_enabled)] = enabled;
    }
    emit_command(
        SessionCommand{SessionCommandType::NavigationStateChanged, std::nullopt, "map", enabled});
}

void GameSession::mark_room_visited(const std::string& room_id)
{
    if (!m_save) {
        return;
    }
    auto& visited = ensure_object(m_save->root(), project_ids::visited_rooms);
    const int count = visited.value(room_id, 0);
    visited[room_id] = count + 1;
}

int GameSession::visited_room_count(const std::string& room_id) const
{
    if (!m_save) {
        return 0;
    }
    const auto& root = m_save->root();
    auto it = root.find(key(project_ids::visited_rooms));
    if (it == root.end() || !it->is_object()) {
        return 0;
    }
    return it->value(room_id, 0);
}

nlohmann::json GameSession::property(std::string_view property_key) const
{
    if (m_save) {
        const auto& root = m_save->root();
        if (auto props_it = root.find(key(project_ids::properties));
            props_it != root.end() && props_it->is_object()) {
            if (auto value_it = props_it->find(std::string(property_key));
                value_it != props_it->end()) {
                return *value_it;
            }
        }
    }
    if (m_project) {
        const auto& root = m_project->document_root();
        if (auto props_it = root.find(key(project_ids::properties));
            props_it != root.end() && props_it->is_object()) {
            if (auto value_it = props_it->find(std::string(property_key));
                value_it != props_it->end()) {
                return *value_it;
            }
        }
    }
    return nullptr;
}

void GameSession::set_property(std::string property_key, nlohmann::json value)
{
    if (!m_save) {
        return;
    }
    ensure_object(m_save->root(), project_ids::properties)[std::move(property_key)] =
        std::move(value);
}

void GameSession::unset_property(std::string_view property_key)
{
    if (!m_save) {
        return;
    }
    auto& properties = ensure_object(m_save->root(), project_ids::properties);
    properties.erase(std::string(property_key));
}

nlohmann::json GameSession::entity_property(EntityType type, const std::string& id,
                                            std::string_view property_key) const
{
    if (m_save) {
        if (const auto* overrides = find_entity_properties(m_save->root(), type, id)) {
            if (auto value_it = overrides->find(std::string(property_key));
                value_it != overrides->end()) {
                return *value_it;
            }
        }
    }
    if (m_project) {
        const auto merged = m_project->merged_properties(type, id);
        if (auto value_it = merged.find(std::string(property_key)); value_it != merged.end()) {
            return *value_it;
        }
    }
    return nullptr;
}

void GameSession::set_entity_property(EntityType type, std::string id, std::string property_key,
                                      nlohmann::json value)
{
    if (!m_save) {
        return;
    }
    ensure_entity_properties(m_save->root(), type, id)[std::move(property_key)] = std::move(value);
}

void GameSession::unset_entity_property(EntityType type, const std::string& id,
                                        std::string_view property_key)
{
    if (!m_save) {
        return;
    }
    auto& properties = ensure_entity_properties(m_save->root(), type, id);
    properties.erase(std::string(property_key));
}

std::optional<EntityRef> GameSession::object_location(const std::string& object_id) const
{
    if (!m_save) {
        return std::nullopt;
    }
    const auto& root = m_save->root();
    const auto locations_it = root.find(key(project_ids::object_locations));
    if (locations_it == root.end() || !locations_it->is_object()) {
        return std::nullopt;
    }
    const auto location_it = locations_it->find(object_id);
    if (location_it == locations_it->end()) {
        return std::nullopt;
    }
    return EntityRef::from_json(*location_it);
}

std::optional<EntityRef> GameSession::effective_object_location(const std::string& object_id) const
{
    if (auto saved = object_location(object_id); saved.has_value()) {
        return saved;
    }
    if (!m_project) {
        return std::nullopt;
    }
    for (const auto& [room_id, room] : m_project->rooms()) {
        for (const auto& object : room.objects) {
            if (object.object_id == object_id) {
                return EntityRef{EntityType::Room, room_id};
            }
        }
    }
    const auto& root = m_project->document_root();
    auto inv_it = root.find(key(project_ids::starting_inventory));
    if (inv_it != root.end() && inv_it->is_array()) {
        for (const auto& item : *inv_it) {
            if (item.is_string() && item.get<std::string>() == object_id) {
                return EntityRef{EntityType::CustomScript, std::string(project_ids::player)};
            }
        }
    }
    return std::nullopt;
}

void GameSession::set_object_location(std::string object_id, EntityRef location)
{
    if (!m_save) {
        return;
    }
    ensure_object(m_save->root(), project_ids::object_locations)[std::move(object_id)] =
        location.to_json();
}

void GameSession::clear_object_location(const std::string& object_id)
{
    if (!m_save) {
        return;
    }
    auto& locations = ensure_object(m_save->root(), project_ids::object_locations);
    locations.erase(object_id);
}

void GameSession::append_log(std::string text, nlohmann::json data)
{
    if (m_save) {
        auto& log = m_save->root()[key(project_ids::log)];
        if (!log.is_array()) {
            log = nlohmann::json::array();
        }
        log.push_back(text);
    }

    RuntimeEvent event;
    event.type = RuntimeEventType::TextLogged;
    event.text = std::move(text);
    event.data = std::move(data);
    m_events.push(std::move(event));
}

void GameSession::notify(std::string text, double duration_ms, nlohmann::json data)
{
    RuntimeEvent event;
    event.type = RuntimeEventType::Notification;
    event.number_value = duration_ms;
    event.text = std::move(text);
    event.data = std::move(data);
    m_events.push(std::move(event));
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
    m_current_room_id.reset();
    m_current_map_id.reset();
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
    if (queue_it != root.end() && !queue_it->is_array()) {
        add_warning(diagnostics, "/entityQueue", "expected array; saved entity queue ignored");
    } else if (queue_it != root.end()) {
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
                            "queued entity '" + ref->id +
                                "' does not exist in project; entry ignored");
                continue;
            }
            queue_entity(*ref);
        }
    }

    const auto locations_it = root.find(key(project_ids::object_locations));
    if (locations_it != root.end() && locations_it->is_object() && m_project) {
        for (auto it = locations_it->begin(); it != locations_it->end(); ++it) {
            const auto path = "/objectLocations/" + it.key();
            if (!m_project->objects().contains(it.key())) {
                add_warning(diagnostics, path,
                            "saved object location for missing object '" + it.key() +
                                "' ignored by runtime views");
                continue;
            }
            auto location = EntityRef::from_json(it.value());
            if (!location.has_value() || !location->has_id()) {
                add_warning(diagnostics, path, "expected selected-entity array [type, id]");
                continue;
            }
            if (location->type == EntityType::CustomScript && location->id == project_ids::player) {
                continue;
            }
            if (!model_has_entity(*m_project, *location)) {
                add_warning(diagnostics, path,
                            "saved object location target '" + location->id +
                                "' does not exist in project");
            }
        }
    }
}

void GameSession::emit_command(SessionCommand command) { m_commands.push_back(std::move(command)); }

} // namespace noveltea::core
