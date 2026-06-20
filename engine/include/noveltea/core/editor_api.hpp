#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/package_export.hpp>
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

enum class RuntimePlaybackInputType {
    Tick,
    Continue,
    DialogueOption,
    Navigate,
    SelectObject,
    ClearObjectSelection,
    RunAction,
    LoadSave,
    SetEntrypoint,
};

enum class RuntimePlaybackAssertionType {
    Mode,
    CurrentRoom,
    Title,
    TextLogContains,
    PropertyEquals,
    ObjectLocation,
    InventoryContains,
    OutputType,
    DiagnosticCategory,
};

struct RuntimePlaybackAssertion {
    RuntimePlaybackAssertionType type = RuntimePlaybackAssertionType::Mode;
    std::string value;
    std::string key;
    nlohmann::json expected = nullptr;
    std::optional<EntityRef> entity_ref;
};

struct RuntimePlaybackStep {
    RuntimePlaybackInputType input = RuntimePlaybackInputType::Tick;
    std::optional<std::uint64_t> index;
    std::optional<double> delta_seconds;
    int option_index = -1;
    int direction = -1;
    std::string verb_id;
    std::vector<std::string> object_ids;
    std::optional<EntityRef> entity_ref;
    nlohmann::json payload = nlohmann::json::object();
    std::string init_script;
    std::string check_script;
    std::vector<RuntimePlaybackAssertion> assertions;
};

struct RuntimePlaybackSpec {
    std::string id;
    std::optional<EntityRef> entrypoint;
    std::optional<double> fixed_delta_seconds;
    std::string init_script;
    std::string check_script;
    std::vector<RuntimePlaybackStep> steps;
};

struct RuntimePlaybackObservation {
    std::uint64_t step_index = 0;
    bool handled = false;
    bool passed = true;
    std::string input;
    RuntimePreviewState state;
    std::vector<RuntimeOutput> outputs;
    std::vector<RuntimeDiagnostic> diagnostics;
    std::vector<std::string> assertion_failures;
};

struct RuntimePlaybackHookResult {
    bool passed = true;
    std::vector<RuntimeOutput> outputs;
    std::vector<RuntimeDiagnostic> diagnostics;
};

struct RuntimePlaybackReport {
    std::string id;
    bool passed = true;
    std::vector<RuntimePlaybackObservation> observations;
    RuntimePreviewState final_state;
    std::vector<RuntimeOutput> outputs;
    std::vector<RuntimeDiagnostic> diagnostics;
    std::vector<std::string> failures;

    [[nodiscard]] nlohmann::json to_json() const;
};

class ProjectTooling {
public:
    [[nodiscard]] static ProjectLoadResult load_project_json(std::string_view source);
    [[nodiscard]] static ProjectLoadResult import_legacy_game_json(std::string_view source);
    [[nodiscard]] static std::vector<ToolDiagnostic>
    validate_project(const ProjectDocument& project);
    [[nodiscard]] static std::string save_project_json(const ProjectDocument& project);
    [[nodiscard]] static PackageExportResult
    export_project_package(const ProjectDocument& project, const std::filesystem::path& path,
                           const PackageExportOptions& options);

    [[nodiscard]] static EntityEditResult set_entity_record(ProjectDocument& project,
                                                            std::string_view collection,
                                                            std::string_view entity_id,
                                                            nlohmann::json record);
    [[nodiscard]] static EntityEditResult erase_entity_record(ProjectDocument& project,
                                                              std::string_view collection,
                                                              std::string_view entity_id);
};

class RuntimePlaybackSession {
public:
    using HookExecutor = std::function<RuntimePlaybackHookResult(
        std::string_view source, std::string_view context, std::optional<std::uint64_t> step_index,
        RuntimeSessionHost& host)>;

    [[nodiscard]] static std::optional<RuntimePlaybackSpec>
    parse_spec(const nlohmann::json& json, std::vector<ToolDiagnostic>& diagnostics,
               std::string_view path = "/");
    [[nodiscard]] static std::vector<RuntimePlaybackSpec>
    specs_from_project(const ProjectDocument& project, std::vector<ToolDiagnostic>& diagnostics);

    void set_hook_executor(HookExecutor executor) { m_hook_executor = std::move(executor); }
    [[nodiscard]] RuntimePlaybackReport run(ProjectDocument project,
                                            const RuntimePlaybackSpec& spec);
    [[nodiscard]] RuntimePlaybackReport run(ProjectDocument project, SaveDocument save,
                                            const RuntimePlaybackSpec& spec);

private:
    HookExecutor m_hook_executor;
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
    bool inject_object_selection(const std::string& object_id);
    bool clear_object_selection();
    bool inject_action(const std::string& verb_id, const std::vector<std::string>& object_ids);

private:
    RuntimeSessionHost m_host;
    std::optional<ProjectDocument> m_project;
    std::optional<SaveDocument> m_initial_save;
    bool m_running = false;
    std::vector<ControllerCommand> m_captured_commands;
};

} // namespace noveltea::core::editor
