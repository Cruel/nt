#pragma once

#include <deque>
#include <optional>
#include <string>
#include <vector>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_model.hpp>
#include <noveltea/core/runtime_events.hpp>
#include <noveltea/core/save_document.hpp>

namespace noveltea::core {

enum class SessionDiagnosticSeverity {
    Info,
    Warning,
    Error,
};

struct SessionDiagnostic {
    SessionDiagnosticSeverity severity = SessionDiagnosticSeverity::Info;
    std::string path;
    std::string message;
};

enum class SessionCommandType {
    StartupResolved,
    EntityQueued,
    EntityDequeued,
    CurrentRoomChanged,
    CurrentMapChanged,
    NavigationStateChanged,
};

struct SessionCommand {
    SessionCommandType type = SessionCommandType::StartupResolved;
    std::optional<EntityRef> entity;
    std::string text;
    bool enabled = false;
};

struct RuntimeStateSnapshot {
    std::optional<EntityRef> current_entity;
    std::optional<std::string> current_room_id;
    std::optional<std::string> current_map_id;
    bool navigation_enabled = true;
    bool map_enabled = true;
    std::size_t queued_entity_count = 0;
};

struct GameSessionLoadResult {
    bool success = false;
    std::vector<SessionDiagnostic> diagnostics;
};

class GameSession {
public:
    GameSession();

    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project,
                                             SaveDocument save = SaveDocument::new_save());
    void reset();
    void tick(double delta_seconds);

    [[nodiscard]] bool loaded() const noexcept { return m_project.has_value(); }
    [[nodiscard]] const ProjectModel* project() const noexcept;
    [[nodiscard]] const SaveDocument* save() const noexcept;
    [[nodiscard]] RuntimeEventBus& events() noexcept { return m_events; }
    [[nodiscard]] const RuntimeEventBus& events() const noexcept { return m_events; }
    [[nodiscard]] RuntimeTimerScheduler& timers() noexcept { return m_timers; }
    [[nodiscard]] const RuntimeTimerScheduler& timers() const noexcept { return m_timers; }

    [[nodiscard]] std::optional<EntityRef> startup_entrypoint() const noexcept
    {
        return m_startup_entrypoint;
    }
    [[nodiscard]] RuntimeStateSnapshot runtime_state() const;
    [[nodiscard]] double play_time() const noexcept { return m_play_time; }
    [[nodiscard]] const std::deque<EntityRef>& entity_queue() const noexcept
    {
        return m_entity_queue;
    }
    [[nodiscard]] std::optional<EntityRef> current_entity() const noexcept
    {
        return m_current_entity;
    }
    [[nodiscard]] std::optional<std::string> current_room_id() const { return m_current_room_id; }
    [[nodiscard]] std::optional<std::string> current_map_id() const { return m_current_map_id; }
    [[nodiscard]] bool navigation_enabled() const noexcept { return m_navigation_enabled; }
    [[nodiscard]] bool map_enabled() const noexcept { return m_map_enabled; }
    [[nodiscard]] SaveDocument snapshot_save() const;
    void replace_save(SaveDocument save);

    void queue_entity(EntityRef ref);
    [[nodiscard]] std::optional<EntityRef> pop_next_entity();
    void set_current_room(std::string room_id);
    void set_current_map(std::string map_id);
    void set_navigation_enabled(bool enabled);
    void set_map_enabled(bool enabled);
    void mark_room_visited(const std::string& room_id);
    [[nodiscard]] int visited_room_count(const std::string& room_id) const;
    [[nodiscard]] nlohmann::json property(std::string_view key) const;
    void set_property(std::string key, nlohmann::json value);
    void unset_property(std::string_view key);
    [[nodiscard]] nlohmann::json entity_property(EntityType type, const std::string& id,
                                                 std::string_view key) const;
    void set_entity_property(EntityType type, std::string id, std::string key,
                             nlohmann::json value);
    void unset_entity_property(EntityType type, const std::string& id, std::string_view key);
    [[nodiscard]] std::optional<EntityRef> object_location(const std::string& object_id) const;
    [[nodiscard]] std::optional<EntityRef>
    effective_object_location(const std::string& object_id) const;
    void set_object_location(std::string object_id, EntityRef location);
    void clear_object_location(const std::string& object_id);
    void append_log(std::string text, nlohmann::json data = nlohmann::json::object());
    void notify(std::string text, double duration_ms = 0.0,
                nlohmann::json data = nlohmann::json::object());
    [[nodiscard]] std::vector<SessionCommand> take_commands();

private:
    [[nodiscard]] std::optional<EntityRef>
    resolve_startup_entrypoint(const ProjectDocument& project, const SaveDocument& save,
                               std::vector<SessionDiagnostic>& diagnostics) const;
    void restore_runtime_state(const SaveDocument& save,
                               std::vector<SessionDiagnostic>& diagnostics);
    void emit_command(SessionCommand command);

    std::optional<ProjectModel> m_project;
    std::optional<SaveDocument> m_save;
    RuntimeEventBus m_events;
    RuntimeTimerScheduler m_timers;
    std::optional<EntityRef> m_startup_entrypoint;
    std::optional<EntityRef> m_current_entity;
    std::optional<std::string> m_current_room_id;
    std::optional<std::string> m_current_map_id;
    bool m_navigation_enabled = true;
    bool m_map_enabled = true;
    std::deque<EntityRef> m_entity_queue;
    std::vector<SessionCommand> m_commands;
    double m_play_time = 0.0;
};

} // namespace noveltea::core
