#pragma once

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

struct GameSessionLoadResult {
    bool success = false;
    std::vector<SessionDiagnostic> diagnostics;
};

class GameSession {
public:
    GameSession();

    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project, SaveDocument save = SaveDocument::new_save());
    void reset();
    void tick(double delta_seconds);

    [[nodiscard]] bool loaded() const noexcept { return m_project.has_value(); }
    [[nodiscard]] const ProjectModel* project() const noexcept;
    [[nodiscard]] const SaveDocument* save() const noexcept;
    [[nodiscard]] RuntimeEventBus& events() noexcept { return m_events; }
    [[nodiscard]] const RuntimeEventBus& events() const noexcept { return m_events; }
    [[nodiscard]] RuntimeTimerScheduler& timers() noexcept { return m_timers; }
    [[nodiscard]] const RuntimeTimerScheduler& timers() const noexcept { return m_timers; }

    [[nodiscard]] std::optional<EntityRef> startup_entrypoint() const noexcept { return m_startup_entrypoint; }
    [[nodiscard]] double play_time() const noexcept { return m_play_time; }

private:
    [[nodiscard]] std::optional<EntityRef> resolve_startup_entrypoint(const ProjectDocument& project,
                                                                      const SaveDocument& save,
                                                                      std::vector<SessionDiagnostic>& diagnostics) const;

    std::optional<ProjectModel> m_project;
    std::optional<SaveDocument> m_save;
    RuntimeEventBus m_events;
    RuntimeTimerScheduler m_timers;
    std::optional<EntityRef> m_startup_entrypoint;
    double m_play_time = 0.0;
};

} // namespace noveltea::core
