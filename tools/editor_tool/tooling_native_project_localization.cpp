#include "tooling_native_project_localization.hpp"

#include "../project_authoring/room_session.hpp"
#include "../project_authoring/source_authority.hpp"

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
    // ActiveText object cues and shorthand contribute an additional identity
    // contract. Never silently produce a fingerprint without those identities.
    if (source.find('[') != std::string_view::npos || source.find('<') != std::string_view::npos)
        throw std::runtime_error("Named Message requires ActiveText cue fingerprinting.");
    const auto plain = std::regex_replace(std::string(source), std::regex("<[^>]*>"), "");
    return normalized_text(plain);
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
    const auto messages = localization.at("messages");
    Json fingerprints = Json::object();
    std::vector<RoomPatch> patches;
    for (const auto& id_json : request.at("messageIds")) {
        const auto id = id_json.get<std::string>();
        if (!messages.contains(id))
            return failure("Native localization named Message is missing: " + id);
        const auto fingerprint = named_fingerprint(messages.at(id));
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
