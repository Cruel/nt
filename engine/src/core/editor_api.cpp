#include <noveltea/core/editor_api.hpp>

#include <noveltea/core/legacy/project_importer.hpp>
#include <noveltea/core/project_ids.hpp>

#include <algorithm>
#include <utility>

namespace noveltea::core::editor {
namespace {

ToolDiagnostic error(std::string path, std::string message)
{
    return ToolDiagnostic {DiagnosticSeverity::Error, std::move(path), std::move(message)};
}

ToolDiagnostic warning(std::string path, std::string message)
{
    return ToolDiagnostic {DiagnosticSeverity::Warning, std::move(path), std::move(message)};
}

bool is_entity_collection(std::string_view collection)
{
    for (const auto key : project_ids::entity_collection_keys) {
        if (key == collection) return true;
    }
    return false;
}

} // namespace

bool ProjectLoadResult::has_errors() const noexcept
{
    return std::any_of(diagnostics.begin(), diagnostics.end(), [](const ToolDiagnostic& diagnostic) {
        return diagnostic.severity == DiagnosticSeverity::Error;
    });
}

bool EntityEditResult::success() const noexcept
{
    return std::none_of(diagnostics.begin(), diagnostics.end(), [](const ToolDiagnostic& diagnostic) {
        return diagnostic.severity == DiagnosticSeverity::Error;
    });
}

ProjectLoadResult ProjectTooling::load_project_json(std::string_view source)
{
    ProjectLoadResult result;
    try {
        result.project = ProjectDocument(nlohmann::json::parse(source));
    } catch (const nlohmann::json::parse_error& parse_error) {
        result.diagnostics.push_back(error("/", std::string("Malformed project JSON: ") + parse_error.what()));
        return result;
    }

    auto validation = validate_project(*result.project);
    result.diagnostics.insert(result.diagnostics.end(),
                              std::make_move_iterator(validation.begin()),
                              std::make_move_iterator(validation.end()));
    return result;
}

ProjectLoadResult ProjectTooling::import_legacy_game_json(std::string_view source)
{
    ProjectLoadResult result;
    std::vector<legacy::ImportError> errors;
    auto imported = legacy::ProjectImporter::import_game_json_text(source, errors);
    if (!imported) {
        for (const auto& import_error : errors) {
            result.diagnostics.push_back(error("/", import_error.message));
        }
        if (result.diagnostics.empty()) {
            result.diagnostics.push_back(error("/", "Legacy project import failed."));
        }
        return result;
    }

    result.imported_legacy = true;
    result.project = std::move(imported->document);
    auto validation = validate_project(*result.project);
    result.diagnostics.insert(result.diagnostics.end(),
                              std::make_move_iterator(validation.begin()),
                              std::make_move_iterator(validation.end()));
    return result;
}

std::vector<ToolDiagnostic> ProjectTooling::validate_project(const ProjectDocument& project)
{
    std::vector<ToolDiagnostic> diagnostics;
    for (const auto& issue : ProjectValidator::validate(project)) {
        diagnostics.push_back(error(issue.path, issue.message));
    }
    return diagnostics;
}

std::string ProjectTooling::save_project_json(const ProjectDocument& project)
{
    return project.dump();
}

EntityEditResult ProjectTooling::set_entity_record(ProjectDocument& project,
                                                   std::string_view collection,
                                                   std::string_view entity_id,
                                                   nlohmann::json record)
{
    EntityEditResult result;
    if (!is_entity_collection(collection)) {
        result.diagnostics.push_back(error("/", "Unknown entity collection '" + std::string(collection) + "'."));
        return result;
    }
    if (entity_id.empty()) {
        result.diagnostics.push_back(error("/" + std::string(collection), "Entity id must not be empty."));
        return result;
    }
    if (!record.is_array()) {
        result.diagnostics.push_back(error("/" + std::string(collection) + "/" + std::string(entity_id),
                                           "Entity record must use the legacy array shape."));
        return result;
    }
    if (record.empty() || !record[0].is_string()) {
        result.diagnostics.push_back(error("/" + std::string(collection) + "/" + std::string(entity_id) + "[0]",
                                           "Entity record id field must be a string."));
        return result;
    }
    if (record[0].get<std::string>() != entity_id) {
        result.diagnostics.push_back(warning("/" + std::string(collection) + "/" + std::string(entity_id) + "[0]",
                                             "Entity record id did not match the map key and was normalized."));
        record[0] = std::string(entity_id);
    }

    auto& root = project.root();
    if (!root.contains(std::string(collection)) || !root[std::string(collection)].is_object()) {
        root[std::string(collection)] = nlohmann::json::object();
    }
    root[std::string(collection)][std::string(entity_id)] = std::move(record);
    return result;
}

EntityEditResult ProjectTooling::erase_entity_record(ProjectDocument& project,
                                                     std::string_view collection,
                                                     std::string_view entity_id)
{
    EntityEditResult result;
    if (!is_entity_collection(collection)) {
        result.diagnostics.push_back(error("/", "Unknown entity collection '" + std::string(collection) + "'."));
        return result;
    }
    auto& root = project.root();
    auto collection_it = root.find(std::string(collection));
    if (collection_it == root.end() || !collection_it->is_object()) return result;
    collection_it->erase(std::string(entity_id));
    return result;
}

GameSessionLoadResult RuntimePreviewSession::load(ProjectDocument project)
{
    m_project = project;
    m_captured_commands.clear();
    m_running = false;
    return m_host.load(std::move(project));
}

void RuntimePreviewSession::start()
{
    if (!m_host.loaded()) return;
    m_running = true;
    step(0.0);
}

void RuntimePreviewSession::stop()
{
    m_running = false;
}

GameSessionLoadResult RuntimePreviewSession::reset()
{
    if (!m_project) {
        m_host.reset();
        m_captured_commands.clear();
        m_running = false;
        return GameSessionLoadResult {};
    }
    const bool was_running = m_running;
    auto result = m_host.load(*m_project);
    m_captured_commands.clear();
    m_running = was_running && result.success;
    if (m_running) step(0.0);
    return result;
}

GameSessionLoadResult RuntimePreviewSession::set_entrypoint(EntityRef entrypoint)
{
    if (!m_project) return GameSessionLoadResult {};
    m_project->root()[project_ids::entrypoint_entity] = entrypoint.to_json();
    return reset();
}

void RuntimePreviewSession::step(double delta_seconds)
{
    if (!m_host.loaded()) return;
    if (!m_running && delta_seconds > 0.0) return;
    m_host.tick(delta_seconds);
    const auto& commands = m_host.last_commands();
    m_captured_commands.insert(m_captured_commands.end(), commands.begin(), commands.end());
}

RuntimePreviewState RuntimePreviewSession::inspect_state() const
{
    RuntimePreviewState state;
    state.loaded = m_host.loaded();
    state.running = m_running;
    state.mode = std::string(m_host.current_mode_name());
    state.view = m_host.view_state();
    if (const auto* controller = m_host.controller()) {
        state.controller_state = controller->save_state();
    }
    return state;
}

std::vector<ControllerCommand> RuntimePreviewSession::take_captured_commands()
{
    auto commands = std::move(m_captured_commands);
    m_captured_commands.clear();
    return commands;
}

bool RuntimePreviewSession::inject_navigation_choice(int direction)
{
    const bool handled = m_host.navigate_path(direction);
    if (handled) {
        const auto& commands = m_host.last_commands();
        m_captured_commands.insert(m_captured_commands.end(), commands.begin(), commands.end());
    }
    return handled;
}

bool RuntimePreviewSession::inject_dialogue_option(int option_index)
{
    const bool handled = m_host.select_dialogue_option(option_index);
    if (handled) {
        const auto& commands = m_host.last_commands();
        m_captured_commands.insert(m_captured_commands.end(), commands.begin(), commands.end());
    }
    return handled;
}

bool RuntimePreviewSession::inject_continue()
{
    const bool handled = m_host.continue_active();
    if (handled) {
        const auto& commands = m_host.last_commands();
        m_captured_commands.insert(m_captured_commands.end(), commands.begin(), commands.end());
    }
    return handled;
}

bool RuntimePreviewSession::inject_action(const std::string& verb_id, const std::vector<std::string>& object_ids)
{
    const bool handled = m_host.process_action(verb_id, object_ids);
    if (handled) {
        const auto& commands = m_host.last_commands();
        m_captured_commands.insert(m_captured_commands.end(), commands.begin(), commands.end());
    }
    return handled;
}

} // namespace noveltea::core::editor
