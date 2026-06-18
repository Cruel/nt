#include <noveltea/core/legacy/project_importer.hpp>

#include <array>
#include <exception>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_ids.hpp>

namespace noveltea::core::legacy {

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

std::string key_to_string(std::string_view key)
{
    return std::string(key);
}

void add_error(std::vector<ImportError>& errors, std::string message)
{
    errors.push_back(ImportError {std::move(message)});
}

void require_object(const nlohmann::json& root, std::string_view key, std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_object()) {
        add_error(errors, "Legacy project key '" + name + "' must be an object.");
    }
}

void require_array(const nlohmann::json& root, std::string_view key, std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_array()) {
        add_error(errors, "Legacy project key '" + name + "' must be an array.");
    }
}

void require_string(const nlohmann::json& root, std::string_view key, std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_string()) {
        add_error(errors, "Legacy project key '" + name + "' must be a string.");
    }
}

} // namespace

std::optional<ImportedProject> ProjectImporter::import_game_json_text(
    std::string_view source,
    std::vector<ImportError>& errors)
{
    errors.clear();
    try {
        return import_game_json(nlohmann::json::parse(source), errors);
    } catch (const nlohmann::json::parse_error& e) {
        add_error(errors, std::string("Malformed legacy project JSON: ") + e.what());
        return std::nullopt;
    } catch (const std::exception& e) {
        add_error(errors, std::string("Failed to import legacy project JSON: ") + e.what());
        return std::nullopt;
    }
}

std::optional<ImportedProject> ProjectImporter::import_game_json(
    const nlohmann::json& root,
    std::vector<ImportError>& errors)
{
    errors.clear();
    if (!root.is_object()) {
        add_error(errors, "Legacy project JSON root must be an object.");
        return std::nullopt;
    }

    for (auto key : required_project_keys) {
        const auto name = key_to_string(key);
        if (!root.contains(name)) {
            add_error(errors, "Legacy project JSON is missing required key '" + name + "'.");
        }
    }

    require_object(root, project_ids::engine_fonts, errors);
    require_object(root, project_ids::shaders, errors);
    require_array(root, project_ids::system_shaders, errors);
    require_array(root, project_ids::project_fonts, errors);
    require_array(root, project_ids::starting_inventory, errors);
    require_array(root, project_ids::textures, errors);

    require_string(root, project_ids::project_name, errors);
    require_string(root, project_ids::project_version, errors);
    require_string(root, project_ids::project_author, errors);
    require_string(root, project_ids::project_font_default, errors);

    for (auto key : project_ids::entity_collection_keys) {
        const auto name = key_to_string(key);
        if (!root.contains(name)) {
            add_error(errors, "Legacy project JSON is missing entity collection '" + name + "'.");
        } else if (!root.at(name).is_object()) {
            add_error(errors, "Legacy entity collection '" + name + "' must be an object.");
        }
    }

    const auto entrypoint_key = key_to_string(project_ids::entrypoint_entity);
    if (root.contains(entrypoint_key) && !EntityRef::from_json(root.at(entrypoint_key)).has_value()) {
        add_error(errors, "Legacy project entrypoint must use selected-entity array shape [type, id].");
    }

    if (!errors.empty()) {
        return std::nullopt;
    }

    return ImportedProject {ProjectDocument(root)};
}

} // namespace noveltea::core::legacy
