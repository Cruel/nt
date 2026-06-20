#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_validator.hpp>
#include <noveltea/core/runtime_session_host.hpp>

namespace noveltea::core::editor {

enum class DiagnosticSeverity {
    Info,
    Warning,
    Error,
};

struct ToolDiagnostic {
    DiagnosticSeverity severity = DiagnosticSeverity::Error;
    std::string path;
    std::string message;
};

struct ProjectLoadResult {
    std::optional<ProjectDocument> project;
    std::vector<ToolDiagnostic> diagnostics;
    bool imported_legacy = false;

    [[nodiscard]] bool success() const noexcept { return project.has_value() && !has_errors(); }
    [[nodiscard]] bool has_errors() const noexcept;
};

struct EntityEditResult {
    std::vector<ToolDiagnostic> diagnostics;

    [[nodiscard]] bool success() const noexcept;
};

struct RuntimePreviewState {
    bool loaded = false;
    bool running = false;
    std::string mode = "none";
    RuntimeUIViewState view;
    nlohmann::json controller_state = nlohmann::json::object();
    nlohmann::json save_snapshot = nlohmann::json::object();
};

class ProjectTooling {
public:
    [[nodiscard]] static ProjectLoadResult load_project_json(std::string_view source);
    [[nodiscard]] static ProjectLoadResult import_legacy_game_json(std::string_view source);
    [[nodiscard]] static std::vector<ToolDiagnostic>
    validate_project(const ProjectDocument& project);
    [[nodiscard]] static std::string save_project_json(const ProjectDocument& project);

    [[nodiscard]] static EntityEditResult set_entity_record(ProjectDocument& project,
                                                            std::string_view collection,
                                                            std::string_view entity_id,
                                                            nlohmann::json record);
    [[nodiscard]] static EntityEditResult erase_entity_record(ProjectDocument& project,
                                                              std::string_view collection,
                                                              std::string_view entity_id);
};

class RuntimePreviewSession {
public:
    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project);
    [[nodiscard]] GameSessionLoadResult load(ProjectDocument project, SaveDocument save);
    [[nodiscard]] bool loaded() const noexcept { return m_host.loaded(); }
    [[nodiscard]] bool running() const noexcept { return m_running; }

    void start();
    void stop();
    [[nodiscard]] GameSessionLoadResult reset();
    [[nodiscard]] GameSessionLoadResult set_entrypoint(EntityRef entrypoint);
    void step(double delta_seconds);

    [[nodiscard]] RuntimePreviewState inspect_state() const;
    [[nodiscard]] const RuntimeUIViewState& view_state() const noexcept
    {
        return m_host.view_state();
    }
    [[nodiscard]] const std::vector<ControllerCommand>& captured_commands() const noexcept
    {
        return m_captured_commands;
    }
    [[nodiscard]] std::vector<ControllerCommand> take_captured_commands();

    bool inject_navigation_choice(int direction);
    bool inject_dialogue_option(int option_index);
    bool inject_continue();
    bool inject_action(const std::string& verb_id, const std::vector<std::string>& object_ids);

private:
    RuntimeSessionHost m_host;
    std::optional<ProjectDocument> m_project;
    std::optional<SaveDocument> m_initial_save;
    bool m_running = false;
    std::vector<ControllerCommand> m_captured_commands;
};

} // namespace noveltea::core::editor
