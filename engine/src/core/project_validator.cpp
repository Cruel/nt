#include <noveltea/core/project_validator.hpp>

#include <set>
#include <string_view>

#include <nlohmann/json.hpp>

#include <noveltea/core/legacy/entity_schema.hpp>
#include <noveltea/core/project_ids.hpp>

namespace noveltea::core {
namespace {

using nlohmann::json;

std::string key(std::string_view value)
{
    return std::string(value);
}

void add_issue(std::vector<ValidationIssue>& issues, std::string path, std::string message)
{
    issues.push_back(ValidationIssue {std::move(path), std::move(message)});
}

std::string type_name(EntityType type)
{
    if (const auto collection = entity_type_collection_key(type); collection.has_value()) {
        return key(*collection);
    }
    if (type == EntityType::CustomScript) {
        return "custom-script";
    }
    return "invalid";
}

struct EntityIndex {
    std::set<std::string> actions;
    std::set<std::string> cutscenes;
    std::set<std::string> dialogues;
    std::set<std::string> maps;
    std::set<std::string> objects;
    std::set<std::string> rooms;
    std::set<std::string> scripts;
    std::set<std::string> verbs;
};

const std::set<std::string>* set_for(const EntityIndex& index, EntityType type)
{
    switch (type) {
    case EntityType::Action:
        return &index.actions;
    case EntityType::Cutscene:
        return &index.cutscenes;
    case EntityType::Dialogue:
        return &index.dialogues;
    case EntityType::Map:
        return &index.maps;
    case EntityType::Object:
        return &index.objects;
    case EntityType::Room:
        return &index.rooms;
    case EntityType::Script:
        return &index.scripts;
    case EntityType::Verb:
        return &index.verbs;
    case EntityType::CustomScript:
    case EntityType::Invalid:
        return nullptr;
    }
    return nullptr;
}

void insert_ids(EntityIndex& index, EntityType type, const json& collection)
{
    if (!collection.is_object()) {
        return;
    }
    auto* ids = const_cast<std::set<std::string>*>(set_for(index, type));
    if (ids == nullptr) {
        return;
    }
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        ids->insert(it.key());
    }
}

bool ref_exists(const EntityIndex& index, const EntityRef& ref)
{
    if (ref.type == EntityType::CustomScript) {
        return ref.has_id();
    }
    const auto* ids = set_for(index, ref.type);
    return ids != nullptr && ids->contains(ref.id);
}

void validate_ref(const EntityIndex& index, const EntityRef& ref, std::string path,
                  std::vector<ValidationIssue>& issues)
{
    if (!ref.has_id()) {
        add_issue(issues, std::move(path), "selected-entity ref has an empty id");
        return;
    }
    if (!is_known_entity_type(ref.type)) {
        add_issue(issues, std::move(path), "selected-entity ref has unknown type");
        return;
    }
    if (!ref_exists(index, ref)) {
        add_issue(issues, std::move(path), "missing " + type_name(ref.type) + " entity '" + ref.id + "'");
    }
}

EntityIndex build_index(const json& root)
{
    EntityIndex index;
    if (!root.is_object()) {
        return index;
    }
    const auto add = [&](EntityType type, std::string_view collection_key) {
        const auto it = root.find(key(collection_key));
        if (it != root.end()) {
            insert_ids(index, type, *it);
        }
    };
    add(EntityType::Action, project_ids::action);
    add(EntityType::Cutscene, project_ids::cutscene);
    add(EntityType::Dialogue, project_ids::dialogue);
    add(EntityType::Map, project_ids::map);
    add(EntityType::Object, project_ids::object);
    add(EntityType::Room, project_ids::room);
    add(EntityType::Script, project_ids::script);
    add(EntityType::Verb, project_ids::verb);
    return index;
}

std::vector<legacy::EntityView> parse_entities(EntityType type, const json& root, std::string_view collection_key,
                                               std::vector<ValidationIssue>& issues)
{
    const auto collection_path = "/" + key(collection_key);
    const auto it = root.find(key(collection_key));
    if (it == root.end()) {
        add_issue(issues, collection_path, "missing entity collection");
        return {};
    }

    std::vector<legacy::SchemaError> schema_errors;
    auto entities = legacy::parse_project_entities(type, *it, schema_errors, collection_path);
    for (const auto& error : schema_errors) {
        add_issue(issues, error.path, error.message);
    }
    return entities;
}

void validate_starting_inventory(const EntityIndex& index, const json& root, std::vector<ValidationIssue>& issues)
{
    const auto it = root.find(key(project_ids::starting_inventory));
    if (it == root.end() || !it->is_array()) {
        return;
    }
    for (std::size_t i = 0; i < it->size(); ++i) {
        const auto path = "/startInv/" + std::to_string(i);
        if (!(*it)[i].is_string()) {
            add_issue(issues, path, "starting inventory entry must be an object id string");
            continue;
        }
        const auto id = (*it)[i].get<std::string>();
        if (!index.objects.contains(id)) {
            add_issue(issues, path, "missing object entity '" + id + "'");
        }
    }
}

void validate_entrypoint(const EntityIndex& index, const json& root, std::vector<ValidationIssue>& issues)
{
    const auto it = root.find(key(project_ids::entrypoint_entity));
    if (it == root.end()) {
        return;
    }
    auto ref = EntityRef::from_json(*it);
    if (!ref.has_value()) {
        add_issue(issues, "/entrypoint", "expected selected-entity array [type, id]");
        return;
    }
    validate_ref(index, *ref, "/entrypoint", issues);
}

void validate_actions(const EntityIndex& index, const std::vector<legacy::EntityView>& entities,
                      std::vector<ValidationIssue>& issues)
{
    for (const auto& entity : entities) {
        if (!entity.action) {
            continue;
        }
        const auto base = "/action/" + entity.action->header.id;
        if (!index.verbs.contains(entity.action->verb_id)) {
            add_issue(issues, base + "[3]", "missing verb entity '" + entity.action->verb_id + "'");
        }
        for (std::size_t i = 0; i < entity.action->object_ids.size(); ++i) {
            const auto& object_id = entity.action->object_ids[i];
            if (!index.objects.contains(object_id)) {
                add_issue(issues, base + "[5][" + std::to_string(i) + "]", "missing object entity '" + object_id + "'");
            }
        }
    }
}

void validate_rooms(const EntityIndex& index, const std::vector<legacy::EntityView>& entities,
                    std::vector<ValidationIssue>& issues)
{
    for (const auto& entity : entities) {
        if (!entity.room) {
            continue;
        }
        const auto base = "/room/" + entity.room->header.id;
        for (std::size_t i = 0; i < entity.room->objects.size(); ++i) {
            const auto& object_id = entity.room->objects[i].object_id;
            if (!index.objects.contains(object_id)) {
                add_issue(issues, base + "[8][" + std::to_string(i) + "][0]", "missing object entity '" + object_id + "'");
            }
        }
        if (entity.room->paths == nullptr || !entity.room->paths->is_array()) {
            continue;
        }
        for (std::size_t i = 0; i < entity.room->paths->size(); ++i) {
            const auto path = base + "[9][" + std::to_string(i) + "]";
            const auto& value = (*entity.room->paths)[i];
            if (!value.is_array() || value.size() != 2 || !value[0].is_boolean()) {
                add_issue(issues, path, "expected room path [enabled, selectedEntity]");
                continue;
            }
            if (!value[0].get<bool>()) {
                continue;
            }
            auto ref = EntityRef::from_json(value[1]);
            if (!ref.has_value()) {
                add_issue(issues, path + "[1]", "expected selected-entity array [type, id]");
                continue;
            }
            validate_ref(index, *ref, path + "[1]", issues);
        }
    }
}

void validate_maps(const EntityIndex& index, const std::vector<legacy::EntityView>& entities,
                   std::vector<ValidationIssue>& issues)
{
    for (const auto& entity : entities) {
        if (!entity.map) {
            continue;
        }
        const auto base = "/map/" + entity.map->header.id;
        for (std::size_t i = 0; i < entity.map->rooms.size(); ++i) {
            const auto& room = entity.map->rooms[i];
            for (std::size_t j = 0; j < room.room_ids.size(); ++j) {
                const auto& room_id = room.room_ids[j];
                if (!index.rooms.contains(room_id)) {
                    add_issue(issues, base + "[5][" + std::to_string(i) + "][5][" + std::to_string(j) + "]",
                              "missing room entity '" + room_id + "'");
                }
            }
        }
        for (std::size_t i = 0; i < entity.map->connections.size(); ++i) {
            const auto& connection = entity.map->connections[i];
            const auto room_count = static_cast<int>(entity.map->rooms.size());
            if (connection.room_start < 0 || connection.room_start >= room_count) {
                add_issue(issues, base + "[6][" + std::to_string(i) + "][0]", "map connection start room index is out of range");
            }
            if (connection.room_end < 0 || connection.room_end >= room_count) {
                add_issue(issues, base + "[6][" + std::to_string(i) + "][1]", "map connection end room index is out of range");
            }
        }
    }
}

void validate_dialogues(const EntityIndex& index, const std::vector<legacy::EntityView>& entities,
                        std::vector<ValidationIssue>& issues)
{
    for (const auto& entity : entities) {
        if (!entity.dialogue) {
            continue;
        }
        const auto base = "/dialogue/" + entity.dialogue->header.id;
        if (entity.dialogue->next_entity) {
            validate_ref(index, *entity.dialogue->next_entity, base + "[4]", issues);
        }
        const auto segment_count = static_cast<int>(entity.dialogue->segments.size());
        if (entity.dialogue->root_index < 0 || entity.dialogue->root_index >= segment_count) {
            add_issue(issues, base + "[5]", "dialogue root index is out of range");
        }
        for (std::size_t i = 0; i < entity.dialogue->segments.size(); ++i) {
            const auto& segment = entity.dialogue->segments[i];
            if (segment.link_id >= segment_count) {
                add_issue(issues, base + "[9][" + std::to_string(i) + "][1]", "dialogue link id is out of range");
            }
            for (std::size_t j = 0; j < segment.children_ids.size(); ++j) {
                const int child = segment.children_ids[j];
                if (child < 0 || child >= segment_count) {
                    add_issue(issues, base + "[9][" + std::to_string(i) + "][11][" + std::to_string(j) + "]",
                              "dialogue child id is out of range");
                }
            }
        }
    }
}

void validate_cutscenes(const EntityIndex& index, const std::vector<legacy::EntityView>& entities,
                        std::vector<ValidationIssue>& issues)
{
    for (const auto& entity : entities) {
        if (!entity.cutscene) {
            continue;
        }
        const auto base = "/cutscene/" + entity.cutscene->header.id;
        if (entity.cutscene->next_entity) {
            validate_ref(index, *entity.cutscene->next_entity, base + "[6]", issues);
        }
    }
}

} // namespace

std::vector<ValidationIssue> ProjectValidator::validate(const ProjectDocument& project)
{
    std::vector<ValidationIssue> issues;
    const auto& root = project.root();
    if (!root.is_object()) {
        add_issue(issues, "", "project root must be an object");
        return issues;
    }

    const auto index = build_index(root);
    validate_entrypoint(index, root, issues);
    validate_starting_inventory(index, root, issues);

    const auto actions = parse_entities(EntityType::Action, root, project_ids::action, issues);
    const auto cutscenes = parse_entities(EntityType::Cutscene, root, project_ids::cutscene, issues);
    const auto dialogues = parse_entities(EntityType::Dialogue, root, project_ids::dialogue, issues);
    const auto maps = parse_entities(EntityType::Map, root, project_ids::map, issues);
    parse_entities(EntityType::Object, root, project_ids::object, issues);
    const auto rooms = parse_entities(EntityType::Room, root, project_ids::room, issues);
    parse_entities(EntityType::Script, root, project_ids::script, issues);
    parse_entities(EntityType::Verb, root, project_ids::verb, issues);

    validate_actions(index, actions, issues);
    validate_cutscenes(index, cutscenes, issues);
    validate_dialogues(index, dialogues, issues);
    validate_maps(index, maps, issues);
    validate_rooms(index, rooms, issues);

    return issues;
}

} // namespace noveltea::core
