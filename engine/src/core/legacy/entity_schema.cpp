#include <noveltea/core/legacy/entity_schema.hpp>

#include <cstddef>

#include <nlohmann/json.hpp>

#include <noveltea/core/project_ids.hpp>
#include <noveltea/core/json_access.hpp>

namespace noveltea::core::legacy {
namespace {

using json_access::get_or;
using nlohmann::json;

std::string child_path(std::string_view path, std::string_view suffix)
{
    if (path.empty()) {
        return std::string(suffix);
    }
    std::string out(path);
    out += suffix;
    return out;
}

void add_error(std::vector<SchemaError>& errors, std::string_view path, std::string message)
{
    errors.push_back(SchemaError{std::string(path), std::move(message)});
}

bool expect_array(const json& value, std::size_t size, std::vector<SchemaError>& errors,
                  std::string_view path)
{
    if (!value.is_array()) {
        add_error(errors, path, "expected array record");
        return false;
    }
    if (value.size() != size) {
        add_error(errors, path,
                  "expected array record with " + std::to_string(size) + " fields, found " +
                      std::to_string(value.size()));
        return false;
    }
    return true;
}

bool expect_string(const json& value, std::vector<SchemaError>& errors, std::string_view path)
{
    if (value.is_string()) {
        return true;
    }
    add_error(errors, path, "expected string");
    return false;
}

bool expect_bool(const json& value, std::vector<SchemaError>& errors, std::string_view path)
{
    if (value.is_boolean()) {
        return true;
    }
    add_error(errors, path, "expected boolean");
    return false;
}

bool expect_number_integer(const json& value, std::vector<SchemaError>& errors,
                           std::string_view path)
{
    if (value.is_number_integer()) {
        return true;
    }
    add_error(errors, path, "expected integer");
    return false;
}

bool expect_number(const json& value, std::vector<SchemaError>& errors, std::string_view path)
{
    if (value.is_number()) {
        return true;
    }
    add_error(errors, path, "expected number");
    return false;
}

bool expect_object(const json& value, std::vector<SchemaError>& errors, std::string_view path)
{
    if (value.is_object()) {
        return true;
    }
    add_error(errors, path, "expected object");
    return false;
}

bool expect_string_array(const json& value, std::vector<std::string>& out,
                         std::vector<SchemaError>& errors, std::string_view path)
{
    if (!value.is_array()) {
        add_error(errors, path, "expected string array");
        return false;
    }
    bool ok = true;
    for (std::size_t i = 0; i < value.size(); ++i) {
        const auto item_path = child_path(path, "[" + std::to_string(i) + "]");
        ok = expect_string(value[i], errors, item_path) && ok;
        if (value[i].is_string()) {
            out.push_back(get_or<std::string>(value[i], {}));
        }
    }
    return ok;
}

bool expect_int_array(const json& value, std::vector<int>& out, std::vector<SchemaError>& errors,
                      std::string_view path)
{
    if (!value.is_array()) {
        add_error(errors, path, "expected integer array");
        return false;
    }
    bool ok = true;
    for (std::size_t i = 0; i < value.size(); ++i) {
        const auto item_path = child_path(path, "[" + std::to_string(i) + "]");
        ok = expect_number_integer(value[i], errors, item_path) && ok;
        if (value[i].is_number_integer()) {
            out.push_back(get_or<int>(value[i], 0));
        }
    }
    return ok;
}

std::optional<EntityHeader> parse_header(const json& record, std::vector<SchemaError>& errors,
                                         std::string_view path)
{
    bool ok = true;
    ok = expect_string(record[0], errors, child_path(path, "[0]")) && ok;
    ok = expect_string(record[1], errors, child_path(path, "[1]")) && ok;
    ok = expect_object(record[2], errors, child_path(path, "[2]")) && ok;
    if (!ok) {
        return std::nullopt;
    }
    return EntityHeader{get_or<std::string>(record[0], {}), get_or<std::string>(record[1], {}),
                        &record[2]};
}

bool expect_entity_ref_or_inline_script(const json& value, std::optional<EntityRef>& out,
                                        std::vector<SchemaError>& errors, std::string_view path)
{
    auto parsed = EntityRef::from_json(value);
    if (!parsed.has_value()) {
        add_error(errors, path, "expected selected-entity array [type, id]");
        return false;
    }
    out = std::move(parsed);
    return true;
}

std::optional<DialogueSegmentView>
parse_dialogue_segment(const json& record, std::vector<SchemaError>& errors, std::string_view path)
{
    if (!expect_array(record, 12, errors, path)) {
        return std::nullopt;
    }
    bool ok = true;
    ok = expect_number_integer(record[0], errors, child_path(path, "[0]")) && ok;
    ok = expect_number_integer(record[1], errors, child_path(path, "[1]")) && ok;
    for (int i = 2; i <= 7; ++i) {
        ok = expect_bool(record[static_cast<std::size_t>(i)], errors,
                         child_path(path, "[" + std::to_string(i) + "]")) &&
             ok;
    }
    for (int i = 8; i <= 10; ++i) {
        ok = expect_string(record[static_cast<std::size_t>(i)], errors,
                           child_path(path, "[" + std::to_string(i) + "]")) &&
             ok;
    }
    DialogueSegmentView view;
    ok = expect_int_array(record[11], view.children_ids, errors, child_path(path, "[11]")) && ok;
    if (!ok) {
        return std::nullopt;
    }
    view.type = get_or<int>(record[0], 0);
    view.link_id = get_or<int>(record[1], 0);
    view.conditional_enabled = get_or<bool>(record[2], false);
    view.scripted_text = get_or<bool>(record[3], false);
    view.script_enabled = get_or<bool>(record[4], false);
    view.autosave = get_or<bool>(record[5], false);
    view.show_once = get_or<bool>(record[6], false);
    view.is_logged = get_or<bool>(record[7], false);
    view.condition_script = get_or<std::string>(record[8], {});
    view.script = get_or<std::string>(record[9], {});
    view.text_raw = get_or<std::string>(record[10], {});
    return view;
}

bool validate_cutscene_segment(const json& record, std::vector<SchemaError>& errors,
                               std::string_view path)
{
    if (!record.is_array() || record.empty()) {
        add_error(errors, path, "expected non-empty cutscene segment array");
        return false;
    }
    if (!record[0].is_number_integer()) {
        add_error(errors, child_path(path, "[0]"), "expected cutscene segment type integer");
        return false;
    }
    const int type = get_or<int>(record[0], -1);
    switch (type) {
    case 0:
        return expect_array(record, 11, errors, path);
    case 1:
        return expect_array(record, 7, errors, path);
    case 2:
        return expect_array(record, 17, errors, path);
    case 3:
        return expect_array(record, 6, errors, path);
    default:
        add_error(errors, child_path(path, "[0]"),
                  "unknown cutscene segment type " + std::to_string(type));
        return false;
    }
}

} // namespace

std::optional<EntityView> parse_entity_record(EntityType type, const json& record,
                                              std::vector<SchemaError>& errors,
                                              std::string_view path)
{
    EntityView entity;
    entity.type = type;

    auto with_header = [&](std::size_t size) -> std::optional<EntityHeader> {
        if (!expect_array(record, size, errors, path)) {
            return std::nullopt;
        }
        return parse_header(record, errors, path);
    };

    switch (type) {
    case EntityType::Object: {
        auto header = with_header(5);
        bool ok = header.has_value();
        ok = expect_string(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_bool(record[4], errors, child_path(path, "[4]")) && ok;
        if (!ok) {
            return std::nullopt;
        }
        entity.object =
            ObjectView{*header, get_or<std::string>(record[3], {}), get_or<bool>(record[4], false)};
        return entity;
    }
    case EntityType::Script: {
        auto header = with_header(5);
        bool ok = header.has_value();
        ok = expect_bool(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_string(record[4], errors, child_path(path, "[4]")) && ok;
        if (!ok) {
            return std::nullopt;
        }
        entity.script =
            ScriptView{*header, get_or<bool>(record[3], false), get_or<std::string>(record[4], {})};
        return entity;
    }
    case EntityType::Action: {
        auto header = with_header(7);
        bool ok = header.has_value();
        ActionView view;
        ok = expect_string(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_string(record[4], errors, child_path(path, "[4]")) && ok;
        ok = expect_string_array(record[5], view.object_ids, errors, child_path(path, "[5]")) && ok;
        ok = expect_bool(record[6], errors, child_path(path, "[6]")) && ok;
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.verb_id = get_or<std::string>(record[3], {});
        view.script = get_or<std::string>(record[4], {});
        view.position_dependent = get_or<bool>(record[6], false);
        entity.action = std::move(view);
        return entity;
    }
    case EntityType::Verb: {
        auto header = with_header(8);
        bool ok = header.has_value();
        VerbView view;
        ok = expect_string(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_number_integer(record[4], errors, child_path(path, "[4]")) && ok;
        ok = expect_string(record[5], errors, child_path(path, "[5]")) && ok;
        ok = expect_string(record[6], errors, child_path(path, "[6]")) && ok;
        ok = expect_string_array(record[7], view.action_structure, errors,
                                 child_path(path, "[7]")) &&
             ok;
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.name = get_or<std::string>(record[3], {});
        view.object_count = get_or<int>(record[4], 0);
        view.default_script = get_or<std::string>(record[5], {});
        view.conditional_script = get_or<std::string>(record[6], {});
        entity.verb = std::move(view);
        return entity;
    }
    case EntityType::Room: {
        auto header = with_header(11);
        bool ok = header.has_value();
        RoomView view;
        for (int i = 3; i <= 7; ++i) {
            ok = expect_string(record[static_cast<std::size_t>(i)], errors,
                               child_path(path, "[" + std::to_string(i) + "]")) &&
                 ok;
        }
        if (!record[8].is_array()) {
            add_error(errors, child_path(path, "[8]"), "expected room object array");
            ok = false;
        } else {
            for (std::size_t i = 0; i < record[8].size(); ++i) {
                const auto item_path = child_path(path, "[8][" + std::to_string(i) + "]");
                const auto& item = record[8][i];
                bool item_ok = expect_array(item, 2, errors, item_path);
                item_ok = item_ok && expect_string(item[0], errors, child_path(item_path, "[0]"));
                item_ok = item_ok && expect_bool(item[1], errors, child_path(item_path, "[1]"));
                if (item_ok) {
                    view.objects.push_back(RoomObjectView{get_or<std::string>(item[0], {}),
                                                          get_or<bool>(item[1], false)});
                }
                ok = item_ok && ok;
            }
        }
        if (!record[9].is_array()) {
            add_error(errors, child_path(path, "[9]"), "expected paths array");
            ok = false;
        }
        ok = expect_string(record[10], errors, child_path(path, "[10]")) && ok;
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.description_raw = get_or<std::string>(record[3], {});
        view.script_before_enter = get_or<std::string>(record[4], {});
        view.script_after_enter = get_or<std::string>(record[5], {});
        view.script_before_leave = get_or<std::string>(record[6], {});
        view.script_after_leave = get_or<std::string>(record[7], {});
        view.paths = &record[9];
        view.name = get_or<std::string>(record[10], {});
        entity.room = std::move(view);
        return entity;
    }
    case EntityType::Map: {
        auto header = with_header(7);
        bool ok = header.has_value();
        MapView view;
        ok = expect_string(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_string(record[4], errors, child_path(path, "[4]")) && ok;
        if (!record[5].is_array()) {
            add_error(errors, child_path(path, "[5]"), "expected map room array");
            ok = false;
        } else {
            for (std::size_t i = 0; i < record[5].size(); ++i) {
                const auto item_path = child_path(path, "[5][" + std::to_string(i) + "]");
                const auto& item = record[5][i];
                MapRoomView room;
                bool item_ok = expect_array(item, 8, errors, item_path);
                item_ok = item_ok && expect_string(item[0], errors, child_path(item_path, "[0]"));
                for (int field = 1; field <= 4; ++field) {
                    item_ok = expect_number_integer(
                                  item[static_cast<std::size_t>(field)], errors,
                                  child_path(item_path, "[" + std::to_string(field) + "]")) &&
                              item_ok;
                }
                item_ok = expect_string_array(item[5], room.room_ids, errors,
                                              child_path(item_path, "[5]")) &&
                          item_ok;
                item_ok = expect_string(item[6], errors, child_path(item_path, "[6]")) && item_ok;
                item_ok =
                    expect_number_integer(item[7], errors, child_path(item_path, "[7]")) && item_ok;
                if (item_ok) {
                    room.name = get_or<std::string>(item[0], {});
                    room.left = get_or<int>(item[1], 0);
                    room.top = get_or<int>(item[2], 0);
                    room.width = get_or<int>(item[3], 0);
                    room.height = get_or<int>(item[4], 0);
                    room.script = get_or<std::string>(item[6], {});
                    room.style = get_or<int>(item[7], 0);
                    view.rooms.push_back(std::move(room));
                }
                ok = item_ok && ok;
            }
        }
        if (!record[6].is_array()) {
            add_error(errors, child_path(path, "[6]"), "expected map connection array");
            ok = false;
        } else {
            for (std::size_t i = 0; i < record[6].size(); ++i) {
                const auto item_path = child_path(path, "[6][" + std::to_string(i) + "]");
                const auto& item = record[6][i];
                bool item_ok = expect_array(item, 8, errors, item_path);
                for (int field = 0; field <= 5; ++field) {
                    item_ok = expect_number_integer(
                                  item[static_cast<std::size_t>(field)], errors,
                                  child_path(item_path, "[" + std::to_string(field) + "]")) &&
                              item_ok;
                }
                item_ok = expect_string(item[6], errors, child_path(item_path, "[6]")) && item_ok;
                item_ok =
                    expect_number_integer(item[7], errors, child_path(item_path, "[7]")) && item_ok;
                if (item_ok) {
                    view.connections.push_back(MapConnectionView{
                        get_or<int>(item[0], 0), get_or<int>(item[1], 0), get_or<int>(item[2], 0),
                        get_or<int>(item[3], 0), get_or<int>(item[4], 0), get_or<int>(item[5], 0),
                        get_or<std::string>(item[6], {}), get_or<int>(item[7], 0)});
                }
                ok = item_ok && ok;
            }
        }
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.default_room_script = get_or<std::string>(record[3], {});
        view.default_path_script = get_or<std::string>(record[4], {});
        entity.map = std::move(view);
        return entity;
    }
    case EntityType::Dialogue: {
        auto header = with_header(10);
        bool ok = header.has_value();
        DialogueView view;
        ok = expect_string(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_entity_ref_or_inline_script(record[4], view.next_entity, errors,
                                                child_path(path, "[4]")) &&
             ok;
        ok = expect_number_integer(record[5], errors, child_path(path, "[5]")) && ok;
        ok = expect_bool(record[6], errors, child_path(path, "[6]")) && ok;
        ok = expect_bool(record[7], errors, child_path(path, "[7]")) && ok;
        ok = expect_number_integer(record[8], errors, child_path(path, "[8]")) && ok;
        if (!record[9].is_array()) {
            add_error(errors, child_path(path, "[9]"), "expected dialogue segment array");
            ok = false;
        } else {
            for (std::size_t i = 0; i < record[9].size(); ++i) {
                auto segment = parse_dialogue_segment(
                    record[9][i], errors, child_path(path, "[9][" + std::to_string(i) + "]"));
                if (segment.has_value()) {
                    view.segments.push_back(std::move(*segment));
                } else {
                    ok = false;
                }
            }
        }
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.default_name = get_or<std::string>(record[3], {});
        view.root_index = get_or<int>(record[5], 0);
        view.enable_disabled_options = get_or<bool>(record[6], false);
        view.show_disabled_options = get_or<bool>(record[7], false);
        view.log_mode = get_or<int>(record[8], 0);
        entity.dialogue = std::move(view);
        return entity;
    }
    case EntityType::Cutscene: {
        auto header = with_header(8);
        bool ok = header.has_value();
        CutsceneView view;
        ok = expect_bool(record[3], errors, child_path(path, "[3]")) && ok;
        ok = expect_bool(record[4], errors, child_path(path, "[4]")) && ok;
        ok = expect_number(record[5], errors, child_path(path, "[5]")) && ok;
        ok = expect_entity_ref_or_inline_script(record[6], view.next_entity, errors,
                                                child_path(path, "[6]")) &&
             ok;
        if (!record[7].is_array()) {
            add_error(errors, child_path(path, "[7]"), "expected cutscene segment array");
            ok = false;
        } else {
            for (std::size_t i = 0; i < record[7].size(); ++i) {
                const auto segment_path = child_path(path, "[7][" + std::to_string(i) + "]");
                if (validate_cutscene_segment(record[7][i], errors, segment_path)) {
                    view.segments.push_back(
                        CutsceneSegmentView{get_or<int>(record[7][i][0], -1), &record[7][i]});
                } else {
                    ok = false;
                }
            }
        }
        if (!ok) {
            return std::nullopt;
        }
        view.header = *header;
        view.full_screen = get_or<bool>(record[3], false);
        view.can_fast_forward = get_or<bool>(record[4], false);
        view.speed_factor = get_or<double>(record[5], 0.0);
        entity.cutscene = std::move(view);
        return entity;
    }
    case EntityType::CustomScript:
    case EntityType::Invalid:
        add_error(errors, path, "entity type has no legacy project collection");
        return std::nullopt;
    }
    return std::nullopt;
}

const EntityHeader* header_for(const EntityView& entity)
{
    switch (entity.type) {
    case EntityType::Object:
        return entity.object ? &entity.object->header : nullptr;
    case EntityType::Script:
        return entity.script ? &entity.script->header : nullptr;
    case EntityType::Action:
        return entity.action ? &entity.action->header : nullptr;
    case EntityType::Verb:
        return entity.verb ? &entity.verb->header : nullptr;
    case EntityType::Room:
        return entity.room ? &entity.room->header : nullptr;
    case EntityType::Map:
        return entity.map ? &entity.map->header : nullptr;
    case EntityType::Dialogue:
        return entity.dialogue ? &entity.dialogue->header : nullptr;
    case EntityType::Cutscene:
        return entity.cutscene ? &entity.cutscene->header : nullptr;
    case EntityType::CustomScript:
    case EntityType::Invalid:
        return nullptr;
    }
    return nullptr;
}

std::vector<EntityView> parse_project_entities(EntityType type, const json& collection,
                                               std::vector<SchemaError>& errors,
                                               std::string_view path)
{
    std::vector<EntityView> out;
    if (!collection.is_object()) {
        add_error(errors, path, "expected entity collection object");
        return out;
    }

    for (auto it = collection.begin(); it != collection.end(); ++it) {
        const auto record_path = child_path(path, "/" + it.key());
        auto parsed = parse_entity_record(type, *it, errors, record_path);
        if (!parsed.has_value()) {
            continue;
        }
        const auto* header = header_for(*parsed);
        if (header == nullptr) {
            add_error(errors, record_path, "parsed entity has no header");
            continue;
        }
        if (header->id != it.key()) {
            add_error(errors, record_path, "record id does not match collection key");
            continue;
        }
        out.push_back(std::move(*parsed));
    }
    return out;
}

} // namespace noveltea::core::legacy
