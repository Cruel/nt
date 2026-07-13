#include <noveltea/core/save_document.hpp>

#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/json_access.hpp>

#include <fstream>

namespace noveltea::core {
namespace {

using nlohmann::json;

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

    const auto& play_time = *json_access::member(m_root, project_ids::play_time);
    const auto& navigation_enabled = *json_access::member(m_root, project_ids::navigation_enabled);
    const auto& map_enabled = *json_access::member(m_root, project_ids::map_enabled);
    const auto& log = *json_access::member(m_root, project_ids::log);
    const auto& properties = *json_access::member(m_root, project_ids::properties);
    const auto& room_descriptions = *json_access::member(m_root, project_ids::room_descriptions);
    const auto& visited_rooms = *json_access::member(m_root, project_ids::visited_rooms);

    ok = expect_number(play_time, errors, "/playTime") && ok;
    ok = expect_bool(navigation_enabled, errors, "/navEnabled") && ok;
    ok = expect_bool(map_enabled, errors, "/mapEnabled") && ok;
    ok = expect_array(log, errors, "/log") && ok;
    ok = expect_object(properties, errors, "/properties") && ok;
    ok = expect_object(room_descriptions, errors, "/roomDescriptions") && ok;
    ok = expect_object(visited_rooms, errors, "/visitedRooms") && ok;

    if (const auto* entrypoint = json_access::member(m_root, project_ids::entrypoint_entity);
        entrypoint && !EntityRef::from_json(*entrypoint).has_value()) {
        add_error(errors, "/entrypoint", "expected selected-entity array [type, id]");
        ok = false;
    }
    if (const auto* metadata = json_access::member(m_root, project_ids::entrypoint_metadata);
        metadata && !metadata->is_array()) {
        add_error(errors, "/entrydata", "expected array");
        ok = false;
    }
    if (const auto* map = json_access::member(m_root, project_ids::save_map);
        map && !map->is_string()) {
        add_error(errors, "/map", "expected string");
        ok = false;
    }
    if (const auto* locations = json_access::member(m_root, project_ids::object_locations);
        locations && !locations->is_object()) {
        add_error(errors, "/objectLocations", "expected object");
        ok = false;
    }

    return ok;
}

double SaveDocument::play_time() const
{
    return json_access::value_or(m_root, project_ids::play_time, 0.0);
}

bool SaveDocument::navigation_enabled() const
{
    return json_access::value_or(m_root, project_ids::navigation_enabled, true);
}

bool SaveDocument::map_enabled() const
{
    return json_access::value_or(m_root, project_ids::map_enabled, true);
}

std::optional<EntityRef> SaveDocument::entrypoint() const
{
    const auto* entrypoint = json_access::member(m_root, project_ids::entrypoint_entity);
    if (!entrypoint) {
        return std::nullopt;
    }
    return EntityRef::from_json(*entrypoint);
}

std::string SaveDocument::current_map_id() const
{
    return json_access::value_or(m_root, project_ids::save_map, std::string());
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

} // namespace noveltea::core
