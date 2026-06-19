#pragma once

#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/project_validator.hpp>

namespace noveltea::core {

struct EntityId {
    EntityType type = EntityType::Invalid;
    std::string id;

    [[nodiscard]] bool valid() const noexcept
    {
        return is_project_entity_type(type) && !id.empty();
    }
};

struct EntityMetadata {
    EntityId entity;
    std::string parent_id;
    nlohmann::json properties = nlohmann::json::object();
};

struct ObjectModel {
    EntityMetadata metadata;
    std::string name;
    bool case_sensitive = false;
};

struct ScriptModel {
    EntityMetadata metadata;
    bool autorun = false;
    std::string content;
};

struct ActionModel {
    EntityMetadata metadata;
    std::string verb_id;
    std::string script;
    std::vector<std::string> object_ids;
    bool position_dependent = false;
};

struct VerbModel {
    EntityMetadata metadata;
    std::string name;
    int object_count = 0;
    std::string default_script;
    std::string conditional_script;
    std::vector<std::string> action_structure;
};

struct RoomObjectModel {
    std::string object_id;
    bool place_in_room = false;
};

struct RoomPathModel {
    bool enabled = false;
    std::optional<EntityRef> target;
};

struct RoomModel {
    EntityMetadata metadata;
    std::string description_raw;
    std::string script_before_enter;
    std::string script_after_enter;
    std::string script_before_leave;
    std::string script_after_leave;
    std::vector<RoomObjectModel> objects;
    std::vector<RoomPathModel> paths;
    std::string name;
};

struct MapRoomModel {
    std::string name;
    int left = 0;
    int top = 0;
    int width = 0;
    int height = 0;
    std::vector<std::string> room_ids;
    std::string script;
    int style = 0;
};

struct MapConnectionModel {
    int room_start = 0;
    int room_end = 0;
    int port_start_x = 0;
    int port_start_y = 0;
    int port_end_x = 0;
    int port_end_y = 0;
    std::string script;
    int style = 0;
};

struct MapModel {
    EntityMetadata metadata;
    std::string default_room_script;
    std::string default_path_script;
    std::vector<MapRoomModel> rooms;
    std::vector<MapConnectionModel> connections;
};

struct DialogueSegmentModel {
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

struct DialogueModel {
    EntityMetadata metadata;
    std::string default_name;
    std::optional<EntityRef> next_entity;
    int root_index = 0;
    bool enable_disabled_options = false;
    bool show_disabled_options = false;
    int log_mode = 0;
    std::vector<DialogueSegmentModel> segments;
};

struct CutsceneSegmentModel {
    int type = -1;
    nlohmann::json record = nlohmann::json::array();
};

struct CutsceneModel {
    EntityMetadata metadata;
    bool full_screen = true;
    bool can_fast_forward = true;
    double speed_factor = 1.0;
    std::optional<EntityRef> next_entity;
    std::vector<CutsceneSegmentModel> segments;
};

class ProjectModel {
public:
    using ObjectStore = std::map<std::string, ObjectModel>;
    using ScriptStore = std::map<std::string, ScriptModel>;
    using ActionStore = std::map<std::string, ActionModel>;
    using VerbStore = std::map<std::string, VerbModel>;
    using RoomStore = std::map<std::string, RoomModel>;
    using MapStore = std::map<std::string, MapModel>;
    using DialogueStore = std::map<std::string, DialogueModel>;
    using CutsceneStore = std::map<std::string, CutsceneModel>;

    [[nodiscard]] static std::optional<ProjectModel>
    from_document(const ProjectDocument& document, std::vector<ValidationIssue>& issues);

    [[nodiscard]] const ObjectStore& objects() const noexcept { return m_objects; }
    [[nodiscard]] const ScriptStore& scripts() const noexcept { return m_scripts; }
    [[nodiscard]] const ActionStore& actions() const noexcept { return m_actions; }
    [[nodiscard]] const VerbStore& verbs() const noexcept { return m_verbs; }
    [[nodiscard]] const RoomStore& rooms() const noexcept { return m_rooms; }
    [[nodiscard]] const MapStore& maps() const noexcept { return m_maps; }
    [[nodiscard]] const DialogueStore& dialogues() const noexcept { return m_dialogues; }
    [[nodiscard]] const CutsceneStore& cutscenes() const noexcept { return m_cutscenes; }

    [[nodiscard]] std::optional<EntityMetadata> metadata(EntityType type,
                                                         const std::string& id) const;
    [[nodiscard]] std::optional<EntityMetadata> parent_metadata(EntityType type,
                                                                const std::string& id) const;
    [[nodiscard]] nlohmann::json merged_properties(EntityType type, const std::string& id) const;

    [[nodiscard]] const nlohmann::json& document_root() const noexcept { return m_document_root; }

private:
    nlohmann::json m_document_root = nlohmann::json::object();

    ObjectStore m_objects;
    ScriptStore m_scripts;
    ActionStore m_actions;
    VerbStore m_verbs;
    RoomStore m_rooms;
    MapStore m_maps;
    DialogueStore m_dialogues;
    CutsceneStore m_cutscenes;
};

} // namespace noveltea::core
