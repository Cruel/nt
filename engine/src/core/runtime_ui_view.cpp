#include <noveltea/core/runtime_ui_view.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <limits>
#include <string_view>
#include <utility>

#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {

namespace {
constexpr std::size_t kMaxTextLogLines = 64;

std::string json_string_or(const nlohmann::json& value, const char* key, std::string fallback = {})
{
    const auto it = value.find(key);
    return it != value.end() && it->is_string() ? it->get<std::string>() : std::move(fallback);
}

RichTextDocument rich_text_or_parse(const nlohmann::json& data, std::string_view fallback)
{
    if (const auto rich = data.find("rich_text"); rich != data.end()) {
        RichTextDocument document;
        if (rich_text_from_json(*rich, document))
            return document;
    }
    return parse_rich_text(fallback);
}

const nlohmann::json& text_log_metadata(const nlohmann::json& data)
{
    if (const auto nested = data.find("data"); nested != data.end() && nested->is_object()) {
        return *nested;
    }
    return data;
}

std::optional<EntityRef> entity_ref_or_empty(const nlohmann::json& data, const char* key)
{
    const auto it = data.find(key);
    if (it == data.end()) {
        return std::nullopt;
    }
    return EntityRef::from_json(*it);
}

bool contains_room_id(const MapRoomModel& room, const std::string& room_id)
{
    return std::find(room.room_ids.begin(), room.room_ids.end(), room_id) != room.room_ids.end();
}

const MapModel* find_map_for_room(const ProjectModel& project, const std::string& room_id,
                                  std::string& map_id)
{
    for (const auto& [id, map] : project.maps()) {
        const auto room_it =
            std::find_if(map.rooms.begin(), map.rooms.end(),
                         [&](const MapRoomModel& room) { return contains_room_id(room, room_id); });
        if (room_it != map.rooms.end()) {
            map_id = id;
            return &map;
        }
    }
    return nullptr;
}

std::vector<int> reachable_path_indices(const ProjectModel& project, const std::string& room_id,
                                        const MapRoomModel& map_room)
{
    std::vector<int> out;
    auto room_it = project.rooms().find(room_id);
    if (room_it == project.rooms().end()) {
        return out;
    }

    const auto& paths = room_it->second.paths;
    for (std::size_t i = 0; i < paths.size(); ++i) {
        const auto& path = paths[i];
        if (!path.enabled || !path.target || path.target->type != EntityType::Room) {
            continue;
        }
        if (contains_room_id(map_room, path.target->id)) {
            out.push_back(static_cast<int>(i));
        }
    }
    return out;
}

bool has_texture_key(const ProjectModel& project, std::string_view key)
{
    const auto& root = project.document_root();
    const auto textures = root.find(std::string(project_ids::textures));
    return textures != root.end() && textures->is_object() &&
           textures->find(std::string(key)) != textures->end();
}

std::string normalize_visual_asset(const ProjectModel& project, const std::string& value)
{
    if (value.empty()) {
        return {};
    }
    if (value.find(":/") != std::string::npos) {
        return value;
    }
    if (value == "image") {
        return "project:/image";
    }
    constexpr std::string_view textures_prefix = "textures/";
    if (value.rfind(std::string(textures_prefix), 0) == 0) {
        return "project:/" + value;
    }
    if (has_texture_key(project, value)) {
        return "project:/textures/" + value;
    }
    return "project:/textures/" + value;
}

std::string property_string(const nlohmann::json& properties, const char* key)
{
    const auto it = properties.find(key);
    return it != properties.end() && it->is_string() ? it->get<std::string>() : std::string{};
}

std::string visual_property(const ProjectModel& project, const EntityMetadata& metadata,
                            std::initializer_list<const char*> keys)
{
    for (const char* key : keys) {
        const auto value = property_string(metadata.properties, key);
        if (!value.empty()) {
            return normalize_visual_asset(project, value);
        }
    }
    return {};
}
} // namespace

void RuntimeUIViewAdapter::reset()
{
    m_state = RuntimeUIViewState{};
    m_next_text_log_sequence = 0;
}

void RuntimeUIViewAdapter::apply(const std::vector<ControllerCommand>& commands)
{
    for (const auto& command : commands) {
        apply(command);
    }
}

void RuntimeUIViewAdapter::apply(const ControllerCommand& command)
{
    switch (command.type) {
    case ControllerCommandType::ModeChanged:
        m_state.mode = json_string_or(command.data, "mode", m_state.mode);
        m_state.dialogue_options.clear();
        if (m_state.mode != "room") {
            m_state.objects.clear();
            m_state.actions.clear();
        }
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::RoomEntry:
        m_state.mode = "room";
        m_state.title = json_string_or(command.data, "name", command.text);
        m_state.dialogue_options.clear();
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::RoomDescription:
        m_state.mode = "room";
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.active_text = rich_text_or_parse(command.data, m_state.body);
        m_state.dialogue_options.clear();
        m_state.page_break = false;
        break;
    case ControllerCommandType::NavigationUpdate:
        apply_navigation(command.data);
        break;
    case ControllerCommandType::Notification:
        m_state.notification = command.text;
        break;
    case ControllerCommandType::TextLogged: {
        push_log_entry(make_text_log_entry(command.text, command.data, m_next_text_log_sequence++));
        break;
    }
    case ControllerCommandType::DialogueText:
        m_state.mode = "dialogue";
        m_state.title = json_string_or(command.data, "name");
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.active_text = rich_text_or_parse(command.data, m_state.body);
        m_state.objects.clear();
        m_state.actions.clear();
        m_state.awaiting_continue = command.data.value("wait_for_click", false);
        m_state.page_break = false;
        break;
    case ControllerCommandType::DialogueOptions:
        apply_options(command.data.value("options", nlohmann::json::array()));
        m_state.awaiting_continue = false;
        break;
    case ControllerCommandType::DialogueComplete:
        m_state.mode = "idle";
        m_state.dialogue_options.clear();
        m_state.awaiting_continue = false;
        break;
    case ControllerCommandType::CutsceneText:
        m_state.mode = "cutscene";
        m_state.title.clear();
        m_state.body = json_string_or(command.data, "text", command.text);
        m_state.active_text = rich_text_or_parse(command.data, m_state.body);
        m_state.dialogue_options.clear();
        m_state.objects.clear();
        m_state.actions.clear();
        m_state.awaiting_continue = command.data.value("wait_for_click", false);
        m_state.page_break = false;
        break;
    case ControllerCommandType::CutscenePageBreak:
        m_state.mode = "cutscene";
        m_state.page_break = true;
        m_state.awaiting_continue = true;
        break;
    case ControllerCommandType::CutsceneComplete:
        m_state.mode = "idle";
        m_state.awaiting_continue = false;
        m_state.page_break = false;
        break;
    case ControllerCommandType::ActionResolved:
        m_state.notification = "Action resolved";
        break;
    case ControllerCommandType::ActionRejected:
        m_state.notification = command.text.empty() ? "Action unavailable" : command.text;
        break;
    case ControllerCommandType::ScriptDeferred:
        break;
    }
}

void RuntimeUIViewAdapter::set_room_interactions(std::vector<RuntimeUIObject> objects,
                                                 std::vector<RuntimeUIAction> actions)
{
    m_state.objects = std::move(objects);
    m_state.actions = std::move(actions);
}

void RuntimeUIViewAdapter::sync_visuals(const GameSession& session)
{
    m_state.cover_image = "project:/image";
    m_state.room_image.clear();
    m_state.background_image = m_state.cover_image;
    m_state.asset_diagnostics.clear();

    const auto* project = session.project();
    const auto current_room = session.current_room_id();
    if (!project || !current_room.has_value()) {
        return;
    }

    const auto room_it = project->rooms().find(*current_room);
    if (room_it == project->rooms().end()) {
        return;
    }

    m_state.room_image = visual_property(*project, room_it->second.metadata, {"image", "texture"});
    const auto background =
        visual_property(*project, room_it->second.metadata, {"background", "image", "texture"});
    if (!background.empty()) {
        m_state.background_image = background;
    }
}

void RuntimeUIViewAdapter::set_saved_text_log(const nlohmann::json& log)
{
    m_state.text_log.clear();
    m_next_text_log_sequence = 0;
    if (!log.is_array()) {
        return;
    }
    for (const auto& item : log) {
        if (item.is_string()) {
            push_log_entry(make_text_log_entry(item.get<std::string>(), nlohmann::json::object(),
                                               m_next_text_log_sequence++));
        }
    }
}

void RuntimeUIViewAdapter::sync_map(const GameSession& session)
{
    RuntimeUIMapView view;
    const auto* project = session.project();
    const auto current_room = session.current_room_id();
    if (!project || !current_room.has_value() || project->maps().empty()) {
        m_state.map_view = std::move(view);
        return;
    }

    const MapModel* map = nullptr;
    std::string map_id;
    if (const auto current_map = session.current_map_id(); current_map.has_value()) {
        auto it = project->maps().find(*current_map);
        if (it != project->maps().end()) {
            map_id = it->first;
            map = &it->second;
        }
    }
    if (!map) {
        map = find_map_for_room(*project, *current_room, map_id);
    }
    if (!map) {
        m_state.map_view = std::move(view);
        return;
    }

    view.available = true;
    view.enabled = session.map_enabled();
    view.map_id = map_id;
    view.current_room_id = *current_room;
    view.default_room_script = map->default_room_script;
    view.default_path_script = map->default_path_script;

    int min_x = std::numeric_limits<int>::max();
    int min_y = std::numeric_limits<int>::max();
    int max_x = std::numeric_limits<int>::min();
    int max_y = std::numeric_limits<int>::min();

    for (const auto& room : map->rooms) {
        RuntimeUIMapRoom out;
        out.name = room.name;
        out.room_ids = room.room_ids;
        out.visibility_script = room.script;
        out.left = room.left;
        out.top = room.top;
        out.width = room.width;
        out.height = room.height;
        out.style = room.style;
        out.visible = view.enabled;
        out.current = contains_room_id(room, *current_room);

        const auto reachable = reachable_path_indices(*project, *current_room, room);
        if (out.visible && !out.current && !reachable.empty()) {
            out.enabled = true;
            out.navigation_index = reachable.front();
        }

        min_x = std::min(min_x, room.left);
        min_y = std::min(min_y, room.top);
        max_x = std::max(max_x, room.left + room.width);
        max_y = std::max(max_y, room.top + room.height);
        view.rooms.push_back(std::move(out));
    }

    if (view.rooms.empty()) {
        min_x = 0;
        min_y = 0;
        max_x = 0;
        max_y = 0;
    }

    for (const auto& connection : map->connections) {
        RuntimeUIMapConnection out;
        out.room_start = connection.room_start;
        out.room_end = connection.room_end;
        out.port_start_x = connection.port_start_x;
        out.port_start_y = connection.port_start_y;
        out.port_end_x = connection.port_end_x;
        out.port_end_y = connection.port_end_y;
        out.visibility_script = connection.script;
        out.style = connection.style;
        const auto start = static_cast<std::size_t>(connection.room_start);
        const auto end = static_cast<std::size_t>(connection.room_end);
        out.visible = view.enabled && connection.room_start >= 0 && connection.room_end >= 0 &&
                      start < view.rooms.size() && end < view.rooms.size() &&
                      view.rooms[start].visible && view.rooms[end].visible;
        view.connections.push_back(std::move(out));
    }

    view.min_x = min_x;
    view.min_y = min_y;
    view.max_x = max_x;
    view.max_y = max_y;
    m_state.map_view = std::move(view);
}

void RuntimeUIViewAdapter::apply_options(const nlohmann::json& options)
{
    m_state.dialogue_options.clear();
    if (!options.is_array())
        return;
    for (const auto& option : options) {
        if (!option.is_object())
            continue;
        RuntimeUIOption out;
        out.text = json_string_or(option, "text");
        out.enabled = option.value("enabled", true);
        m_state.dialogue_options.push_back(std::move(out));
    }
}

void RuntimeUIViewAdapter::apply_navigation(const nlohmann::json& data)
{
    m_state.navigation.clear();
    static constexpr std::array<const char*, 4> keys = {"north", "east", "south", "west"};
    for (const char* key : keys) {
        if (data.value(key, false)) {
            m_state.navigation.emplace_back(key);
        }
    }

    const auto paths = data.find("paths");
    if (paths != data.end() && paths->is_array()) {
        for (const auto& path : *paths) {
            if (path.is_string()) {
                m_state.navigation.push_back(path.get<std::string>());
            } else if (path.is_object()) {
                auto label = json_string_or(path, "label");
                if (label.empty())
                    label = json_string_or(path, "direction");
                if (label.empty())
                    label = json_string_or(path, "target_id");
                if (!label.empty() && path.value("enabled", true)) {
                    m_state.navigation.push_back(std::move(label));
                }
            }
        }
    }
}

void RuntimeUIViewAdapter::push_log_entry(RuntimeUITextLogEntry entry)
{
    if (entry.plain_text.empty())
        return;
    m_state.text_log.push_back(std::move(entry));
    if (m_state.text_log.size() > kMaxTextLogLines) {
        m_state.text_log.erase(
            m_state.text_log.begin(),
            m_state.text_log.begin() +
                static_cast<std::ptrdiff_t>(m_state.text_log.size() - kMaxTextLogLines));
    }
}

RuntimeUITextLogEntry make_text_log_entry(std::string text, const nlohmann::json& data,
                                          std::uint64_t sequence)
{
    const auto& metadata = text_log_metadata(data);

    RuntimeUITextLogEntry entry;
    entry.sequence = sequence;
    entry.plain_text = std::move(text);
    entry.rich_text = rich_text_or_parse(metadata, entry.plain_text);
    entry.speaker = json_string_or(metadata, "speaker", json_string_or(metadata, "name"));
    entry.source_name = json_string_or(metadata, "source_name");
    if (entry.source_name.empty()) {
        entry.source_name = entry.speaker;
    }
    entry.category = json_string_or(metadata, "category");
    entry.source = entity_ref_or_empty(metadata, "source");
    if (!entry.source.has_value()) {
        entry.source = entity_ref_or_empty(metadata, "source_ref");
    }
    return entry;
}

nlohmann::json text_log_entry_to_json(const RuntimeUITextLogEntry& entry)
{
    nlohmann::json out = {
        {"sequence", entry.sequence},
        {"plain_text", entry.plain_text},
        {"rich_text", to_json(entry.rich_text)},
    };
    if (!entry.speaker.empty()) {
        out["speaker"] = entry.speaker;
    }
    if (!entry.source_name.empty()) {
        out["source_name"] = entry.source_name;
    }
    if (entry.source.has_value()) {
        out["source"] = entry.source->to_json();
    }
    if (!entry.category.empty()) {
        out["category"] = entry.category;
    }
    return out;
}

} // namespace noveltea::core
