#include "room_session.hpp"

#include "source_authority.hpp"
#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

constexpr std::array<std::string_view, 16> collections = {
    "assets",     "animations", "variables",     "materials", "layouts",      "archetypes",
    "characters", "rooms",      "interactables", "verbs",     "interactions", "dialogues",
    "scenes",     "maps",       "scripts",       "tests"};

bool collection_known(std::string_view family)
{
    return std::find(collections.begin(), collections.end(), family) != collections.end();
}

std::string escape_pointer(std::string_view segment)
{
    std::string out;
    for (char c : segment) {
        if (c == '~')
            out += "~0";
        else if (c == '/')
            out += "~1";
        else
            out += c;
    }
    return out;
}

std::string member_string(const Json& value, std::string_view key)
{
    const auto name = std::string(key);
    return value.is_object() && value.contains(name) && value.at(name).is_string()
               ? value.at(name).as<std::string>()
               : std::string{};
}

Json record_key(std::string_view family, std::string_view id)
{
    Json key = Json::object();
    key["kind"] = "record";
    key["collection"] = std::string(family);
    key["id"] = std::string(id);
    return key;
}

Json nested_key(std::string_view family, std::string_view owner, std::string_view kind,
                std::string_view id)
{
    Json key = Json::object();
    key["kind"] = "nested";
    key["ownerCollection"] = std::string(family);
    key["ownerId"] = std::string(owner);
    key["family"] = std::string(kind);
    key["id"] = std::string(id);
    return key;
}

Json trait_key(std::string_view id)
{
    Json key = Json::object();
    key["kind"] = "trait-definition";
    key["id"] = std::string(id);
    return key;
}

Json project_key(std::string_view path)
{
    Json key = Json::object();
    key["kind"] = "project-field";
    key["path"] = std::string(path);
    return key;
}

template<typename Key> void sort_json_array(Json& values, Key key)
{
    std::vector<Json> sorted;
    sorted.reserve(values.size());
    for (const auto& value : values.array_range())
        sorted.push_back(value);
    std::stable_sort(sorted.begin(), sorted.end(),
                     [&](const Json& a, const Json& b) { return key(a) < key(b); });
    values = Json::array();
    for (auto& value : sorted)
        values.push_back(std::move(value));
}

Json localization_key(std::string_view locale, std::string_view id)
{
    Json key = Json::object();
    key["kind"] = "localization-message";
    key["locale"] = std::string(locale);
    key["messageId"] = std::string(id);
    return key;
}

std::string reference_role(std::string_view path, std::string_view target_collection)
{
    const auto has = [&](std::string_view segment) { return path.find(segment) != path.npos; };
    if (path.ends_with("/data/base/material/$ref"))
        return "material-base";
    if (has("/data/background/asset/$ref"))
        return "room-background";
    if (has("/data/background/material/$ref"))
        return "room-background-material";
    if (has("/data/cast/") && path.ends_with("/character/$ref"))
        return "room-cast-character";
    if (has("/data/overlays/") && path.ends_with("/layout/$ref"))
        return "room-overlay-layout";
    if (has("/data/placements/") && path.ends_with("/layout/$ref"))
        return "room-placement-layout";
    if (has("/data/props/") && path.ends_with("/asset/$ref"))
        return "room-prop-asset";
    if (has("/data/props/") && path.ends_with("/material/$ref"))
        return "room-prop-material";
    if (has("/data/environments/") && path.ends_with("/asset/$ref"))
        return "room-environment-asset";
    if (has("/data/environments/") && path.ends_with("/material/$ref"))
        return "room-environment-material";
    if (has("/data/compose/") && path.ends_with("/script/$ref"))
        return "room-compose-script";
    if (has("/data/scriptHooks/") && path.ends_with("/module/$ref"))
        return "room-script-hook";
    if (has("/data/exits/") && path.ends_with("/target/$ref"))
        return "room-exit-target";
    if (has("/data/profiles/") && path.ends_with("/visual/image/$ref"))
        return "character-pose-visual";
    if (has("/data/profiles/") && path.ends_with("/visual/animation/$ref"))
        return "character-pose-visual";
    if (has("/data/expressions/") && has("/visual/") && path.ends_with("/$ref"))
        return "character-expression-visual";
    if (has("/data/presentation/visual/") && path.ends_with("/$ref"))
        return "interactable-visual";
    if (has("/data/presentation/material/$ref"))
        return "interactable-material";
    if (has("/data/textures/") && path.ends_with("/source/$ref"))
        return "material-texture";
    if (has("/layouts/") && has("/data/rml/sourceAsset/$ref"))
        return "layout-rml-source";
    if (has("/layouts/") && has("/data/rcss/sourceAsset/$ref"))
        return "layout-rcss-source";
    if (has("/layouts/") && has("/data/dependencies/images/"))
        return "layout-image";
    if (has("/layouts/") && has("/data/dependencies/fonts/"))
        return "layout-font";
    if (has("/layouts/") && has("/data/dependencies/templates/"))
        return "layout-template";
    if (has("/layouts/") && has("/data/dependencies/stylesheets/"))
        return "layout-stylesheet";
    if (has("/layouts/") && has("/data/dependencies/materials/"))
        return "layout-material";
    if (has("/settings/ui/systemLayouts/") || has("/settings/inventory/defaultLayout/"))
        return "system-layout";
    if (has("/settings/text/defaultFont/"))
        return "default-font";
    if (has("/settings/text/fontStack/") || has("/localization/locales/") && has("/fontStack/"))
        return "font-stack";
    if (target_collection == "variables")
        return "variable-ref";
    return "explicit-ref";
}

std::vector<std::string> impact_paths(std::string_view role, std::string_view target)
{
    static const std::set<std::string_view> assets = {"room-background",
                                                      "room-prop-asset",
                                                      "room-environment-asset",
                                                      "character-pose-visual",
                                                      "character-expression-visual",
                                                      "interactable-visual",
                                                      "material-texture",
                                                      "layout-rml-source",
                                                      "layout-rcss-source",
                                                      "layout-image",
                                                      "layout-font",
                                                      "layout-stylesheet",
                                                      "layout-template",
                                                      "default-font",
                                                      "font-stack"};
    if (assets.contains(role)) {
        std::vector<std::string> fields;
        for (const char* part : {"/data/source/path", "/data/contentHash", "/data/kind",
                                 "/data/extension", "/data/sampling"})
            fields.push_back(std::string(target) + part);
        return fields;
    }
    if (role == "condition-variable" || role == "variable-ref")
        return {std::string(target) + "/data/type", std::string(target) + "/data/defaultValue",
                std::string(target) + "/data/enumValues"};
    if (role == "room-cast-character")
        return {std::string(target) + "/data/defaults", std::string(target) + "/data/poses",
                std::string(target) + "/data/expressions", std::string(target) + "/data/idles"};
    if (role == "room-compose-script" || role == "room-script-hook")
        return {std::string(target) + "/data/source"};
    if (role == "system-layout" || role == "room-overlay-layout" || role == "room-placement-layout")
        return {std::string(target) + "/data/rml", std::string(target) + "/data/rcss",
                std::string(target) + "/data/lua", std::string(target) + "/data/dependencies",
                std::string(target) + "/data/target"};
    if (role.ends_with("-material") || role == "material-base" || role == "layout-material")
        return {std::string(target) + "/data"};
    return {std::string(target)};
}

struct Builder {
    Json nodes = Json::array();
    Json edges = Json::array();
    Json diagnostics = Json::array();
    std::set<std::string> node_keys;
    std::set<std::string> edge_ids;
    std::map<std::string, std::vector<Json>> identities;

    void node(const Json& key, std::string_view path, std::string_view label)
    {
        const auto identity = key.to_string();
        if (!node_keys.insert(identity).second)
            return;
        Json item = Json::object();
        item["key"] = key;
        item["keyText"] = identity;
        item["owningPath"] = std::string(path);
        item["label"] = std::string(label);
        nodes.push_back(std::move(item));
        if (key.at("kind") == "record")
            identities[member_string(key, "id")].push_back(key);
    }

    void diagnostic(std::string_view path, std::string_view code, std::string_view message,
                    std::string_view severity = "warning")
    {
        Json item = Json::object();
        item["severity"] = std::string(severity);
        item["code"] = std::string(code);
        item["path"] = std::string(path);
        item["message"] = std::string(message);
        diagnostics.push_back(std::move(item));
    }

    void edge(const Json& source, const Json& target, const std::string& path,
              const std::string& target_path, std::string_view role = "explicit-ref",
              std::string_view repair_kind = "blocked")
    {
        const auto selected_role = role == "explicit-ref"
                                       ? reference_role(path, member_string(target, "collection"))
                                       : std::string(role);
        const auto identity =
            source.to_string() + "|" + path + "|" + target.to_string() + "|" + selected_role;
        if (!edge_ids.insert(identity).second)
            return;
        Json item = Json::object();
        item["id"] = identity;
        item["source"] = source;
        item["target"] = target;
        item["sourcePath"] = path;
        item["targetPath"] = target_path;
        item["role"] = selected_role;
        item["facets"] = Json::array({"reference-integrity", "tooling-reference"});
        if (selected_role == "localization-text") {
            item["facets"] = Json::array({"tooling-reference", "preview-ui", "validation"});
        }
        if (selected_role == "room-background" || selected_role == "room-prop-asset" ||
            selected_role == "room-environment-asset" || selected_role == "material-texture" ||
            selected_role == "character-pose-visual" ||
            selected_role == "character-expression-visual" ||
            selected_role == "interactable-visual" || selected_role == "room-background-material" ||
            selected_role == "room-prop-material" || selected_role == "room-environment-material" ||
            selected_role == "material-base" || selected_role == "room-cast-character")
            item["facets"].push_back("preview-visual");
        if (selected_role == "system-layout" || selected_role == "room-overlay-layout" ||
            selected_role == "room-placement-layout" || selected_role.starts_with("layout-") ||
            selected_role == "default-font" || selected_role == "font-stack" ||
            selected_role == "source-recognized-reference")
            item["facets"].push_back("preview-ui");
        if (selected_role == "room-background" || selected_role.starts_with("layout-") ||
            selected_role == "material-texture" || selected_role == "default-font" ||
            selected_role == "font-stack" || selected_role == "source-recognized-reference")
            item["facets"].push_back("resource");
        item["targetImpactPaths"] = Json::array();
        for (const auto& field : impact_paths(selected_role, target_path))
            item["targetImpactPaths"].push_back(field);
        item["repair"] = Json::object();
        // Only schema-proven nullable reference fields can be cleared. The
        // reference edge points at /$ref when the admitted value is a typed
        // reference object; the repair must replace its containing nullable
        // field rather than corrupting the inner reference identity.
        const bool nullable_reference =
            selected_role == "room-background" || selected_role == "room-background-material" ||
            selected_role == "room-prop-asset" || selected_role == "room-prop-material" ||
            selected_role == "room-environment-asset" ||
            selected_role == "room-compose-script" || selected_role == "system-layout";
        const auto repair_action = nullable_reference ? "set-null" : repair_kind;
        item["repair"]["kind"] = std::string(repair_action);
        if (repair_action == "blocked")
            item["repair"]["reason"] = "No proven native automatic repair for this reference.";
        else if (repair_action == "set-null" && path.ends_with("/$ref"))
            item["repair"]["path"] = path.substr(0, path.size() - 5);
        else
            item["repair"]["path"] = path;
        edges.push_back(std::move(item));
    }
};

void walk(const Json& value, const std::string& path, const Json& owner, Builder& graph)
{
    if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i)
            walk(value[i], path + "/" + std::to_string(i), owner, graph);
        return;
    }
    if (value.is_string()) {
        // Current authored YAML retains several schema-typed references as
        // scalar IDs. Never infer an edge from the literal value alone: both
        // its owning collection and its recognized field path are required.
        const auto family = member_string(owner, "collection").empty()
                                ? member_string(owner, "ownerCollection")
                                : member_string(owner, "collection");
        const auto id = value.as<std::string>();
        if (id.empty())
            return;
        const auto has = [&](std::string_view part) { return path.find(part) != path.npos; };
        std::string target_family, role;
        if (family == "rooms" && path.ends_with("/data/background/asset")) {
            target_family = "assets";
            role = "room-background";
        } else if (family == "rooms" && path.ends_with("/data/background/material")) {
            target_family = "materials";
            role = "room-background-material";
        } else if (family == "rooms" && has("/data/props/") && path.ends_with("/asset")) {
            target_family = "assets";
            role = "room-prop-asset";
        } else if (family == "rooms" && has("/data/props/") && path.ends_with("/material")) {
            target_family = "materials";
            role = "room-prop-material";
        } else if (family == "rooms" && has("/data/environments/") && path.ends_with("/asset")) {
            target_family = "assets";
            role = "room-environment-asset";
        } else if (family == "rooms" && has("/data/environments/") && path.ends_with("/material")) {
            target_family = "materials";
            role = "room-environment-material";
        } else if (family == "maps" && has("/data/locations/") && path.ends_with("/room")) {
            target_family = "rooms";
        } else if ((family == "dialogues" || family == "scenes") && has("/data/") &&
                   path.ends_with("/asset")) {
            target_family = "assets";
        } else if ((family == "dialogues" || family == "scenes" || family == "interactions") &&
                   has("/data/") && path.ends_with("/character")) {
            target_family = "characters";
        } else if (family == "interactions" && has("/data/") && path.ends_with("/layout")) {
            target_family = "layouts";
        } else if (family == "interactions" && has("/data/") && path.ends_with("/room")) {
            target_family = "rooms";
        }
        if (!target_family.empty())
            graph.edge(owner, record_key(target_family, id), path,
                       "/" + target_family + "/" + escape_pointer(id),
                       role.empty() ? "explicit-ref" : role);
        return;
    }
    if (!value.is_object())
        return;
    if (value.contains("$ref") && value.at("$ref").is_object()) {
        const auto& ref = value.at("$ref");
        const auto family = member_string(ref, "collection");
        const auto id = member_string(ref, "id");
        if (collection_known(family) && !id.empty()) {
            const auto target = record_key(family, id);
            const auto target_path = "/" + family + "/" + escape_pointer(id);
            graph.edge(owner, target, path + "/$ref", target_path);
        }
    }
    if (value.contains("$var") && value.at("$var").is_string()) {
        const auto id = value.at("$var").as<std::string>();
        if (!id.empty())
            graph.edge(owner, record_key("variables", id), path + "/$var",
                       "/variables/" + escape_pointer(id), "variable-ref");
    }
    if (value.contains("room") && value.contains("placement") && value.at("room").is_string() &&
        value.at("placement").is_string()) {
        const auto room = value.at("room").as<std::string>();
        const auto placement = value.at("placement").as<std::string>();
        graph.edge(owner, nested_key("rooms", room, "room-placement", placement), path,
                   "/rooms/" + escape_pointer(room) + "/data/placements");
    }
    if (value.contains("room") && value.contains("exit") && value.at("room").is_string() &&
        value.at("exit").is_string()) {
        const auto room = value.at("room").as<std::string>();
        const auto exit = value.at("exit").as<std::string>();
        graph.edge(owner, nested_key("rooms", room, "room-exit", exit), path,
                   "/rooms/" + escape_pointer(room) + "/data/exits");
    }
    // Flow discriminants are authoritative only in explicitly typed target
    // positions. An arbitrary {kind,id} object is not a reference.
    if ((path.ends_with("/target") || path.ends_with("/next") || path.ends_with("/entrypoint") ||
         path.ends_with("/continuation") || path.ends_with("/completion")) &&
        value.contains("kind")) {
        const auto kind = member_string(value, "kind");
        const auto id = member_string(value, "id");
        const auto family = kind == "room"       ? "rooms"
                            : kind == "scene"    ? "scenes"
                            : kind == "dialogue" ? "dialogues"
                                                 : "";
        if (*family && !id.empty())
            graph.edge(owner, record_key(family, id), path,
                       "/" + std::string(family) + "/" + escape_pointer(id), "flow-target");
    }
    for (const auto& member : value.object_range()) {
        // A nested element is represented by its own semantic owner. Do not
        // also attach its same outgoing references to the enclosing Room:
        // that would double Find Usages and deletion counts.
        const auto collection = member_string(owner, "collection");
        const bool direct_nested =
            owner.at("kind") == "record" &&
            (collection == "rooms" || collection == "interactables") &&
            path == "/" + collection + "/" + escape_pointer(member_string(owner, "id")) + "/data" &&
            (member.key() == "placements" || member.key() == "exits" ||
             member.key() == "hotspots" || member.key() == "features");
        if (direct_nested) {
            const auto& entries = member.value();
            const auto all_have_identity = [&]() {
                if (entries.is_array()) {
                    for (const auto& item : entries.array_range())
                        if (member_string(item, "id").empty())
                            return false;
                    return true;
                }
                if (entries.is_object()) {
                    for (const auto& item : entries.object_range())
                        if (member_string(item.value(), "id").empty())
                            return false;
                    return true;
                }
                return false;
            }();
            if (all_have_identity)
                continue;
        }
        walk(member.value(), path + "/" + escape_pointer(member.key()), owner, graph);
    }
}

void collect_nested(const Json& record, std::string_view family, std::string_view id,
                    Builder& graph)
{
    if (!record.is_object() || !record.contains("data") || !record.at("data").is_object())
        return;
    const auto& data = record.at("data");
    const auto base = "/" + std::string(family) + "/" + escape_pointer(id) + "/data";
    const std::array<std::pair<std::string_view, std::string_view>, 4> groups = {
        {{"placements", "room-placement"},
         {"exits", "room-exit"},
         {"features", family == "rooms" ? "room-feature" : "interactable-feature"},
         {"hotspots", family == "rooms" ? "room-hotspot" : "interactable-hotspot"}}};
    for (const auto& [property, kind] : groups) {
        if (!data.contains(std::string(property)))
            continue;
        const auto& values = data.at(std::string(property));
        const auto add = [&](const Json& value, const std::string& path) {
            const auto nested_id = member_string(value, "id");
            if (nested_id.empty())
                return;
            const auto key = nested_key(family, id, kind, nested_id);
            graph.node(key, path,
                       member_string(value, "label").empty() ? nested_id
                                                             : member_string(value, "label"));
            walk(value, path, key, graph);
        };
        if (values.is_array()) {
            for (std::size_t i = 0; i < values.size(); ++i)
                add(values[i], base + "/" + std::string(property) + "/" + std::to_string(i));
        } else if (values.is_object()) {
            for (const auto& entry : values.object_range())
                add(entry.value(),
                    base + "/" + std::string(property) + "/" + escape_pointer(entry.key()));
        }
    }
}

std::string read_contained_source(const std::filesystem::path& root, const std::string& relative)
{
    const auto candidate = root / relative;
    const auto inside = std::filesystem::weakly_canonical(candidate).lexically_relative(
        std::filesystem::weakly_canonical(root));
    if (inside.empty() || *inside.begin() == ".." || std::filesystem::is_symlink(candidate) ||
        !std::filesystem::is_regular_file(candidate))
        throw std::runtime_error("Untrusted native graph text source: " + relative);
    const auto size = std::filesystem::file_size(candidate);
    const auto timestamp = std::filesystem::last_write_time(candidate);
    std::ifstream input(candidate, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read native graph source: " + relative);
    std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    if (input.bad() || bytes.size() != size || std::filesystem::file_size(candidate) != size ||
        std::filesystem::last_write_time(candidate) != timestamp)
        throw std::runtime_error("Native graph text source changed during read: " + relative);
    return bytes;
}
} // namespace

std::string ProjectSession::semantic_graph(std::uint64_t expected_revision)
{
    if (expected_revision != working_revision_)
        throw std::runtime_error("Stale native semantic graph working revision.");
    // The observer is authoritative for external mutations, independently of
    // whether the editor has yet received a worker watch notification.
    const auto first = observe_sources();
    if (first.full_rescan || (!first.authoritative && !first.scoped_authority) ||
        !first.delta_revisions.empty())
        throw std::runtime_error("Native semantic graph source generation changed.");
    validate_project();
    if (expected_revision != working_revision_)
        throw std::runtime_error("Native semantic graph working revision advanced.");
    auto verified = source_authority_->verified_revisions();
    if (!verified || source_authority_->uncertain())
        throw std::runtime_error("Native semantic graph has no complete source proof.");

    Json response = Json::object();
    response["workingRevision"] = working_revision_;
    response["sourceRevisions"] = Json::object();
    response["textSourceRevisions"] = Json::object();
    for (const auto& [path, revision] : *verified)
        response["sourceRevisions"][path] = revision;
    Builder graph;
    Json incomplete = Json::array();
    for (const auto& path : source_authority_->invalid_source_paths()) {
        incomplete.push_back(path);
        graph.diagnostic("/" + path, "native.graph.invalid_source_owner",
                         "Native source observer could not admit this owner.", "error");
    }
    std::map<std::string, Json> records;
    const auto disk_records = reconciliation_disk_record_snapshots();
    std::map<std::string, std::string> message_ids;
    std::set<std::string> locales;
    std::string source_locale;
    const auto localization_source = [&](const std::string& path,
                                         bool required = true) -> std::optional<Json> {
        const auto proof = verified->find(path);
        if (proof == verified->end() || proof->second == "absent") {
            if (required)
                incomplete.push_back(path);
            return std::nullopt;
        }
        const auto bytes = read_contained_source(root_, path);
        if (exact_source_revision(bytes) != proof->second)
            throw std::runtime_error("Native graph localization revision changed: " + path);
        const auto opened = open_yaml_source(bytes);
        if (!opened.accepted) {
            incomplete.push_back(path);
            graph.diagnostic("/" + path, "native.graph.invalid_localization_source",
                             "Cannot parse this localized Project source.", "error");
            return std::nullopt;
        }
        return Json::parse(opened.source_json);
    };
    if (const auto config = localization_source("i18n/project.yaml")) {
        const auto& data = *config;
        source_locale = member_string(data, "sourceLocale");
        if (data.contains("locales") && data.at("locales").is_object())
            for (const auto& locale : data.at("locales").object_range())
                locales.insert(locale.key());
    }
    std::map<std::string, std::set<std::string>> actual_translations;
    for (const auto& locale : locales) {
        if (locale == source_locale)
            continue;
        if (const auto data = localization_source("i18n/locales/" + locale + ".yaml", false))
            if (data->is_object())
                for (const auto& entry : data->object_range())
                    actual_translations[locale].insert(entry.key());
    }
    if (const auto message_file = localization_source("i18n/messages.yaml")) {
        const auto& data = *message_file;
        if (data.contains("messages") && data.at("messages").is_object()) {
            for (const auto& message : data.at("messages").object_range()) {
                const auto id = message.key();
                const auto key = member_string(message.value(), "key");
                if (key.empty())
                    continue;
                message_ids[key] = id;
                for (const auto& locale : locales)
                    if (locale == source_locale || actual_translations[locale].contains(id))
                        graph.node(localization_key(locale, id),
                                   locale == source_locale
                                       ? "/localization/messages/" + escape_pointer(id) + "/source"
                                       : "/localization/translations/" + escape_pointer(locale) +
                                             "/" + escape_pointer(id),
                                   key);
            }
        }
    }
    for (const auto& [owner, state] : disk_records) {
        const auto slash = owner.find('/');
        if (slash == std::string::npos || !collection_known(owner.substr(0, slash)))
            continue;
        if (!state.valid || state.normalized_json.empty()) {
            incomplete.push_back(owner);
            // Normalization can reject one owner's semantics while preserving
            // structurally readable source references from that same owner.
        }
        try {
            const auto json =
                Json::parse(state.valid && !state.normalized_json.empty() ? state.normalized_json
                                                                          : state.source_json);
            if (json.is_object())
                records[owner] = json;
        } catch (...) {
            graph.diagnostic("/" + owner, "native.graph.invalid_owner",
                             "Native record cannot be structurally read.", "error");
        }
    }
    for (const auto& [owner, state] : record_snapshots()) {
        if (deleted_records_.contains(owner))
            continue;
        const auto slash = owner.find('/');
        if (slash == std::string::npos || !collection_known(owner.substr(0, slash)))
            continue;
        if (!state.valid || state.normalized_json.empty())
            incomplete.push_back(owner);
        try {
            const auto json =
                Json::parse(state.valid && !state.normalized_json.empty() ? state.normalized_json
                                                                          : state.source_json);
            if (json.is_object())
                records[owner] = json;
        } catch (...) {
            graph.diagnostic("/" + owner, "native.graph.invalid_owner",
                             "Dirty native record cannot be structurally read.", "error");
            records.erase(owner);
        }
    }
    for (const auto& [owner, record] : records) {
        const auto separator = owner.find('/');
        const auto family = owner.substr(0, separator);
        const auto id = owner.substr(separator + 1);
        const auto key = record_key(family, id);
        graph.node(key, "/" + owner, member_string(record, "label"));
    }
    // Schema-admitted Trait definitions and fixed Project fields are distinct
    // graph identities; they are not synthesized from lexical source matches.
    if (const auto traits = records_.find("traits"); traits != records_.end()) {
        const auto& state = traits->second->snapshot();
        if (!state.valid)
            incomplete.push_back("traits");
        if (!state.normalized_json.empty()) {
            const auto value = Json::parse(state.normalized_json);
            if (value.is_object())
                for (const auto& trait : value.object_range()) {
                    graph.node(trait_key(trait.key()), "/traits/" + escape_pointer(trait.key()),
                               trait.key());
                    if (trait.value().is_object() && trait.value().contains("properties") &&
                        trait.value().at("properties").is_array()) {
                        const auto& definitions = trait.value().at("properties");
                        for (std::size_t i = 0; i < definitions.size(); ++i) {
                            const auto property = member_string(definitions[i], "id");
                            if (property.empty())
                                continue;
                            const auto pointer = "/traits/" + escape_pointer(trait.key()) +
                                                 "/properties/" + std::to_string(i);
                            graph.node(project_key(pointer), pointer, property);
                            graph.edge(trait_key(trait.key()), project_key(pointer), pointer,
                                       pointer, "trait-property");
                        }
                    }
                }
        }
    } else if (const auto disk = disk_records.find("traits");
               disk != disk_records.end() && !disk->second.normalized_json.empty()) {
        // Disk contributor existence and shape are covered by native validation.
        const auto value = Json::parse(disk->second.normalized_json);
        if (value.is_object())
            for (const auto& trait : value.object_range())
                graph.node(trait_key(trait.key()), "/traits/" + escape_pointer(trait.key()),
                           trait.key());
    }
    for (const auto& [owner, record] : records) {
        const auto separator = owner.find('/');
        const auto family = owner.substr(0, separator);
        const auto id = owner.substr(separator + 1);
        const auto key = record_key(family, id);
        const auto path = "/" + family + "/" + escape_pointer(id);
        walk(record, path, key, graph);
        if (family == "rooms" || family == "interactables")
            collect_nested(record, family, id, graph);
        if (record.contains("traits") && record.at("traits").is_array()) {
            std::size_t index = 0;
            for (const auto& value : record.at("traits").array_range()) {
                if (value.is_string()) {
                    const auto trait = value.as<std::string>();
                    graph.edge(key, trait_key(trait), path + "/traits/" + std::to_string(index),
                               "/traits/" + escape_pointer(trait), "trait-attachment");
                }
                ++index;
            }
        }
    }
    const auto manifest = snapshot();
    if (!manifest.valid)
        incomplete.push_back("project");
    if (!manifest.source_json.empty()) {
        try {
            const auto manifest_json = Json::parse(
                manifest.valid && !manifest.normalized_json.empty() ? manifest.normalized_json
                                                                    : manifest.source_json);
            for (const auto* field : {"settings", "project", "localization"}) {
                if (manifest_json.contains(field)) {
                    graph.node(project_key("/" + std::string(field)), "/" + std::string(field),
                               field);
                    walk(manifest_json.at(field), "/" + std::string(field),
                         project_key("/" + std::string(field)), graph);
                }
            }
            // Every fixed Project setting has a stable path independent of
            // whether the authored YAML explicitly includes its default.
            for (const char* field :
                 {"/settings/display", "/settings/accessibility", "/settings/text/defaultFont",
                  "/settings/text/fontStack", "/settings/ui/systemLayouts/game-hud",
                  "/settings/ui/systemLayouts/pause-menu", "/settings/inventory/defaultLayout",
                  "/settings/interaction/defaultVerbMenuLayout", "/localization/defaultLocale",
                  "/localization/sourceLocale"}) {
                graph.node(project_key(field), field, field);
            }
            if (manifest_json.contains("entrypoint")) {
                const auto& entry = manifest_json.at("entrypoint");
                const auto family = member_string(entry, "kind");
                const auto id = member_string(entry, "id");
                graph.node(project_key("/entrypoint"), "/entrypoint", "Entry point");
                const auto collection = family == "room"       ? "rooms"
                                        : family == "scene"    ? "scenes"
                                        : family == "dialogue" ? "dialogues"
                                                               : "";
                if (*collection && !id.empty())
                    graph.edge(
                        project_key("/entrypoint"), record_key(collection, id), "/entrypoint",
                        "/" + std::string(collection) + "/" + escape_pointer(id), "entrypoint");
            }
            if (manifest_json.contains("bootstrapModule")) {
                graph.node(project_key("/bootstrapModule"), "/bootstrapModule", "Bootstrap module");
                walk(manifest_json.at("bootstrapModule"), "/bootstrapModule",
                     project_key("/bootstrapModule"), graph);
            }
            for (const auto& [owner, record] : records) {
                if (!owner.starts_with("rooms/"))
                    continue;
                const auto key = record_key("rooms", owner.substr(sizeof("rooms/") - 1));
                for (const char* field :
                     {"/settings/display", "/settings/accessibility", "/settings/text/defaultFont",
                      "/settings/text/fontStack", "/settings/ui/systemLayouts/game-hud"})
                    graph.edge(key, project_key(field), "/" + owner, field, "explicit-ref");
            }
        } catch (...) {
            incomplete.push_back("project");
        }
    }
    Json occurrences = Json::array();
    std::map<std::string, std::string> supplemental_sources;
    std::map<std::string, std::string> named_cursors;
    if (!manifest.normalized_json.empty()) {
        const auto effective = Json::parse(manifest.normalized_json);
        if (effective.contains("settings") && effective.at("settings").is_object()) {
            const auto& settings = effective.at("settings");
            if (settings.contains("cursors") && settings.at("cursors").is_object() &&
                settings.at("cursors").contains("named") &&
                settings.at("cursors").at("named").is_array()) {
                const auto& named = settings.at("cursors").at("named");
                for (std::size_t i = 0; i < named.size(); ++i) {
                    const auto id = member_string(named[i], "id");
                    if (id.empty())
                        continue;
                    const auto pointer = "/settings/cursors/named/" + std::to_string(i) + "/id";
                    graph.node(project_key(pointer), pointer, id);
                    named_cursors[id] = pointer;
                }
            }
        }
    }
    std::map<std::string, std::vector<Json>> source_targets;
    for (const auto& [owner, record] : records) {
        const auto slash = owner.find('/');
        const auto family = owner.substr(0, slash);
        const auto id = owner.substr(slash + 1);
        if ((family == "assets" || family == "scripts") && record.contains("data") &&
            record.at("data").is_object()) {
            const auto& data = record.at("data");
            if (data.contains("source") && data.at("source").is_object()) {
                const auto path = member_string(data.at("source"), "path");
                if (!path.empty())
                    source_targets[path].push_back(record_key(family, id));
            }
        }
        if (family == "layouts") {
            for (const char* ext : {"lua", "rml", "rcss"})
                source_targets["records/layouts/" + id + "/layout." + ext].push_back(
                    record_key(family, id));
        }
    }
    for (const auto& [path, analysis] : source_analyses()) {
        const auto inlined = inline_text_sources_.find(path);
        const auto overlay = text_source_overlays_.find(path);
        const auto observed = verified->find(path);
        if (inlined == inline_text_sources_.end() && overlay == text_source_overlays_.end()) {
            if (observed != verified->end()) {
                // Asset-backed text uses the observer's physical identity
                // (mtime/size proof), not the SHA256 content identity used by
                // the source analyzer. Verify both, independently.
                if (!observed->second.starts_with("physical:") &&
                    observed->second != analysis.source_revision)
                    throw std::runtime_error("Native graph text source proof is stale: " + path);
                if (observed->second.starts_with("physical:") &&
                    exact_source_revision(read_contained_source(root_, path)) !=
                        analysis.source_revision)
                    throw std::runtime_error("Native graph Asset text bytes are stale: " + path);
            } else {
                // Some declared Layout/Asset text dependencies are not yet in
                // the YAML observer's tracked-source set. Independently prove
                // their exact bytes here; do not silently treat them as watched.
                const auto bytes = read_contained_source(root_, path);
                if (exact_source_revision(bytes) != analysis.source_revision)
                    throw std::runtime_error("Native graph extra source is stale: " + path);
                supplemental_sources.emplace(path, analysis.source_revision);
            }
        }
        response["textSourceRevisions"][path] = analysis.source_revision;
        const auto lexical = analyze_project_text(path, analysis.source_text, true);
        if (!lexical.complete)
            incomplete.push_back(path);
        const auto owner_it = text_source_owners_.find(path);
        if (owner_it == text_source_owners_.end())
            continue;
        for (const auto& cursor : analysis.cursors) {
            const auto found = named_cursors.find(cursor.name);
            if (found == named_cursors.end())
                continue; // system cursors are not named Project references
            const auto target = project_key(found->second);
            for (const auto& owner : owner_it->second) {
                const auto slash = owner.find('/');
                if (slash == std::string::npos || !collection_known(owner.substr(0, slash)))
                    continue;
                const auto source_key = record_key(owner.substr(0, slash), owner.substr(slash + 1));
                if (!graph.node_keys.contains(source_key.to_string()))
                    continue;
                graph.edge(source_key, target, "/" + owner, found->second,
                           "source-recognized-reference");
                Json occurrence = Json::object();
                occurrence["ownerPath"] = "/" + owner;
                occurrence["sourceUrl"] = "project:/" + path;
                occurrence["sourceRevision"] = analysis.source_revision;
                occurrence["line"] = cursor.line;
                occurrence["column"] = cursor.column;
                occurrence["value"] = cursor.name;
                occurrence["classification"] = "exact-manual";
                occurrence["recognizedBy"] = "native.rcss-named-cursor";
                occurrence["target"] = target;
                occurrences.push_back(std::move(occurrence));
            }
        }
        std::set<std::size_t> recognized_literal_starts;
        for (const auto& reference : lexical.recognized_references) {
            if (reference.id.empty())
                continue;
            Json target = Json::null();
            std::string target_path;
            if (reference.collection == "cursor") {
                const auto cursor = named_cursors.find(reference.id);
                if (cursor == named_cursors.end())
                    continue;
                target_path = cursor->second;
                target = project_key(target_path);
            } else if (collection_known(reference.collection)) {
                target = record_key(reference.collection, reference.id);
                target_path = "/" + reference.collection + "/" + escape_pointer(reference.id);
            } else
                continue;
            bool recognized = false;
            for (const auto& owner : owner_it->second) {
                const auto slash = owner.find('/');
                if (slash == std::string::npos || !collection_known(owner.substr(0, slash)))
                    continue;
                if ((reference.recognized_by == "noveltea.script-module-import" ||
                     reference.recognized_by == "noveltea.room-hook-module") &&
                    !owner.starts_with("scripts/"))
                    continue;
                const auto source_key = record_key(owner.substr(0, slash), owner.substr(slash + 1));
                if (!graph.node_keys.contains(source_key.to_string()))
                    continue;
                recognized = true;
                graph.edge(source_key, target, "/" + owner, target_path,
                           "lua-recognized-reference");
                Json occurrence = Json::object();
                occurrence["ownerPath"] = "/" + owner;
                occurrence["sourceUrl"] = "project:/" + path;
                occurrence["sourceRevision"] = lexical.source_revision;
                occurrence["line"] = reference.line;
                occurrence["column"] = reference.column;
                occurrence["startUtf16"] = reference.start_utf16;
                occurrence["endUtf16"] = reference.end_utf16;
                occurrence["value"] = reference.id;
                occurrence["classification"] = "exact-manual";
                occurrence["recognizedBy"] = reference.recognized_by;
                occurrence["target"] = target;
                // The existing source rewrite mutator requires exact inner
                // UTF-16 offsets and expected text. Only unescaped text
                // literals in a single-owned physical file are eligible.
                if (!path.starts_with("inline/") && owner_it->second.size() == 1 &&
                    reference.expected_text && reference.end_utf16 <= lexical.source_text.size() &&
                    std::all_of(lexical.source_text.begin(),
                                lexical.source_text.begin() + reference.end_utf16,
                                [](unsigned char c) { return c < 128; }) &&
                    lexical.source_text.substr(reference.start_utf16,
                                               reference.end_utf16 - reference.start_utf16) ==
                        *reference.expected_text) {
                    occurrence["classification"] = "exact-rewriteable";
                    occurrence["rewriteRange"] = Json::object();
                    occurrence["rewriteRange"]["startUtf16"] = reference.start_utf16;
                    occurrence["rewriteRange"]["endUtf16"] = reference.end_utf16;
                    occurrence["rewriteRange"]["expectedText"] = *reference.expected_text;
                }
                occurrences.push_back(std::move(occurrence));
            }
            if (recognized)
                recognized_literal_starts.insert(reference.expected_text ? reference.start_utf16 - 1
                                                                         : reference.start_utf16);
        }
        for (const auto& reference : analysis.references) {
            // A Project-absolute URL recognized by the analyzer can bind to
            // a unique native record source. Relative RML template names
            // and ambiguous shared paths never acquire authoritative edges.
            if (!reference.target.starts_with("project:/"))
                continue;
            const auto source_path = reference.target.substr(sizeof("project:/") - 1);
            const auto found = source_targets.find(source_path);
            if (found == source_targets.end())
                continue;
            if (found->second.size() != 1) {
                graph.diagnostic("/" + path, "native.graph.ambiguous_source_target",
                                 "Recognized Project text path resolves to multiple records.");
                continue;
            }
            const auto& target = found->second.front();
            const auto target_path = "/" + member_string(target, "collection") + "/" +
                                     escape_pointer(member_string(target, "id"));
            for (const auto& owner : owner_it->second) {
                const auto split = owner.find('/');
                if (split == std::string::npos || !collection_known(owner.substr(0, split)))
                    continue;
                const auto origin = record_key(owner.substr(0, split), owner.substr(split + 1));
                if (!graph.node_keys.contains(origin.to_string()))
                    continue;
                graph.edge(origin, target, "/" + owner, target_path, "source-recognized-reference");
                Json occurrence = Json::object();
                occurrence["ownerPath"] = "/" + owner;
                occurrence["sourceUrl"] = "project:/" + path;
                occurrence["sourceRevision"] = analysis.source_revision;
                occurrence["line"] = reference.line;
                occurrence["column"] = reference.column;
                occurrence["value"] = reference.target;
                occurrence["classification"] = "exact-manual";
                occurrence["recognizedBy"] = "native." + reference.kind;
                occurrence["target"] = target;
                occurrences.push_back(std::move(occurrence));
            }
        }
        std::set<std::size_t> named_literal_starts;
        for (const auto& message : analysis.messages) {
            if (!message.lua_call || message.kind != "named")
                continue;
            const auto found = message_ids.find(message.source);
            if (found == message_ids.end())
                continue;
            if (message.source_start_utf16)
                named_literal_starts.insert(*message.source_start_utf16);
            for (const auto& owner : owner_it->second) {
                const auto split = owner.find('/');
                if (split == std::string::npos || !collection_known(owner.substr(0, split)))
                    continue;
                const auto source_key = record_key(owner.substr(0, split), owner.substr(split + 1));
                if (!graph.node_keys.contains(source_key.to_string()))
                    continue;
                for (const auto& locale : locales) {
                    const auto target = localization_key(locale, found->second);
                    if (!graph.node_keys.contains(target.to_string()))
                        continue;
                    const auto target_path =
                        locale == source_locale
                            ? "/localization/messages/" + escape_pointer(found->second) + "/source"
                            : "/localization/translations/" + escape_pointer(locale) + "/" +
                                  escape_pointer(found->second);
                    graph.edge(source_key, target, "/" + owner, target_path, "localization-text");
                    Json occurrence = Json::object();
                    occurrence["ownerPath"] = "/" + owner;
                    occurrence["sourceUrl"] = "project:/" + path;
                    occurrence["sourceRevision"] = analysis.source_revision;
                    occurrence["line"] = message.line;
                    occurrence["column"] = message.column;
                    if (message.source_start_utf16 && message.source_end_utf16) {
                        occurrence["startUtf16"] = *message.source_start_utf16;
                        occurrence["endUtf16"] = *message.source_end_utf16;
                    }
                    occurrence["value"] = message.source;
                    occurrence["classification"] = "exact-manual";
                    occurrence["recognizedBy"] = "native.Text.msg";
                    // A safe rewrite range is an analyzer-owned literal in a
                    // single-owner physical source, with an exact unescaped
                    // quoted lexeme. Multi-owner/inline/Unicode-offset cases
                    // remain manual rather than guessing at YAML byte offsets.
                    if (!path.starts_with("inline/") && owner_it->second.size() == 1 &&
                        message.source_start_utf16 && message.source_end_utf16 &&
                        *message.source_end_utf16 <= analysis.source_text.size() &&
                        std::all_of(analysis.source_text.begin(),
                                    analysis.source_text.begin() + *message.source_end_utf16,
                                    [](unsigned char c) { return c < 128; })) {
                        const auto span = analysis.source_text.substr(
                            *message.source_start_utf16,
                            *message.source_end_utf16 - *message.source_start_utf16);
                        if (span == "'" + message.source + "'" ||
                            span == "\"" + message.source + "\"") {
                            occurrence["classification"] = "exact-rewriteable";
                            occurrence["rewriteRange"] = Json::object();
                            occurrence["rewriteRange"]["startUtf16"] = *message.source_start_utf16;
                            occurrence["rewriteRange"]["endUtf16"] = *message.source_end_utf16;
                            occurrence["rewriteRange"]["expectedText"] = span;
                        }
                    }
                    occurrence["target"] = target;
                    occurrences.push_back(std::move(occurrence));
                }
            }
        }
        for (const auto& literal : lexical.lua_literals) {
            if (named_literal_starts.contains(literal.start_utf16) ||
                recognized_literal_starts.contains(literal.start_utf16))
                continue;
            const auto targets = graph.identities.find(literal.value);
            if (targets == graph.identities.end())
                continue;
            for (const auto& owner : owner_it->second)
                for (const auto& target : targets->second) {
                    Json occurrence = Json::object();
                    occurrence["ownerPath"] = "/" + owner;
                    occurrence["sourceUrl"] = "project:/" + path;
                    occurrence["sourceRevision"] = lexical.source_revision;
                    occurrence["line"] = literal.line;
                    occurrence["column"] = literal.column;
                    occurrence["startUtf16"] = literal.start_utf16;
                    occurrence["endUtf16"] = literal.end_utf16;
                    occurrence["value"] = literal.value;
                    occurrence["classification"] = "possible-lexical";
                    occurrence["target"] = target;
                    occurrences.push_back(std::move(occurrence));
                }
        }
    }
    const auto last = observe_sources();
    if (last.full_rescan || (!last.authoritative && !last.scoped_authority) ||
        !last.delta_revisions.empty() || source_authority_->verified_revisions() != verified ||
        working_revision_ != expected_revision)
        throw std::runtime_error("Native semantic graph source proof changed during query.");
    for (const auto& [path, revision] : supplemental_sources) {
        if (exact_source_revision(read_contained_source(root_, path)) != revision)
            throw std::runtime_error("Native graph additional source changed during query: " +
                                     path);
        response["sourceRevisions"][path] = revision;
    }
    for (const auto& [path, analysis] : source_analyses()) {
        const auto monitored = verified->find(path);
        if (monitored != verified->end() && monitored->second.starts_with("physical:") &&
            exact_source_revision(read_contained_source(root_, path)) != analysis.source_revision)
            throw std::runtime_error("Native graph Asset text source changed during query: " +
                                     path);
    }
    // Assembly diagnostics only after all native record and source-recognized
    // edges exist; a forward reference must not be mistaken for a missing
    // target based on map iteration order.
    for (const auto& edge : graph.edges.array_range())
        if (!graph.node_keys.contains(edge.at("target").to_string()))
            graph.diagnostic(edge.at("sourcePath").as<std::string>(), "native.graph.missing_target",
                             "Referenced target is not present in the admitted Project.");
    std::vector<std::string> incomplete_list;
    for (const auto& owner : incomplete.array_range())
        incomplete_list.push_back(owner.as<std::string>());
    std::sort(incomplete_list.begin(), incomplete_list.end());
    incomplete_list.erase(std::unique(incomplete_list.begin(), incomplete_list.end()),
                          incomplete_list.end());
    incomplete = Json::array();
    for (const auto& owner : incomplete_list)
        incomplete.push_back(owner);
    response["complete"] = incomplete_list.empty();
    sort_json_array(graph.nodes,
                    [](const Json& node) { return node.at("keyText").as<std::string>(); });
    sort_json_array(graph.edges, [](const Json& edge) { return edge.at("id").as<std::string>(); });
    sort_json_array(graph.diagnostics, [](const Json& issue) {
        return issue.at("path").as<std::string>() + "|" + issue.at("code").as<std::string>() + "|" +
               issue.at("message").as<std::string>();
    });
    sort_json_array(occurrences, [](const Json& item) {
        return item.at("sourceUrl").as<std::string>() + "|" +
               item.at("ownerPath").as<std::string>() + "|" + item.at("target").to_string() + "|" +
               std::to_string(item.at("line").as<std::size_t>()) + "|" +
               std::to_string(item.at("column").as<std::size_t>()) + "|" +
               item.at("classification").as<std::string>();
    });
    response["incompleteOwners"] = std::move(incomplete);
    response["nodes"] = std::move(graph.nodes);
    response["edges"] = std::move(graph.edges);
    response["diagnostics"] = std::move(graph.diagnostics);
    response["occurrences"] = std::move(occurrences);
    return response.to_string();
}
} // namespace noveltea::authoring
