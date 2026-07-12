#include "noveltea/core/runtime_project_codec.hpp"
#include "noveltea/core/json_access.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <limits>
#include <string_view>
#include <unordered_set>

namespace noveltea::core {
namespace {

struct Decoder {
    Diagnostics diagnostics;

    void error(std::string code, std::string message, std::string pointer)
    {
        diagnostics.push_back({std::move(code),
                               std::move(message),
                               ErrorSeverity::Error,
                               {},
                               std::move(pointer),
                               {}});
    }

    const nlohmann::json* member(const nlohmann::json& object, std::string_view key,
                                 nlohmann::json::value_t type, const std::string& pointer,
                                 bool required = true)
    {
        if (!object.is_object()) {
            error("runtime_project.type", "Expected an object", pointer);
            return nullptr;
        }
        const auto it = object.find(key);
        if (it == object.end()) {
            if (required)
                error("runtime_project.missing_field",
                      "Missing required field '" + std::string(key) + "'",
                      pointer + "/" + std::string(key));
            return nullptr;
        }
        if (it->type() != type) {
            error("runtime_project.type", "Field '" + std::string(key) + "' has the wrong type",
                  pointer + "/" + std::string(key));
            return nullptr;
        }
        return &*it;
    }

    std::string string(const nlohmann::json& object, std::string_view key,
                       const std::string& pointer, bool required = true)
    {
        const auto* value = member(object, key, nlohmann::json::value_t::string, pointer, required);
        return value ? value->get<std::string>() : std::string{};
    }

    std::optional<std::string> optional_string(const nlohmann::json& object, std::string_view key,
                                               const std::string& pointer)
    {
        const auto it = object.find(key);
        if (it == object.end() || it->is_null())
            return std::nullopt;
        if (!it->is_string()) {
            error("runtime_project.type",
                  "Field '" + std::string(key) + "' must be a string or null",
                  pointer + "/" + std::string(key));
            return std::nullopt;
        }
        return json_access::get_or<std::string>(*it, {});
    }

    std::vector<std::string> strings(const nlohmann::json& object, std::string_view key,
                                     const std::string& pointer)
    {
        std::vector<std::string> result;
        const auto* array = member(object, key, nlohmann::json::value_t::array, pointer, false);
        if (!array)
            return result;
        for (std::size_t i = 0; i < array->size(); ++i) {
            if (!(*array)[i].is_string())
                error("runtime_project.type", "Expected a string",
                      pointer + "/" + std::string(key) + "/" + std::to_string(i));
            else
                result.push_back(json_access::get_or<std::string>((*array)[i], {}));
        }
        return result;
    }
};

template<class T, class Parse>
std::vector<T> records(Decoder& decoder, const nlohmann::json& root, std::string_view key,
                       Parse parse)
{
    std::vector<T> result;
    const std::string base = "/" + std::string(key);
    const auto* array = decoder.member(root, key, nlohmann::json::value_t::array, "");
    if (!array)
        return result;
    std::unordered_set<std::string> ids;
    for (std::size_t i = 0; i < array->size(); ++i) {
        const auto pointer = base + "/" + std::to_string(i);
        if (!(*array)[i].is_object()) {
            decoder.error("runtime_project.type", "Expected an object", pointer);
            continue;
        }
        auto record = parse((*array)[i], pointer);
        if (record.id.empty())
            decoder.error("runtime_project.empty_id", "Record ID cannot be empty", pointer + "/id");
        else if (!ids.insert(record.id).second)
            decoder.error("runtime_project.duplicate_id", "Duplicate ID '" + record.id + "'",
                          pointer + "/id");
        result.push_back(std::move(record));
    }
    return result;
}

template<class T> std::unordered_set<std::string> id_set(const std::vector<T>& records)
{
    std::unordered_set<std::string> result;
    for (const auto& record : records)
        result.insert(record.id);
    return result;
}

void require_ref(Decoder& decoder, const std::unordered_set<std::string>& ids,
                 const std::string& id, std::string kind, std::string pointer)
{
    if (!id.empty() && !ids.contains(id))
        decoder.error("runtime_project.missing_reference",
                      "Unknown " + kind + " reference '" + id + "'", std::move(pointer));
}

} // namespace

RuntimeProjectDecodeResult decode_runtime_project(const nlohmann::json& document)
{
    Decoder d;
    RuntimeProject project;
    if (!document.is_object()) {
        d.error("runtime_project.type", "Runtime project must be an object", "");
        return RuntimeProjectDecodeResult::failure(std::move(d.diagnostics));
    }
    const auto schema = d.string(document, "schema", "");
    if (!schema.empty() && schema != runtime_project_schema)
        d.error("runtime_project.schema", "Unsupported runtime project schema '" + schema + "'",
                "/schema");
    const auto* version =
        d.member(document, "schemaVersion", nlohmann::json::value_t::number_unsigned, "");
    if (!version) {
        const auto it = document.find("schemaVersion");
        if (it != document.end() && it->is_number_integer() && it->get<std::int64_t>() >= 0)
            version = &*it;
    }
    if (version && version->get<std::uint64_t>() != runtime_project_schema_version)
        d.error("runtime_project.schema_version", "Unsupported runtime project schema version",
                "/schemaVersion");

    if (const auto* identity =
            d.member(document, "identity", nlohmann::json::value_t::object, "")) {
        project.identity = {d.string(*identity, "id", "/identity"),
                            d.string(*identity, "name", "/identity"),
                            d.string(*identity, "version", "/identity"),
                            d.string(*identity, "author", "/identity", false),
                            d.string(*identity, "website", "/identity", false)};
    }
    if (const auto* settings =
            d.member(document, "settings", nlohmann::json::value_t::object, "")) {
        if (auto locale = d.string(*settings, "locale", "/settings", false); !locale.empty())
            project.settings.locale = std::move(locale);
        project.settings.default_font = d.string(*settings, "defaultFont", "/settings", false);
        if (const auto* saves = d.member(*settings, "allowSaves", nlohmann::json::value_t::boolean,
                                         "/settings", false))
            project.settings.allow_saves = saves->get<bool>();
    }
    if (const auto* entry = d.member(document, "entrypoint", nlohmann::json::value_t::object, "")) {
        const auto kind = d.string(*entry, "kind", "/entrypoint");
        project.entrypoint.id = d.string(*entry, "id", "/entrypoint");
        if (kind == "room")
            project.entrypoint.kind = EntrypointKind::Room;
        else if (kind == "dialogue")
            project.entrypoint.kind = EntrypointKind::Dialogue;
        else if (kind == "scene")
            project.entrypoint.kind = EntrypointKind::Scene;
        else if (kind == "script")
            project.entrypoint.kind = EntrypointKind::Script;
        else if (!kind.empty())
            d.error("runtime_project.entrypoint_kind", "Unknown entrypoint kind '" + kind + "'",
                    "/entrypoint/kind");
    }
    if (const auto* variables =
            d.member(document, "variables", nlohmann::json::value_t::object, "")) {
        for (const auto& [name, value] : variables->items()) {
            if (value.is_null())
                project.variables.emplace(name, std::monostate{});
            else if (value.is_boolean())
                project.variables.emplace(name, json_access::get_or<bool>(value, false));
            else if (value.is_number_integer())
                project.variables.emplace(name, json_access::get_or<std::int64_t>(value, 0));
            else if (value.is_number_float() &&
                     std::isfinite(json_access::get_or<double>(value, 0.0)))
                project.variables.emplace(name, json_access::get_or<double>(value, 0.0));
            else if (value.is_string())
                project.variables.emplace(name, json_access::get_or<std::string>(value, {}));
            else
                d.error("runtime_project.variable_type", "Runtime variables must be scalar values",
                        "/variables/" + name);
        }
    }

    project.assets = records<AssetRecord>(d, document, "assets", [&](const auto& v, const auto& p) {
        return AssetRecord{d.string(v, "id", p), d.string(v, "path", p),
                           d.string(v, "mediaType", p, false)};
    });
    project.asset_aliases =
        records<AssetAlias>(d, document, "assetAliases", [&](const auto& v, const auto& p) {
            return AssetAlias{d.string(v, "id", p), d.string(v, "assetId", p)};
        });
    project.rooms = records<RoomRecord>(d, document, "rooms", [&](const auto& v, const auto& p) {
        return RoomRecord{d.string(v, "id", p),
                          d.string(v, "name", p),
                          d.string(v, "description", p, false),
                          d.optional_string(v, "mapId", p),
                          d.strings(v, "objectIds", p),
                          d.strings(v, "verbIds", p)};
    });
    project.objects =
        records<ObjectRecord>(d, document, "objects", [&](const auto& v, const auto& p) {
            return ObjectRecord{d.string(v, "id", p), d.string(v, "name", p),
                                d.string(v, "description", p, false), d.strings(v, "verbIds", p)};
        });
    project.verbs = records<VerbRecord>(d, document, "verbs", [&](const auto& v, const auto& p) {
        return VerbRecord{d.string(v, "id", p), d.string(v, "label", p)};
    });
    project.actions =
        records<ActionRecord>(d, document, "actions", [&](const auto& v, const auto& p) {
            return ActionRecord{d.string(v, "id", p), d.string(v, "verbId", p),
                                d.optional_string(v, "objectId", p), d.strings(v, "steps", p)};
        });
    project.dialogues =
        records<DialogueRecord>(d, document, "dialogues", [&](const auto& v, const auto& p) {
            DialogueRecord r{d.string(v, "id", p), {}};
            const auto* nodes = d.member(v, "nodes", nlohmann::json::value_t::array, p);
            if (nodes)
                for (std::size_t i = 0; i < nodes->size(); ++i) {
                    const auto np = p + "/nodes/" + std::to_string(i);
                    if (!(*nodes)[i].is_object()) {
                        d.error("runtime_project.type", "Expected an object", np);
                        continue;
                    }
                    DialogueNode n{
                        d.string((*nodes)[i], "id", np), d.string((*nodes)[i], "text", np), {}};
                    if (const auto* choices = d.member((*nodes)[i], "choices",
                                                       nlohmann::json::value_t::array, np, false))
                        for (std::size_t j = 0; j < choices->size(); ++j) {
                            const auto cp = np + "/choices/" + std::to_string(j);
                            if ((*choices)[j].is_object())
                                n.choices.push_back(
                                    {d.string((*choices)[j], "label", cp),
                                     d.optional_string((*choices)[j], "nextNodeId", cp)});
                            else
                                d.error("runtime_project.type", "Expected an object", cp);
                        }
                    r.nodes.push_back(std::move(n));
                }
            return r;
        });
    project.scenes = records<SceneRecord>(d, document, "scenes", [&](const auto& v, const auto& p) {
        return SceneRecord{d.string(v, "id", p), d.strings(v, "steps", p)};
    });
    project.maps = records<MapRecord>(d, document, "maps", [&](const auto& v, const auto& p) {
        MapRecord r{d.string(v, "id", p), d.optional_string(v, "assetId", p), {}};
        if (const auto* locations =
                d.member(v, "locations", nlohmann::json::value_t::array, p, false))
            for (std::size_t i = 0; i < locations->size(); ++i) {
                const auto lp = p + "/locations/" + std::to_string(i);
                if (!(*locations)[i].is_object()) {
                    d.error("runtime_project.type", "Expected an object", lp);
                    continue;
                }
                MapLocation l{d.string((*locations)[i], "id", lp),
                              d.string((*locations)[i], "roomId", lp)};
                for (auto [key, out] : {std::pair{"x", &l.x}, std::pair{"y", &l.y}}) {
                    const auto it = (*locations)[i].find(key);
                    if (it != (*locations)[i].end() && it->is_number())
                        *out = it->template get<double>();
                    else
                        d.error("runtime_project.type",
                                std::string("Field '") + key + "' has the wrong type",
                                lp + "/" + key);
                }
                r.locations.push_back(std::move(l));
            }
        return r;
    });
    project.scripts =
        records<ScriptRecord>(d, document, "scripts", [&](const auto& v, const auto& p) {
            return ScriptRecord{d.string(v, "id", p), d.string(v, "source", p)};
        });
    project.layouts =
        records<LayoutRecord>(d, document, "layouts", [&](const auto& v, const auto& p) {
            return LayoutRecord{d.string(v, "id", p), d.string(v, "documentAssetId", p)};
        });
    if (const auto* ui = d.member(document, "runtimeUi", nlohmann::json::value_t::object, ""))
        project.runtime_ui = {d.optional_string(*ui, "defaultLayoutId", "/runtimeUi"),
                              d.optional_string(*ui, "themeAssetId", "/runtimeUi")};

    const auto assets = id_set(project.assets), rooms = id_set(project.rooms),
               objects = id_set(project.objects), verbs = id_set(project.verbs),
               maps = id_set(project.maps), dialogues = id_set(project.dialogues),
               scenes = id_set(project.scenes), scripts = id_set(project.scripts),
               layouts = id_set(project.layouts);
    const auto& entry_ids = project.entrypoint.kind == EntrypointKind::Room       ? rooms
                            : project.entrypoint.kind == EntrypointKind::Dialogue ? dialogues
                            : project.entrypoint.kind == EntrypointKind::Scene    ? scenes
                                                                                  : scripts;
    require_ref(d, entry_ids, project.entrypoint.id, "entrypoint", "/entrypoint/id");
    for (std::size_t i = 0; i < project.asset_aliases.size(); ++i)
        require_ref(d, assets, project.asset_aliases[i].asset_id, "asset",
                    "/assetAliases/" + std::to_string(i) + "/assetId");
    for (std::size_t i = 0; i < project.rooms.size(); ++i) {
        if (project.rooms[i].map_id)
            require_ref(d, maps, *project.rooms[i].map_id, "map",
                        "/rooms/" + std::to_string(i) + "/mapId");
        for (const auto& id : project.rooms[i].object_ids)
            require_ref(d, objects, id, "object", "/rooms/" + std::to_string(i) + "/objectIds");
        for (const auto& id : project.rooms[i].verb_ids)
            require_ref(d, verbs, id, "verb", "/rooms/" + std::to_string(i) + "/verbIds");
    }
    for (std::size_t i = 0; i < project.actions.size(); ++i) {
        require_ref(d, verbs, project.actions[i].verb_id, "verb",
                    "/actions/" + std::to_string(i) + "/verbId");
        if (project.actions[i].object_id)
            require_ref(d, objects, *project.actions[i].object_id, "object",
                        "/actions/" + std::to_string(i) + "/objectId");
    }
    for (std::size_t i = 0; i < project.maps.size(); ++i) {
        if (project.maps[i].asset_id)
            require_ref(d, assets, *project.maps[i].asset_id, "asset",
                        "/maps/" + std::to_string(i) + "/assetId");
        for (const auto& l : project.maps[i].locations)
            require_ref(d, rooms, l.room_id, "room", "/maps/" + std::to_string(i) + "/locations");
    }
    for (std::size_t i = 0; i < project.layouts.size(); ++i)
        require_ref(d, assets, project.layouts[i].document_asset_id, "asset",
                    "/layouts/" + std::to_string(i) + "/documentAssetId");
    if (project.runtime_ui.default_layout_id)
        require_ref(d, layouts, *project.runtime_ui.default_layout_id, "layout",
                    "/runtimeUi/defaultLayoutId");
    if (project.runtime_ui.theme_asset_id)
        require_ref(d, assets, *project.runtime_ui.theme_asset_id, "asset",
                    "/runtimeUi/themeAssetId");

    if (!d.diagnostics.empty())
        return RuntimeProjectDecodeResult::failure(std::move(d.diagnostics));
    return RuntimeProjectDecodeResult::success(std::move(project));
}

} // namespace noveltea::core
