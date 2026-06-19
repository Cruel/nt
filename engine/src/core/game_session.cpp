#include <noveltea/core/game_session.hpp>

#include <utility>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {
namespace {

SessionDiagnostic validation_to_session(const ValidationIssue& issue)
{
    return SessionDiagnostic {SessionDiagnosticSeverity::Error, issue.path, issue.message};
}

SessionDiagnostic document_to_session(const DocumentError& error)
{
    return SessionDiagnostic {SessionDiagnosticSeverity::Error, error.path, error.message};
}

void add_info(std::vector<SessionDiagnostic>& diagnostics, std::string path, std::string message)
{
    diagnostics.push_back(SessionDiagnostic {SessionDiagnosticSeverity::Info, std::move(path), std::move(message)});
}

void add_error(std::vector<SessionDiagnostic>& diagnostics, std::string path, std::string message)
{
    diagnostics.push_back(SessionDiagnostic {SessionDiagnosticSeverity::Error, std::move(path), std::move(message)});
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

    RuntimeEvent event;
    event.type = RuntimeEventType::GameLoaded;
    event.number_value = m_play_time;
    event.text = m_startup_entrypoint->id;
    event.data = m_startup_entrypoint->to_json();
    m_events.push(std::move(event));

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

const SaveDocument* GameSession::save() const noexcept
{
    return m_save ? &*m_save : nullptr;
}

std::optional<EntityRef> GameSession::resolve_startup_entrypoint(const ProjectDocument& project,
                                                                 const SaveDocument& save,
                                                                 std::vector<SessionDiagnostic>& diagnostics) const
{
    if (const auto save_entrypoint = save.entrypoint(); save_entrypoint.has_value() && save_entrypoint->has_id()) {
        add_info(diagnostics, "/entrypoint", "using save entrypoint");
        return save_entrypoint;
    }

    if (!project.has_valid_entrypoint()) {
        add_error(diagnostics, "/" + std::string(project_ids::entrypoint_entity),
                  "project has no valid startup entrypoint");
        return std::nullopt;
    }

    const auto parsed = EntityRef::from_json(project.root().at(std::string(project_ids::entrypoint_entity)));
    if (!parsed.has_value() || !parsed->has_id()) {
        add_error(diagnostics, "/" + std::string(project_ids::entrypoint_entity),
                  "project has no valid startup entrypoint");
        return std::nullopt;
    }
    add_info(diagnostics, "/entrypoint", "using project entrypoint");
    return parsed;
}

} // namespace noveltea::core
