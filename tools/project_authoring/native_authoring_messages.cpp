#include "native_authoring_messages.hpp"
#include "tooling_native_project_localization.hpp"
#include "character_archetype_semantics.hpp"
#include "localization_semantics.hpp"

#include <noveltea/core/message_realization.hpp>

#include <algorithm>
#include <cstdint>
#include <cctype>
#include <functional>
#include <optional>
#include <tuple>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& object(const Json& root, std::string_view key)
{
    static const Json empty = Json::object();
    const auto found = root.is_object() ? root.find(std::string(key)) : root.end();
    return found != root.end() && found->is_object() ? *found : empty;
}

const Json& array(const Json& root, std::string_view key)
{
    static const Json empty = Json::array();
    const auto found = root.is_object() ? root.find(std::string(key)) : root.end();
    return found != root.end() && found->is_array() ? *found : empty;
}

std::string escape(std::string_view segment)
{
    std::string result;
    for (char ch : segment) {
        if (ch == '~')
            result += "~0";
        else if (ch == '/')
            result += "~1";
        else
            result += ch;
    }
    return result;
}

// JavaScript uses UTF-16 code units for structuredMessageId's FNV-1a input.
std::string structured_id(std::string_view path)
{
    std::vector<std::uint16_t> units;
    for (std::size_t i = 0; i < path.size();) {
        const auto first = static_cast<unsigned char>(path[i++]);
        std::uint32_t cp = first;
        if (first >= 0xc2 && first <= 0xf4) {
            const auto continuation = first < 0xe0 ? 1u : first < 0xf0 ? 2u : 3u;
            if (i + continuation > path.size())
                throw std::runtime_error("Invalid UTF-8 Message semantic path.");
            cp = first & (continuation == 1 ? 0x1fu : continuation == 2 ? 0x0fu : 0x07u);
            for (unsigned j = 0; j < continuation; ++j) {
                const auto byte = static_cast<unsigned char>(path[i++]);
                if ((byte & 0xc0u) != 0x80u)
                    throw std::runtime_error("Invalid UTF-8 Message semantic path.");
                cp = (cp << 6) | (byte & 0x3fu);
            }
        }
        if (cp <= 0xffff)
            units.push_back(static_cast<std::uint16_t>(cp));
        else {
            cp -= 0x10000;
            units.push_back(static_cast<std::uint16_t>(0xd800u + (cp >> 10)));
            units.push_back(static_cast<std::uint16_t>(0xdc00u + (cp & 0x3ffu)));
        }
    }
    std::string raw;
    constexpr char digits[] = "0123456789abcdef";
    for (const auto seed : {0x811c9dc5u, 0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u}) {
        std::uint32_t hash = seed;
        for (const auto unit : units)
            hash = (hash ^ unit) * 0x01000193u;
        for (int shift = 28; shift >= 0; shift -= 4)
            raw += digits[(hash >> shift) & 0xfu];
    }
    auto hex = raw.substr(0, 8) + "-" + raw.substr(8, 4) + "-5" + raw.substr(13, 3) + "-";
    const auto variant = static_cast<unsigned>(std::stoul(raw.substr(16, 2), nullptr, 16));
    hex += digits[((variant & 0x3fu) | 0x80u) >> 4];
    hex += digits[variant & 0xfu];
    return hex + raw.substr(18, 2) + "-" + raw.substr(20, 12);
}

struct Message {
    std::string stable_id;
    std::string source;
    std::string path;
    Json authored;
    Json markup = "plain";
    Json cues;
};

void register_message(std::map<std::string, Message>& messages, const Json& localization,
                      std::string path, std::string value, Json markup = "plain")
{
    const auto& tracked = object(localization, "structuredMessageIds");
    const auto stable_id =
        tracked.contains(path) ? tracked.at(path).get<std::string>() : structured_id(path);
    const auto inserted =
        messages.emplace(stable_id, Message{stable_id, std::move(value), path, {}, markup});
    if (!inserted.second)
        throw std::runtime_error("Colliding structured Message identity at '" + path + "'.");
}

void visit(const Json& value, std::string path, const Json& localization,
           std::map<std::string, Message>& messages)
{
    if (value.is_object()) {
        if ((value.value("markup", "") == "plain" || value.value("markup", "") == "active-text") &&
            object(value, "source").value("kind", "") == "inline") {
            register_message(messages, localization, std::move(path),
                             object(value, "source").at("text").get<std::string>(),
                             value.at("markup"));
            return;
        }
        for (const auto& [name, child] : value.items())
            visit(child, path + "/" + escape(name), localization, messages);
    } else if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i) {
            const auto& child = value.at(i);
            const auto token = child.is_object() && child.contains("id") &&
                                       child["id"].is_string() &&
                                       !child["id"].get<std::string>().empty()
                                   ? "@" + escape(child["id"].get<std::string>())
                                   : std::to_string(i);
            visit(child, path + "/" + token, localization, messages);
        }
    }
}

void register_record(const Json& data, const std::string& base, const Json& localization,
                     std::map<std::string, Message>& messages)
{
    if (data.contains("displayName") && data.at("displayName").is_string())
        register_message(messages, localization, base + "/displayName",
                         data.at("displayName").get<std::string>());
    const auto& dialogue = object(data, "dialogue");
    if (dialogue.contains("name") && dialogue["name"].is_string())
        register_message(messages, localization, base + "/dialogue/name",
                         dialogue.at("name").get<std::string>());
    const auto& exits = array(data, "exits");
    for (std::size_t i = 0; i < exits.size(); ++i) {
        const auto& exit = exits.at(i);
        if (!exit.is_object() || !exit.contains("label") || !exit["label"].is_string())
            continue;
        const auto token =
            exit.contains("id") && exit["id"].is_string() && !exit["id"].get<std::string>().empty()
                ? "@" + escape(exit["id"].get<std::string>())
                : std::to_string(i);
        register_message(messages, localization, base + "/exits/" + token + "/label",
                         exit.at("label").get<std::string>());
    }
    visit(data, base, localization, messages);
}

Json placeholder_arguments(const std::string& value)
{
    // An escaped '{{' starts no placeholder. The authoring validator already
    // constrains this grammar, but lowering must preserve its exact interpretation.
    std::set<std::string> names;
    static const std::regex name_pattern("^[A-Za-z_][A-Za-z0-9_-]*$");
    for (std::size_t i = 0; i < value.size(); ++i) {
        if (value[i] != '{')
            continue;
        if (i + 1 < value.size() && value[i + 1] == '{') {
            ++i;
            continue;
        }
        const auto close = value.find('}', i + 1);
        if (close == std::string::npos)
            continue;
        const auto name = value.substr(i + 1, close - i - 1);
        if (std::regex_match(name, name_pattern))
            names.insert(name);
        i = close;
    }
    Json result = Json::array();
    for (const auto& name : names)
        result.push_back({{"name", name}, {"type", "printable"}});
    return result;
}

int append_pattern(const Json& pattern, Json& nodes)
{
    const auto index = static_cast<int>(nodes.size());
    nodes.push_back({{"kind", "text"}, {"text", ""}});
    const auto kind = pattern.at("kind").get<std::string>();
    if (kind == "text") {
        nodes[index] = {{"kind", "text"}, {"text", pattern.at("text")}};
    } else {
        Json cases = Json::array();
        for (const auto& [name, child] : pattern.at("cases").items())
            cases.push_back({{"key", name}, {"node", append_pattern(child, nodes)}});
        nodes[index] = {
            {"kind", kind}, {"argument", pattern.at("argument")}, {"cases", std::move(cases)}};
    }
    return index;
}

Json lower_pattern(const Json& pattern)
{
    Json nodes = Json::array();
    const auto root = append_pattern(pattern, nodes);
    return {{"root", root}, {"nodes", std::move(nodes)}};
}

std::string named_stable_id(const Json& project, std::string_view key)
{
    for (const auto& [stable_id, message] :
         object(object(project, "localization"), "messages").items()) {
        if (message.value("kind", "") == "named" && message.value("key", "") == key)
            return stable_id;
    }
    throw std::runtime_error("Named Message '" + std::string(key) + "' was not admitted.");
}

std::string array_token(const Json& item, std::size_t index)
{
    return item.is_object() && item.contains("id") && item.at("id").is_string() &&
                   !item.at("id").get<std::string>().empty()
               ? "@" + escape(item.at("id").get<std::string>())
               : std::to_string(index);
}

std::size_t utf16_to_byte(std::string_view source, std::size_t units)
{
    std::size_t consumed = 0;
    for (std::size_t offset = 0; offset < source.size();) {
        if (consumed >= units)
            return offset;
        const auto byte = static_cast<unsigned char>(source[offset]);
        const auto width = byte < 0x80 ? 1u : byte < 0xe0 ? 2u : byte < 0xf0 ? 3u : 4u;
        offset += width;
        consumed += width == 4 ? 2 : 1;
        if (consumed > units)
            throw std::runtime_error("Managed Lua edit splits a UTF-16 surrogate pair.");
    }
    if (consumed != units)
        throw std::runtime_error("Managed Lua edit exceeds the source length.");
    return source.size();
}

std::string preserve_newlines(std::string_view original, std::string replacement)
{
    const auto count = [](std::string_view input) {
        std::size_t lines = 0;
        for (std::size_t i = 0; i < input.size(); ++i)
            if (input[i] == '\n' ||
                (input[i] == '\r' && (i + 1 == input.size() || input[i + 1] != '\n')))
                ++lines;
        return lines;
    };
    const auto old_count = count(original);
    const auto new_count = count(replacement);
    if (old_count > new_count)
        replacement.append(old_count - new_count, '\n');
    return replacement;
}

std::string tracked_id(const Json& localization,
                       const authoring::NativeLocalizationTrackingSource& source,
                       const authoring::NativeLocalizationTrackingOccurrence& occurrence)
{
    const std::string source_key =
        source.family + ":" + source.owner_key + ":" + source.source_path;
    const auto& entry = object(localization.at("sourceMessageTracking"), source_key);
    const auto fingerprint_matches =
        [&](const authoring::NativeLocalizationTrackingOccurrence& input) {
            std::vector<std::string> both, structural, anchor;
            for (const auto& prior : array(entry, "occurrences")) {
                const bool same_structure =
                    prior.at("structuralFingerprint") == input.structural_fingerprint;
                const bool same_anchor = prior.at("anchorFingerprint") == input.anchor_fingerprint;
                if (same_structure && same_anchor)
                    both.push_back(prior.at("messageId").get<std::string>());
                if (same_structure)
                    structural.push_back(prior.at("messageId").get<std::string>());
                if (same_anchor)
                    anchor.push_back(prior.at("messageId").get<std::string>());
            }
            if (both.size() == 1)
                return both;
            if (structural.size() == 1)
                return structural;
            if (anchor.size() == 1)
                return anchor;
            return std::vector<std::string>{};
        };
    if (!entry.empty()) {
        const auto matches = fingerprint_matches(occurrence);
        if (matches.size() == 1) {
            const auto count = std::count_if(
                source.occurrences.begin(), source.occurrences.end(), [&](const auto& candidate) {
                    const auto found = fingerprint_matches(candidate);
                    return found.size() == 1 && found.front() == matches.front();
                });
            if (count == 1)
                return matches.front();
        }
        if (entry.value("sourceSnapshotFingerprint", "") == source.source_snapshot_fingerprint) {
            std::vector<std::string> by_ordinal;
            for (const auto& prior : array(entry, "occurrences"))
                if (prior.at("ordinal") == occurrence.ordinal)
                    by_ordinal.push_back(prior.at("messageId").get<std::string>());
            if (by_ordinal.size() == 1)
                return by_ordinal.front();
        }
    }
    const auto seed = "source-message|" + source.family + "|" + source.owner_key + "|" +
                      source.source_path + "|" + occurrence.structural_fingerprint + "|" +
                      occurrence.anchor_fingerprint + "|" + occurrence.source_fingerprint + "|" +
                      std::to_string(occurrence.ordinal);
    return structured_id(seed);
}

struct ManagedSource {
    std::string path;
    std::string source;
    authoring::SourceAnalysis analyzed;
    std::vector<std::string> stable_ids;
};

struct RmlSource {
    std::string path;
    std::string source;
    authoring::SourceAnalysis analyzed;
    std::vector<std::string> stable_ids;
};

void add_managed_sources(const Json& original, const Json& localization,
                         std::map<std::string, Message>& messages,
                         std::vector<ManagedSource>& lua_sources,
                         std::vector<RmlSource>& rml_sources)
{
    // Inspect known execution surfaces only. A free-form string elsewhere in
    // authoring data is never Lua merely because it contains a Text token.
    const auto inspect_lua = [&](const std::string& path, const std::string& owner_key,
                                 const std::string& source) {
        const auto analysis = authoring::analyze_project_text("authoring:inline-lua.lua", source);
        if (!analysis.complete)
            throw std::runtime_error("at " + path + ": Managed Lua source analysis incomplete.");
        for (const auto& diagnostic : analysis.diagnostics)
            if (diagnostic.severity == "error")
                throw std::runtime_error("at " + path + ": " + diagnostic.message);
        const auto tracking =
            authoring::native_localization_tracking_source(analysis, "lua", owner_key, path);
        ManagedSource item{path, source, analysis, {}};
        std::size_t tracked_ordinal = 0;
        for (const auto& occurrence : analysis.messages) {
            if (!occurrence.lua_call)
                continue;
            // Native tracking candidates include named occurrences as well as
            // local ones, exactly as the reference's occurrence ordinal does.
            const auto ordinal = tracked_ordinal++;
            if (occurrence.kind == "named") {
                const auto stable_id = named_stable_id(original, occurrence.source);
                const auto& named = object(localization, "messages").at(stable_id);
                std::vector<std::string> expected_arguments;
                for (const auto& [name, type] : object(named, "arguments").items()) {
                    (void)type;
                    expected_arguments.push_back(name);
                }
                if (!expected_arguments.empty() && !occurrence.has_runtime_arguments)
                    throw std::runtime_error("at " + path +
                                             ": Text.msg requires runtime Message arguments.");
                if (occurrence.runtime_argument_names &&
                    *occurrence.runtime_argument_names != expected_arguments)
                    throw std::runtime_error(
                        "at " + path +
                        ": Text.msg runtime arguments do not match the named Message.");
                item.stable_ids.push_back(stable_id);
                continue;
            }
            if (ordinal >= tracking.occurrences.size())
                throw std::runtime_error("Managed Lua source lost tracking at '" + path + "'.");
            const auto& candidate = tracking.occurrences.at(ordinal);
            const auto id = tracked_id(localization, tracking, candidate);
            Json authored{{"kind", "local"}, {"source", occurrence.source}};
            if (occurrence.kind == "plural" || occurrence.kind == "select") {
                authored["arguments"] = {
                    {"value", occurrence.kind == "plural" ? "plural-number" : "string"}};
                authored["pattern"] = {
                    {"kind", occurrence.kind}, {"argument", "value"}, {"cases", Json::object()}};
                for (const auto& [key, value] : occurrence.cases)
                    authored["pattern"]["cases"][key] = {{"kind", "text"}, {"text", value}};
            } else {
                const auto placeholders = placeholder_arguments(occurrence.source);
                if (!placeholders.empty() && !occurrence.has_runtime_arguments)
                    throw std::runtime_error("Text.tr source requires runtime arguments at '" +
                                             path + "'.");
                if (!placeholders.empty()) {
                    authored["arguments"] = Json::object();
                    for (const auto& argument : placeholders)
                        authored["arguments"][argument.at("name").get<std::string>()] = "printable";
                }
            }
            const auto result =
                messages.emplace(id, Message{id, occurrence.source, "", std::move(authored)});
            if (!result.second)
                throw std::runtime_error("Managed Lua Message identity collision at '" + path +
                                         "'.");
            item.stable_ids.push_back(id);
        }
        if (!item.stable_ids.empty())
            lua_sources.push_back(std::move(item));
    };

    std::set<std::string> seen;
    const auto scan_strings = [&](const auto& self, const Json& value, const std::string& path,
                                  const std::string& owner) -> void {
        if (value.is_object()) {
            for (const auto& [key, child] : value.items())
                self(self, child, path + "/" + escape(key), owner);
        } else if (value.is_array()) {
            for (std::size_t i = 0; i < value.size(); ++i)
                self(self, value.at(i), path + "/" + std::to_string(i), owner);
        } else if (value.is_string() &&
                   (path.ends_with("/source") || path.ends_with("/sourceText")) &&
                   !path.ends_with("/rml/sourceText") && !path.ends_with("/rcss/sourceText") &&
                   seen.insert(path).second) {
            inspect_lua(path, owner, value.get<std::string>());
        }
    };
    for (const auto* family : {"scripts", "layouts", "rooms", "scenes", "dialogues", "verbs",
                               "interactions", "maps", "tests"}) {
        for (const auto& [id, record] : object(original, family).items()) {
            const auto owner = "record:" + std::string(family) + ":" + id;
            scan_strings(scan_strings, object(record, "data"),
                         "/" + std::string(family) + "/" + escape(id) + "/data", owner);
        }
    }
    for (const auto& [id, record] : object(original, "layouts").items()) {
        const auto& rml = object(object(record, "data"), "rml");
        if (rml.value("sourceMode", "") != "inline")
            continue;
        const auto source = rml.at("sourceText").get<std::string>();
        const auto path = "/layouts/" + escape(id) + "/data/rml/sourceText";
        const auto analysis = authoring::analyze_project_text("authoring:inline-rml.rml", source);
        if (!analysis.complete)
            throw std::runtime_error("Malformed RML localization at '" + path + "'.");
        const auto tracking = authoring::native_localization_tracking_source(
            analysis, "rml", "record:layouts:" + id, path);
        RmlSource lowered{path, source, analysis, {}};
        std::size_t ordinal = 0;
        for (const auto& call : analysis.messages) {
            if (call.lua_call)
                continue;
            if (call.kind == "named") {
                if (core::system_message_id(call.source))
                    lowered.stable_ids.push_back("system:" + call.source);
                else
                    lowered.stable_ids.push_back(named_stable_id(original, call.source));
                continue;
            }
            if (ordinal >= tracking.occurrences.size())
                throw std::runtime_error("RML source lost tracked Message candidate at '" + path +
                                         "'.");
            const auto& occurrence = tracking.occurrences.at(ordinal++);
            const auto stable_id = tracked_id(localization, tracking, occurrence);
            Json arguments = Json::object();
            for (const auto& item : placeholder_arguments(occurrence.source_snapshot))
                arguments[item.at("name").get<std::string>()] = item.at("type");
            Json authored = Json::object();
            if (!arguments.empty())
                authored["arguments"] = std::move(arguments);
            const auto inserted = messages.emplace(
                stable_id, Message{stable_id, occurrence.source_snapshot, "", std::move(authored)});
            if (!inserted.second)
                throw std::runtime_error("RML localized Message identity collision at '" + path +
                                         "'.");
            lowered.stable_ids.push_back(stable_id);
        }
        if (!lowered.stable_ids.empty())
            rml_sources.push_back(std::move(lowered));
    }
}

void set_pointer(Json& root, std::string_view pointer, const std::string& value)
{
    auto& target = root[Json::json_pointer(std::string(pointer))];
    if (!target.is_string())
        throw std::runtime_error("Managed Lua source path no longer resolves to a string.");
    target = value;
}

Json rewrite_managed_sources(Json& project, const std::vector<ManagedSource>& sources,
                             const Json& ids)
{
    Json rewrites = Json::object();
    struct Edit {
        std::size_t begin, end;
        std::string replacement;
    };
    for (const auto& source : sources) {
        std::vector<Edit> edits;
        std::size_t ordinal = 0;
        const auto add = [&](std::size_t start, std::size_t finish, std::string replacement) {
            const auto begin = utf16_to_byte(source.source, start);
            const auto end = utf16_to_byte(source.source, finish);
            edits.push_back(
                {begin, end,
                 preserve_newlines(std::string_view(source.source).substr(begin, end - begin),
                                   std::move(replacement))});
        };
        for (const auto& occurrence : source.analyzed.messages) {
            if (!occurrence.lua_call)
                continue;
            const auto id = ids.at(source.stable_ids.at(ordinal++)).get<std::uint32_t>();
            add(occurrence.member_start_utf16, occurrence.member_end_utf16, "__message");
            if (occurrence.kind == "plural" || occurrence.kind == "select") {
                if (!occurrence.selector_start_utf16 || !occurrence.selector_end_utf16 ||
                    !occurrence.cases_end_utf16)
                    throw std::runtime_error("Managed Lua selector spans are unavailable.");
                add(*occurrence.selector_start_utf16, *occurrence.selector_start_utf16,
                    std::to_string(id) + ", { value = ");
                add(*occurrence.selector_end_utf16, *occurrence.cases_end_utf16, " }");
            } else {
                if (!occurrence.source_start_utf16 || !occurrence.source_end_utf16)
                    throw std::runtime_error("Managed Lua Message literal span is unavailable.");
                add(*occurrence.source_start_utf16, *occurrence.source_end_utf16,
                    std::to_string(id));
            }
            if (occurrence.metadata_start_utf16 && occurrence.metadata_end_utf16)
                add(*occurrence.metadata_start_utf16, *occurrence.metadata_end_utf16, "nil");
        }
        std::sort(edits.begin(), edits.end(), [](const Edit& a, const Edit& b) {
            return a.begin > b.begin || (a.begin == b.begin && a.end > b.end);
        });
        std::string lowered = source.source;
        std::size_t previous = source.source.size() + 1;
        for (const auto& edit : edits) {
            if (edit.end > previous)
                throw std::runtime_error("Overlapping managed Lua edits at '" + source.path + "'.");
            lowered.replace(edit.begin, edit.end - edit.begin, edit.replacement);
            previous = edit.begin;
        }
        set_pointer(project, source.path, lowered);
        rewrites[source.path] = lowered;
    }
    return rewrites;
}

Json rewrite_rml_sources(Json& project, const std::vector<RmlSource>& sources, const Json& ids)
{
    Json rewrites = Json::object();
    static const std::regex key_attribute(R"(\bkey\s*=\s*("[^"]*"|'[^']*'|[^\s/>]+))",
                                          std::regex::icase);
    for (const auto& source : sources) {
        struct Edit {
            std::size_t begin, end;
            std::string replacement;
        };
        std::vector<Edit> edits;
        std::size_t ordinal = 0;
        for (const auto& occurrence : source.analyzed.messages) {
            if (occurrence.lua_call)
                continue;
            const auto stable = source.stable_ids.at(ordinal++);
            const auto numeric = stable.starts_with("system:")
                                     ? core::system_message_id(stable.substr(7)).value()
                                     : ids.at(stable).get<std::uint32_t>();
            if (!occurrence.rml_open_end_utf16 || !occurrence.rml_content_end_utf16)
                throw std::runtime_error("RML Message source spans are unavailable at '" +
                                         source.path + "'.");
            const auto start = utf16_to_byte(source.source, occurrence.call_start_utf16);
            const auto open_end = utf16_to_byte(source.source, *occurrence.rml_open_end_utf16);
            const auto finish = utf16_to_byte(source.source, occurrence.call_end_utf16);
            if (open_end <= start || finish < open_end)
                throw std::runtime_error("Malformed RML Message source range at '" + source.path +
                                         "'.");
            const auto body =
                std::string_view(source.source)
                    .substr(open_end,
                            utf16_to_byte(source.source, *occurrence.rml_content_end_utf16) -
                                open_end);
            if (body.find("<nt-tr") != std::string_view::npos)
                throw std::runtime_error("Nested RML Messages are unsupported at '" + source.path +
                                         "'.");
            std::string opening = source.source.substr(start, open_end - start);
            if (occurrence.kind == "named")
                opening = std::regex_replace(opening, key_attribute, "");
            opening.pop_back(); // closing '>'
            while (!opening.empty() && std::isspace(static_cast<unsigned char>(opening.back())))
                opening.pop_back();
            if (!opening.empty() && opening.back() == '/') {
                opening.pop_back();
                while (!opening.empty() && std::isspace(static_cast<unsigned char>(opening.back())))
                    opening.pop_back();
            }
            edits.push_back(
                {start, finish, opening + " message=\"" + std::to_string(numeric) + "\"></nt-tr>"});
        }
        std::sort(edits.begin(), edits.end(),
                  [](const Edit& a, const Edit& b) { return a.begin > b.begin; });
        std::string lowered = source.source;
        for (const auto& edit : edits)
            lowered.replace(edit.begin, edit.end - edit.begin, edit.replacement);
        set_pointer(project, source.path, lowered);
        rewrites[source.path] = lowered;
    }
    return rewrites;
}

void collect_dialogue_cues(const Json& project, const Json& localization,
                           std::map<std::string, Message>& messages)
{
    // Each named Message may occur at multiple dialogue sites. The first
    // lexically ordered semantic path with cues owns its source cue contract.
    std::map<std::string, Json> by_path;
    for (const auto& [id, record] : object(project, "dialogues").items()) {
        const auto& blocks = array(object(record, "data"), "blocks");
        for (std::size_t b = 0; b < blocks.size(); ++b) {
            const auto& block = blocks.at(b);
            if (!block.is_object() || block.value("type", "") != "sequence")
                continue;
            const auto& segments = array(block, "segments");
            for (std::size_t s = 0; s < segments.size(); ++s) {
                const auto& segment = segments.at(s);
                if (!segment.is_object() || segment.value("type", "") != "line")
                    continue;
                const auto& text = object(segment, "text");
                const auto& source = object(text, "source");
                const auto path = "/dialogues/" + escape(id) + "/data/blocks/" +
                                  array_token(block, b) + "/segments/" + array_token(segment, s) +
                                  "/text";
                std::string stable_id;
                if (source.value("kind", "") == "inline") {
                    stable_id = object(localization, "structuredMessageIds")
                                    .value(path, structured_id(path));
                } else if (source.value("kind", "") == "localized") {
                    stable_id = named_stable_id(project, source.at("key").get<std::string>());
                } else {
                    continue;
                }
                Json placements = Json::array();
                for (const auto& cue : array(segment, "cues")) {
                    if (!cue.is_object() || cue.value("kind", "") == "active-text" ||
                        cue.value("kind", "") == "invalid-markup")
                        continue;
                    placements.push_back({{"id", cue.at("id")}, {"position", cue.at("position")}});
                }
                std::sort(placements.begin(), placements.end(), [](const Json& a, const Json& b) {
                    const auto& lhs = a.at("position");
                    const auto& rhs = b.at("position");
                    return std::tuple(lhs.at("offset").get<int>(), lhs.at("order").get<int>(),
                                      a.at("id").get<std::string>()) <
                           std::tuple(rhs.at("offset").get<int>(), rhs.at("order").get<int>(),
                                      b.at("id").get<std::string>());
                });
                if (!placements.empty())
                    by_path[path] = {{"stableId", stable_id}, {"cues", std::move(placements)}};
            }
        }
    }
    for (const auto& [path, usage] : by_path) {
        const auto id = usage.at("stableId").get<std::string>();
        if (auto it = messages.find(id); it != messages.end() && it->second.cues.is_null())
            it->second.cues = usage.at("cues");
    }
}
} // namespace

NativeMessageProjection lower_authoring_messages(const Json& project)
{
    const auto& localization = object(project, "localization");
    std::map<std::string, Message> messages;
    for (const auto& [id, value] : object(localization, "messages").items())
        messages.emplace(id, Message{id, value.at("source").get<std::string>(), "", value});

    const authoring::AuthoringRecordResolver record_resolver =
        [&](std::string_view family, std::string_view id) -> std::optional<std::string> {
        const auto& records = object(project, family);
        const auto it = records.find(std::string(id));
        return it == records.end() ? std::nullopt : std::optional<std::string>(it->dump());
    };
    for (const auto* family : {"characters", "rooms", "interactables", "dialogues", "scenes",
                               "verbs", "interactions", "maps"}) {
        for (const auto& [id, record] : object(project, family).items()) {
            Json resolved;
            if (record.contains("archetype") && !record.at("archetype").is_null()) {
                const auto effective =
                    authoring::validate_archetype_owner(family, record.dump(), record_resolver);
                if (!effective.accepted || effective.effective_json.empty())
                    throw std::runtime_error("Admitted archetype owner could not be lowered at /" +
                                             std::string(family) + "/" + escape(id));
                resolved = Json::parse(effective.effective_json);
            }
            const auto& data =
                resolved.is_object() ? object(resolved, "data") : object(record, "data");
            const auto base = "/" + std::string(family) + "/" + escape(id) + "/data";
            register_record(data, base, localization, messages);
        }
    }
    for (const auto& [id, record] : object(project, "archetypes").items()) {
        const auto effective =
            authoring::validate_archetype_dependencies(id, record.dump(), record_resolver);
        if (!effective.accepted || effective.effective_json.empty())
            throw std::runtime_error("Admitted archetype could not be lowered at /archetypes/" +
                                     escape(id));
        const auto resolved = Json::parse(effective.effective_json);
        register_record(object(resolved, "data"), "/archetypes/" + escape(id) + "/configuration",
                        localization, messages);
    }
    const auto& settings = object(object(project, "settings"), "titleScreen");
    for (const auto* name : {"subtitle", "startLabel"})
        register_message(messages, localization, std::string("/settings/titleScreen/") + name,
                         settings.at(name).get<std::string>());
    visit(project.at("undefinedInteractionProgram"), "/undefinedInteractionProgram", localization,
          messages);
    collect_dialogue_cues(project, localization, messages);
    std::vector<ManagedSource> lua_sources;
    std::vector<RmlSource> rml_sources;
    add_managed_sources(project, localization, messages, lua_sources, rml_sources);

    std::vector<std::string> ordered;
    std::vector<std::string> settings_ids;
    for (const auto& [id, message] : messages) {
        if (message.path.starts_with("/settings/"))
            settings_ids.push_back(id);
        else
            ordered.push_back(id);
    }
    ordered.insert(ordered.end(), settings_ids.begin(), settings_ids.end());
    NativeMessageProjection output{Json::object(), Json::array(),  Json::object(), Json::object(),
                                   project,        Json::object(), Json::object()};
    for (const auto& source : rml_sources) {
        std::size_t ordinal = 0;
        for (const auto& occurrence : source.analyzed.messages) {
            if (occurrence.lua_call)
                continue;
            const auto& id = source.stable_ids.at(ordinal++);
            if (occurrence.kind == "named")
                continue;
            output.rml_workflow_fingerprints[id] =
                native_authoring_rml_semantic_fingerprint(occurrence.source);
        }
    }
    for (const auto& source : lua_sources)
        for (const auto& id : source.stable_ids)
            if (!object(localization, "messages").contains(id))
                output.managed_lua_local_ids.push_back(id);
    std::uint32_t next_id = 0;
    for (const auto& id : ordered) {
        const auto& message = messages.at(id);
        const auto& authored = message.authored;
        const auto fixed = authored.is_object() && authored.value("kind", "") == "named"
                               ? core::system_message_id(authored.value("key", ""))
                               : std::nullopt;
        const auto number = fixed ? *fixed : next_id++;
        output.ids[id] = number;

        Json entry{{"messageId", number}, {"value", message.source}};
        Json args = Json::array();
        if (authored.is_object() && authored.contains("arguments")) {
            for (const auto& [name, type] : authored.at("arguments").items())
                args.push_back({{"name", name}, {"type", type}});
        } else if (!message.path.empty()) {
            args = placeholder_arguments(message.source);
        }
        if (!args.empty())
            entry["arguments"] = args;
        if (authored.is_object() && authored.contains("pattern"))
            entry["pattern"] = lower_pattern(authored.at("pattern"));
        if (!message.cues.is_null())
            entry["dialogueCues"] = message.cues;
        output.source_entries.push_back(std::move(entry));
        if (!message.path.empty())
            output.compiled_texts[message.path] = {
                {"markup", message.markup}, {"source", {{"kind", "message"}, {"id", number}}}};
    }
    for (const auto& [locale, definition] : object(localization, "locales").items()) {
        Json entries = Json::array();
        if (locale == localization.at("sourceLocale")) {
            entries = output.source_entries;
        } else {
            for (std::size_t i = 0; i < ordered.size(); ++i) {
                const auto& id = ordered[i];
                std::string current = locale;
                std::set<std::string> visited;
                const Json* translation = nullptr;
                while (current != localization.at("sourceLocale") &&
                       visited.insert(current).second) {
                    const auto& translations =
                        object(object(localization, "translations"), current);
                    if (translations.contains(id)) {
                        translation = &translations.at(id);
                        break;
                    }
                    const auto& parent = object(object(localization, "locales"), current);
                    if (!parent.contains("parentLocale") || parent.at("parentLocale").is_null())
                        break;
                    current = parent.at("parentLocale").get<std::string>();
                }
                if (!translation || translation->contains("useSource"))
                    continue;
                Json entry{{"messageId", output.ids.at(id)}, {"value", translation->at("text")}};
                const auto& original = output.source_entries.at(i);
                if (original.contains("arguments"))
                    entry["arguments"] = original.at("arguments");
                if (translation->contains("pattern"))
                    entry["pattern"] = lower_pattern(translation->at("pattern"));
                if (translation->contains("dialogueCues"))
                    entry["dialogueCues"] = translation->at("dialogueCues");
                entries.push_back(std::move(entry));
            }
        }
        output.translated_entries[locale] = std::move(entries);
    }
    output.rewritten_sources =
        rewrite_managed_sources(output.lowered_project, lua_sources, output.ids);
    output.rewritten_rml = rewrite_rml_sources(output.lowered_project, rml_sources, output.ids);
    // Expose compiled text references for the same schema-owned text surfaces
    // that downstream definition lowering will consume. This remains a
    // nonpublishable projection, with its semantic owner paths retained.
    const std::function<void(const Json&, const std::string&)> collect_text =
        [&](const Json& value, const std::string& path) {
            if (value.is_object()) {
                const auto& source = object(value, "source");
                if ((value.value("markup", "") == "plain" ||
                     value.value("markup", "") == "active-text") &&
                    (source.value("kind", "") == "inline" ||
                     source.value("kind", "") == "localized" ||
                     source.value("kind", "") == "lua-expression")) {
                    output.compiled_texts[path] =
                        lower_authoring_text(project, output, value, path);
                    return;
                }
                for (const auto& [key, child] : value.items())
                    collect_text(child, path + "/" + escape(key));
            } else if (value.is_array()) {
                for (std::size_t i = 0; i < value.size(); ++i)
                    collect_text(value.at(i), path + "/" + array_token(value.at(i), i));
            }
        };
    for (const auto* family : {"characters", "rooms", "interactables", "dialogues", "scenes",
                               "verbs", "interactions", "maps"})
        for (const auto& [id, record] : object(output.lowered_project, family).items())
            collect_text(object(record, "data"),
                         "/" + std::string(family) + "/" + escape(id) + "/data");
    collect_text(output.lowered_project.at("undefinedInteractionProgram"),
                 "/undefinedInteractionProgram");
    return output;
}

Json lower_authoring_text(const Json& project, const NativeMessageProjection& messages,
                          const Json& text, std::string_view semantic_path)
{
    const auto& source = text.at("source");
    if (source.at("kind") == "lua-expression")
        return {{"markup", text.at("markup")},
                {"source", {{"kind", "lua-expression"}, {"source", source.at("source")}}}};
    if (source.at("kind") == "localized") {
        const auto key = source.at("key").get<std::string>();
        if (const auto system = core::system_message_id(key))
            return {{"markup", text.at("markup")},
                    {"source", {{"kind", "message"}, {"id", *system}}}};
    }
    const auto stable_id =
        source.at("kind") == "localized"
            ? named_stable_id(project, source.at("key").get<std::string>())
            : object(object(project, "localization"), "structuredMessageIds")
                  .value(std::string(semantic_path), structured_id(semantic_path));
    if (!messages.ids.contains(stable_id))
        throw std::runtime_error("Message at '" + std::string(semantic_path) + "' is unresolved.");
    return {{"markup", text.at("markup")},
            {"source", {{"kind", "message"}, {"id", messages.ids.at(stable_id)}}}};
}

Json lower_authoring_message_value(const Json& project, const NativeMessageProjection& messages,
                                   const Json& value)
{
    if (!value.is_object() || !value.contains("$message"))
        return value;
    const auto key = value.at("$message").get<std::string>();
    if (const auto fixed = core::system_message_id(key))
        return {{"kind", "message"}, {"id", *fixed}};
    const auto id = named_stable_id(project, key);
    if (!messages.ids.contains(id))
        throw std::runtime_error("Message Variable references unresolved '" + key + "'.");
    return {{"kind", "message"}, {"id", messages.ids.at(id)}};
}

} // namespace noveltea::cli
