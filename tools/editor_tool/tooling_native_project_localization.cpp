#include "tooling_native_project_localization.hpp"

#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"
#include "../project_authoring/source_analysis.hpp"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <regex>
#include <set>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Json = nlohmann::json;
using namespace noveltea::authoring;

Json failure(std::string message) { return {{"ok", false}, {"error", std::move(message)}}; }

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

std::string pattern_contract(const Json& pattern, int depth = 0)
{
    if (pattern.is_null())
        return {};
    if (!pattern.is_object() || depth > 32 || !pattern.contains("kind") ||
        !pattern.at("kind").is_string())
        throw std::runtime_error("Unsupported native Message pattern.");
    const auto kind = pattern.at("kind").get<std::string>();
    if (kind == "text")
        return Json::array({"text", linguistic(pattern.at("text").get<std::string>())}).dump();
    if (kind != "select" && kind != "plural")
        throw std::runtime_error("Unsupported native Message pattern branch.");
    Json cases = Json::array();
    for (const auto& [key, branch] : pattern.at("cases").items())
        cases.push_back(Json::array({key, pattern_contract(branch, depth + 1)}));
    return Json::array({kind, pattern.at("argument"), cases}).dump();
}

std::string named_fingerprint(const Json& message)
{
    if (!message.is_object() || message.value("kind", std::string{}) != "named")
        throw std::runtime_error("Named Message workflow requires a named Message.");
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

Json tracked_message_fingerprints(const Json& localization, const ProjectSession& session)
{
    Json fingerprints = Json::object();
    const auto& tracking = localization.at("sourceMessageTracking");
    const auto collect = [&](const std::string& source_key, const SourceAnalysis& analysis,
                             bool is_lua) {
        if (!tracking.contains(source_key))
            return;
        std::vector<const ManagedSourceOccurrence*> managed;
        for (const auto& message : analysis.messages)
            managed.push_back(&message);
        for (const auto& target : tracking.at(source_key).at("occurrences")) {
            const auto ordinal = target.at("ordinal").get<std::size_t>();
            if (ordinal >= managed.size())
                continue;
            const auto& message = *managed[ordinal];
            if (message.kind == "named")
                continue;
            if (message.source != target.at("sourceSnapshot").get<std::string>())
                continue; // No stale identity may be accepted as an active Message.
            const auto id = target.at("messageId").get<std::string>();
            if (is_lua) {
                Json view{{"kind", "named"}, {"source", message.source}};
                if (message.kind == "plural" || message.kind == "select") {
                    view["arguments"] = {
                        {"value", message.kind == "plural" ? "plural-number" : "string"}};
                    Json pattern{
                        {"kind", message.kind}, {"argument", "value"}, {"cases", Json::object()}};
                    for (const auto& [key, value] : message.cases)
                        pattern["cases"][key] = {{"kind", "text"}, {"text", value}};
                    view["pattern"] = std::move(pattern);
                } else {
                    const auto arguments = placeholder_contract(message.source);
                    if (!arguments.empty())
                        view["arguments"] = arguments;
                }
                fingerprints[id] = named_fingerprint(view);
            } else {
                auto plain =
                    normalized_text(std::regex_replace(message.source, std::regex("<[^>]*>"), ""));
                const auto arguments = placeholder_contract(message.source);
                std::string contract;
                for (const auto& [key, value] : arguments.items()) {
                    if (!contract.empty())
                        contract += '|';
                    contract += key + ":" + value.get<std::string>();
                }
                fingerprints[id] = fnv1a(std::string("semantic\0", 9) + plain + '\0' + contract);
            }
        }
    };
    for (const auto& [physical, analysis] : session.source_analyses()) {
        if (!physical.starts_with("inline/") || !physical.ends_with(".lua"))
            continue;
        const auto relative = physical.substr(std::string("inline/").size());
        const auto collection_end = relative.find('/');
        const auto id_end = collection_end == std::string::npos
                                ? std::string::npos
                                : relative.find('/', collection_end + 1);
        if (id_end == std::string::npos || relative.size() <= 4)
            continue;
        const auto collection = relative.substr(0, collection_end);
        const auto record_id = relative.substr(collection_end + 1, id_end - collection_end - 1);
        std::string source_path{"/"};
        source_path.append(relative.data(), relative.size() - 4);
        collect("lua:record:" + collection + ":" + record_id + ":" + source_path, analysis, true);
    }
    for (const auto& [owner, snapshot] : session.validated_disk_record_snapshots()) {
        if (!owner.starts_with("layouts/") || !snapshot.valid || snapshot.normalized_json.empty())
            continue;
        const auto data = Json::parse(snapshot.normalized_json).at("data");
        if (!data.contains("rml") || !data.at("rml").is_object())
            continue;
        const auto& rml = data.at("rml");
        if (rml.value("sourceMode", std::string{}) != "inline" || !rml.contains("sourceText") ||
            !rml.at("sourceText").is_string())
            continue;
        const auto id = owner.substr(std::string("layouts/").size());
        const auto path = "/layouts/" + id + "/data/rml/sourceText";
        const auto analysis =
            analyze_project_text("inline" + path + ".rml", rml.at("sourceText").get<std::string>());
        collect("rml:record:layouts:" + id + ":" + path, analysis, false);
    }
    return fingerprints;
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
    const auto validated = session.validate_project();
    if (!validated.valid)
        return failure("Native localization workflow requires a valid disk Project.");
    const auto prepared = session.prepare_working(session.snapshot().working_revision);
    if (!prepared.accepted)
        return failure(prepared.error);
    const auto project = Json::parse(prepared.project_json);
    const auto& localization = project.at("localization");
    if (locale == localization.at("sourceLocale") || !localization.at("locales").contains(locale))
        return failure("Invalid target translation locale.");
    const auto path = "i18n/locales/" + locale + ".yaml";
    const auto owner = path;
    const auto& messages = localization.at("messages");
    const auto local_fingerprints = tracked_message_fingerprints(localization, session);
    Json fingerprints = Json::object();
    std::vector<RoomPatch> patches;
    for (const auto& id_json : request.at("messageIds")) {
        const auto id = id_json.get<std::string>();
        std::string fingerprint;
        if (messages.contains(id)) {
            auto message = messages.at(id);
            if (message.value("kind", std::string{}) == "local")
                message["kind"] = "named";
            fingerprint = named_fingerprint(message);
        } else if (local_fingerprints.contains(id)) {
            fingerprint = local_fingerprints.at(id).get<std::string>();
        } else {
            return failure("Native localization Message is missing or has stale source identity: " +
                           id);
        }
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
                {"fingerprints", std::move(fingerprints)},
                {"writes", Json::array()}};
    if (operation == "inspect" || dry_run || patches.empty())
        return result;
    if (!request.at("sourceRevision").is_string() ||
        request.at("sourceRevision").get<std::string>() !=
            exact_source_revision(bytes_at(root / path)))
        return failure("Stale native localization source precondition.");
    const auto patched = session.patch(session.snapshot().working_revision, patches,
                                       {{owner, request.at("sourceRevision").get<std::string>()}});
    if (!patched.accepted)
        return failure(patched.error);
    const auto saved = session.save_owners(patched.snapshot.working_revision, {owner}, false,
                                           TransactionDecision::KeepComments);
    if (!saved.accepted)
        return failure(saved.error);
    if (!saved.affected_records.empty())
        result["writes"] = Json::array({path});
    return result;
}
