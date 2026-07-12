#include <noveltea/core/legacy/project_importer.hpp>

#include <array>
#include <exception>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_ids.hpp>

namespace noveltea::core::legacy {

namespace {

constexpr std::array required_project_keys = {
    project_ids::engine_version, project_ids::engine_fonts,
    project_ids::project_name,   project_ids::project_version,
    project_ids::project_author, project_ids::project_font_default,
    project_ids::project_fonts,  project_ids::starting_inventory,
    project_ids::shaders,        project_ids::system_shaders,
    project_ids::textures,
};

std::string key_to_string(std::string_view key) { return std::string(key); }

void add_error(std::vector<ImportError>& errors, std::string message)
{
    errors.push_back(ImportError{std::move(message)});
}

std::string kind_of(const nlohmann::json& value) { return value.type_name(); }

void require_object(const nlohmann::json& root, std::string_view key,
                    std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_object()) {
        add_error(errors, "Legacy project key '" + name + "' expected object but found " +
                              kind_of(root.at(name)) + ".");
    }
}

void require_array(const nlohmann::json& root, std::string_view key,
                   std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_array()) {
        add_error(errors, "Legacy project key '" + name + "' expected array but found " +
                              kind_of(root.at(name)) + ".");
    }
}

void require_string(const nlohmann::json& root, std::string_view key,
                    std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_string()) {
        add_error(errors, "Legacy project key '" + name + "' expected string but found " +
                              kind_of(root.at(name)) + ".");
    }
}

void require_number(const nlohmann::json& root, std::string_view key,
                    std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (root.contains(name) && !root.at(name).is_number()) {
        add_error(errors, "Legacy project key '" + name + "' expected number but found " +
                              kind_of(root.at(name)) + ".");
    }
}

void require_object_or_empty_array(const nlohmann::json& root, std::string_view key,
                                   std::vector<ImportError>& errors)
{
    const auto name = key_to_string(key);
    if (!root.contains(name)) {
        return;
    }

    const auto& value = root.at(name);
    if (value.is_object() || (value.is_array() && value.empty())) {
        return;
    }
    add_error(errors, "Legacy project key '" + name +
                          "' expected object map or empty array placeholder but found " +
                          kind_of(value) + ".");
}

} // namespace

std::optional<ImportedProject>
ProjectImporter::import_game_json_text(std::string_view source, std::vector<ImportError>& errors)
{
    errors.clear();
    auto parsed = nlohmann::json::parse(source, nullptr, false);
    if (parsed.is_discarded()) {
        add_error(errors, "Malformed legacy project JSON");
        return std::nullopt;
    }
    return import_game_json(parsed, errors);
}

std::optional<ImportedProject> ProjectImporter::import_game_json(const nlohmann::json& root,
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

    require_number(root, project_ids::engine_version, errors);
    require_object(root, project_ids::engine_fonts, errors);
    require_object(root, project_ids::shaders, errors);
    require_array(root, project_ids::system_shaders, errors);
    require_object_or_empty_array(root, project_ids::project_fonts, errors);
    require_array(root, project_ids::starting_inventory, errors);
    require_object_or_empty_array(root, project_ids::textures, errors);

    require_string(root, project_ids::project_name, errors);
    require_string(root, project_ids::project_version, errors);
    require_string(root, project_ids::project_author, errors);
    require_string(root, project_ids::project_website, errors);
    require_string(root, project_ids::project_font_default, errors);
    require_string(root, project_ids::script_before_save, errors);
    require_string(root, project_ids::script_after_load, errors);
    require_string(root, project_ids::script_after_action, errors);
    require_string(root, project_ids::script_before_action, errors);
    require_string(root, project_ids::script_undefined_action, errors);
    require_string(root, project_ids::script_after_enter, errors);
    require_string(root, project_ids::script_before_enter, errors);
    require_string(root, project_ids::script_after_leave, errors);
    require_string(root, project_ids::script_before_leave, errors);

    for (auto key : project_ids::entity_collection_keys) {
        const auto name = key_to_string(key);
        if (!root.contains(name)) {
            add_error(errors, "Legacy project JSON is missing entity collection '" + name + "'.");
        } else if (!root.at(name).is_object()) {
            add_error(errors, "Legacy entity collection '" + name + "' expected object but found " +
                                  kind_of(root.at(name)) + ".");
        }
    }

    const auto entrypoint_key = key_to_string(project_ids::entrypoint_entity);
    if (root.contains(entrypoint_key) &&
        !EntityRef::from_json(root.at(entrypoint_key)).has_value()) {
        add_error(errors,
                  "Legacy project entrypoint must use selected-entity array shape [type, id].");
    }

    if (!errors.empty()) {
        return std::nullopt;
    }

    return ImportedProject{ProjectDocument(root)};
}

} // namespace noveltea::core::legacy
