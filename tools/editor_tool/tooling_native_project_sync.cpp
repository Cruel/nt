#include "tooling_native_project_sync.hpp"

#include "../project_authoring/localization_semantics.hpp"
#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/yaml_codec.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <queue>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

struct Current {
    std::string key;
    NativeLocalizationTrackingSource source;
    NativeLocalizationTrackingOccurrence occurrence;
    std::string identity() const { return key + "#" + std::to_string(occurrence.ordinal); }
};

struct Previous {
    std::string key;
    Json entry;
    Json occurrence;
    bool valuable = false;
    std::string identity() const
    {
        return key + "#" + occurrence.at("messageId").get<std::string>();
    }
};

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read tracked localization source.");
    const std::string bytes{std::istreambuf_iterator<char>(input),
                            std::istreambuf_iterator<char>()};
    if (input.bad())
        throw std::runtime_error("Cannot finish localization source read.");
    return bytes;
}

Json source_mapping(const std::filesystem::path& path)
{
    const auto opened = open_yaml_source(bytes_at(path));
    if (!opened.accepted)
        throw std::runtime_error("Cannot decode native localization source: " + path.string());
    auto parsed = Json::parse(opened.source_json);
    if (!parsed.is_object())
        throw std::runtime_error("Native localization source must be a mapping: " + path.string());
    return parsed;
}

Json localization_from_physical_sources(const std::filesystem::path& root)
{
    Json model{{"sourceMessageTracking", source_mapping(root / "i18n/tracking.yaml")},
               {"orphanedMessages", source_mapping(root / "i18n/orphans.yaml")},
               {"translations", Json::object()}};
    const auto locales = root / "i18n/locales";
    const auto kind = std::filesystem::symlink_status(locales).type();
    if (kind != std::filesystem::file_type::not_found &&
        kind != std::filesystem::file_type::directory)
        throw std::runtime_error("Localization chunk directory is not a contained directory.");
    if (kind == std::filesystem::file_type::directory)
        for (const auto& entry : std::filesystem::directory_iterator(locales)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
                continue;
            model["translations"][entry.path().stem().string()] = source_mapping(entry.path());
        }
    return model;
}

std::string escape_pointer(std::string_view value)
{
    std::string result;
    for (const auto ch : value)
        result += ch == '~' ? "~0" : ch == '/' ? "~1" : std::string(1, ch);
    return result;
}

std::string source_key(const NativeLocalizationTrackingSource& source)
{
    return source.family + ":" + source.owner_key + ":" + source.source_path;
}

Json occurrence_json(const Current& current, std::string_view message_id)
{
    const auto& occurrence = current.occurrence;
    Json value{{"messageId", message_id},
               {"ordinal", occurrence.ordinal},
               {"structuralFingerprint", occurrence.structural_fingerprint},
               {"anchorFingerprint", occurrence.anchor_fingerprint},
               {"sourceFingerprint", occurrence.source_fingerprint},
               {"sourceSnapshot", occurrence.source_snapshot}};
    if (occurrence.context_snapshot)
        value["contextSnapshot"] = *occurrence.context_snapshot;
    if (occurrence.translator_note_snapshot)
        value["translatorNoteSnapshot"] = *occurrence.translator_note_snapshot;
    return value;
}

Json entry_json(const NativeLocalizationTrackingSource& source)
{
    return {{"family", source.family},
            {"ownerKey", source.owner_key},
            {"sourcePath", source.source_path},
            {"sourceSnapshotFingerprint", source.source_snapshot_fingerprint},
            {"occurrences", Json::array()}};
}

const Json& field(const Json& value, std::string_view key)
{
    static const Json absent;
    return value.is_object() && value.contains(std::string(key)) ? value.at(std::string(key))
                                                                 : absent;
}

void register_condition(const Json& value, std::string_view path, std::set<std::string>& paths)
{
    if (field(value, "kind") == "lua-predicate" && field(value, "source").is_string())
        paths.insert(std::string(path) + "/source");
}

void register_text(const Json& value, std::string_view path, std::set<std::string>& paths)
{
    const auto& source = field(value, "source");
    if (field(source, "kind") == "lua-expression" && field(source, "source").is_string())
        paths.insert(std::string(path) + "/source/source");
}

void register_effect(const Json& value, std::string_view path, std::set<std::string>& paths)
{
    if (field(value, "kind") == "run-lua-effect" && field(value, "source").is_string())
        paths.insert(std::string(path) + "/source");
}

void register_command(const Json& value, const std::string& path, std::set<std::string>& paths,
                      int depth = 0)
{
    if (depth > 64)
        return;
    if (field(value, "kind") == "run-lua") {
        if (field(value, "source").is_string())
            paths.insert(path + "/source");
        return;
    }
    if (field(value, "kind") == "notify")
        register_text(field(value, "message"), path + "/message", paths);
    if (field(value, "kind") != "if")
        return;
    register_condition(field(value, "condition"), path + "/condition", paths);
    for (const char* branch : {"then", "else"}) {
        const auto& nested = field(value, branch);
        if (!nested.is_array())
            continue;
        for (std::size_t index = 0; index < nested.size(); ++index)
            register_command(nested.at(index), path + "/" + branch + "/" + std::to_string(index),
                             paths, depth + 1);
    }
}

void register_commands(const Json& value, const std::string& path, std::set<std::string>& paths)
{
    const auto& instructions = field(value, "instructions");
    if (!instructions.is_array())
        return;
    for (std::size_t index = 0; index < instructions.size(); ++index)
        register_command(instructions.at(index), path + "/instructions/" + std::to_string(index),
                         paths);
}

void register_source_fields(const std::string& family, const std::string& id, const Json& data,
                            std::set<std::string>& paths)
{
    const auto prefix = "/" + family + "/" + id + "/data";
    const auto register_array = [&](std::string_view name, auto visit) {
        const auto& array = field(data, name);
        if (!array.is_array())
            return;
        for (std::size_t index = 0; index < array.size(); ++index)
            visit(array.at(index), prefix + "/" + std::string(name) + "/" + std::to_string(index));
    };
    if (family == "rooms") {
        register_text(field(data, "description"), prefix + "/description", paths);
        for (const char* collection : {"overlays", "cast", "props", "environments", "exits"})
            register_array(collection, [&](const auto& record, const std::string& path) {
                register_condition(field(record, "condition"), path + "/condition", paths);
            });
        register_array("placements", [&](const auto& record, const std::string& path) {
            register_text(field(field(record, "presentation"), "label"),
                          path + "/presentation/label", paths);
        });
        const auto& lifecycle = field(data, "lifecycle");
        register_condition(field(lifecycle, "canEnter"), prefix + "/lifecycle/canEnter", paths);
        register_condition(field(lifecycle, "canLeave"), prefix + "/lifecycle/canLeave", paths);
    } else if (family == "scenes") {
        register_array("events", [&](const auto& event, const std::string& path) {
            register_condition(field(event, "condition"), path + "/condition", paths);
            const auto type = field(event, "type");
            if (type == "run-lua" && field(event, "source").is_string())
                paths.insert(path + "/source");
            if (type == "show-text")
                register_text(field(event, "text"), path + "/text", paths);
            const auto& branches = field(event, "branches");
            if (type == "conditional-branch" && branches.is_array())
                for (std::size_t index = 0; index < branches.size(); ++index)
                    register_condition(field(branches.at(index), "condition"),
                                       path + "/branches/" + std::to_string(index) + "/condition",
                                       paths);
            const auto& options = field(event, "options");
            if (type == "choice" && options.is_array())
                for (std::size_t index = 0; index < options.size(); ++index) {
                    const auto& option = options.at(index);
                    const auto option_path = path + "/options/" + std::to_string(index);
                    register_text(field(option, "label"), option_path + "/label", paths);
                    register_condition(field(option, "condition"), option_path + "/condition",
                                       paths);
                    const auto& effects = field(option, "effects");
                    if (effects.is_array())
                        for (std::size_t effect = 0; effect < effects.size(); ++effect)
                            register_effect(effects.at(effect),
                                            option_path + "/effects/" + std::to_string(effect),
                                            paths);
                }
        });
    } else if (family == "dialogues") {
        register_array("blocks", [&](const auto& block, const std::string& path) {
            if (field(block, "type") != "sequence")
                return;
            const auto& segments = field(block, "segments");
            if (!segments.is_array())
                return;
            for (std::size_t index = 0; index < segments.size(); ++index) {
                const auto& segment = segments.at(index);
                const auto current = path + "/segments/" + std::to_string(index);
                register_condition(field(segment, "condition"), current + "/condition", paths);
                if (field(segment, "type") == "run-lua" && field(segment, "source").is_string())
                    paths.insert(current + "/source");
                if (field(segment, "type") == "line") {
                    register_text(field(segment, "text"), current + "/text", paths);
                    const auto& effects = field(segment, "effects");
                    if (effects.is_array())
                        for (std::size_t effect = 0; effect < effects.size(); ++effect)
                            register_command(effects.at(effect),
                                             current + "/effects/" + std::to_string(effect), paths);
                }
            }
        });
        register_array("edges", [&](const auto& edge, const std::string& path) {
            if (field(edge, "kind") != "choice")
                return;
            register_text(field(edge, "label"), path + "/label", paths);
            register_condition(field(edge, "condition"), path + "/condition", paths);
            const auto& effects = field(edge, "effects");
            if (effects.is_array())
                for (std::size_t effect = 0; effect < effects.size(); ++effect)
                    register_command(effects.at(effect),
                                     path + "/effects/" + std::to_string(effect), paths);
        });
    } else if (family == "verbs") {
        register_text(field(data, "actionText"), prefix + "/actionText", paths);
        register_condition(field(data, "availability"), prefix + "/availability", paths);
        register_commands(field(data, "defaultProgram"), prefix + "/defaultProgram", paths);
    } else if (family == "interactions") {
        register_array("rules", [&](const auto& rule, const std::string& path) {
            const auto& context = field(rule, "context");
            if (field(context, "kind") == "predicate")
                register_condition(field(context, "condition"), path + "/context/condition", paths);
            register_commands(field(rule, "program"), path + "/program", paths);
        });
    } else if (family == "maps") {
        register_text(field(field(data, "presentation"), "title"), prefix + "/presentation/title",
                      paths);
        register_array("locations", [&](const auto& location, const std::string& path) {
            register_text(field(location, "label"), path + "/label", paths);
            register_condition(field(location, "visibility"), path + "/visibility", paths);
        });
        register_array("connections", [&](const auto& connection, const std::string& path) {
            register_text(field(connection, "label"), path + "/label", paths);
            register_condition(field(connection, "visibility"), path + "/visibility", paths);
        });
    } else if (family == "scripts") {
        const auto& source = field(data, "source");
        if (field(source, "kind") == "inline-lua" && field(source, "source").is_string())
            paths.insert(prefix + "/source/source");
    } else if (family == "layouts") {
        const auto& lua = field(data, "lua");
        if (field(lua, "sourceMode") == "inline" && field(lua, "sourceText").is_string())
            paths.insert(prefix + "/lua/sourceText");
    }
}

std::vector<NativeLocalizationTrackingSource> current_sources(ProjectSession& session)
{
    const auto validated = session.validate_project();
    if (!validated.valid) {
        std::string reason;
        for (const auto& diagnostic : validated.diagnostics) {
            if (diagnostic.severity != "error")
                continue;
            if (diagnostic.code == "semantic.localization.validate")
                continue; // Reconciliation must be able to repair stale target Messages.
            if (!reason.empty())
                reason += "; ";
            reason += diagnostic.code + ": " + diagnostic.path + " " + diagnostic.message;
            if (reason.size() > 800)
                break;
        }
        if (!reason.empty())
            throw std::runtime_error("Localization sync requires a valid disk Project: " + reason);
    }
    std::vector<NativeLocalizationTrackingSource> current;
    std::set<std::string> found;
    std::set<std::string> registered_paths;
    for (const auto& [owner, snapshot] : session.reconciliation_disk_record_snapshots()) {
        if (!snapshot.valid || snapshot.normalized_json.empty())
            continue;
        const auto slash = owner.find('/');
        if (slash == std::string::npos)
            continue;
        const auto family = owner.substr(0, slash);
        const auto id = owner.substr(slash + 1);
        const auto record = Json::parse(snapshot.normalized_json);
        register_source_fields(family, id, field(record, "data"), registered_paths);
    }
    for (const auto& [physical, analysis] : session.source_analyses()) {
        if (!physical.starts_with("inline/") || !physical.ends_with(".lua"))
            continue; // External source files are not managed Lua inline-text contracts.
        const auto relative = physical.substr(sizeof("inline/") - 1);
        const auto family_end = relative.find('/');
        const auto id_end = family_end == std::string::npos ? std::string::npos
                                                            : relative.find('/', family_end + 1);
        if (id_end == std::string::npos)
            continue;
        const auto family = relative.substr(0, family_end);
        const auto id = relative.substr(family_end + 1, id_end - family_end - 1);
        if (family.empty() || id.empty())
            continue;
        std::string source_path{"/"};
        source_path.append(relative.data(), relative.size() - 4);
        if (!registered_paths.contains(source_path))
            continue;
        auto source = native_localization_tracking_source(
            analysis, "lua", "record:" + family + ":" + id, source_path);
        const auto key = source_key(source);
        if (found.insert(key).second)
            current.push_back(std::move(source));
    }
    for (const auto& [owner, snapshot] : session.reconciliation_disk_record_snapshots()) {
        if (!owner.starts_with("layouts/") || !snapshot.valid || snapshot.normalized_json.empty())
            continue;
        const auto data = Json::parse(snapshot.normalized_json).at("data");
        const auto id = owner.substr(sizeof("layouts/") - 1);
        if (data.contains("lua") && data.at("lua").is_object()) {
            const auto& lua = data.at("lua");
            if (lua.value("sourceMode", std::string{}) == "inline" && lua.contains("sourceText") &&
                lua.at("sourceText").is_string()) {
                const auto path = "/layouts/" + id + "/data/lua/sourceText";
                const auto analysis = analyze_project_text("inline/" + path.substr(1) + ".lua",
                                                           lua.at("sourceText").get<std::string>());
                auto source = native_localization_tracking_source(analysis, "lua",
                                                                  "record:layouts:" + id, path);
                const auto key = source_key(source);
                if (found.insert(key).second)
                    current.push_back(std::move(source));
            }
        }
        if (!data.contains("rml") || !data.at("rml").is_object())
            continue;
        const auto& rml = data.at("rml");
        if (rml.value("sourceMode", std::string{}) != "inline" || !rml.contains("sourceText") ||
            !rml.at("sourceText").is_string())
            continue;
        const auto path = "/layouts/" + id + "/data/rml/sourceText";
        const auto analysis = analyze_project_text("inline/" + path.substr(1) + ".rml",
                                                   rml.at("sourceText").get<std::string>());
        auto source =
            native_localization_tracking_source(analysis, "rml", "record:layouts:" + id, path);
        const auto key = source_key(source);
        if (found.insert(key).second)
            current.push_back(std::move(source));
    }
    std::sort(current.begin(), current.end(),
              [](const auto& a, const auto& b) { return source_key(a) < source_key(b); });
    return current;
}

std::string uuid_from_seed(std::string_view seed)
{
    const auto raw = native_localization_tracking_fingerprint(seed).substr(6);
    const auto high = static_cast<unsigned char>(std::stoi(raw.substr(16, 2), nullptr, 16));
    const auto alphabet = "0123456789abcdef";
    const auto variant = std::string{alphabet[((high & 0x3fu) | 0x80u) >> 4],
                                     alphabet[((high & 0x3fu) | 0x80u) & 0xfu]};
    return raw.substr(0, 8) + "-" + raw.substr(8, 4) + "-5" + raw.substr(13, 3) + "-" + variant +
           raw.substr(18, 2) + "-" + raw.substr(20, 12);
}

std::string new_message_id(const Current& current)
{
    const auto& source = current.source;
    const auto& occurrence = current.occurrence;
    return uuid_from_seed("source-message|" + source.family + "|" + source.owner_key + "|" +
                          source.source_path + "|" + occurrence.structural_fingerprint + "|" +
                          occurrence.anchor_fingerprint + "|" + occurrence.source_fingerprint +
                          "|" + std::to_string(occurrence.ordinal));
}

bool relevant(const Current& current, const Previous& prior)
{
    if (current.source.family != prior.entry.at("family"))
        return false;
    return current.key == prior.key || current.source.owner_key == prior.entry.at("ownerKey") ||
           current.occurrence.structural_fingerprint ==
               prior.occurrence.at("structuralFingerprint") ||
           current.occurrence.anchor_fingerprint == prior.occurrence.at("anchorFingerprint");
}

bool match_phase(const Current& current, const Previous& prior, int phase)
{
    const bool source = current.key == prior.key;
    const bool structure =
        current.occurrence.structural_fingerprint == prior.occurrence.at("structuralFingerprint");
    const bool anchor =
        current.occurrence.anchor_fingerprint == prior.occurrence.at("anchorFingerprint");
    const bool family = current.source.family == prior.entry.at("family");
    const bool owner = current.source.owner_key == prior.entry.at("ownerKey");
    switch (phase) {
    case 0:
        return source && structure && anchor;
    case 1:
        return source && structure;
    case 2:
        return source && anchor;
    case 3:
        return source && !prior.valuable;
    case 4:
        return family && owner && structure;
    case 5:
        return family && structure;
    default:
        return false;
    }
}

struct Synchronization {
    Json tracking;
    Json materialized = Json::array();
    Json preserved = Json::array();
    Json unresolved = Json::array();
    bool changed = false;
};

Synchronization synchronize(const Json& localization,
                            const std::vector<NativeLocalizationTrackingSource>& sources)
{
    const auto& prior_tracking = localization.at("sourceMessageTracking");
    std::vector<Current> currents;
    for (const auto& source : sources)
        for (const auto& occurrence : source.occurrences)
            currents.push_back({source_key(source), source, occurrence});
    std::vector<Previous> previous;
    for (const auto& [key, entry] : prior_tracking.items())
        for (const auto& occurrence : entry.at("occurrences")) {
            const auto id = occurrence.at("messageId").get<std::string>();
            bool valuable = (occurrence.contains("contextSnapshot") &&
                             !occurrence.at("contextSnapshot").get<std::string>().empty()) ||
                            (occurrence.contains("translatorNoteSnapshot") &&
                             !occurrence.at("translatorNoteSnapshot").get<std::string>().empty());
            for (const auto& [_, translations] : localization.at("translations").items())
                valuable |= translations.contains(id);
            previous.push_back({key, entry, occurrence, valuable});
        }
    std::set<std::size_t> current_matched;
    std::set<std::size_t> prior_matched;
    std::map<std::size_t, std::size_t> matches;
    for (int phase = 0; phase < 6; ++phase) {
        bool progress = true;
        while (progress) {
            progress = false;
            for (std::size_t index = 0; index < currents.size(); ++index) {
                if (current_matched.contains(index))
                    continue;
                std::vector<std::size_t> candidates;
                for (std::size_t prior = 0; prior < previous.size(); ++prior)
                    if (!prior_matched.contains(prior) &&
                        match_phase(currents[index], previous[prior], phase))
                        candidates.push_back(prior);
                if (candidates.size() != 1)
                    continue;
                const auto candidate = candidates.front();
                std::size_t reverse = 0;
                for (std::size_t other = 0; other < currents.size(); ++other)
                    if (!current_matched.contains(other) &&
                        match_phase(currents[other], previous[candidate], phase))
                        ++reverse;
                if (reverse != 1)
                    continue;
                current_matched.insert(index);
                prior_matched.insert(candidate);
                matches[index] = candidate;
                progress = true;
            }
        }
    }
    Synchronization result;
    result.tracking = Json::object();
    for (const auto& [key, entry] : prior_tracking.items()) {
        Json retained = Json::array();
        for (std::size_t index = 0; index < previous.size(); ++index) {
            const auto& prior = previous[index];
            if (prior.key != key || prior_matched.contains(index))
                continue;
            const bool related =
                std::any_of(currents.begin(), currents.end(),
                            [&](const auto& current) { return relevant(current, prior); });
            if (prior.valuable || !related)
                retained.push_back(prior.occurrence);
        }
        if (!retained.empty()) {
            auto value = entry;
            value["occurrences"] = std::move(retained);
            result.tracking[key] = std::move(value);
        }
    }
    for (std::size_t index = 0; index < currents.size(); ++index) {
        const auto& current = currents[index];
        std::string id;
        if (const auto found = matches.find(index); found != matches.end()) {
            id = previous[found->second].occurrence.at("messageId").get<std::string>();
            result.preserved.push_back(id);
        } else {
            const bool plausible =
                std::any_of(previous.begin(), previous.end(), [&](const auto& prior) {
                    const auto pointer = &prior - previous.data();
                    return !prior_matched.contains(static_cast<std::size_t>(pointer)) &&
                           prior.valuable && relevant(current, prior);
                });
            if (plausible) {
                result.unresolved.push_back({{"family", current.source.family},
                                             {"ownerKey", current.source.owner_key},
                                             {"sourcePath", current.source.source_path},
                                             {"ordinal", current.occurrence.ordinal}});
                continue;
            }
            id = new_message_id(current);
            result.materialized.push_back(id);
        }
        auto entry = result.tracking.contains(current.key) ? result.tracking.at(current.key)
                                                           : entry_json(current.source);
        entry["family"] = current.source.family;
        entry["ownerKey"] = current.source.owner_key;
        entry["sourcePath"] = current.source.source_path;
        entry["sourceSnapshotFingerprint"] = current.source.source_snapshot_fingerprint;
        auto& entries = entry["occurrences"];
        Json next = Json::array();
        for (const auto& occurrence : entries)
            if (occurrence.at("messageId") != id)
                next.push_back(occurrence);
        next.push_back(occurrence_json(current, id));
        std::sort(next.begin(), next.end(), [](const auto& a, const auto& b) {
            return a.at("ordinal") < b.at("ordinal") ||
                   (a.at("ordinal") == b.at("ordinal") && a.at("messageId") < b.at("messageId"));
        });
        entry["occurrences"] = std::move(next);
        result.tracking[current.key] = std::move(entry);
    }
    const auto sort_by_string = [](Json& values) {
        std::sort(values.begin(), values.end(), [](const auto& a, const auto& b) { return a < b; });
    };
    sort_by_string(result.materialized);
    sort_by_string(result.preserved);
    result.changed = result.tracking != prior_tracking;
    return result;
}

using Ordered = nlohmann::ordered_json;

Ordered ordered_fields(const Json& entry, std::initializer_list<const char*> fields)
{
    Ordered result = Ordered::object();
    for (const char* field : fields)
        if (entry.contains(field))
            result[field] = Ordered::parse(entry.at(field).dump());
    return result;
}

Ordered ordered_occurrence(const Json& entry)
{
    return ordered_fields(entry, {"messageId", "ordinal", "structuralFingerprint",
                                  "anchorFingerprint", "sourceFingerprint", "sourceSnapshot",
                                  "contextSnapshot", "translatorNoteSnapshot"});
}

Ordered ordered_entry(const Json& entry)
{
    auto result =
        ordered_fields(entry, {"family", "ownerKey", "sourcePath", "sourceSnapshotFingerprint"});
    result["occurrences"] = Ordered::array();
    for (const auto& occurrence : entry.at("occurrences"))
        result["occurrences"].push_back(ordered_occurrence(occurrence));
    return result;
}

Ordered ordered_pattern(const Json& pattern)
{
    auto result = ordered_fields(pattern, {"kind", "text", "argument"});
    if (pattern.contains("cases")) {
        result["cases"] = Ordered::object();
        for (const auto& [name, child] : pattern.at("cases").items())
            result["cases"][name] = ordered_pattern(child);
    }
    return result;
}

Ordered ordered_translation(const Json& entry)
{
    auto result =
        ordered_fields(entry, {"text", "pattern", "dialogueCues", "sourceFingerprint", "origin",
                               "review", "provider", "model", "acknowledgedPresentationFingerprint",
                               "acknowledgedGuidanceFingerprint", "useSource"});
    if (entry.contains("pattern"))
        result["pattern"] = ordered_pattern(entry.at("pattern"));
    return result;
}

Ordered ordered_orphan(const Json& orphan)
{
    auto result =
        ordered_fields(orphan, {"family", "ownerKey", "sourcePath", "sourceSnapshotFingerprint"});
    result["occurrence"] = ordered_occurrence(orphan.at("occurrence"));
    result["translations"] = Ordered::object();
    for (const auto& [locale, translation] : orphan.at("translations").items())
        result["translations"][locale] = ordered_translation(translation);
    return result;
}

std::string reconciliation_fingerprint(const Json& localization,
                                       const std::vector<NativeLocalizationTrackingSource>& sources)
{
    Ordered document;
    document["sources"] = Ordered::array();
    for (const auto& source : sources) {
        Ordered item{{"family", source.family},
                     {"ownerKey", source.owner_key},
                     {"sourcePath", source.source_path},
                     {"sourceSnapshotFingerprint", source.source_snapshot_fingerprint},
                     {"occurrences", Ordered::array()}};
        for (const auto& occurrence : source.occurrences)
            item["occurrences"].push_back(
                Ordered{{"ordinal", occurrence.ordinal},
                        {"structuralFingerprint", occurrence.structural_fingerprint},
                        {"anchorFingerprint", occurrence.anchor_fingerprint},
                        {"sourceFingerprint", occurrence.source_fingerprint}});
        document["sources"].push_back(std::move(item));
    }
    document["tracking"] = Ordered::array();
    for (const auto& [key, entry] : localization.at("sourceMessageTracking").items())
        document["tracking"].push_back(Ordered::array({key, ordered_entry(entry)}));
    document["orphans"] = Ordered::array();
    for (const auto& [key, entry] : localization.at("orphanedMessages").items())
        document["orphans"].push_back(Ordered::array({key, ordered_orphan(entry)}));
    document["translationIds"] = Ordered::array();
    for (const auto& [locale, entries] : localization.at("translations").items()) {
        Ordered ids = Ordered::array();
        for (const auto& [id, _] : entries.items())
            ids.push_back(id);
        document["translationIds"].push_back(Ordered::array({locale, ids}));
    }
    return native_localization_tracking_fingerprint(document.dump());
}

struct ReconcilePrevious {
    std::string id;
    std::string source_key;
    std::string origin;
    std::string family;
    std::string owner_key;
    std::string source_path;
    std::string source_snapshot_fingerprint;
    Json occurrence;
    bool valuable = false;
};

std::vector<ReconcilePrevious> reconcile_previous(const Json& localization)
{
    std::vector<ReconcilePrevious> result;
    for (const auto& [key, entry] : localization.at("sourceMessageTracking").items()) {
        for (const auto& occurrence : entry.at("occurrences")) {
            const auto message_id = occurrence.at("messageId").get<std::string>();
            bool valuable = occurrence.value("contextSnapshot", std::string{}) != "" ||
                            occurrence.value("translatorNoteSnapshot", std::string{}) != "";
            for (const auto& [_, translations] : localization.at("translations").items())
                valuable |= translations.contains(message_id);
            result.push_back(
                {"tracked:" + key + "#" + message_id, key, "tracked",
                 entry.at("family").get<std::string>(), entry.at("ownerKey").get<std::string>(),
                 entry.at("sourcePath").get<std::string>(),
                 entry.at("sourceSnapshotFingerprint").get<std::string>(), occurrence, valuable});
        }
    }
    for (const auto& [id, orphan] : localization.at("orphanedMessages").items()) {
        const auto family = orphan.at("family").get<std::string>();
        const auto owner = orphan.at("ownerKey").get<std::string>();
        const auto source = orphan.at("sourcePath").get<std::string>();
        result.push_back({"orphan:" + id, family + ":" + owner + ":" + source, "orphan", family,
                          owner, source, orphan.at("sourceSnapshotFingerprint").get<std::string>(),
                          orphan.at("occurrence"), true});
    }
    return result;
}

bool weakly_related(const Current& current, const ReconcilePrevious& prior)
{
    return current.source.family == prior.family &&
           (current.key == prior.source_key || current.source.owner_key == prior.owner_key ||
            current.occurrence.structural_fingerprint ==
                prior.occurrence.at("structuralFingerprint") ||
            current.occurrence.anchor_fingerprint == prior.occurrence.at("anchorFingerprint"));
}

std::vector<Current> flatten_current(const std::vector<NativeLocalizationTrackingSource>& sources)
{
    std::vector<Current> result;
    for (const auto& source : sources)
        for (const auto& occurrence : source.occurrences)
            result.push_back({source_key(source), source, occurrence});
    return result;
}

bool freshly_tracked(const Current& current, const Json& localization)
{
    const auto& tracking = localization.at("sourceMessageTracking");
    if (!tracking.contains(current.key))
        return false;
    const auto& entry = tracking.at(current.key);
    if (entry.at("sourceSnapshotFingerprint") != current.source.source_snapshot_fingerprint)
        return false;
    for (const auto& occurrence : entry.at("occurrences"))
        if (occurrence.at("ordinal") == current.occurrence.ordinal &&
            occurrence.at("structuralFingerprint") == current.occurrence.structural_fingerprint &&
            occurrence.at("anchorFingerprint") == current.occurrence.anchor_fingerprint &&
            occurrence.at("sourceFingerprint") == current.occurrence.source_fingerprint &&
            occurrence.at("sourceSnapshot") == current.occurrence.source_snapshot)
            return true;
    return false;
}

Json reconciliation_plan(const Json& original,
                         const std::vector<NativeLocalizationTrackingSource>& sources,
                         const std::string& workspace_revision)
{
    const auto synced = synchronize(original, sources);
    auto localization = original;
    localization["sourceMessageTracking"] = synced.tracking;
    const auto all = flatten_current(sources);
    const auto orphans = reconcile_previous(original);
    std::set<std::string> related_orphan_occurrences;
    for (const auto& current : all)
        if (std::any_of(orphans.begin(), orphans.end(), [&](const auto& previous) {
                return previous.origin == "orphan" && weakly_related(current, previous);
            }))
            related_orphan_occurrences.insert(current.identity());
    std::vector<Current> currents;
    std::set<std::string> fresh_message_ids;
    for (const auto& current : all) {
        const bool fresh = freshly_tracked(current, localization);
        if (fresh) {
            for (const auto& occurrence :
                 localization.at("sourceMessageTracking").at(current.key).at("occurrences"))
                if (occurrence.at("ordinal") == current.occurrence.ordinal)
                    fresh_message_ids.insert(occurrence.at("messageId").get<std::string>());
        }
        if (!fresh || related_orphan_occurrences.contains(current.identity()))
            currents.push_back(current);
    }
    std::vector<ReconcilePrevious> previous;
    for (const auto& item : reconcile_previous(localization))
        if (item.origin == "orphan" ||
            !fresh_message_ids.contains(item.occurrence.at("messageId").get<std::string>()))
            previous.push_back(item);

    std::vector<bool> current_seen(currents.size(), false);
    std::vector<bool> previous_seen(previous.size(), false);
    Json groups = Json::array();
    for (std::size_t seed = 0; seed < currents.size() + previous.size(); ++seed) {
        const auto is_current = seed < currents.size();
        const auto offset = is_current ? seed : seed - currents.size();
        if (is_current ? current_seen[offset] : previous_seen[offset])
            continue;
        std::vector<std::size_t> current_indices;
        std::vector<std::size_t> previous_indices;
        std::queue<std::pair<bool, std::size_t>> pending;
        pending.emplace(is_current, offset);
        while (!pending.empty()) {
            const auto [current, index] = pending.front();
            pending.pop();
            if (current) {
                if (current_seen[index])
                    continue;
                current_seen[index] = true;
                current_indices.push_back(index);
                for (std::size_t n = 0; n < previous.size(); ++n)
                    if (!previous_seen[n] && weakly_related(currents[index], previous[n]))
                        pending.emplace(false, n);
            } else {
                if (previous_seen[index])
                    continue;
                previous_seen[index] = true;
                previous_indices.push_back(index);
                for (std::size_t n = 0; n < currents.size(); ++n)
                    if (!current_seen[n] && weakly_related(currents[n], previous[index]))
                        pending.emplace(true, n);
            }
        }
        Json public_current = Json::array();
        Json public_previous = Json::array();
        std::set<std::string> ids;
        bool valuable = false;
        for (const auto index : current_indices) {
            const auto& item = currents[index];
            public_current.push_back({{"id", item.identity()},
                                      {"family", item.source.family},
                                      {"ownerKey", item.source.owner_key},
                                      {"sourcePath", item.source.source_path},
                                      {"ordinal", item.occurrence.ordinal},
                                      {"sourceSnapshot", item.occurrence.source_snapshot}});
        }
        for (const auto index : previous_indices) {
            const auto& item = previous[index];
            const auto id = item.occurrence.at("messageId").get<std::string>();
            ids.insert(id);
            valuable |= item.valuable;
            Json view{{"messageId", id},
                      {"origin", item.origin},
                      {"family", item.family},
                      {"ownerKey", item.owner_key},
                      {"sourcePath", item.source_path},
                      {"ordinal", item.occurrence.at("ordinal")},
                      {"sourceSnapshot", item.occurrence.at("sourceSnapshot")},
                      {"valuable", item.valuable}};
            for (const char* field : {"contextSnapshot", "translatorNoteSnapshot"})
                if (item.occurrence.contains(field))
                    view[field] = item.occurrence.at(field);
            public_previous.push_back(std::move(view));
        }
        const auto sort_ids = [](Json& values, const char* key) {
            std::sort(values.begin(), values.end(), [key](const auto& a, const auto& b) {
                return a.at(key).template get<std::string>() <
                       b.at(key).template get<std::string>();
            });
        };
        sort_ids(public_current, "id");
        sort_ids(public_previous, "messageId");
        std::string group_seed;
        for (const auto& item : public_current) {
            if (!group_seed.empty())
                group_seed += '|';
            group_seed += item.at("id").get<std::string>();
        }
        for (const auto& item : public_previous) {
            if (!group_seed.empty())
                group_seed += '|';
            group_seed += item.at("messageId").get<std::string>();
        }
        Json prior_ids = Json::array();
        for (const auto& id : ids)
            prior_ids.push_back(id);
        groups.push_back(
            {{"id", native_localization_tracking_fingerprint(group_seed)},
             {"currentOccurrences", std::move(public_current)},
             {"previousOccurrences", std::move(public_previous)},
             {"previousMessageIds", std::move(prior_ids)},
             {"requiresDecision", !current_indices.empty() && valuable &&
                                      !(current_indices.size() > 1 && previous_indices.size() > 1)},
             {"defaultResolution", current_indices.empty() ? "orphan-or-garbage-collect" : "new"}});
    }
    std::sort(groups.begin(), groups.end(),
              [](const auto& a, const auto& b) { return a.at("id") < b.at("id"); });
    return {{"expectedWorkspaceRevision", workspace_revision},
            {"expectedFingerprint", reconciliation_fingerprint(original, sources)},
            {"deterministicChanged", synced.changed},
            {"groups", groups}};
}

} // namespace

// Include all tracked native authoring sources, rather than only the YAML owner
// selected for a write. This prevents publishing identities derived from a
// changed Lua/RML buffer after the editor's read generation has gone stale.
std::string native_project_source_generation(const ProjectSession& session,
                                             const std::filesystem::path& root)
{
    std::string identity = "native-project-source-generation-v1";
    identity.push_back('\0');
    for (const auto& source : session.file_inventory()) {
        if (source.kind != ProjectFileKind::TrackedSource &&
            source.kind != ProjectFileKind::ProjectSource)
            continue;
        const auto path = root / std::filesystem::path(source.path);
        if (!std::filesystem::is_regular_file(path) || std::filesystem::is_symlink(path))
            throw std::runtime_error("Cannot verify native source generation: " + source.path);
        identity.append(source.path).push_back('\0');
        identity.append(exact_source_revision(bytes_at(path))).push_back('\0');
    }
    return exact_source_revision(identity);
}

bool native_project_source_generation_is_current(const std::filesystem::path& root,
                                                 std::string_view expected)
{
    std::string error;
    auto fresh = ProjectSession::open(root, error);
    return fresh && native_project_source_generation(*fresh, root) == expected;
}

std::vector<NativeLocalizationTrackingSource>
native_project_localization_sources(ProjectSession& session)
{
    return current_sources(session);
}

Json native_project_localization_sync(const Json& request, ProjectSession& session,
                                      const std::filesystem::path& root)
{
    if ((request.contains("dryRun") && !request.at("dryRun").is_boolean()) ||
        (request.contains("sourceRevision") && !request.at("sourceRevision").is_string()))
        return failure("Native localization sync options are malformed.");
    const bool dry_run = request.value("dryRun", true);
    const auto generation = native_project_source_generation(session, root);
    const auto source_revision = exact_source_revision(bytes_at(root / "i18n/tracking.yaml"));
    const auto sources = current_sources(session);
    const auto localization = localization_from_physical_sources(root);
    const auto synchronized = synchronize(localization, sources);
    Json result{{"ok", true},
                {"dryRun", dry_run},
                {"sourceGeneration", generation},
                {"sourceRevision", source_revision},
                {"changed", synchronized.changed},
                {"materializedMessageIds", synchronized.materialized},
                {"preservedMessageIds", synchronized.preserved},
                {"unresolved", synchronized.unresolved},
                {"structuredMessageCount", native_localization_structured_message_count(root)},
                {"writes", Json::array()}};
    if (dry_run || !synchronized.changed)
        return result;
    if (!request.contains("expectedSourceGeneration") ||
        !request.at("expectedSourceGeneration").is_string() ||
        request.at("expectedSourceGeneration") != generation)
        return failure("Native localization sync requires its exact planned source generation.");
    const auto path = "i18n/tracking.yaml";
    const auto physical_revision = exact_source_revision(bytes_at(root / path));
    if (!request.contains("sourceRevision") || request.at("sourceRevision") != physical_revision)
        return failure(
            "Native localization sync requires an exact current tracking source revision.");
    std::vector<RoomPatch> edits;
    const auto& before = localization.at("sourceMessageTracking");
    for (const auto& [key, entry] : before.items())
        if (!synchronized.tracking.contains(key))
            edits.push_back({RoomPatch::Operation::Remove,
                             "/localization/sourceMessageTracking/" + escape_pointer(key), ""});
    for (const auto& [key, entry] : synchronized.tracking.items()) {
        const bool prior = before.contains(key);
        if (!prior || before.at(key) != entry)
            edits.push_back({prior ? RoomPatch::Operation::Replace : RoomPatch::Operation::Add,
                             "/localization/sourceMessageTracking/" + escape_pointer(key),
                             entry.dump()});
    }
    const auto patched =
        session.patch(session.snapshot().working_revision, edits, {{path, physical_revision}});
    if (!patched.accepted)
        return failure(patched.error);
    if (!native_project_source_generation_is_current(root, generation))
        return failure("Native localization source generation changed before sync commit.");
    const auto saved = session.save_owners(patched.snapshot.working_revision, {path}, false,
                                           TransactionDecision::KeepComments);
    if (!saved.accepted)
        return failure(saved.error);
    if (!saved.affected_records.empty())
        result["writes"] = Json::array({path});
    return result;
}

Json native_project_localization_reconcile(const Json& request, ProjectSession& session,
                                           const std::filesystem::path& root)
{
    if ((request.contains("dryRun") && !request.at("dryRun").is_boolean()) ||
        (request.contains("workspaceRevision") && !request.at("workspaceRevision").is_string()))
        return failure("Native localization reconciliation options are malformed.");
    const bool dry_run = request.value("dryRun", true);
    const auto sources = current_sources(session);
    const auto original = localization_from_physical_sources(root);
    const auto generation = native_project_source_generation(session, root);
    // A native source generation is an opaque, disk-authoritative Project
    // revision token. The client must not synthesize it from TypeScript state.
    const auto revision = request.value("workspaceRevision", generation);
    const auto plan = reconciliation_plan(original, sources, revision);
    if (dry_run) {
        Json preconditions = Json::object();
        for (const auto& file : session.file_inventory()) {
            if (file.kind != ProjectFileKind::TrackedSource || !file.path.starts_with("i18n/") ||
                !file.path.ends_with(".yaml"))
                continue;
            preconditions[file.path] = exact_source_revision(bytes_at(root / file.path));
        }
        return {{"ok", true},
                {"plan", plan},
                {"sourceGeneration", generation},
                {"diskPreconditions", std::move(preconditions)},
                {"writes", Json::array()}};
    }
    if (!request.contains("expectedWorkspaceRevision") ||
        !request.at("expectedWorkspaceRevision").is_string() || revision.empty() ||
        request.at("expectedWorkspaceRevision") != revision ||
        !request.contains("expectedFingerprint") ||
        !request.at("expectedFingerprint").is_string() ||
        request.at("expectedFingerprint") != plan.at("expectedFingerprint") ||
        !request.contains("expectedSourceGeneration") ||
        !request.at("expectedSourceGeneration").is_string() ||
        request.at("expectedSourceGeneration") != generation)
        return failure("Native reconciliation plan is stale or unverified.");
    if (!request.contains("resolutions") || !request.at("resolutions").is_object() ||
        !request.contains("diskPreconditions") || !request.at("diskPreconditions").is_object())
        return failure("Native reconciliation apply requires resolutions and disk preconditions.");
    const auto& decisions = request.at("resolutions");
    for (const auto& [_, decision] : decisions.items())
        if (!decision.is_string() || decision.get<std::string>().empty())
            return failure("Native reconciliation decisions must be nonempty strings.");
    Json missing = Json::array();
    for (const auto& group : plan.at("groups")) {
        if (!group.at("requiresDecision").get<bool>())
            continue;
        for (const auto& occurrence : group.at("currentOccurrences")) {
            const auto id = occurrence.at("id").get<std::string>();
            if (!decisions.contains(id))
                missing.push_back(id);
        }
    }
    if (!missing.empty()) {
        std::sort(missing.begin(), missing.end());
        return {{"ok", false},
                {"status", "needs-decision"},
                {"plan", plan},
                {"occurrenceIds", missing}};
    }
    const auto synced = synchronize(original, sources);
    Json next = original;
    next["sourceMessageTracking"] = synced.tracking;
    auto all = flatten_current(sources);
    std::map<std::string, Current> by_current;
    for (auto& current : all)
        by_current.emplace(current.identity(), current);
    std::map<std::string, ReconcilePrevious> by_previous;
    for (const auto& previous : reconcile_previous(next))
        by_previous.emplace(previous.occurrence.at("messageId").get<std::string>(), previous);
    std::set<std::string> used_previous;
    std::set<std::string> relinked;
    std::set<std::string> materialized;
    std::set<std::string> orphaned;
    std::set<std::string> collected;
    for (const auto& group : plan.at("groups")) {
        const std::set<std::string> allowed(group.at("previousMessageIds").begin(),
                                            group.at("previousMessageIds").end());
        for (const auto& occurrence : group.at("currentOccurrences")) {
            const auto current_id = occurrence.at("id").get<std::string>();
            const auto found = by_current.find(current_id);
            if (found == by_current.end())
                return failure("Current Message identity changed during reconciliation.");
            const auto& current = found->second;
            const auto selection = decisions.value(current_id, std::string("new"));
            std::string message_id;
            if (selection == "new") {
                message_id = new_message_id(current);
                materialized.insert(message_id);
            } else {
                if (!allowed.contains(selection) || !used_previous.insert(selection).second)
                    return failure("Invalid or reused prior Message resolution.");
                message_id = selection;
                relinked.insert(message_id);
                if (next.at("orphanedMessages").contains(message_id)) {
                    const auto& source = next.at("orphanedMessages").at(message_id);
                    for (const auto& [locale, translation] : source.at("translations").items())
                        next["translations"][locale][message_id] = translation;
                    next["orphanedMessages"].erase(message_id);
                }
            }
            Json entry = next.at("sourceMessageTracking").contains(current.key)
                             ? next.at("sourceMessageTracking").at(current.key)
                             : entry_json(current.source);
            Json occurrences = Json::array();
            for (const auto& prior : entry.at("occurrences"))
                if (prior.at("messageId") != message_id &&
                    prior.at("ordinal") != current.occurrence.ordinal)
                    occurrences.push_back(prior);
            occurrences.push_back(occurrence_json(current, message_id));
            std::sort(occurrences.begin(), occurrences.end(),
                      [](const auto& left, const auto& right) {
                          if (left.at("ordinal") != right.at("ordinal"))
                              return left.at("ordinal") < right.at("ordinal");
                          return left.at("messageId") < right.at("messageId");
                      });
            entry["occurrences"] = std::move(occurrences);
            next["sourceMessageTracking"][current.key] = std::move(entry);
        }
    }
    for (const auto& group : plan.at("groups")) {
        for (const auto& prior_view : group.at("previousOccurrences")) {
            const auto message_id = prior_view.at("messageId").get<std::string>();
            if (used_previous.contains(message_id))
                continue;
            const auto found = by_previous.find(message_id);
            if (found == by_previous.end())
                continue;
            const auto& previous = found->second;
            if (previous.origin == "tracked" &&
                next.at("sourceMessageTracking").contains(previous.source_key)) {
                auto& entry = next["sourceMessageTracking"][previous.source_key];
                Json kept = Json::array();
                for (const auto& occurrence : entry.at("occurrences"))
                    if (occurrence.at("messageId") != message_id)
                        kept.push_back(occurrence);
                if (kept.empty())
                    next["sourceMessageTracking"].erase(previous.source_key);
                else
                    entry["occurrences"] = std::move(kept);
            }
            if (!previous.valuable) {
                if (previous.origin == "orphan")
                    next["orphanedMessages"].erase(message_id);
                collected.insert(message_id);
                continue;
            }
            if (previous.origin == "tracked") {
                Json translations = Json::object();
                for (auto it = next["translations"].begin(); it != next["translations"].end();) {
                    if (it.value().contains(message_id)) {
                        translations[it.key()] = it.value().at(message_id);
                        it.value().erase(message_id);
                    }
                    if (it.value().empty())
                        it = next["translations"].erase(it);
                    else
                        ++it;
                }
                next["orphanedMessages"][message_id] = {
                    {"family", previous.family},
                    {"ownerKey", previous.owner_key},
                    {"sourcePath", previous.source_path},
                    {"sourceSnapshotFingerprint", previous.source_snapshot_fingerprint},
                    {"occurrence", previous.occurrence},
                    {"translations", translations}};
            }
            orphaned.insert(message_id);
        }
    }
    Json result{{"ok", true}, {"status", "applied"}, {"writes", Json::array()}};
    const auto add_ids = [&](const char* key, const auto& ids) {
        result[key] = Json::array();
        for (const auto& id : ids)
            result[key].push_back(id);
    };
    add_ids("relinkedMessageIds", relinked);
    add_ids("materializedMessageIds", materialized);
    add_ids("orphanedMessageIds", orphaned);
    add_ids("garbageCollectedMessageIds", collected);
    if (next == original)
        return result;
    std::vector<RoomPatch> patches;
    std::set<std::string> affected;
    auto compare_records = [&](const Json& before, const Json& after, std::string pointer,
                               auto owner) {
        for (const auto& [key, value] : before.items())
            if (!after.contains(key)) {
                patches.push_back(
                    {RoomPatch::Operation::Remove, pointer + escape_pointer(key), ""});
                affected.insert(owner(key));
            }
        for (const auto& [key, value] : after.items()) {
            const bool existing = before.contains(key);
            if (!existing || before.at(key) != value) {
                patches.push_back(
                    {existing ? RoomPatch::Operation::Replace : RoomPatch::Operation::Add,
                     pointer + escape_pointer(key), value.dump()});
                affected.insert(owner(key));
            }
        }
    };
    compare_records(original.at("sourceMessageTracking"), next.at("sourceMessageTracking"),
                    "/localization/sourceMessageTracking/",
                    [](const std::string&) { return std::string("i18n/tracking.yaml"); });
    compare_records(original.at("orphanedMessages"), next.at("orphanedMessages"),
                    "/localization/orphanedMessages/",
                    [](const std::string&) { return std::string("i18n/orphans.yaml"); });
    std::set<std::string> locales;
    for (const auto& [locale, _] : original.at("translations").items())
        locales.insert(locale);
    for (const auto& [locale, _] : next.at("translations").items())
        locales.insert(locale);
    for (const auto& locale : locales) {
        const auto empty = Json::object();
        const auto& before = original.at("translations").contains(locale)
                                 ? original.at("translations").at(locale)
                                 : empty;
        const auto& after =
            next.at("translations").contains(locale) ? next.at("translations").at(locale) : empty;
        compare_records(
            before, after, "/localization/translations/" + escape_pointer(locale) + "/",
            [&locale](const std::string&) { return "i18n/locales/" + locale + ".yaml"; });
    }
    std::map<std::string, std::string> preconditions;
    for (const auto& owner : affected) {
        if (!request.at("diskPreconditions").contains(owner) ||
            !request.at("diskPreconditions").at(owner).is_string())
            return failure("Missing source revision for reconciliation owner: " + owner);
        const auto expected = request.at("diskPreconditions").at(owner).get<std::string>();
        const auto observed = std::filesystem::is_regular_file(root / owner)
                                  ? exact_source_revision(bytes_at(root / owner))
                                  : std::string("absent");
        if (observed != expected)
            return failure("Stale source revision for reconciliation owner: " + owner);
        preconditions.emplace(owner, expected);
    }
    const auto patched = session.patch(session.snapshot().working_revision, patches, preconditions);
    if (!patched.accepted)
        return failure(patched.error);
    if (!patched.snapshot.valid) {
        Json diagnostics = Json::array();
        for (const auto& issue : patched.snapshot.diagnostics) {
            diagnostics.push_back(
                {{"code", issue.code}, {"path", issue.path}, {"message", issue.message}});
            if (diagnostics.size() == 12)
                break;
        }
        return {{"ok", false},
                {"error", "Native reconciliation would leave an invalid dependent Project; "
                          "no localization source was written."},
                {"diagnostics", diagnostics}};
    }
    std::vector<std::string> owners(affected.begin(), affected.end());
    if (!native_project_source_generation_is_current(root, generation))
        return failure(
            "Native localization source generation changed before reconciliation commit.");
    const auto saved = session.save_owners(patched.snapshot.working_revision, owners, false,
                                           TransactionDecision::KeepComments);
    if (!saved.accepted)
        return failure(saved.error);
    for (const auto& owner : saved.affected_records)
        result["writes"].push_back(owner);
    return result;
}
