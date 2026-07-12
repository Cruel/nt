#include <noveltea/core/save_document.hpp>

#include <noveltea/core/project_ids.hpp>

#include <fstream>

namespace noveltea::core {
namespace {

using nlohmann::json;

constexpr std::string_view size_factor_key = "sizeFactor";
constexpr std::string_view active_profile_key = "activeProfile";
constexpr std::string_view profiles_key = "profiles";

std::string key(std::string_view value) { return std::string(value); }

void add_error(std::vector<DocumentError>& errors, std::string_view path, std::string message)
{
    errors.push_back(DocumentError{std::string(path), std::move(message)});
}

bool expect_object(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_object()) {
        return true;
    }
    add_error(errors, path, "expected object");
    return false;
}

bool expect_array(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_array()) {
        return true;
    }
    add_error(errors, path, "expected array");
    return false;
}

bool expect_bool(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_boolean()) {
        return true;
    }
    add_error(errors, path, "expected boolean");
    return false;
}

bool expect_number(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_number()) {
        return true;
    }
    add_error(errors, path, "expected number");
    return false;
}

bool expect_integer(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_number_integer()) {
        return true;
    }
    add_error(errors, path, "expected integer");
    return false;
}

bool expect_string(const json& value, std::vector<DocumentError>& errors, std::string_view path)
{
    if (value.is_string()) {
        return true;
    }
    add_error(errors, path, "expected string");
    return false;
}

bool require_key(const json& root, std::string_view field, std::vector<DocumentError>& errors)
{
    if (root.contains(key(field))) {
        return true;
    }
    add_error(errors, "/" + key(field), "missing required key");
    return false;
}

std::optional<json> parse_text(std::string_view text, std::vector<DocumentError>& errors,
                               std::string_view label)
{
    auto parsed = json::parse(text.begin(), text.end(), nullptr, false);
    if (parsed.is_discarded()) {
        add_error(errors, "", std::string("malformed ") + std::string(label) + " JSON");
        return std::nullopt;
    }
    return parsed;
}

} // namespace

SaveDocument::SaveDocument() : m_root(json::object()) {}
SaveDocument::SaveDocument(json root) : m_root(std::move(root)) {}

SaveDocument SaveDocument::new_save()
{
    json root = json::object();
    root[project_ids::play_time] = 0.0;
    root[project_ids::navigation_enabled] = true;
    root[project_ids::map_enabled] = true;
    root[project_ids::log] = json::array();
    root[project_ids::properties] = json::object();
    root[project_ids::room_descriptions] = json::object();
    root[project_ids::visited_rooms] = json::object();
    return SaveDocument(std::move(root));
}

std::optional<SaveDocument> SaveDocument::parse_json_text(std::string_view text,
                                                          std::vector<DocumentError>& errors)
{
    auto root = parse_text(text, errors, ".ntsav");
    if (!root.has_value()) {
        return std::nullopt;
    }
    SaveDocument document(std::move(*root));
    if (!document.validate(errors)) {
        return std::nullopt;
    }
    return document;
}

bool SaveDocument::validate(std::vector<DocumentError>& errors) const
{
    if (!expect_object(m_root, errors, "")) {
        return false;
    }

    bool ok = true;
    ok = require_key(m_root, project_ids::play_time, errors) && ok;
    ok = require_key(m_root, project_ids::navigation_enabled, errors) && ok;
    ok = require_key(m_root, project_ids::map_enabled, errors) && ok;
    ok = require_key(m_root, project_ids::log, errors) && ok;
    ok = require_key(m_root, project_ids::properties, errors) && ok;
    ok = require_key(m_root, project_ids::room_descriptions, errors) && ok;
    ok = require_key(m_root, project_ids::visited_rooms, errors) && ok;
    if (!ok) {
        return false;
    }

    ok = expect_number(m_root.at(key(project_ids::play_time)), errors, "/playTime") && ok;
    ok = expect_bool(m_root.at(key(project_ids::navigation_enabled)), errors, "/navEnabled") && ok;
    ok = expect_bool(m_root.at(key(project_ids::map_enabled)), errors, "/mapEnabled") && ok;
    ok = expect_array(m_root.at(key(project_ids::log)), errors, "/log") && ok;
    ok = expect_object(m_root.at(key(project_ids::properties)), errors, "/properties") && ok;
    ok = expect_object(m_root.at(key(project_ids::room_descriptions)), errors,
                       "/roomDescriptions") &&
         ok;
    ok = expect_object(m_root.at(key(project_ids::visited_rooms)), errors, "/visitedRooms") && ok;

    if (m_root.contains(key(project_ids::entrypoint_entity)) &&
        !EntityRef::from_json(m_root.at(key(project_ids::entrypoint_entity))).has_value()) {
        add_error(errors, "/entrypoint", "expected selected-entity array [type, id]");
        ok = false;
    }
    if (m_root.contains(key(project_ids::entrypoint_metadata)) &&
        !m_root.at(key(project_ids::entrypoint_metadata)).is_array()) {
        add_error(errors, "/entrydata", "expected array");
        ok = false;
    }
    if (m_root.contains(key(project_ids::save_map)) &&
        !m_root.at(key(project_ids::save_map)).is_string()) {
        add_error(errors, "/map", "expected string");
        ok = false;
    }
    if (m_root.contains(key(project_ids::object_locations)) &&
        !m_root.at(key(project_ids::object_locations)).is_object()) {
        add_error(errors, "/objectLocations", "expected object");
        ok = false;
    }

    return ok;
}

double SaveDocument::play_time() const { return m_root.value(key(project_ids::play_time), 0.0); }

bool SaveDocument::navigation_enabled() const
{
    return m_root.value(key(project_ids::navigation_enabled), true);
}

bool SaveDocument::map_enabled() const { return m_root.value(key(project_ids::map_enabled), true); }

std::optional<EntityRef> SaveDocument::entrypoint() const
{
    if (!m_root.contains(key(project_ids::entrypoint_entity))) {
        return std::nullopt;
    }
    return EntityRef::from_json(m_root.at(key(project_ids::entrypoint_entity)));
}

std::string SaveDocument::current_map_id() const
{
    return m_root.value(key(project_ids::save_map), std::string());
}

std::string SaveDocument::dump() const { return m_root.dump(); }

bool MemorySaveSlotStore::has_slot(SaveSlotId slot) const
{
    return m_slots.find(slot.value) != m_slots.end();
}

SaveSlotResult MemorySaveSlotStore::read_slot(SaveSlotId slot) const
{
    SaveSlotResult result;
    auto it = m_slots.find(slot.value);
    if (it == m_slots.end()) {
        add_error(result.errors, "/slot", "save slot does not exist");
        return result;
    }
    result.success = true;
    result.save = it->second;
    return result;
}

SaveSlotResult MemorySaveSlotStore::write_slot(SaveSlotId slot, const SaveDocument& save)
{
    SaveSlotResult result;
    std::vector<DocumentError> errors;
    if (!save.validate(errors)) {
        result.errors = std::move(errors);
        return result;
    }
    m_slots[slot.value] = save;
    result.success = true;
    result.save = save;
    return result;
}

void MemorySaveSlotStore::delete_slot(SaveSlotId slot) { m_slots.erase(slot.value); }

FilesystemSaveSlotStore::FilesystemSaveSlotStore(std::filesystem::path root)
    : m_root(std::move(root))
{
}

std::filesystem::path FilesystemSaveSlotStore::slot_path(SaveSlotId slot) const
{
    return m_root / (slot.is_autosave() ? "autosave.ntsav"
                                        : "slot-" + std::to_string(slot.value) + ".ntsav");
}

bool FilesystemSaveSlotStore::has_slot(SaveSlotId slot) const
{
    std::error_code error;
    return std::filesystem::is_regular_file(slot_path(slot), error);
}

SaveSlotResult FilesystemSaveSlotStore::read_slot(SaveSlotId slot) const
{
    SaveSlotResult result;
    std::ifstream file(slot_path(slot), std::ios::binary);
    if (!file) {
        add_error(result.errors, "/slot", "save slot does not exist or cannot be read");
        return result;
    }
    std::string text{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
    auto parsed = SaveDocument::parse_json_text(text, result.errors);
    if (!parsed)
        return result;
    result.success = true;
    result.save = std::move(*parsed);
    return result;
}

SaveSlotResult FilesystemSaveSlotStore::write_slot(SaveSlotId slot, const SaveDocument& save)
{
    SaveSlotResult result;
    std::error_code error;
    std::filesystem::create_directories(m_root, error);
    if (error) {
        add_error(result.errors, "/slot", "failed to create save directory: " + error.message());
        return result;
    }
    const auto destination = slot_path(slot);
    const auto temporary = destination.string() + ".tmp";
    {
        std::ofstream file(temporary, std::ios::binary | std::ios::trunc);
        if (!file || !(file << save.dump()) || !file.flush()) {
            std::filesystem::remove(temporary, error);
            add_error(result.errors, "/slot", "failed to write temporary save file");
            return result;
        }
    }
    std::filesystem::rename(temporary, destination, error);
    if (error) {
        std::filesystem::remove(destination, error);
        error.clear();
        std::filesystem::rename(temporary, destination, error);
    }
    if (error) {
        std::filesystem::remove(temporary, error);
        add_error(result.errors, "/slot", "failed to replace save file transactionally");
        return result;
    }
    result.success = true;
    result.save = save;
    return result;
}

void FilesystemSaveSlotStore::delete_slot(SaveSlotId slot)
{
    std::error_code error;
    std::filesystem::remove(slot_path(slot), error);
}

SettingsDocument::SettingsDocument() : m_root(json::object()) {}
SettingsDocument::SettingsDocument(json root) : m_root(std::move(root)) {}

SettingsDocument SettingsDocument::defaults()
{
    json root = json::object();
    root[size_factor_key] = 1.0;
    root[profiles_key] = json::array();
    root[active_profile_key] = -1;
    return SettingsDocument(std::move(root));
}

std::optional<SettingsDocument>
SettingsDocument::parse_json_text(std::string_view text, std::vector<DocumentError>& errors)
{
    auto root = parse_text(text, errors, "settings.conf");
    if (!root.has_value()) {
        return std::nullopt;
    }
    SettingsDocument document(std::move(*root));
    if (!document.validate(errors)) {
        return std::nullopt;
    }
    return document;
}

bool SettingsDocument::validate(std::vector<DocumentError>& errors) const
{
    if (!expect_object(m_root, errors, "")) {
        return false;
    }

    bool ok = true;
    ok = require_key(m_root, size_factor_key, errors) && ok;
    ok = require_key(m_root, profiles_key, errors) && ok;
    ok = require_key(m_root, active_profile_key, errors) && ok;
    if (!ok) {
        return false;
    }

    ok = expect_number(m_root.at(key(size_factor_key)), errors, "/sizeFactor") && ok;
    ok = expect_array(m_root.at(key(profiles_key)), errors, "/profiles") && ok;
    ok = expect_integer(m_root.at(key(active_profile_key)), errors, "/activeProfile") && ok;

    if (m_root.at(key(profiles_key)).is_array()) {
        const auto& profile_values = m_root.at(key(profiles_key));
        for (std::size_t i = 0; i < profile_values.size(); ++i) {
            const auto path = "/profiles/" + std::to_string(i);
            const auto& profile = profile_values[i];
            if (!profile.is_array() || profile.size() != 1) {
                add_error(errors, path, "expected profile array [name]");
                ok = false;
                continue;
            }
            ok = expect_string(profile[0], errors, path + "/0") && ok;
        }
    }

    if (m_root.at(key(active_profile_key)).is_number_integer() &&
        m_root.at(key(profiles_key)).is_array()) {
        const int active = m_root.at(key(active_profile_key)).get<int>();
        const auto count = static_cast<int>(m_root.at(key(profiles_key)).size());
        if (active >= count) {
            add_error(errors, "/activeProfile", "active profile index is out of range");
            ok = false;
        }
    }

    return ok;
}

double SettingsDocument::font_size_multiplier() const
{
    return m_root.value(key(size_factor_key), 1.0);
}

int SettingsDocument::active_profile_index() const
{
    return m_root.value(key(active_profile_key), -1);
}

std::vector<Profile> SettingsDocument::profiles() const
{
    std::vector<Profile> out;
    const auto it = m_root.find(key(profiles_key));
    if (it == m_root.end() || !it->is_array()) {
        return out;
    }
    for (const auto& item : *it) {
        if (item.is_array() && item.size() == 1 && item[0].is_string()) {
            out.push_back(Profile{item[0].get<std::string>()});
        }
    }
    return out;
}

std::string SettingsDocument::dump() const { return m_root.dump(); }

namespace profile_paths {

std::string profile_directory_name(int profile_index) { return std::to_string(profile_index); }

std::string slot_filename(int slot) { return std::to_string(slot) + std::string(save_extension); }

std::string slot_path(int profile_index, int slot)
{
    return profile_directory_name(profile_index) + "/" + slot_filename(slot);
}

} // namespace profile_paths

} // namespace noveltea::core
