#include "localization_semantics.hpp"

#include "localization_operations.hpp"
#include "character_archetype_semantics.hpp"
#include "room_session.hpp"
#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <map>
#include <regex>
#include <sstream>
#include <set>
#include <stdexcept>
#include <string_view>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

std::string escape(std::string_view name)
{
    std::string result;
    for (const auto c : name) {
        if (c == '/')
            result += "~1";
        else if (c == '~')
            result += "~0";
        else
            result += c;
    }
    return result;
}

void add(ValidationResult& result, std::string path, std::string code, std::string message,
         std::string source)
{
    Diagnostic issue{std::move(path), std::move(code), std::move(message)};
    issue.source_path = std::move(source);
    result.diagnostics.push_back(std::move(issue));
}

std::string owner_for_path(std::string_view path)
{
    if (path.starts_with("/localization/translations/")) {
        auto locale = path.substr(sizeof("/localization/translations/") - 1);
        locale = locale.substr(0, locale.find('/'));
        return "i18n/locales/" + std::string(locale) + ".yaml";
    }
    if (path.starts_with("/localization/assets/")) {
        auto locale = path.substr(sizeof("/localization/assets/") - 1);
        locale = locale.substr(0, locale.find('/'));
        return "i18n/assets/" + std::string(locale) + ".yaml";
    }
    if (path.starts_with("/localization/messages/") ||
        path.starts_with("/localization/structuredMessageIds/"))
        return "i18n/messages.yaml";
    if (path.starts_with("/localization/usageNotes/"))
        return "i18n/usage-notes.yaml";
    if (path.starts_with("/localization/sourceMessageTracking/"))
        return "i18n/tracking.yaml";
    if (path.starts_with("/localization/orphanedMessages/"))
        return "i18n/orphans.yaml";
    return "i18n/project.yaml";
}

std::string derived_message_id(std::string_view path)
{
    // Same four seeded FNV-1a words as structuredMessageId() in the TS oracle.
    // Source paths are semantic JSON pointers, not display text.
    std::string raw;
    for (const std::uint32_t seed : {0x811c9dc5u, 0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u}) {
        auto hash = seed;
        for (const auto c : path) {
            hash ^= static_cast<unsigned char>(c);
            hash *= 0x01000193u;
        }
        std::ostringstream hex;
        hex << std::hex << std::setfill('0') << std::setw(8) << hash;
        raw += hex.str();
    }
    const auto version = raw.substr(0, 8) + "-" + raw.substr(8, 4) + "-5" + raw.substr(13, 3) + "-";
    const auto variant = (std::stoul(raw.substr(16, 2), nullptr, 16) & 0x3fu) | 0x80u;
    std::ostringstream result;
    result << version << std::hex << std::setfill('0') << std::setw(2) << variant
           << raw.substr(18, 2) << "-" << raw.substr(20, 12);
    return result.str();
}

void collect_structured_sources(const Json& value, const std::string& path,
                                std::map<std::string, std::string>& messages)
{
    if (value.is_object()) {
        if (value.contains("markup") &&
            (value.at("markup") == "plain" || value.at("markup") == "active-text") &&
            value.contains("source") && value.at("source").is_object()) {
            const auto& source = value.at("source");
            if (source.contains("kind") && source.at("kind") == "inline" &&
                source.contains("text") && source.at("text").is_string()) {
                messages.emplace(path, source.at("text").as<std::string>());
                return;
            }
        }
        for (const auto& entry : value.object_range())
            collect_structured_sources(entry.value(), path + "/" + escape(entry.key()), messages);
    } else if (value.is_array()) {
        for (std::size_t i = 0; i < value.size(); ++i) {
            const auto& child = value.at(i);
            const auto key = child.is_object() && child.contains("id") &&
                                     child.at("id").is_string() &&
                                     !child.at("id").as<std::string>().empty()
                                 ? "@" + escape(child.at("id").as<std::string>())
                                 : std::to_string(i);
            collect_structured_sources(child, path + "/" + key, messages);
        }
    }
}

void collect_top_level_strings(const Json& data, const std::string& base,
                               std::map<std::string, std::string>& messages)
{
    if (!data.is_object())
        return;
    if (data.contains("displayName") && data.at("displayName").is_string())
        messages.emplace(base + "/displayName", data.at("displayName").as<std::string>());
    if (data.contains("dialogue") && data.at("dialogue").is_object() &&
        data.at("dialogue").contains("name") && data.at("dialogue").at("name").is_string())
        messages.emplace(base + "/dialogue/name", data.at("dialogue").at("name").as<std::string>());
    if (data.contains("exits") && data.at("exits").is_array()) {
        std::size_t index = 0;
        for (const auto& exit : data.at("exits").array_range()) {
            if (exit.is_object() && exit.contains("label") && exit.at("label").is_string()) {
                const auto key = exit.contains("id") && exit.at("id").is_string()
                                     ? "@" + escape(exit.at("id").as<std::string>())
                                     : std::to_string(index);
                messages.emplace(base + "/exits/" + key + "/label",
                                 exit.at("label").as<std::string>());
            }
            ++index;
        }
    }
}

std::optional<Json> working_record(const std::filesystem::path& root,
                                   const std::map<std::string, std::string>& overlays,
                                   std::string_view family, std::string_view id)
{
    const auto name = "records/" + std::string(family) + "/" + std::string(id) +
                      (family == "layouts" ? "/layout.yaml" : ".yaml");
    if (const auto it = overlays.find(name); it != overlays.end())
        return Json::parse(it->second);
    const auto file = root / name;
    if (!std::filesystem::is_regular_file(file))
        return std::nullopt;
    std::ifstream input(file, std::ios::binary);
    const std::string bytes{std::istreambuf_iterator<char>{input},
                            std::istreambuf_iterator<char>{}};
    const auto decoded = open_yaml_source(bytes);
    if (!decoded.accepted)
        return std::nullopt;
    return Json::parse(decoded.source_json);
}

std::string tracking_fingerprint(std::string_view value)
{
    std::string result = "fnv1a:";
    for (const std::uint32_t seed : {0x811c9dc5u, 0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u}) {
        auto hash = seed;
        for (std::size_t i = 0; i < value.size();) {
            const auto first = static_cast<unsigned char>(value[i++]);
            std::uint32_t codepoint = first;
            if (first >= 0xc2 && first <= 0xf4) {
                const auto count = first < 0xe0 ? 1u : first < 0xf0 ? 2u : 3u;
                if (i + count <= value.size()) {
                    codepoint = first & (count == 1 ? 0x1fu : count == 2 ? 0x0fu : 0x07u);
                    for (unsigned int n = 0; n < count; ++n)
                        codepoint =
                            (codepoint << 6) | (static_cast<unsigned char>(value[i++]) & 0x3fu);
                }
            }
            if (codepoint > 0xffff) {
                const auto u = codepoint - 0x10000;
                hash = (hash ^ (0xd800u + (u >> 10))) * 0x01000193u;
                hash = (hash ^ (0xdc00u + (u & 0x3ffu))) * 0x01000193u;
            } else
                hash = (hash ^ codepoint) * 0x01000193u;
        }
        std::ostringstream hex;
        hex << std::hex << std::setfill('0') << std::setw(8) << hash;
        result += hex.str();
    }
    return result;
}

std::size_t byte_at_utf16(std::string_view text, std::size_t target)
{
    std::size_t units = 0, offset = 0;
    while (offset < text.size() && units < target) {
        const auto first = static_cast<unsigned char>(text[offset]);
        const auto width = first < 0x80 ? 1u : first < 0xe0 ? 2u : first < 0xf0 ? 3u : 4u;
        offset += std::min<std::size_t>(width, text.size() - offset);
        units += width == 4 ? 2 : 1;
    }
    return offset;
}

// ECMAScript RegExp \s and String.trim include Unicode WhiteSpace and
// LineTerminator, not the locale-dependent C isspace() byte classification.
// Match whole UTF-8 codepoint encodings so multi-byte whitespace cannot be
// partially preserved or collapsed. U+0085, U+180E and U+200B are NOT \s.
std::size_t ecmascript_whitespace_width(std::string_view text, std::size_t at)
{
    const auto first = static_cast<unsigned char>(text[at]);
    if (first == 0x20 || (first >= 0x09 && first <= 0x0d))
        return 1;
    if (at + 1 < text.size() && first == 0xc2 && static_cast<unsigned char>(text[at + 1]) == 0xa0)
        return 2; // U+00A0
    if (at + 2 >= text.size())
        return 0;
    const auto second = static_cast<unsigned char>(text[at + 1]);
    const auto third = static_cast<unsigned char>(text[at + 2]);
    if (first == 0xe1 && second == 0x9a && third == 0x80)
        return 3; // U+1680
    if (first == 0xe2 && second == 0x80 &&
        ((third >= 0x80 && third <= 0x8a) || third == 0xa8 || third == 0xa9 || third == 0xaf))
        return 3; // U+2000..U+200A, U+2028, U+2029, U+202F
    if ((first == 0xe2 && second == 0x81 && third == 0x9f) ||
        (first == 0xe3 && second == 0x80 && third == 0x80) ||
        (first == 0xef && second == 0xbb && third == 0xbf))
        return 3; // U+205F, U+3000, U+FEFF
    return 0;
}

std::string collapse_space(std::string_view text)
{
    std::string result;
    bool pending = false;
    for (std::size_t at = 0; at < text.size();) {
        if (const auto width = ecmascript_whitespace_width(text, at)) {
            pending = !result.empty();
            at += width;
            continue;
        }
        if (pending)
            result += ' ';
        result += text[at++];
        pending = false;
    }
    return result;
}

std::string normalize_lua_tracking(const std::string& text)
{
    static const std::regex long_comment(R"(--\[(=*)\[[\s\S]*?\]\1\])");
    static const std::regex line_comment(R"(--[^\r\n]*)");
    const auto stripped =
        std::regex_replace(std::regex_replace(text, long_comment, ""), line_comment, "");
    std::string normalized;
    for (std::size_t at = 0; at < stripped.size();) {
        if (const auto width = ecmascript_whitespace_width(stripped, at))
            at += width;
        else
            normalized += stripped[at++];
    }
    return normalized;
}

std::string normalize_rml_tracking(std::string_view text)
{
    static const std::regex content(R"(>([^<]+)<)");
    const std::string input(text);
    std::string result;
    auto cursor = input.cbegin();
    std::smatch match;
    while (std::regex_search(cursor, input.cend(), match, content)) {
        result.append(cursor, match[0].first);
        result += ">";
        if (!collapse_space(match[1].str()).empty())
            result += "<text>";
        result += "<";
        cursor = match[0].second;
    }
    result.append(cursor, input.cend());
    return collapse_space(result);
}

struct TrackedCandidate {
    const ManagedSourceOccurrence* occurrence;
    std::string structural;
    std::string anchor;
};

std::vector<TrackedCandidate> tracked_candidates(const SourceAnalysis& analyzed,
                                                 std::string_view family)
{
    std::vector<TrackedCandidate> result;
    const auto& source = analyzed.source_text;
    for (const auto& message : analyzed.messages) {
        if (family == "rml" ? message.lua_call || message.kind != "local" : !message.lua_call)
            continue;
        const auto call_start = byte_at_utf16(source, message.call_start_utf16);
        const auto call_end = byte_at_utf16(source, message.call_end_utf16);
        if (call_start >= call_end || call_end > source.size())
            continue;
        const auto window = family == "rml" ? 128u : 96u;
        const auto before = byte_at_utf16(
            source, message.call_start_utf16 > window ? message.call_start_utf16 - window : 0);
        const auto after = byte_at_utf16(source, message.call_end_utf16 + window);
        std::string structural;
        std::string anchor;
        if (family == "rml") {
            if (!message.rml_open_end_utf16 || !message.rml_content_end_utf16)
                continue;
            const auto open_end = byte_at_utf16(source, *message.rml_open_end_utf16);
            const auto content_end = byte_at_utf16(source, *message.rml_content_end_utf16);
            structural = tracking_fingerprint(
                collapse_space(source.substr(call_start, open_end - call_start)) + "|" +
                normalize_rml_tracking(source.substr(open_end, content_end - open_end)));
            anchor = tracking_fingerprint(
                normalize_rml_tracking(source.substr(before, call_start - before)) + "|<nt-tr>|" +
                normalize_rml_tracking(source.substr(call_end, after - call_end)));
        } else {
            std::string call = source.substr(call_start, call_end - call_start);
            std::vector<std::tuple<std::size_t, std::size_t, std::string>> edits;
            if (message.source_start_utf16 && message.source_end_utf16)
                edits.emplace_back(byte_at_utf16(source, *message.source_start_utf16) - call_start,
                                   byte_at_utf16(source, *message.source_end_utf16) - call_start,
                                   "<source>");
            if (message.metadata_start_utf16 && message.metadata_end_utf16)
                edits.emplace_back(
                    byte_at_utf16(source, *message.metadata_start_utf16) - call_start,
                    byte_at_utf16(source, *message.metadata_end_utf16) - call_start, "<metadata>");
            std::sort(edits.begin(), edits.end(), std::greater<>{});
            for (const auto& [start, end, replacement] : edits)
                if (start <= end && end <= call.size())
                    call.replace(start, end - start, replacement);
            structural = tracking_fingerprint(message.kind + "|" + normalize_lua_tracking(call));
            anchor = tracking_fingerprint(
                normalize_lua_tracking(source.substr(before, call_start - before)) + "|<message>|" +
                normalize_lua_tracking(source.substr(call_end, after - call_end)));
        }
        result.push_back({&message, std::move(structural), std::move(anchor)});
    }
    std::sort(result.begin(), result.end(), [](const auto& a, const auto& b) {
        return a.occurrence->call_start_utf16 < b.occurrence->call_start_utf16;
    });
    return result;
}

std::vector<std::size_t> matching_tracked(const Json& tracked, const TrackedCandidate& candidate)
{
    std::vector<std::size_t> both, structural, anchor;
    std::size_t index = 0;
    for (const auto& occurrence : tracked.at("occurrences").array_range()) {
        const bool shape = occurrence.at("structuralFingerprint") == candidate.structural;
        const bool location = occurrence.at("anchorFingerprint") == candidate.anchor;
        if (shape && location)
            both.push_back(index);
        if (shape)
            structural.push_back(index);
        if (location)
            anchor.push_back(index);
        ++index;
    }
    if (both.size() == 1)
        return both;
    if (structural.size() == 1)
        return structural;
    if (anchor.size() == 1)
        return anchor;
    return {};
}

const ManagedSourceOccurrence* tracked_occurrence(const Json& entry, const Json& previous,
                                                  const SourceAnalysis& source,
                                                  std::string_view family)
{
    const auto candidates = tracked_candidates(source, family);
    const auto ordinal = previous.at("ordinal").as<std::size_t>();
    const auto& old = entry.at("occurrences");
    for (const auto& candidate : candidates) {
        const auto matches = matching_tracked(entry, candidate);
        if (matches.size() != 1 ||
            old.at(matches.front()).at("messageId") != previous.at("messageId"))
            continue;
        const auto reverse =
            std::count_if(candidates.begin(), candidates.end(), [&](const TrackedCandidate& other) {
                const auto links = matching_tracked(entry, other);
                return links.size() == 1 &&
                       old.at(links.front()).at("messageId") == previous.at("messageId");
            });
        if (reverse == 1)
            return candidate.occurrence;
    }
    // Ordinal fallback is safe only if the original entire source is still
    // byte-for-byte identical (matching the TypeScript tracking policy).
    if (entry.at("sourceSnapshotFingerprint") == tracking_fingerprint(source.source_text))
        for (std::size_t index = 0; index < candidates.size(); ++index)
            if (index == ordinal)
                return candidates[index].occurrence;
    return nullptr;
}

std::map<std::string, std::string>
structured_sources(const std::filesystem::path& root,
                   const std::map<std::string, std::string>& record_overlays)
{
    std::map<std::string, std::string> messages;
    for (const auto* family : {"characters", "rooms", "interactables", "dialogues", "scenes",
                               "verbs", "interactions", "maps"}) {
        const auto dir = root / "records" / family;
        if (!std::filesystem::is_directory(dir))
            continue;
        for (const auto& entry : std::filesystem::directory_iterator(dir)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
                continue;
            const auto record =
                working_record(root, record_overlays, family, entry.path().stem().string());
            if (!record)
                continue;
            if (!record->contains("data") || !record->at("data").is_object())
                continue;
            const auto base =
                "/" + std::string(family) + "/" + escape(entry.path().stem().string()) + "/data";
            collect_top_level_strings(record->at("data"), base, messages);
            collect_structured_sources(record->at("data"), base, messages);
        }
    }
    return messages;
}

// A managed Message ID is stored in i18n/tracking.yaml rather than in
// i18n/messages.yaml. Its source contract must be projected from the active
// analyzed Lua/RML buffer, falling back to its tracked source snapshot.
std::optional<std::string> record_source_at(const std::filesystem::path& root,
                                            const std::map<std::string, std::string>& records,
                                            std::string_view pointer)
{
    if (!pointer.starts_with('/'))
        return std::nullopt;
    const auto family_end = pointer.find('/', 1);
    const auto id_end = family_end == std::string_view::npos ? std::string_view::npos
                                                             : pointer.find('/', family_end + 1);
    if (id_end == std::string_view::npos)
        return std::nullopt;
    const auto record = working_record(root, records, pointer.substr(1, family_end - 1),
                                       pointer.substr(family_end + 1, id_end - family_end - 1));
    if (!record)
        return std::nullopt;
    const Json* current = &*record;
    for (auto pos = id_end + 1; pos < pointer.size();) {
        const auto end = pointer.find('/', pos);
        const auto token = pointer.substr(pos, end == std::string_view::npos ? end : end - pos);
        if (current->is_object()) {
            if (!current->contains(std::string(token)))
                return std::nullopt;
            current = &current->at(std::string(token));
        } else if (current->is_array()) {
            if (token.empty() || !std::all_of(token.begin(), token.end(),
                                              [](unsigned char c) { return c >= '0' && c <= '9'; }))
                return std::nullopt;
            const auto index = std::stoul(std::string(token));
            if (index >= current->size())
                return std::nullopt;
            current = &current->at(index);
        } else
            return std::nullopt;
        if (end == std::string_view::npos)
            break;
        pos = end + 1;
    }
    return current->is_string() ? std::optional<std::string>(current->as<std::string>())
                                : std::nullopt;
}

std::optional<SourceAnalysis> resolve_tracked_source(
    const std::filesystem::path& root, const std::map<std::string, std::string>& records,
    const std::map<std::string, SourceAnalysis>& working_sources, const Json& tracked)
{
    const auto pointer = tracked.at("sourcePath").as<std::string>();
    const auto owner = tracked.at("ownerKey").as<std::string>();
    std::string physical;
    std::optional<std::string> inline_text;
    if (owner.starts_with("record:layouts:")) {
        const auto id = owner.substr(sizeof("record:layouts:") - 1);
        const auto layout = working_record(root, records, "layouts", id);
        if (layout && layout->contains("data")) {
            const auto channel = pointer.find("/data/rml/") != std::string::npos    ? "rml"
                                 : pointer.find("/data/rcss/") != std::string::npos ? "rcss"
                                                                                    : "lua";
            const auto& data = layout->at("data");
            if (data.contains(channel) && data.at(channel).is_object()) {
                const auto& selector = data.at(channel);
                if (!selector.contains("sourceMode") || !selector.at("sourceMode").is_string())
                    return std::nullopt;
                const auto mode = selector.at("sourceMode").as<std::string>();
                if (mode == "file")
                    physical = "records/layouts/" + id + "/layout." + channel;
                else if (mode == "inline") {
                    physical =
                        "inline/layouts/" + id + "/data/" + channel + "/sourceText." + channel;
                    if (selector.contains("sourceText") && selector.at("sourceText").is_string())
                        inline_text = selector.at("sourceText").as<std::string>();
                } else if (mode == "asset" && selector.contains("sourceAsset")) {
                    const auto& reference = selector.at("sourceAsset");
                    std::string asset_id;
                    if (reference.is_string())
                        asset_id = reference.as<std::string>();
                    else if (reference.is_object() && reference.contains("$ref"))
                        asset_id = reference.at("$ref").at("id").as<std::string>();
                    if (!asset_id.empty()) {
                        const auto asset = working_record(root, records, "assets", asset_id);
                        if (asset && asset->contains("data") && asset->at("data").is_object() &&
                            asset->at("data").contains("source") &&
                            asset->at("data").at("source").is_object()) {
                            const auto& source = asset->at("data").at("source");
                            if (source.contains("type") && source.at("type") == "project-file" &&
                                source.contains("path") && source.at("path").is_string())
                                physical = source.at("path").as<std::string>();
                        }
                    }
                }
            }
        }
    } else if (owner.starts_with("record:scripts:")) {
        const auto id = owner.substr(sizeof("record:scripts:") - 1);
        const auto script = working_record(root, records, "scripts", id);
        if (script && script->contains("data") && script->at("data").is_object() &&
            script->at("data").contains("source") && script->at("data").at("source").is_object()) {
            const auto& source = script->at("data").at("source");
            if (source.contains("kind") && source.at("kind") == "project-file" &&
                source.contains("path") && source.at("path").is_string())
                physical = source.at("path").as<std::string>();
            else if (source.contains("kind") && source.at("kind") == "inline-lua" &&
                     source.contains("source") && source.at("source").is_string()) {
                physical = "inline/scripts/" + id + "/data/source/source.lua";
                inline_text = source.at("source").as<std::string>();
            }
        }
    }
    if (physical.empty() && pointer.starts_with("/")) {
        physical = "inline/" + pointer.substr(1) + ".lua";
        inline_text = record_source_at(root, records, pointer);
    }
    if (const auto active = working_sources.find(physical); active != working_sources.end())
        return active->second;
    if (!physical.empty() && std::filesystem::is_regular_file(root / physical)) {
        std::ifstream stream(root / physical, std::ios::binary);
        const std::string bytes{std::istreambuf_iterator<char>{stream},
                                std::istreambuf_iterator<char>{}};
        return analyze_project_text(physical, bytes);
    }
    if (inline_text)
        return analyze_project_text(physical, *inline_text);
    return std::nullopt;
}

void add_tracked_messages(Json& model, const std::filesystem::path& root,
                          const std::map<std::string, std::string>& record_overlays,
                          const std::map<std::string, SourceAnalysis>& working_sources)
{
    const auto& tracking = model.at("sourceMessageTracking");
    std::set<std::string> named_keys;
    for (const auto& entry : model.at("messages").object_range())
        if (entry.value().at("kind") == "named")
            named_keys.insert(entry.value().at("key").as<std::string>());
    static const std::regex placeholder(R"(\{([A-Za-z_][A-Za-z0-9_-]*)\})");
    for (const auto& entry : tracking.object_range()) {
        const auto& tracked = entry.value();
        const auto active = resolve_tracked_source(root, record_overlays, working_sources, tracked);
        const auto& occurrences = tracked.at("occurrences");
        for (const auto& occurrence : occurrences.array_range()) {
            const auto id = occurrence.at("messageId").as<std::string>();
            if (model["messages"].contains(id))
                continue;
            std::string text = occurrence.at("sourceSnapshot").as<std::string>();
            const ManagedSourceOccurrence* current = nullptr;
            if (active)
                current = tracked_occurrence(tracked, occurrence, *active,
                                             tracked.at("family").as<std::string>());
            if (current)
                text = current->source;
            if (named_keys.contains(text) || (current && current->kind == "named"))
                continue;
            Json message = Json::object();
            message["kind"] = "local";
            message["source"] = text;
            Json arguments = Json::object();
            for (auto it = std::sregex_iterator(text.begin(), text.end(), placeholder);
                 it != std::sregex_iterator(); ++it)
                arguments.insert_or_assign((*it)[1].str(), "printable");
            if (current && !current->cases.empty()) {
                Json pattern = Json::object();
                pattern["kind"] = current->kind;
                pattern["argument"] = "value";
                pattern["cases"] = Json::object();
                for (const auto& [branch, value] : current->cases) {
                    Json node = Json::object();
                    node["kind"] = "text";
                    node["text"] = value;
                    pattern["cases"][branch] = std::move(node);
                }
                message["pattern"] = std::move(pattern);
                arguments.insert_or_assign("value",
                                           current->kind == "plural" ? "plural-number" : "string");
            }
            if (!arguments.empty())
                message["arguments"] = std::move(arguments);
            model["messages"].insert_or_assign(id, std::move(message));
        }
    }
}

std::map<std::string, Json>
dialogue_cue_contracts(const std::filesystem::path& root, const Json& localization,
                       const std::map<std::string, std::string>& record_overlays)
{
    std::map<std::string, std::string> named_ids;
    for (const auto& message : localization.at("messages").object_range())
        if (message.value().at("kind") == "named")
            named_ids.emplace(message.value().at("key").as<std::string>(),
                              std::string(message.key()));
    std::vector<std::pair<std::string, std::pair<std::string, Json>>> usages;
    const auto directory = root / "records/dialogues";
    if (!std::filesystem::is_directory(directory))
        return {};
    const auto token = [](const Json& value, std::size_t index) {
        return value.is_object() && value.contains("id") && value.at("id").is_string() &&
                       !value.at("id").as<std::string>().empty()
                   ? "@" + escape(value.at("id").as<std::string>())
                   : std::to_string(index);
    };
    for (const auto& entry : std::filesystem::directory_iterator(directory)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
            continue;
        const auto record =
            working_record(root, record_overlays, "dialogues", entry.path().stem().string());
        if (!record || !record->contains("data"))
            continue;
        const auto& data = record->at("data");
        if (!data.contains("blocks") || !data.at("blocks").is_array())
            continue;
        const auto base = "/dialogues/" + escape(entry.path().stem().string()) + "/data";
        std::size_t block_index = 0;
        for (const auto& block : data.at("blocks").array_range()) {
            const auto block_path = base + "/blocks/" + token(block, block_index++);
            if (!block.is_object() || !block.contains("type") || block.at("type") != "sequence" ||
                !block.contains("segments") || !block.at("segments").is_array())
                continue;
            std::size_t segment_index = 0;
            for (const auto& segment : block.at("segments").array_range()) {
                const auto path =
                    block_path + "/segments/" + token(segment, segment_index++) + "/text";
                if (!segment.is_object() || !segment.contains("type") ||
                    segment.at("type") != "line" || !segment.contains("text") ||
                    !segment.at("text").is_object())
                    continue;
                const auto& text = segment.at("text");
                if (!text.contains("source") || !text.at("source").is_object())
                    continue;
                const auto& source = text.at("source");
                std::string id;
                if (source.at("kind") == "inline")
                    id = localization.at("structuredMessageIds").contains(path)
                             ? localization.at("structuredMessageIds").at(path).as<std::string>()
                             : derived_message_id(path);
                else if (source.at("kind") == "localized" && source.contains("key")) {
                    const auto found = named_ids.find(source.at("key").as<std::string>());
                    if (found != named_ids.end())
                        id = found->second;
                }
                if (id.empty() || !segment.contains("cues") || !segment.at("cues").is_array())
                    continue;
                std::vector<Json> placements;
                for (const auto& cue : segment.at("cues").array_range()) {
                    if (!cue.is_object() || !cue.contains("kind") ||
                        cue.at("kind") == "active-text" || cue.at("kind") == "invalid-markup")
                        continue;
                    if (!cue.contains("id") || !cue.contains("position"))
                        continue;
                    Json placement = Json::object();
                    placement["id"] = cue.at("id");
                    placement["position"] = cue.at("position");
                    placements.push_back(std::move(placement));
                }
                if (placements.empty())
                    continue;
                std::sort(placements.begin(), placements.end(), [](const Json& a, const Json& b) {
                    const auto& x = a.at("position");
                    const auto& y = b.at("position");
                    return x.at("offset") != y.at("offset")
                               ? x.at("offset").as<std::size_t>() < y.at("offset").as<std::size_t>()
                           : x.at("order") != y.at("order")
                               ? x.at("order").as<std::size_t>() < y.at("order").as<std::size_t>()
                               : a.at("id").as<std::string>() < b.at("id").as<std::string>();
                });
                Json ordered = Json::array();
                for (const auto& placement : placements)
                    ordered.push_back(placement);
                usages.emplace_back(path, std::make_pair(id, std::move(ordered)));
            }
        }
    }
    std::sort(usages.begin(), usages.end(),
              [](const auto& a, const auto& b) { return a.first < b.first; });
    std::map<std::string, Json> contracts;
    for (auto& [_, entry] : usages)
        contracts.emplace(std::move(entry.first), std::move(entry.second));
    return contracts;
}

void validate_dialogue_cue_translations(ValidationResult& result, const std::filesystem::path& root,
                                        const Json& model,
                                        const std::map<std::string, std::string>& record_overlays)
{
    const auto contracts = dialogue_cue_contracts(root, model, record_overlays);
    for (const auto& locale : model.at("translations").object_range())
        for (const auto& entry : locale.value().object_range()) {
            const auto& translation = entry.value();
            if (translation.contains("useSource") && translation.at("useSource") == true)
                continue;
            const auto path = "/localization/translations/" + escape(locale.key()) + "/" +
                              escape(entry.key()) + "/dialogueCues";
            const auto emit = [&](std::string suffix, std::string code, std::string message) {
                add(result, path + suffix, std::move(code), std::move(message),
                    "i18n/locales/" + std::string(locale.key()) + ".yaml");
            };
            const auto source = contracts.find(std::string(entry.key()));
            if (source == contracts.end()) {
                if (translation.contains("dialogueCues"))
                    emit("", "localization.translation.dialogue-cue-unexpected",
                         "Translation cannot introduce Dialogue Cue placements for a Message "
                         "without semantic Cues.");
                continue;
            }
            const auto& required = source->second;
            const auto& target = translation.contains("dialogueCues")
                                     ? translation.at("dialogueCues")
                                     : Json::array();
            bool same = required.size() == target.size();
            if (same)
                for (std::size_t i = 0; i < required.size(); ++i)
                    if (required.at(i).at("id") != target.at(i).at("id"))
                        same = false;
            if (!same)
                emit("", "localization.translation.dialogue-cue-contract-mismatch",
                     "Translation must preserve every required Dialogue Cue exactly once and in "
                     "semantic order.");
            std::size_t text_length = 0;
            for (const auto c : translation.at("text").as<std::string>())
                if ((static_cast<unsigned char>(c) & 0xc0) != 0x80)
                    ++text_length;
            std::size_t prior_offset = 0, prior_order = 0;
            for (std::size_t i = 0; i < target.size(); ++i) {
                const auto& placement = target.at(i).at("position");
                const auto offset = placement.at("offset").as<std::size_t>();
                const auto order = placement.at("order").as<std::size_t>();
                const auto base = "/" + std::to_string(i) + "/position";
                if (offset > text_length)
                    emit(base + "/offset",
                         "localization.translation.dialogue-cue-offset-out-of-range",
                         "Dialogue Cue offset exceeds translated text length.");
                if (i &&
                    (offset < prior_offset || (offset == prior_offset && order <= prior_order)))
                    emit(base, "localization.translation.dialogue-cue-placement-order",
                         "Dialogue Cue placements must remain strictly ordered by offset and "
                         "order.");
                prior_offset = offset;
                prior_order = order;
            }
        }
}

bool fragment(ValidationResult& result, const std::filesystem::path& root,
              const std::map<std::string, std::string>& overlays, std::string_view file,
              std::string_view contract, std::string_view logical, Json& target)
{
    const std::string name(file);
    std::string value;
    if (const auto found = overlays.find(name); found != overlays.end()) {
        value = found->second;
    } else {
        std::ifstream input(root / name, std::ios::binary);
        if (!input) {
            add(result, std::string(logical), "localization.source.missing",
                "Required localization source is missing or unreadable: " + name, name);
            return false;
        }
        const std::string bytes{std::istreambuf_iterator<char>{input},
                                std::istreambuf_iterator<char>{}};
        const auto opened = open_yaml_source(bytes);
        if (!opened.accepted) {
            add(result, std::string(logical), "localization.source.yaml", opened.error, name);
            return false;
        }
        value = opened.source_json;
    }
    const auto valid = validate_record(contract, value);
    if (!valid.accepted) {
        for (const auto& issue : valid.diagnostics)
            add(result, std::string(logical) + issue.path, issue.code, issue.message, name);
        return false;
    }
    target = Json::parse(valid.effective_json);
    return true;
}

void append_locales(ValidationResult& result, const std::filesystem::path& root,
                    const std::map<std::string, std::string>& overlays, std::string_view directory,
                    std::string_view contract, std::string_view logical, Json& target)
{
    const auto folder = root / std::string(directory);
    std::set<std::string> files;
    std::error_code error;
    if (!std::filesystem::is_directory(folder, error)) {
        add(result, std::string(logical), "localization.source.missing",
            "Required localization directory is missing.", std::string(directory));
        return;
    }
    for (const auto& item : std::filesystem::directory_iterator(folder)) {
        if (!item.is_regular_file()) {
            add(result, std::string(logical), "localization.source.kind",
                "Localization chunk must be a regular YAML source.",
                item.path().lexically_relative(root).generic_string());
            continue;
        }
        files.insert(item.path().filename().generic_string());
    }
    for (const auto& [name, _] : overlays)
        if (name.starts_with(std::string(directory) + "/") &&
            name.substr(std::string(directory).size() + 1).find('/') == std::string::npos)
            files.insert(name.substr(std::string(directory).size() + 1));
    for (const auto& leaf : files) {
        const auto owner = std::string(directory) + "/" + leaf;
        if (!leaf.ends_with(".yaml") || leaf.size() <= 5 ||
            !is_canonical_localization_locale(std::string_view(leaf).substr(0, leaf.size() - 5))) {
            add(result, std::string(logical), "localization.source.locale",
                "Localization chunk filename must contain a canonical BCP 47 locale.", owner);
            continue;
        }
        const auto locale = leaf.substr(0, leaf.size() - 5);
        const auto base = std::string(logical) + "/" + escape(locale);
        Json normalized;
        if (!fragment(result, root, overlays, owner, contract, base, normalized))
            continue;
        if (normalized.empty()) {
            add(result, base, "localization.source.empty",
                "Empty localization chunk is not a valid tracked source.", owner);
            continue;
        }
        target.insert_or_assign(locale, std::move(normalized));
    }
}
} // namespace

std::string native_localization_tracking_fingerprint(std::string_view text)
{
    return tracking_fingerprint(text);
}

std::map<std::string, std::string>
native_localization_record_structured_sources(const std::filesystem::path& root,
                                              std::string_view family, std::string_view id)
{
    std::map<std::string, std::string> sources;
    const auto authored = working_record(root, {}, family, id);
    if (!authored || !authored->contains("data") || !authored->at("data").is_object())
        return sources;
    const auto base = "/" + std::string(family) + "/" + escape(id) + "/data";
    collect_top_level_strings(authored->at("data"), base, sources);
    collect_structured_sources(authored->at("data"), base, sources);
    // The workspace projects schema defaults before scanning structured Text.
    // For a sparse Room with no authored description, that still yields an
    // inline empty TextContent at /data/description and therefore a stable
    // source-Message ID that must survive identity remapping.
    if (family == "rooms") {
        const auto path = base + "/description";
        if (!sources.contains(path)) {
            std::string error;
            auto record =
                RoomSession::open_record(root, std::string(family), std::string(id), error);
            if (record && record->snapshot().valid) {
                const auto normalized = Json::parse(record->snapshot().normalized_json);
                const auto& data = normalized.at("data");
                if (data.contains("description") && data.at("description").is_object()) {
                    const auto& description = data.at("description");
                    if (description.contains("source") && description.at("source").is_object() &&
                        description.at("source").at("kind") == "inline" &&
                        description.at("source").contains("text") &&
                        description.at("source").at("text").is_string())
                        sources.emplace(path,
                                        description.at("source").at("text").as<std::string>());
                }
            }
        }
    }
    return sources;
}

std::string native_localization_structured_message_id(std::string_view semantic_path)
{
    return derived_message_id(semantic_path);
}

std::size_t native_localization_structured_message_count(const std::filesystem::path& root)
{
    auto messages = structured_sources(root, {});
    std::string error;
    const auto manifest = RoomSession::open_project_source(root, error);
    if (!manifest || !manifest->snapshot().valid)
        throw std::runtime_error("Cannot count structured Messages in invalid Project manifest.");
    const auto project = Json::parse(manifest->snapshot().normalized_json);
    const auto& settings = project.at("settings").at("titleScreen");
    messages.insert_or_assign("/settings/titleScreen/subtitle",
                              settings.at("subtitle").as<std::string>());
    messages.insert_or_assign("/settings/titleScreen/startLabel",
                              settings.at("startLabel").as<std::string>());
    collect_structured_sources(project.at("undefinedInteractionProgram"),
                               "/undefinedInteractionProgram", messages);

    std::map<std::string, std::string> records;
    for (const auto* family : {"archetypes", "characters", "rooms", "interactables"}) {
        const auto directory = root / "records" / family;
        if (!std::filesystem::is_directory(directory))
            continue;
        for (const auto& entry : std::filesystem::directory_iterator(directory)) {
            if (!entry.is_regular_file() || entry.path().extension() != ".yaml")
                continue;
            auto record =
                RoomSession::open_record(root, family, entry.path().stem().string(), error);
            if (!record || !record->snapshot().valid)
                continue;
            records.emplace(std::string(family) + "/" + entry.path().stem().string(),
                            record->snapshot().normalized_json);
        }
    }
    // Sparse TextContent omits declared markup defaults. Counting raw Room
    // fragments without native schema normalization misses valid Messages.
    for (const auto& [owner, raw] : records) {
        if (!owner.starts_with("rooms/"))
            continue;
        const auto data = Json::parse(raw).at("data");
        const auto base = "/" + owner + "/data";
        collect_top_level_strings(data, base, messages);
        collect_structured_sources(data, base, messages);
    }
    const AuthoringRecordResolver resolve = [&](std::string_view family,
                                                std::string_view id) -> std::optional<std::string> {
        const auto found = records.find(std::string(family) + "/" + std::string(id));
        return found == records.end() ? std::nullopt : std::optional<std::string>(found->second);
    };
    for (const auto& [owner, raw] : records) {
        if (owner.starts_with("archetypes/")) {
            const auto id = owner.substr(sizeof("archetypes/") - 1);
            const auto resolved = validate_archetype_dependencies(id, raw, resolve);
            if (!resolved.accepted || resolved.effective_json.empty())
                continue;
            const auto data = Json::parse(resolved.effective_json).at("data");
            const auto base = "/archetypes/" + escape(id) + "/configuration";
            collect_top_level_strings(data, base, messages);
            collect_structured_sources(data, base, messages);
            continue;
        }
        if (!owner.starts_with("characters/") && !owner.starts_with("rooms/") &&
            !owner.starts_with("interactables/"))
            continue;
        const auto value = Json::parse(raw);
        if (!value.contains("archetype") || value.at("archetype").is_null())
            continue;
        const auto family = owner.substr(0, owner.find('/'));
        const auto resolved = validate_archetype_owner(family, raw, resolve);
        if (!resolved.accepted || resolved.effective_json.empty())
            continue;
        const auto base = "/" + owner + "/data";
        for (auto it = messages.begin(); it != messages.end();) {
            if (it->first.starts_with(base + "/"))
                it = messages.erase(it);
            else
                ++it;
        }
        const auto data = Json::parse(resolved.effective_json).at("data");
        collect_top_level_strings(data, base, messages);
        collect_structured_sources(data, base, messages);
    }
    return messages.size();
}

NativeLocalizationTrackingSource native_localization_tracking_source(const SourceAnalysis& analysis,
                                                                     std::string family,
                                                                     std::string owner_key,
                                                                     std::string source_path)
{
    NativeLocalizationTrackingSource source;
    source.family = std::move(family);
    source.owner_key = std::move(owner_key);
    source.source_path = std::move(source_path);
    source.source_snapshot_fingerprint = tracking_fingerprint(analysis.source_text);
    const auto found = tracked_candidates(analysis, source.family);
    for (std::size_t index = 0; index < found.size(); ++index) {
        const auto& candidate = found[index];
        const auto& original = *candidate.occurrence;
        source.occurrences.push_back(NativeLocalizationTrackingOccurrence{
            index, candidate.structural, candidate.anchor, tracking_fingerprint(original.source),
            original.source, original.context, original.translator_note});
    }
    return source;
}

ValidationResult
validate_project_localization(const std::filesystem::path& project_root,
                              const std::map<std::string, std::string>& source_overlays,
                              const std::map<std::string, std::string>& record_overlays,
                              const std::map<std::string, SourceAnalysis>& working_sources)
{
    ValidationResult result;
    try {
        Json policy, messages, usage, tracking, orphans;
        bool complete = true;
        complete &= fragment(result, project_root, source_overlays, "i18n/project.yaml",
                             "WorkspaceLocalizationPolicy", "/localization", policy);
        complete &= fragment(result, project_root, source_overlays, "i18n/messages.yaml",
                             "WorkspaceLocalizationMessages", "/localization", messages);
        complete &= fragment(result, project_root, source_overlays, "i18n/usage-notes.yaml",
                             "WorkspaceLocalizationUsageNotes", "/localization/usageNotes", usage);
        complete &= fragment(result, project_root, source_overlays, "i18n/tracking.yaml",
                             "WorkspaceLocalizationTracking", "/localization/sourceMessageTracking",
                             tracking);
        complete &=
            fragment(result, project_root, source_overlays, "i18n/orphans.yaml",
                     "WorkspaceLocalizationOrphans", "/localization/orphanedMessages", orphans);
        Json translations = Json::object();
        Json assets = Json::object();
        append_locales(result, project_root, source_overlays, "i18n/locales",
                       "WorkspaceLocalizationLocale", "/localization/translations", translations);
        append_locales(result, project_root, source_overlays, "i18n/assets",
                       "WorkspaceLocalizationAssets", "/localization/assets", assets);
        if (!complete || !result.diagnostics.empty())
            return result;
        Json model = policy;
        for (const auto& entry : messages.object_range())
            model.insert_or_assign(entry.key(), entry.value());
        model.insert_or_assign("usageNotes", usage);
        model.insert_or_assign("sourceMessageTracking", tracking);
        model.insert_or_assign("orphanedMessages", orphans);
        model.insert_or_assign("translations", translations);
        model.insert_or_assign("assets", assets);
        // Structured source Messages are owned by gameplay records, not the
        // split i18n/messages.yaml file. Resolve their semantic-path IDs before
        // translation checking, then discard this validation-only projection.
        const auto physical_messages = model.at("messages");
        const auto physical_ids = model.at("structuredMessageIds");
        static const std::regex placeholder(R"(\{([A-Za-z_][A-Za-z0-9_-]*)\})");
        for (const auto& [path, source_text] : structured_sources(project_root, record_overlays)) {
            const auto id = physical_ids.contains(path) ? physical_ids.at(path).as<std::string>()
                                                        : derived_message_id(path);
            model["structuredMessageIds"].insert_or_assign(path, id);
            if (model["messages"].contains(id))
                continue;
            Json message = Json::object();
            message["kind"] = "local";
            message["source"] = source_text;
            Json arguments = Json::object();
            for (auto it =
                     std::sregex_iterator(source_text.begin(), source_text.end(), placeholder);
                 it != std::sregex_iterator(); ++it)
                arguments.insert_or_assign((*it)[1].str(), "printable");
            if (!arguments.empty())
                message["arguments"] = std::move(arguments);
            model["messages"].insert_or_assign(id, std::move(message));
        }
        add_tracked_messages(model, project_root, record_overlays, working_sources);
        const auto validation = validate_record("WorkspaceLocalization", model.to_string());
        for (const auto& issue : validation.diagnostics) {
            auto diagnostic = issue;
            diagnostic.path = "/localization" + diagnostic.path;
            diagnostic.source_path = owner_for_path(diagnostic.path);
            result.diagnostics.push_back(std::move(diagnostic));
        }
        if (validation.accepted)
            validate_dialogue_cue_translations(result, project_root, model, record_overlays);
        result.accepted = result.diagnostics.empty();
        if (result.accepted) {
            auto effective = Json::parse(validation.effective_json);
            effective.insert_or_assign("messages", physical_messages);
            effective.insert_or_assign("structuredMessageIds", physical_ids);
            result.effective_json = effective.to_string();
        }
    } catch (const std::exception& error) {
        add(result, "/localization", "localization.source.failure", error.what(),
            "i18n/project.yaml");
    }
    return result;
}
} // namespace noveltea::authoring
