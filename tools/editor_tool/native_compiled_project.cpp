#include "native_compiled_project.hpp"

#include "native_authoring_messages.hpp"
#include "native_authoring_programs.hpp"
#include "native_authoring_resources.hpp"
#include "native_authoring_shared.hpp"
#include "native_compiled_project_save_contract.hpp"
#include "native_compiled_locale_tables.hpp"
#include "native_flow_prediction.hpp"

#include <noveltea/core/compiled_project_codec.hpp>

#include <algorithm>
#include <array>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace noveltea::cli {
namespace {
using Json = nlohmann::json;

const Json& object(const Json& value, std::string_view key)
{
    static const Json empty = Json::object();
    if (!value.is_object())
        return empty;
    const auto found = value.find(std::string(key));
    return found != value.end() && found->is_object() ? *found : empty;
}

Json ref(std::string_view kind, const Json& value)
{
    return {{"kind", kind}, {"id", object(value, "$ref").at("id")}};
}

std::string language(std::string locale)
{
    for (char& c : locale)
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c - 'A' + 'a');
    return locale.substr(0, locale.find('-'));
}

// The compiled metadata is a runtime contract, not a host-locale lookup.
// Use the same pinned autonyms as the authoring compiler.
std::string autonym(const std::string& locale)
{
    static const std::map<std::string, std::string> names{
        {"ar", "العربية"},    {"de", "Deutsch"},    {"en", "English"},    {"es", "español"},
        {"fr", "français"},   {"he", "עברית"},      {"hi", "हिन्दी"},      {"it", "italiano"},
        {"ja", "日本語"},     {"ko", "한국어"},     {"nl", "Nederlands"}, {"pl", "polski"},
        {"pt", "português"},  {"ru", "русский"},    {"sv", "svenska"},    {"tr", "Türkçe"},
        {"uk", "українська"}, {"vi", "Tiếng Việt"}, {"zh", "中文"}};
    const auto found = names.find(language(locale));
    return found == names.end() ? locale : found->second;
}

std::string lowercase(std::string value)
{
    for (auto& c : value) {
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c - 'A' + 'a');
        if (c == '_')
            c = '-';
    }
    return value;
}

std::vector<std::string> split(std::string_view source, std::string_view delimiter)
{
    std::vector<std::string> result;
    for (std::size_t begin = 0; begin <= source.size();) {
        const auto end = source.find(delimiter, begin);
        result.emplace_back(source.substr(begin, end == source.npos ? end : end - begin));
        if (end == source.npos)
            break;
        begin = end + delimiter.size();
    }
    return result;
}

std::vector<std::string> locale_candidates(const std::string& locale)
{
    const auto canonical = lowercase(locale);
    const auto components = split(canonical, "-");
    const auto& lang = components.front();
    std::vector<std::string> result{canonical};
    std::string script;
    std::string region;
    for (std::size_t i = 1; i < components.size(); ++i) {
        const auto& part = components[i];
        if (script.empty() && part.size() == 4)
            script = part;
        if (region.empty() &&
            (part.size() == 2 ||
             (part.size() == 3 &&
              std::all_of(part.begin(), part.end(), [](char c) { return c >= '0' && c <= '9'; }))))
            region = part;
    }
    if (!script.empty())
        result.push_back(lang + "-" + script);
    if (!region.empty())
        result.push_back(lang + "-" + region);
    result.push_back(lang);
    return result;
}

using RuleSource = std::pair<std::string, std::string>;
using RuleSources = std::vector<RuleSource>;

const std::map<std::string, RuleSources>& cardinal_sources()
{
    static const auto sources = [] {
        std::map<std::string, RuleSources> result;
        std::istringstream input{std::string(locale_data::cardinal_sources)};
        for (std::string line; std::getline(input, line);) {
            const auto fields = split(line, "|");
            if (fields.size() < 2)
                continue;
            RuleSources rules;
            for (std::size_t i = 1; i < fields.size(); ++i) {
                const auto marker = fields[i].find("=>");
                if (marker != std::string::npos)
                    rules.emplace_back(fields[i].substr(0, marker), fields[i].substr(marker + 2));
            }
            for (const auto& locale : split(fields.front(), " "))
                if (!locale.empty())
                    result[lowercase(locale)] = rules;
        }
        return result;
    }();
    return sources;
}

Json plural_relation(std::string_view text)
{
    static const std::regex grammar(R"(^([nivwfte])(?:\s*%\s*(\d+))?\s*(!=|=)\s*(.+)$)");
    std::smatch match;
    const std::string input(text);
    if (!std::regex_match(input, match, grammar))
        throw std::logic_error("Pinned CLDR cardinal relation is malformed: " + input);
    Json ranges = Json::array();
    for (const auto& source : split(match[4].str(), ",")) {
        const auto parts = split(source, "..");
        const auto minimum = std::stoi(parts.front());
        const auto maximum = parts.size() == 1 ? minimum : std::stoi(parts.back());
        ranges.push_back({{"minimum", minimum}, {"maximum", maximum}});
    }
    return {{"operand", match[1].str()},
            {"modulo", match[2].matched ? Json(std::stoi(match[2].str())) : Json(nullptr)},
            {"negated", match[3].str() == "!="},
            {"ranges", std::move(ranges)}};
}

Json plural_rules(const std::string& locale)
{
    const auto& sources = cardinal_sources();
    for (const auto& candidate : locale_candidates(locale)) {
        const auto it = sources.find(candidate);
        if (it == sources.end())
            continue;
        Json result = Json::array();
        for (const auto& [category, expression] : it->second) {
            Json alternatives = Json::array();
            for (const auto& alternative : split(expression, " or ")) {
                Json relations = Json::array();
                for (const auto& relation : split(alternative, " and "))
                    relations.push_back(plural_relation(relation));
                alternatives.push_back(std::move(relations));
            }
            result.push_back({{"category", category}, {"alternatives", alternatives}});
        }
        return result;
    }
    // CLDR's default cardinal grammar is a single 'other' category.
    return Json::array();
}

const std::map<std::string, Json>& pinned_number_formats()
{
    static const auto formats = [] {
        std::map<std::string, Json> result;
        std::istringstream input{std::string(locale_data::number_format_sources)};
        for (std::string line; std::getline(input, line);) {
            const auto sep = line.find('|');
            if (sep == std::string::npos)
                continue;
            const auto format = Json::parse(line.substr(sep + 1));
            for (const auto& locale : split(std::string_view(line).substr(0, sep), " "))
                if (!locale.empty())
                    result[locale] = format;
        }
        return result;
    }();
    return formats;
}

Json number_format(const std::string& locale)
{
    const auto& formats = pinned_number_formats();
    for (const auto& candidate : locale_candidates(locale))
        if (const auto it = formats.find(candidate); it != formats.end())
            return it->second;
    return {{"decimalSeparator", "."},
            {"groupSeparator", ","},
            {"primaryGroupSize", 3},
            {"secondaryGroupSize", 3},
            {"digits", Json::array({"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"})}};
}

bool right_to_left(const std::string& locale)
{
    static const auto rtl = [] {
        std::set<std::string> result;
        for (const auto& name : split(locale_data::rtl_locales, " "))
            if (!name.empty())
                result.insert(name);
        return result;
    }();
    const auto candidates = locale_candidates(locale);
    // An explicitly requested script takes precedence over the language's
    // likely script; otherwise use the pinned Intl.Locale maximized scripts.
    const auto components = split(lowercase(locale), "-");
    for (const auto& component : components)
        if (component.size() == 4)
            return component == "adlm" || component == "arab" || component == "hebr" ||
                   component == "nkoo" || component == "rohg" || component == "syrc" ||
                   component == "thaa";
    for (const auto& candidate : candidates)
        if (rtl.contains(candidate))
            return true;
    return false;
}
Json localization(const Json& project, const NativeMessageProjection& messages)
{
    const auto& authored = object(project, "localization");
    const auto& all_locales = object(authored, "locales");
    Json result{{"sourceLocale", authored.at("sourceLocale")},
                {"defaultLocale", authored.at("defaultLocale")},
                {"locales", Json::array()},
                {"catalogs", Json::array()}};
    for (const auto& [locale, definition] : all_locales.items()) {
        const auto name = autonym(locale);
        Json font_stack = Json::array();
        const Json& fonts =
            definition.contains("fontStack") && !definition.at("fontStack").is_null()
                ? definition.at("fontStack")
                : project.at("settings").at("text").at("fontStack");
        for (const auto& font : fonts)
            font_stack.push_back(ref("asset", font));
        const Json rules = plural_rules(locale);
        Json categories = Json::array();
        for (const auto& rule : rules)
            categories.push_back(rule.at("category"));
        categories.push_back("other");
        const bool rtl = right_to_left(locale);
        result["locales"].push_back(
            {{"locale", locale},
             {"parentLocale", definition.value("parentLocale", Json(nullptr))},
             {"supported", definition.at("supported")},
             {"nativeName", name},
             {"displayName", definition.value("displayName", Json(name))},
             {"rightToLeft", rtl},
             {"pluralCategories", std::move(categories)},
             {"pluralRules", rules},
             {"numberFormat", number_format(locale)},
             {"fontStack", std::move(font_stack)}});
        result["catalogs"].push_back(
            {{"locale", locale}, {"entries", messages.translated_entries.at(locale)}});
    }
    return result;
}

void validate_closure(const Json& wire)
{
    const auto& resources = wire.at("resources");
    std::map<std::string, std::set<std::string>> available;
    for (const auto* kind : {"asset", "animation", "layout", "script"}) {
        const std::string table = std::string(kind) + "s";
        for (const auto& item : resources.at(table))
            available[kind].insert(item.at("id").get<std::string>());
    }
    std::map<std::string, std::set<std::string>> missing;
    const auto visit = [&](const auto& self, const Json& value) -> void {
        if (value.is_array()) {
            for (const auto& item : value)
                self(self, item);
        } else if (value.is_object()) {
            if (value.contains("id") && value.at("id").is_string() && value.contains("kind") &&
                value.at("kind").is_string()) {
                const auto kind = value.at("kind").get<std::string>();
                if (available.contains(kind) &&
                    !available.at(kind).contains(value.at("id").get<std::string>()))
                    missing[kind].insert(value.at("id").get<std::string>());
            }
            for (const auto& [_, item] : value.items())
                self(self, item);
        }
    };
    visit(visit, wire);
    if (!missing.empty()) {
        const auto& [kind, ids] = *missing.begin();
        throw std::runtime_error("at /resources/" + kind + "s: Referenced " + kind + " '" +
                                 *ids.begin() + "' is absent from the gameplay resource table.");
    }
}
} // namespace

Json compile_native_compiled_project(const Json& project)
{
    if (!project.contains("entrypoint") || project.at("entrypoint").is_null())
        throw std::runtime_error("at /entrypoint: A Room, Scene, or Dialogue entrypoint is "
                                 "required for compiled gameplay.");
    const auto messages = lower_authoring_messages(project);
    Json wire = lower_dialogue_interaction_programs(
        project, messages,
        lower_room_scene_programs(project, messages,
                                  lower_shared_authoring_project(project, messages)));
    const Json identity = lower_static_authoring_identity(project);
    const Json static_resources = lower_static_authoring_resources(messages.lowered_project);
    for (const auto* field : {"bootstrapModule", "entrypoint"})
        wire[field] = identity.at(field);
    for (const auto* field : {"assets", "animations", "scripts"})
        wire["resources"][field] = static_resources.at(field);
    wire["localization"] = localization(project, messages);
    wire["schema"] = "noveltea.compiled.project";
    wire["schemaVersion"] = 1;
    validate_closure(wire);
    if (const auto flow = compile_native_flow_prediction(wire, object(project, "prefetchHints")))
        wire["flowPrediction"] = *flow;
    wire["saveContract"] = compiled_project_save_contract(wire);
    const auto decoded = noveltea::core::decode_compiled_project(wire, "native-cold-compiler");
    if (!decoded) {
        // Preserve actionable, deterministic engine diagnostics instead of
        // returning a generic decoder rejection to the source owner.
        std::vector<std::tuple<std::string, std::string, std::string>> problems;
        for (const auto& item : decoded.error())
            problems.emplace_back(item.json_pointer, item.code, item.message);
        std::sort(problems.begin(), problems.end());
        if (problems.empty())
            throw std::runtime_error("at /compiler: Engine rejected native Compiled Project wire.");
        const auto& [path, code, message] = problems.front();
        throw std::runtime_error("at " + (path.empty() ? std::string("/compiler") : path) +
                                 ": Engine rejected native Compiled Project (" + code +
                                 "): " + message);
    }
    return wire;
}
} // namespace noveltea::cli
