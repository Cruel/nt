#include <noveltea/core/project_document.hpp>

#include <array>
#include <exception>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {

namespace {

constexpr std::array required_project_keys = {
    project_ids::engine_version,
    project_ids::engine_fonts,
    project_ids::project_name,
    project_ids::project_version,
    project_ids::project_author,
    project_ids::project_font_default,
    project_ids::project_fonts,
    project_ids::starting_inventory,
    project_ids::shaders,
    project_ids::system_shaders,
    project_ids::textures,
};

nlohmann::json empty_object()
{
    return nlohmann::json::object();
}

nlohmann::json empty_array()
{
    return nlohmann::json::array();
}

std::string key_to_string(std::string_view key)
{
    return std::string(key);
}

} // namespace

ProjectDocument::ProjectDocument() : m_root(nlohmann::json::object()) {}
ProjectDocument::ProjectDocument(nlohmann::json root) : m_root(std::move(root)) {}

ProjectDocument ProjectDocument::new_project()
{
    nlohmann::json root = nlohmann::json::object();
    root[project_ids::engine_version] = static_cast<double>(project_ids::engine_version_value);
    root[project_ids::project_name] = "Project Name";
    root[project_ids::project_version] = "1.0";
    root[project_ids::project_author] = "Author Name";
    root[project_ids::project_website] = "";
    root[project_ids::project_font_default] = "sys";
    root[project_ids::project_fonts] = empty_object();
    root[project_ids::starting_inventory] = empty_array();
    root[project_ids::script_before_save] = "";
    root[project_ids::script_after_load] = "";
    root[project_ids::script_after_action] = "";
    root[project_ids::script_before_action] = "return true;";
    root[project_ids::script_undefined_action] = "return false;";
    root[project_ids::script_after_leave] = "";
    root[project_ids::script_before_leave] = "return true;";
    root[project_ids::script_after_enter] = "";
    root[project_ids::script_before_enter] = "return true;";
    root[project_ids::open_tabs] = empty_array();
    root[project_ids::open_tab_index] = -1;
    root[project_ids::textures] = empty_object();
    root[project_ids::tests] = empty_object();

    root[project_ids::shaders] = nlohmann::json::object({
        {"defaultFrag", "builtin:legacy-default-fragment"},
        {"defaultVert", "builtin:legacy-default-vertex"},
    });
    root[project_ids::system_shaders] = nlohmann::json::array({"defaultFrag", "defaultFrag"});
    root[project_ids::engine_fonts] = nlohmann::json::object({
        {"sys", "LiberationSans.ttf"},
        {"sysIcon", "fontawesome.ttf"},
    });

    for (auto key : project_ids::entity_collection_keys) {
        root[key] = empty_object();
    }

    return ProjectDocument(std::move(root));
}

ProjectImportResult ProjectDocument::import_legacy_json_text(std::string_view source)
{
    try {
        return import_legacy_json(nlohmann::json::parse(source));
    } catch (const nlohmann::json::parse_error& e) {
        ProjectImportResult result;
        result.diagnostics.push_back(std::string("Malformed legacy project JSON: ") + e.what());
        return result;
    } catch (const std::exception& e) {
        ProjectImportResult result;
        result.diagnostics.push_back(std::string("Failed to import legacy project JSON: ") + e.what());
        return result;
    }
}

ProjectImportResult ProjectDocument::import_legacy_json(const nlohmann::json& root)
{
    ProjectImportResult result;
    if (!root.is_object()) {
        result.diagnostics.push_back("Legacy project JSON root must be an object.");
        return result;
    }

    for (auto key : required_project_keys) {
        if (!root.contains(key_to_string(key))) {
            result.diagnostics.push_back("Legacy project JSON is missing required key '" + key_to_string(key) + "'.");
        }
    }
    for (auto key : project_ids::entity_collection_keys) {
        if (!root.contains(key_to_string(key))) {
            result.diagnostics.push_back("Legacy project JSON is missing entity collection '" + key_to_string(key) + "'.");
        } else if (!root.at(key_to_string(key)).is_object()) {
            result.diagnostics.push_back("Legacy entity collection '" + key_to_string(key) + "' must be an object.");
        }
    }

    if (root.contains(key_to_string(project_ids::entrypoint_entity))) {
        auto ref = EntityRef::from_json(root.at(key_to_string(project_ids::entrypoint_entity)));
        if (!ref.has_value()) {
            result.diagnostics.push_back("Legacy project entrypoint must use selected-entity array shape [type, id].");
        }
    }

    if (!result.diagnostics.empty()) {
        return result;
    }

    result.document = ProjectDocument(root);
    return result;
}

std::span<const std::string_view> ProjectDocument::entity_collection_keys() const noexcept
{
    return project_ids::entity_collection_keys;
}

bool ProjectDocument::has_required_project_keys() const
{
    if (!m_root.is_object()) {
        return false;
    }
    for (auto key : required_project_keys) {
        if (!m_root.contains(key_to_string(key))) {
            return false;
        }
    }
    for (auto key : project_ids::entity_collection_keys) {
        if (!m_root.contains(key_to_string(key))) {
            return false;
        }
    }
    return true;
}

bool ProjectDocument::has_valid_entrypoint() const
{
    if (!m_root.is_object() || !m_root.contains(key_to_string(project_ids::entrypoint_entity))) {
        return false;
    }
    const auto ref = EntityRef::from_json(m_root.at(key_to_string(project_ids::entrypoint_entity)));
    return ref.has_value() && ref->has_id();
}

bool ProjectDocument::validate_entrypoint(std::string* error_message) const
{
    if (has_valid_entrypoint()) {
        if (error_message != nullptr) {
            error_message->clear();
        }
        return true;
    }
    if (error_message != nullptr) {
        *error_message = "No valid entry point defined in project settings.";
    }
    return false;
}

std::string ProjectDocument::dump() const
{
    return m_root.dump();
}

} // namespace noveltea::core
