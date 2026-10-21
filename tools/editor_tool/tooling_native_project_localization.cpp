#include "tooling_native_project_localization.hpp"
#include "../project_authoring/character_archetype_semantics.hpp"

#include "../project_authoring/room_session.hpp"
#include "../project_authoring/localization_semantics.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/source_analysis.hpp"
#include "tooling_native_project_sync.hpp"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

// Keep string comparisons type-strict and independent of nlohmann's implicit
// conversion overloads (ambiguous with std::string_view on MSVC).
bool json_string_equals(const Json& value, std::string_view expected)
{
    return value.is_string() && value.get_ref<const std::string&>() == expected;
}

bool whitespace(char32_t c)
{
    return (c >= 0x9 && c <= 0xd) || c == 0x20 || c == 0xa0 || c == 0x1680 ||
           (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f ||
           c == 0x205f || c == 0x3000 || c == 0xfeff;
}

struct CodePoint {
    char32_t value = 0;
    std::size_t size = 0;
};

CodePoint next_utf8(std::string_view source, std::size_t position)
{
    const auto lead = static_cast<unsigned char>(source[position]);
    const auto size = lead < 0x80 ? 1u : lead < 0xe0 ? 2u : lead < 0xf0 ? 3u : 4u;
    char32_t value = lead & (size == 1 ? 0x7f : size == 2 ? 0x1f : size == 3 ? 0x0f : 0x07);
    if (position + size > source.size())
        throw std::runtime_error("Invalid UTF-8 Message source.");
    for (unsigned int i = 1; i < size; ++i) {
        const auto byte = static_cast<unsigned char>(source[position + i]);
        if ((byte & 0xc0) != 0x80)
            throw std::runtime_error("Invalid UTF-8 Message source.");
        value = (value << 6) | (byte & 0x3f);
    }
    if ((size == 2 && value < 0x80) || (size == 3 && value < 0x800) ||
        (size == 4 && value < 0x10000) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
        throw std::runtime_error("Invalid UTF-8 Message source.");
    return {value, size};
}

std::string normalized_text(std::string_view source)
{
    std::string value;
    bool pending_space = false;
    for (std::size_t i = 0; i < source.size();) {
        const auto next = next_utf8(source, i);
        if (whitespace(next.value)) {
            pending_space = !value.empty();
        } else {
            if (pending_space)
                value += ' ';
            value.append(source.substr(i, next.size));
            pending_space = false;
        }
        i += next.size;
    }
    return value;
}

std::string trimmed_text(std::string_view source)
{
    std::size_t first = source.size();
    std::size_t last = 0;
    for (std::size_t position = 0; position < source.size();) {
        const auto next = next_utf8(source, position);
        if (!whitespace(next.value)) {
            if (first == source.size())
                first = position;
            last = position + next.size;
        }
        position += next.size;
    }
    return first == source.size() ? std::string{} : std::string(source.substr(first, last - first));
}

std::string fnv1a(std::string_view source)
{
    std::ostringstream hex;
    hex << "fnv1a:" << std::hex << std::setfill('0');
    for (const std::uint32_t seed : {0x811c9dc5u, 0x9e3779b9u, 0x85ebca6bu, 0xc2b2ae35u}) {
        std::uint32_t hash = seed;
        const auto consume = [&](std::uint32_t unit) {
            hash ^= unit;
            hash *= 0x01000193u;
        };
        for (std::size_t i = 0; i < source.size();) {
            const auto next = next_utf8(source, i);
            if (next.value <= 0xffff) {
                consume(static_cast<std::uint32_t>(next.value));
            } else {
                const auto scalar = static_cast<std::uint32_t>(next.value - 0x10000);
                consume(0xd800u + (scalar >> 10));
                consume(0xdc00u + (scalar & 0x3ffu));
            }
            i += next.size;
        }
        hex << std::setw(8) << hash;
    }
    return hex.str();
}

std::string linguistic(std::string_view source)
{
    // Mirror authoring-localization-workflow.ts: expand [[label|objectId]],
    // strip Dialogue/ActiveText markup, retain recognized object cue IDs in
    // their encounter order, and then normalize Unicode whitespace.
    std::string expanded;
    std::vector<std::string> objects;
    const std::regex shorthand(R"(\[\[([^\]|]*)\|([^\]]+)\]\])");
    const std::string input(source);
    std::size_t cursor = 0;
    for (std::sregex_iterator it(input.begin(), input.end(), shorthand), end; it != end; ++it) {
        const auto& match = *it;
        expanded += input.substr(cursor, static_cast<std::size_t>(match.position()) - cursor);
        expanded += match[1].str();
        objects.push_back(trimmed_text(match[2].str()));
        cursor = static_cast<std::size_t>(match.position() + match.length());
    }
    expanded += input.substr(cursor);

    std::string plain;
    const std::regex object_token(R"(^\[(?:o|object)(?:\s+id)?=([^\]]+)\]$)",
                                  std::regex_constants::icase);
    for (std::size_t index = 0; index < expanded.size();) {
        if (expanded[index] != '[') {
            const auto point = next_utf8(expanded, index);
            plain.append(expanded, index, point.size);
            index += point.size;
            continue;
        }
        const auto close = expanded.find(']', index + 1);
        if (close == std::string::npos)
            break; // Same invalid-markup projection as parseDialogueCueMarkup.
        const auto token = expanded.substr(index, close - index + 1);
        std::smatch match;
        if (std::regex_match(token, match, object_token)) {
            const auto id = trimmed_text(match[1].str());
            if (!id.empty())
                objects.push_back(id);
        }
        index = close + 1;
    }
    const auto text = normalized_text(std::regex_replace(plain, std::regex("<[^>]*>"), ""));
    if (objects.empty())
        return text;
    std::string result = text + std::string(1, '\0') + "objects:";
    for (std::size_t index = 0; index < objects.size(); ++index) {
        if (index)
            result += '|';
        result += objects[index];
    }
    return result;
}

std::string pattern_contract(const Json& pattern, int depth = 0, bool linguistic_text = true)
{
    if (pattern.is_null())
        return {};
    if (!pattern.is_object() || depth > 32 || !pattern.contains("kind") ||
        !pattern.at("kind").is_string())
        throw std::runtime_error("Unsupported native Message pattern.");
    const auto kind = pattern.at("kind").get<std::string>();
    if (kind == "text")
        return Json::array({"text", linguistic_text
                                        ? linguistic(pattern.at("text").get<std::string>())
                                        : pattern.at("text").get<std::string>()})
            .dump();
    if (kind != "select" && kind != "plural")
        throw std::runtime_error("Unsupported native Message pattern branch.");
    Json cases = Json::array();
    for (const auto& [key, branch] : pattern.at("cases").items())
        cases.push_back(Json::array({key, pattern_contract(branch, depth + 1, linguistic_text)}));
    return Json::array({kind, pattern.at("argument"), cases}).dump();
}

std::string message_fingerprint(const Json& message)
{
    if (!message.is_object() || (message.value("kind", std::string{}) != "named" &&
                                 message.value("kind", std::string{}) != "local"))
        throw std::runtime_error("Localization fingerprint requires a Message source.");
    std::vector<std::string> arguments;
    if (message.contains("arguments") && message.at("arguments").is_object()) {
        for (const auto& [key, value] : message.at("arguments").items())
            arguments.push_back(key + ":" + value.get<std::string>());
    }
    std::sort(arguments.begin(), arguments.end());
    std::string contract;
    for (const auto& argument : arguments) {
        if (!contract.empty())
            contract += '|';
        contract += argument;
    }
    const auto source = linguistic(message.at("source").get<std::string>());
    const auto pattern = pattern_contract(message.value("pattern", Json(nullptr)));
    return fnv1a(std::string("semantic\0", 9) + source + '\0' + contract + '\0' + pattern + '\0');
}

Json placeholder_contract(std::string_view text)
{
    Json arguments = Json::object();
    static const std::regex valid(R"(^[A-Za-z_][A-Za-z0-9_-]*$)");
    for (std::size_t at = 0; at < text.size(); ++at) {
        if (text[at] != '{')
            continue;
        if (at + 1 < text.size() && text[at + 1] == '{') {
            ++at;
            continue;
        }
        const auto end = text.find('}', at + 1);
        if (end == std::string_view::npos)
            continue;
        const std::string name(text.substr(at + 1, end - at - 1));
        if (std::regex_match(name, valid))
            arguments[name] = "printable";
        at = end;
    }
    return arguments;
}

std::string bytes_at(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw std::runtime_error("Cannot read localization target source.");
    const std::string bytes{std::istreambuf_iterator<char>(input),
                            std::istreambuf_iterator<char>()};
    if (input.bad())
        throw std::runtime_error("Cannot finish localization target source read.");
    return bytes;
}

std::string escape_pointer(std::string value)
{
    std::string escaped;
    for (auto character : value)
        escaped += character == '~' ? "~0" : character == '/' ? "~1" : std::string(1, character);
    return escaped;
}
} // namespace

Json native_project_localization(const Json& request, ProjectSession& session,
                                 const std::filesystem::path& root)
{
    if (!request.contains("locale") || !request.at("locale").is_string() ||
        !request.contains("messageIds") || !request.at("messageIds").is_array() ||
        !request.contains("operation") || !request.at("operation").is_string() ||
        (request.contains("dryRun") && !request.at("dryRun").is_boolean()) ||
        (request.contains("sourceRevision") && !request.at("sourceRevision").is_string()))
        return failure("Named localization workflow requires locale, operation, and Message IDs.");
    for (const auto& id : request.at("messageIds"))
        if (!id.is_string())
            return failure("Native localization Message IDs must be strings.");
    const auto locale = request.at("locale").get<std::string>();
    const auto operation = request.at("operation").get<std::string>();
    if (operation != "accept" && operation != "review" && operation != "inspect")
        return failure("Unknown native localization workflow operation.");
    const bool dry_run = request.value("dryRun", true);
    if (!dry_run && !request.contains("sourceRevision"))
        return failure("Localization commit requires an exact source precondition.");
    const auto generation = native_project_source_generation(session, root);
    const auto validated = session.validate_project();
    if (!validated.valid)
        return failure("Native localization workflow requires a valid disk Project.");
    const auto prepared = session.prepare_working(session.snapshot().working_revision);
    if (!prepared.accepted)
        return failure(prepared.error);
    const auto project = Json::parse(prepared.project_json);
    const auto& localization = project.at("localization");
    if (locale == localization.at("sourceLocale").get<std::string>() ||
        !localization.at("locales").contains(locale))
        return failure("Invalid target translation locale.");
    const auto path = "i18n/locales/" + locale + ".yaml";
    const auto source_revision = std::filesystem::is_regular_file(root / path)
                                     ? exact_source_revision(bytes_at(root / path))
                                     : std::string("absent");
    const auto owner = path;
    const auto view = native_project_localization_view({{"locale", locale}}, session);
    if (!view.value("ok", false))
        return failure(view.value("error", std::string("Native localization view failed.")));
    std::map<std::string, std::string> active_fingerprints;
    for (const auto& message : view.at("messages"))
        active_fingerprints.emplace(message.at("id").get<std::string>(),
                                    message.at("sourceFingerprint").get<std::string>());
    Json fingerprints = Json::object();
    std::vector<RoomPatch> patches;
    for (const auto& id_json : request.at("messageIds")) {
        const auto id = id_json.get<std::string>();
        if (!active_fingerprints.contains(id)) {
            return failure("Native localization Message is missing or has stale source identity: " +
                           id);
        }
        const auto& fingerprint = active_fingerprints.at(id);
        fingerprints[id] = fingerprint;
        if (operation == "inspect")
            continue;
        if (!localization.at("translations").contains(locale) ||
            !localization.at("translations").at(locale).contains(id))
            return failure("Message has no target translation: " + id);
        const auto& target = localization.at("translations").at(locale).at(id);
        if (operation == "review" && target.at("sourceFingerprint") != fingerprint)
            return failure("Outdated target cannot be reviewed: " + id);
        RoomPatch patch;
        patch.operation = RoomPatch::Operation::Replace;
        patch.path = "/localization/translations/" + escape_pointer(locale) + "/" +
                     escape_pointer(id) +
                     (operation == "review" ? "/review" : "/sourceFingerprint");
        patch.value_json = Json(operation == "review" ? "reviewed" : fingerprint).dump();
        patches.push_back(std::move(patch));
    }
    Json result{{"ok", true},
                {"locale", locale},
                {"messageIds", request.at("messageIds")},
                {"dryRun", dry_run},
                {"sourceGeneration", generation},
                {"sourceRevision", source_revision},
                {"fingerprints", std::move(fingerprints)},
                {"writes", Json::array()}};
    if (operation == "inspect" || dry_run || patches.empty())
        return result;
    if (!request.at("sourceRevision").is_string() ||
        request.at("sourceRevision").get<std::string>() !=
            exact_source_revision(bytes_at(root / path)))
        return failure("Stale native localization source precondition.");
    if (!request.contains("expectedSourceGeneration") ||
        !request.at("expectedSourceGeneration").is_string() ||
        request.at("expectedSourceGeneration") != generation)
        return failure("Native localization acceptance requires its planned source generation.");
    const auto patched = session.patch(session.snapshot().working_revision, patches,
                                       {{owner, request.at("sourceRevision").get<std::string>()}});
    if (!patched.accepted)
        return failure(patched.error);
    if (!native_project_source_generation_is_current(root, generation))
        return failure("Native localization inputs changed before acceptance commit.");
    const auto saved = session.save_owners(patched.snapshot.working_revision, {owner}, false,
                                           TransactionDecision::KeepComments);
    if (!saved.accepted)
        return failure(saved.error);
    if (!saved.affected_records.empty())
        result["writes"] = Json::array({path});
    return result;
}

namespace {
std::string semantic_segment(std::string_view value)
{
    std::string result;
    for (auto ch : value)
        result += ch == '~' ? "~0" : ch == '/' ? "~1" : std::string(1, ch);
    return result;
}

std::string semantic_unescape(std::string value)
{
    for (std::size_t at = 0; (at = value.find('~', at)) != std::string::npos;) {
        if (at + 1 >= value.size() || (value[at + 1] != '0' && value[at + 1] != '1'))
            throw std::runtime_error("Invalid structured localization semantic path.");
        value.replace(at, 2, value[at + 1] == '1' ? "/" : "~");
        ++at;
    }
    return value;
}

const Json* semantic_value(const Json& root, std::string_view pointer)
{
    const Json* value = &root;
    for (std::size_t at = 1; at < pointer.size();) {
        const auto end = pointer.find('/', at);
        const auto part = semantic_unescape(
            std::string(pointer.substr(at, end == std::string_view::npos ? end : end - at)));
        if (value->is_object() && value->contains(part))
            value = &value->at(part);
        else if (value->is_array()) {
            if (part.starts_with('@')) {
                auto found = std::find_if(value->begin(), value->end(), [&](const Json& item) {
                    return item.is_object() && item.value("id", std::string{}) == part.substr(1);
                });
                if (found == value->end())
                    return nullptr;
                value = &*found;
            } else {
                if (part.empty() || !std::all_of(part.begin(), part.end(),
                                                 [](unsigned char c) { return std::isdigit(c); }))
                    return nullptr;
                const auto index = std::stoull(part);
                if (index >= value->size())
                    return nullptr;
                value = &value->at(index);
            }
        } else
            return nullptr;
        if (end == std::string_view::npos)
            break;
        at = end + 1;
    }
    return value;
}

void named_usages(const Json& value, const std::string& path,
                  const std::map<std::string, std::string>& keys,
                  std::map<std::string, std::set<std::string>>& usages)
{
    if (value.is_array()) {
        for (std::size_t index = 0; index < value.size(); ++index)
            named_usages(value.at(index), path + "/" + std::to_string(index), keys, usages);
        return;
    }
    if (!value.is_object()) {
        if (value.is_string() && (path.ends_with("/source") || path.ends_with("/lua/sourceText"))) {
            const auto text = value.get<std::string>();
            if (text.find("Text.msg") != std::string::npos) {
                const auto analysis = analyze_project_text("inline.lua", text);
                if (!analysis.complete)
                    throw std::runtime_error("Incomplete named localization Lua source.");
                for (const auto& message : analysis.messages) {
                    if (message.kind == "named" && keys.contains(message.source))
                        usages[keys.at(message.source)].insert(path);
                }
            }
        }
        return;
    }
    if (value.contains("source") && value.at("source").is_object() &&
        value.at("source").value("kind", std::string{}) == "localized" &&
        value.at("source").contains("key") && value.at("source").at("key").is_string() &&
        keys.contains(value.at("source").at("key").get<std::string>())) {
        const auto name = value.at("source").at("key").get<std::string>();
        usages[keys.at(name)].insert(path + "/source");
        return;
    }
    if (value.size() == 1 && value.contains("$message") && value.at("$message").is_string() &&
        keys.contains(value.at("$message").get<std::string>())) {
        if (path.find("/defaultProperties/") == std::string::npos)
            usages[keys.at(value.at("$message").get<std::string>())].insert(path);
        return;
    }
    for (const auto& [key, child] : value.items())
        named_usages(child, path + "/" + semantic_segment(key), keys, usages);
}

Json resolved_translation(const Json& localization, std::string locale, const std::string& id)
{
    std::set<std::string> visited;
    const auto& translations = localization.at("translations");
    const auto& locales = localization.at("locales");
    while (!locale.empty() && locale != localization.at("sourceLocale").get<std::string>() &&
           visited.insert(locale).second) {
        if (translations.contains(locale) && translations.at(locale).contains(id))
            return translations.at(locale).at(id);
        if (!locales.contains(locale))
            break;
        const auto& parent = locales.at(locale).value("parentLocale", Json(nullptr));
        locale = parent.is_string() ? parent.get<std::string>() : "";
    }
    return nullptr;
}

bool matches_filter(std::string_view filter, std::string_view freshness, const Json& translation,
                    const Json& attention)
{
    if (filter.empty() || filter == freshness)
        return true;
    if (filter == "attention")
        return !attention.empty();
    if (translation.is_null())
        return false;
    return (translation.contains("origin") &&
            json_string_equals(translation.at("origin"), filter)) ||
           (translation.contains("review") && json_string_equals(translation.at("review"), filter));
}

std::vector<const Json*>
matching_tracking_entries(const Json& entry, const NativeLocalizationTrackingOccurrence& candidate)
{
    const auto find_matches = [&](auto predicate) {
        std::vector<const Json*> matches;
        for (const auto& prior : entry.at("occurrences"))
            if (predicate(prior))
                matches.push_back(&prior);
        return matches;
    };
    const auto both = find_matches([&](const Json& prior) {
        return json_string_equals(prior.at("structuralFingerprint"),
                                  candidate.structural_fingerprint) &&
               json_string_equals(prior.at("anchorFingerprint"), candidate.anchor_fingerprint);
    });
    if (both.size() == 1)
        return both;
    const auto structural = find_matches([&](const Json& prior) {
        return json_string_equals(prior.at("structuralFingerprint"),
                                  candidate.structural_fingerprint);
    });
    if (structural.size() == 1)
        return structural;
    const auto anchor = find_matches([&](const Json& prior) {
        return json_string_equals(prior.at("anchorFingerprint"), candidate.anchor_fingerprint);
    });
    return anchor.size() == 1 ? anchor : std::vector<const Json*>{};
}

std::string native_source_message_identity(const Json& localization,
                                           const NativeLocalizationTrackingSource& source,
                                           const NativeLocalizationTrackingOccurrence& candidate)
{
    const auto key = source.family + ":" + source.owner_key + ":" + source.source_path;
    const auto& tracking = localization.at("sourceMessageTracking");
    if (tracking.contains(key)) {
        const auto& entry = tracking.at(key);
        const auto matches = matching_tracking_entries(entry, candidate);
        if (matches.size() == 1) {
            std::size_t reverse = 0;
            for (const auto& other : source.occurrences) {
                const auto other_matches = matching_tracking_entries(entry, other);
                reverse += other_matches.size() == 1 && other_matches.front()->at("messageId") ==
                                                            matches.front()->at("messageId");
            }
            if (reverse == 1)
                return matches.front()->at("messageId").get<std::string>();
        }
        if (json_string_equals(entry.at("sourceSnapshotFingerprint"),
                               source.source_snapshot_fingerprint)) {
            const Json* matched = nullptr;
            for (const auto& prior : entry.at("occurrences")) {
                if (prior.at("ordinal") != candidate.ordinal)
                    continue;
                if (matched) {
                    matched = nullptr;
                    break;
                }
                matched = &prior;
            }
            if (matched)
                return matched->at("messageId").get<std::string>();
        }
    }
    const auto seed = "source-message|" + source.family + "|" + source.owner_key + "|" +
                      source.source_path + "|" + candidate.structural_fingerprint + "|" +
                      candidate.anchor_fingerprint + "|" + candidate.source_fingerprint + "|" +
                      std::to_string(candidate.ordinal);
    const auto hash = fnv1a(seed).substr(sizeof("fnv1a:") - 1);
    const auto variant = (std::stoul(hash.substr(16, 2), nullptr, 16) & 0x3fu) | 0x80u;
    std::ostringstream uuid;
    uuid << hash.substr(0, 8) << '-' << hash.substr(8, 4) << "-5" << hash.substr(13, 3) << '-'
         << std::hex << std::setfill('0') << std::setw(2) << variant << hash.substr(18, 2) << '-'
         << hash.substr(20, 12);
    return uuid.str();
}
} // namespace

Json native_project_localization_view(const Json& request, ProjectSession& session)
{
    if (!request.contains("locale") || !request.at("locale").is_string() ||
        (request.contains("status") && !request.at("status").is_string()))
        return failure("Native localization view requires a target locale and status filter.");
    const auto locale = request.at("locale").get<std::string>();
    const auto status = request.value("status", std::string{});
    static const std::set<std::string> accepted{
        "",      "missing", "current",  "outdated", "needs-review", "reviewed",
        "human", "ai",      "imported", "unknown",  "attention"};
    if (!accepted.contains(status))
        return failure("Unknown localization view status filter.");
    const auto verified = session.validate_project();
    if (!verified.valid) {
        std::string reason = "Native localization view requires a valid disk Project.";
        for (const auto& diagnostic : verified.diagnostics) {
            if (diagnostic.severity != "error")
                continue;
            reason += " " + diagnostic.code + ": " + diagnostic.path + " " + diagnostic.message;
            if (reason.size() > 950)
                break;
        }
        return failure(reason);
    }
    const auto prepared = session.prepare_working(session.snapshot().working_revision);
    if (!prepared.accepted)
        return failure(prepared.error);
    const auto project = Json::parse(prepared.project_json);
    const auto& localization = project.at("localization");
    if (locale == localization.at("sourceLocale").get<std::string>() ||
        !localization.at("locales").contains(locale))
        return failure("Localization view requires a registered target locale.");
    std::map<std::string, Json> messages;
    std::map<std::string, std::set<std::string>> usages;
    std::map<std::string, std::string> named_keys;
    Json presentations = Json::object();
    Json guidance = Json::object();
    for (const auto& [id, source] : localization.at("messages").items()) {
        Json view{{"id", id}, {"kind", source.at("kind")}, {"source", source.at("source")}};
        if (source.value("kind", std::string{}) == "named") {
            view["key"] = source.at("key");
            named_keys[source.at("key").get<std::string>()] = id;
        }
        for (const auto* field_name : {"context", "translatorNote"})
            if (source.contains(field_name))
                view[field_name] = source.at(field_name);
        view["sourceFingerprint"] = message_fingerprint(source);
        presentations[id] =
            fnv1a(std::string("presentation\0", 13) + source.at("source").get<std::string>() +
                  '\0' + pattern_contract(source.value("pattern", Json(nullptr)), 0, false) + '\0');
        guidance[id] = fnv1a(std::string("guidance\0", 9) + source.value("context", std::string{}) +
                             '\0' + source.value("translatorNote", std::string{}));
        messages[id] = std::move(view);
    }
    const auto record_snapshots = session.validated_disk_record_snapshots();
    const auto add_structured = [&](const std::string& path, const std::string& source,
                                    const Json* location, const Json* parent = nullptr) {
        const auto identity = localization.at("structuredMessageIds")
                                  .value(path, native_localization_structured_message_id(path));
        const bool text = location && location->is_object() && location->contains("source") &&
                          location->at("source").is_object();
        const auto markup = text ? location->value("markup", std::string("plain")) : "";
        const auto semantic =
            text && markup == "active-text" ? linguistic(source) : normalized_text(source);
        std::string cue_contract;
        if (parent && parent->is_object() && parent->contains("cues") &&
            parent->at("cues").is_array()) {
            std::vector<Json> cues;
            for (const auto& cue : parent->at("cues"))
                if (cue.is_object() && cue.value("kind", std::string{}) != "active-text" &&
                    cue.value("kind", std::string{}) != "invalid-markup")
                    cues.push_back(cue);
            std::sort(cues.begin(), cues.end(), [](const Json& left, const Json& right) {
                const auto key = [](const Json& cue) {
                    const auto& position = cue.at("position");
                    return std::make_tuple(position.value("offset", 0), position.value("order", 0),
                                           cue.value("id", std::string{}));
                };
                return key(left) < key(right);
            });
            for (const auto& cue : cues) {
                if (!cue_contract.empty())
                    cue_contract += '|';
                cue_contract += cue.at("id").get<std::string>();
            }
        }
        const auto fingerprint =
            fnv1a(std::string("semantic\0", 9) + semantic +
                  (text ? std::string(1, '\0') + cue_contract : std::string(3, '\0')));
        messages[identity] = {{"id", identity},
                              {"kind", "local"},
                              {"source", source},
                              {"sourceFingerprint", fingerprint}};
        std::string cue_presentation;
        if (parent && parent->is_object() && parent->contains("cues") &&
            parent->at("cues").is_array()) {
            std::vector<std::tuple<int, int, std::string>> sorted;
            for (const auto& cue : parent->at("cues")) {
                if (!cue.is_object() || cue.value("kind", std::string{}) == "active-text" ||
                    cue.value("kind", std::string{}) == "invalid-markup")
                    continue;
                const auto& position = cue.at("position");
                sorted.emplace_back(position.value("offset", 0), position.value("order", 0),
                                    cue.at("id").get<std::string>());
            }
            std::sort(sorted.begin(), sorted.end());
            for (const auto& [offset, order, cue_id] : sorted) {
                if (!cue_presentation.empty())
                    cue_presentation += '|';
                cue_presentation +=
                    cue_id + ":" + std::to_string(offset) + ":" + std::to_string(order);
            }
        }
        presentations[identity] = fnv1a(std::string("presentation\0", 13) +
                                        (text ? markup + '\0' + source + '\0' + cue_presentation
                                              : source + std::string(2, '\0')));
        guidance[identity] = fnv1a(std::string("guidance\0\0", 10));
        usages[identity].insert(path);
    };
    static const std::set<std::string> message_families{"characters",   "rooms",  "interactables",
                                                        "dialogues",    "scenes", "verbs",
                                                        "interactions", "maps"};
    const AuthoringRecordResolver resolve_record =
        [&](std::string_view family, std::string_view id) -> std::optional<std::string> {
        const auto found = record_snapshots.find(std::string(family) + "/" + std::string(id));
        return found == record_snapshots.end() || !found->second.valid
                   ? std::nullopt
                   : std::optional<std::string>(found->second.normalized_json);
    };
    for (const auto& [owner, snapshot] : record_snapshots) {
        if (!snapshot.valid || snapshot.normalized_json.empty())
            return failure("Native localization view cannot inspect an invalid record.");
        const auto slash = owner.find('/');
        if (slash == std::string::npos)
            continue;
        const auto family = owner.substr(0, slash);
        const auto id = owner.substr(slash + 1);
        auto record = Json::parse(snapshot.normalized_json);
        named_usages(record, "/" + owner, named_keys, usages);
        if (!message_families.contains(family))
            continue;
        if (family == "rooms" || family == "characters" || family == "interactables") {
            const auto resolved =
                validate_archetype_owner(family, snapshot.normalized_json, resolve_record);
            if (!resolved.accepted)
                return failure("Native localization cannot resolve effective Archetype owner: " +
                               owner);
            if (!resolved.effective_json.empty())
                record = Json::parse(resolved.effective_json);
        }
        for (const auto& [path, source] :
             native_localization_effective_structured_sources(family, id, record.dump())) {
            const auto* location = semantic_value(record, path.substr(owner.size() + 1));
            const Json* parent = nullptr;
            if (family == "dialogues" && path.ends_with("/text")) {
                const auto from_owner = path.substr(owner.size() + 1);
                parent = semantic_value(record, from_owner.substr(0, from_owner.size() - 5));
            }
            add_structured(path, source, location, parent);
        }
    }
    const auto& settings = project.at("settings").at("titleScreen");
    for (const auto* name : {"subtitle", "startLabel"}) {
        const auto path = "/settings/titleScreen/" + std::string(name);
        add_structured(path, settings.at(name).get<std::string>(), &settings.at(name));
    }
    if (!project.at("undefinedInteractionProgram").is_null()) {
        const auto& program = project.at("undefinedInteractionProgram");
        // A Project-level fallback is a schema-owned Message source, just like
        // the program on a gameplay record.
        Json wrapper{{"data", program}};
        for (const auto& [path, source] : native_localization_effective_structured_sources(
                 "project", "fallback", wrapper.dump())) {
            const auto suffix = path.substr(std::string("/project/fallback/data").size());
            const auto semantic_path = "/undefinedInteractionProgram" + suffix;
            add_structured(semantic_path, source, semantic_value(program, suffix));
        }
    }
    // prepare_working() projects manifest/localization owners. Record sources
    // belong to the validated disk-record snapshot, not project_json.
    for (const auto& [owner, snapshot] : record_snapshots) {
        if (!owner.starts_with("archetypes/"))
            continue;
        const auto archetype_id = owner.substr(sizeof("archetypes/") - 1);
        const auto archetype = Json::parse(snapshot.normalized_json);
        const auto effective =
            validate_archetype_dependencies(archetype_id, snapshot.normalized_json, resolve_record);
        if (!effective.accepted || effective.effective_json.empty())
            return failure("Native localization cannot resolve Archetype configuration: " +
                           archetype_id);
        const auto effective_record = Json::parse(effective.effective_json);
        const auto& data = effective_record.at("data");
        const auto source_prefix = "/archetypes/" + semantic_segment(archetype_id) + "/data";
        const auto path_base = "/archetypes/" + semantic_segment(archetype_id) + "/configuration";
        for (const auto& [source_path, source] : native_localization_effective_structured_sources(
                 "archetypes", archetype_id, effective.effective_json)) {
            const auto suffix = source_path.substr(source_prefix.size());
            add_structured(path_base + suffix, source, semantic_value(data, suffix));
        }
    }
    // The read-only identity resolver must also expose unsynced occurrences.
    // Those use deterministic ephemeral IDs until an explicit sync commits
    // their tracking, without manufacturing an on-disk Message identity.
    for (const auto& source : native_project_localization_sources(session)) {
        for (const auto& occurrence : source.occurrences) {
            if (occurrence.kind == "named")
                continue;
            const auto id = native_source_message_identity(localization, source, occurrence);
            const auto& text = occurrence.source_snapshot;
            std::string fingerprint;
            if (source.family == "rml") {
                const auto arguments = placeholder_contract(text);
                std::string contract;
                for (const auto& [key, value] : arguments.items()) {
                    if (!contract.empty())
                        contract += '|';
                    contract += key + ":" + value.get<std::string>();
                }
                fingerprint =
                    fnv1a(std::string("semantic\0", 9) +
                          normalized_text(std::regex_replace(text, std::regex("<[^>]*>"), "")) +
                          '\0' + contract);
                presentations[id] = fnv1a(std::string("presentation\0", 13) + text);
                guidance[id] = fnv1a(std::string("guidance\0\0", 10));
            } else {
                Json msg{{"kind", "named"}, {"source", text}};
                if (occurrence.kind == "plural" || occurrence.kind == "select") {
                    msg["arguments"] = {
                        {"value", occurrence.kind == "plural" ? "plural-number" : "string"}};
                    Json pattern{{"kind", occurrence.kind},
                                 {"argument", "value"},
                                 {"cases", Json::object()}};
                    for (const auto& [key, branch] : occurrence.cases)
                        pattern["cases"][key] = {{"kind", "text"}, {"text", branch}};
                    msg["pattern"] = std::move(pattern);
                } else {
                    auto arguments = placeholder_contract(text);
                    if (!arguments.empty())
                        msg["arguments"] = std::move(arguments);
                }
                fingerprint = message_fingerprint(msg);
                presentations[id] =
                    fnv1a(std::string("presentation\0", 13) + text + '\0' +
                          pattern_contract(msg.value("pattern", Json(nullptr)), 0, false) + '\0');
                guidance[id] =
                    fnv1a(std::string("guidance\0", 9) + occurrence.context_snapshot.value_or("") +
                          '\0' + occurrence.translator_note_snapshot.value_or(""));
            }
            messages[id] = {{"id", id},
                            {"kind", "local"},
                            {"source", text},
                            {"sourceFingerprint", fingerprint}};
            if (occurrence.context_snapshot)
                messages[id]["context"] = *occurrence.context_snapshot;
            if (occurrence.translator_note_snapshot)
                messages[id]["translatorNote"] = *occurrence.translator_note_snapshot;
            usages[id].insert(source.source_path);
        }
    }
    Json output = Json::array();
    for (auto& [id, view] : messages) {
        const auto target = resolved_translation(localization, locale, id);
        const auto freshness =
            target.is_null() ? "missing"
            : target.value("useSource", false) ||
                    target.at("sourceFingerprint") == view.at("sourceFingerprint")
                ? "current"
                : "outdated";
        Json attention = Json::array();
        if (!target.is_null() && !target.value("useSource", false)) {
            if (!presentations.contains(id) || !guidance.contains(id))
                return failure("Missing native localization presentation/guidance fingerprints.");
            if (target.contains("acknowledgedPresentationFingerprint") &&
                target.at("acknowledgedPresentationFingerprint") != presentations.at(id))
                attention.push_back("presentation");
            if (target.contains("acknowledgedGuidanceFingerprint") &&
                target.at("acknowledgedGuidanceFingerprint") != guidance.at(id))
                attention.push_back("guidance");
        }
        if (!matches_filter(status, freshness, target, attention))
            continue;
        view["status"] = freshness;
        view["target"] = target;
        view["attention"] = attention;
        view["usages"] = Json::array();
        for (const auto& path : usages[id])
            view["usages"].push_back(path);
        view["usageNotes"] = Json::array();
        if (view.at("kind") == "named") {
            for (const auto& path : usages[id]) {
                const auto key = (path.ends_with("/source") ? "structured:" : "typed:") + path;
                if (localization.at("usageNotes").contains(key))
                    view["usageNotes"].push_back({{"usageId", key},
                                                  {"path", path},
                                                  {"note", localization.at("usageNotes").at(key)}});
            }
        } else if (localization.at("usageNotes").contains(id)) {
            const auto& paths = usages[id];
            const auto usage_path = paths.empty()
                                        ? "/localization/messages/" + escape_pointer(id) + "/source"
                                        : *paths.begin();
            view["usageNotes"].push_back({{"usageId", id},
                                          {"path", usage_path},
                                          {"note", localization.at("usageNotes").at(id)}});
        }
        if (localization.at("usageNotes").contains(id))
            view["usageNote"] = localization.at("usageNotes").at(id);
        output.push_back(view);
    }
    Json response{{"ok", true}, {"locale", locale}, {"messages", std::move(output)}};
    if (!status.empty())
        response["statusFilter"] = status;
    return response;
}
