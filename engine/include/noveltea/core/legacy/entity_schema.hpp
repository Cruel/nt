#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json_fwd.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/entity_type.hpp>

namespace noveltea::core::legacy {

struct SchemaError {
    std::string path;
    std::string message;
};

struct EntityHeader {
    std::string id;
    std::string parent_id;
    const nlohmann::json* properties = nullptr;
};

struct ObjectView {
    EntityHeader header;
    std::string name;
    bool case_sensitive = false;
};

struct ScriptView {
    EntityHeader header;
    bool autorun = false;
    std::string content;
};

struct ActionView {
    EntityHeader header;
    std::string verb_id;
    std::string script;
    std::vector<std::string> object_ids;
    bool position_dependent = false;
};

struct VerbView {
    EntityHeader header;
    std::string name;
    int object_count = 0;
    std::string default_script;
    std::string conditional_script;
    std::vector<std::string> action_structure;
};

struct RoomObjectView {
    std::string object_id;
    bool place_in_room = false;
};

struct RoomView {
    EntityHeader header;
    std::string description_raw;
    std::string script_before_enter;
    std::string script_after_enter;
    std::string script_before_leave;
    std::string script_after_leave;
    std::vector<RoomObjectView> objects;
    const nlohmann::json* paths = nullptr;
    std::string name;
};

struct MapRoomView {
    std::string name;
    int left = 0;
    int top = 0;
    int width = 0;
    int height = 0;
    std::vector<std::string> room_ids;
    std::string script;
    int style = 0;
};

struct MapConnectionView {
    int room_start = 0;
    int room_end = 0;
    int port_start_x = 0;
    int port_start_y = 0;
    int port_end_x = 0;
    int port_end_y = 0;
    std::string script;
    int style = 0;
};

struct MapView {
    EntityHeader header;
    std::string default_room_script;
    std::string default_path_script;
    std::vector<MapRoomView> rooms;
    std::vector<MapConnectionView> connections;
};

struct DialogueSegmentView {
    int type = -1;
    int link_id = -1;
    bool conditional_enabled = false;
    bool scripted_text = false;
    bool script_enabled = false;
    bool autosave = false;
    bool show_once = false;
    bool is_logged = true;
    std::string condition_script;
    std::string script;
    std::string text_raw;
    std::vector<int> children_ids;
};

struct DialogueView {
    EntityHeader header;
    std::string default_name;
    std::optional<EntityRef> next_entity;
    int root_index = 0;
    bool enable_disabled_options = false;
    bool show_disabled_options = false;
    int log_mode = 0;
    std::vector<DialogueSegmentView> segments;
};

struct CutsceneSegmentView {
    int type = -1;
    const nlohmann::json* record = nullptr;
};

struct CutsceneView {
    EntityHeader header;
    bool full_screen = true;
    bool can_fast_forward = true;
    double speed_factor = 1.0;
    std::optional<EntityRef> next_entity;
    std::vector<CutsceneSegmentView> segments;
};

struct EntityView {
    EntityType type = EntityType::Invalid;
    std::optional<ObjectView> object;
    std::optional<ScriptView> script;
    std::optional<ActionView> action;
    std::optional<VerbView> verb;
    std::optional<RoomView> room;
    std::optional<MapView> map;
    std::optional<DialogueView> dialogue;
    std::optional<CutsceneView> cutscene;
};

[[nodiscard]] std::optional<EntityView> parse_entity_record(EntityType type,
                                                            const nlohmann::json& record,
                                                            std::vector<SchemaError>& errors,
                                                            std::string_view path = {});

[[nodiscard]] std::vector<EntityView> parse_project_entities(EntityType type,
                                                             const nlohmann::json& collection,
                                                             std::vector<SchemaError>& errors,
                                                             std::string_view path = {});

} // namespace noveltea::core::legacy
