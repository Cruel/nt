#include <noveltea/core/project_model.hpp>

#include <nlohmann/json.hpp>

#include <noveltea/core/legacy/entity_schema.hpp>
#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {
namespace {

std::string key(std::string_view value)
{
    return std::string(value);
}

EntityMetadata metadata_from(EntityType type, const legacy::EntityHeader& header)
{
    EntityMetadata out;
    out.entity = EntityId {type, header.id};
    out.parent_id = header.parent_id;
    if (header.properties != nullptr && header.properties->is_object()) {
        out.properties = *header.properties;
    }
    return out;
}

void append_schema_issues(const std::vector<legacy::SchemaError>& schema_errors, std::vector<ValidationIssue>& issues)
{
    for (const auto& error : schema_errors) {
        issues.push_back(ValidationIssue {error.path, error.message});
    }
}

std::vector<legacy::EntityView> parse_entities(const ProjectDocument& document, EntityType type,
                                               std::string_view collection_key, std::vector<ValidationIssue>& issues)
{
    const auto& root = document.root();
    const auto it = root.find(key(collection_key));
    if (it == root.end()) {
        issues.push_back(ValidationIssue {"/" + key(collection_key), "missing entity collection"});
        return {};
    }

    std::vector<legacy::SchemaError> schema_errors;
    auto views = legacy::parse_project_entities(type, *it, schema_errors, "/" + key(collection_key));
    append_schema_issues(schema_errors, issues);
    return views;
}

std::vector<RoomPathModel> room_paths_from(const legacy::RoomView& view)
{
    std::vector<RoomPathModel> out;
    if (view.paths == nullptr || !view.paths->is_array()) {
        return out;
    }
    for (const auto& path : *view.paths) {
        RoomPathModel model;
        if (path.is_array() && path.size() == 2 && path[0].is_boolean()) {
            model.enabled = path[0].get<bool>();
            model.target = EntityRef::from_json(path[1]);
        }
        out.push_back(std::move(model));
    }
    return out;
}

void merge_json_object(nlohmann::json& target, const nlohmann::json& source)
{
    if (!source.is_object()) {
        return;
    }
    for (auto it = source.begin(); it != source.end(); ++it) {
        target[it.key()] = it.value();
    }
}

} // namespace

std::optional<ProjectModel> ProjectModel::from_document(const ProjectDocument& document, std::vector<ValidationIssue>& issues)
{
    auto validation_issues = ProjectValidator::validate(document);
    issues.insert(issues.end(), validation_issues.begin(), validation_issues.end());
    if (!validation_issues.empty()) {
        return std::nullopt;
    }

    ProjectModel model;

    for (const auto& entity : parse_entities(document, EntityType::Object, project_ids::object, issues)) {
        if (!entity.object) {
            continue;
        }
        ObjectModel value;
        value.metadata = metadata_from(EntityType::Object, entity.object->header);
        value.name = entity.object->name;
        value.case_sensitive = entity.object->case_sensitive;
        model.m_objects.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Script, project_ids::script, issues)) {
        if (!entity.script) {
            continue;
        }
        ScriptModel value;
        value.metadata = metadata_from(EntityType::Script, entity.script->header);
        value.autorun = entity.script->autorun;
        value.content = entity.script->content;
        model.m_scripts.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Action, project_ids::action, issues)) {
        if (!entity.action) {
            continue;
        }
        ActionModel value;
        value.metadata = metadata_from(EntityType::Action, entity.action->header);
        value.verb_id = entity.action->verb_id;
        value.script = entity.action->script;
        value.object_ids = entity.action->object_ids;
        value.position_dependent = entity.action->position_dependent;
        model.m_actions.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Verb, project_ids::verb, issues)) {
        if (!entity.verb) {
            continue;
        }
        VerbModel value;
        value.metadata = metadata_from(EntityType::Verb, entity.verb->header);
        value.name = entity.verb->name;
        value.object_count = entity.verb->object_count;
        value.default_script = entity.verb->default_script;
        value.conditional_script = entity.verb->conditional_script;
        value.action_structure = entity.verb->action_structure;
        model.m_verbs.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Room, project_ids::room, issues)) {
        if (!entity.room) {
            continue;
        }
        RoomModel value;
        value.metadata = metadata_from(EntityType::Room, entity.room->header);
        value.description_raw = entity.room->description_raw;
        value.script_before_enter = entity.room->script_before_enter;
        value.script_after_enter = entity.room->script_after_enter;
        value.script_before_leave = entity.room->script_before_leave;
        value.script_after_leave = entity.room->script_after_leave;
        value.name = entity.room->name;
        for (const auto& object : entity.room->objects) {
            value.objects.push_back(RoomObjectModel {object.object_id, object.place_in_room});
        }
        value.paths = room_paths_from(*entity.room);
        model.m_rooms.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Map, project_ids::map, issues)) {
        if (!entity.map) {
            continue;
        }
        MapModel value;
        value.metadata = metadata_from(EntityType::Map, entity.map->header);
        value.default_room_script = entity.map->default_room_script;
        value.default_path_script = entity.map->default_path_script;
        for (const auto& room : entity.map->rooms) {
            value.rooms.push_back(MapRoomModel {room.name, room.left, room.top, room.width, room.height,
                                                room.room_ids, room.script, room.style});
        }
        for (const auto& connection : entity.map->connections) {
            value.connections.push_back(MapConnectionModel {connection.room_start, connection.room_end,
                                                            connection.port_start_x, connection.port_start_y,
                                                            connection.port_end_x, connection.port_end_y,
                                                            connection.script, connection.style});
        }
        model.m_maps.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Dialogue, project_ids::dialogue, issues)) {
        if (!entity.dialogue) {
            continue;
        }
        DialogueModel value;
        value.metadata = metadata_from(EntityType::Dialogue, entity.dialogue->header);
        value.default_name = entity.dialogue->default_name;
        value.next_entity = entity.dialogue->next_entity;
        value.root_index = entity.dialogue->root_index;
        value.enable_disabled_options = entity.dialogue->enable_disabled_options;
        value.show_disabled_options = entity.dialogue->show_disabled_options;
        value.log_mode = entity.dialogue->log_mode;
        for (const auto& segment : entity.dialogue->segments) {
            value.segments.push_back(DialogueSegmentModel {segment.type, segment.link_id, segment.conditional_enabled,
                                                           segment.scripted_text, segment.script_enabled,
                                                           segment.autosave, segment.show_once, segment.is_logged,
                                                           segment.condition_script, segment.script,
                                                           segment.text_raw, segment.children_ids});
        }
        model.m_dialogues.emplace(value.metadata.entity.id, std::move(value));
    }
    for (const auto& entity : parse_entities(document, EntityType::Cutscene, project_ids::cutscene, issues)) {
        if (!entity.cutscene) {
            continue;
        }
        CutsceneModel value;
        value.metadata = metadata_from(EntityType::Cutscene, entity.cutscene->header);
        value.full_screen = entity.cutscene->full_screen;
        value.can_fast_forward = entity.cutscene->can_fast_forward;
        value.speed_factor = entity.cutscene->speed_factor;
        value.next_entity = entity.cutscene->next_entity;
        for (const auto& segment : entity.cutscene->segments) {
            value.segments.push_back(CutsceneSegmentModel {
                segment.type,
                segment.record != nullptr ? *segment.record : nlohmann::json::array(),
            });
        }
        model.m_cutscenes.emplace(value.metadata.entity.id, std::move(value));
    }

    return model;
}

std::optional<EntityMetadata> ProjectModel::metadata(EntityType type, const std::string& id) const
{
    switch (type) {
    case EntityType::Action:
        if (const auto it = m_actions.find(id); it != m_actions.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Cutscene:
        if (const auto it = m_cutscenes.find(id); it != m_cutscenes.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Dialogue:
        if (const auto it = m_dialogues.find(id); it != m_dialogues.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Map:
        if (const auto it = m_maps.find(id); it != m_maps.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Object:
        if (const auto it = m_objects.find(id); it != m_objects.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Room:
        if (const auto it = m_rooms.find(id); it != m_rooms.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Script:
        if (const auto it = m_scripts.find(id); it != m_scripts.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::Verb:
        if (const auto it = m_verbs.find(id); it != m_verbs.end()) {
            return it->second.metadata;
        }
        break;
    case EntityType::CustomScript:
    case EntityType::Invalid:
        break;
    }
    return std::nullopt;
}

std::optional<EntityMetadata> ProjectModel::parent_metadata(EntityType type, const std::string& id) const
{
    const auto child = metadata(type, id);
    if (!child.has_value() || child->parent_id.empty()) {
        return std::nullopt;
    }
    return metadata(type, child->parent_id);
}

nlohmann::json ProjectModel::merged_properties(EntityType type, const std::string& id) const
{
    nlohmann::json result = nlohmann::json::object();
    const auto entity = metadata(type, id);
    if (!entity.has_value()) {
        return result;
    }
    if (!entity->parent_id.empty()) {
        merge_json_object(result, merged_properties(type, entity->parent_id));
    }
    merge_json_object(result, entity->properties);
    return result;
}

} // namespace noveltea::core
