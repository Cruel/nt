#include "localization_operations.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <string>
#include <string_view>

namespace noveltea::authoring {
namespace {
using Json = jsoncons::ojson;

std::string token(std::string_view input)
{
    std::string output;
    for (const char c : input) {
        if (c == '~')
            output += "~0";
        else if (c == '/')
            output += "~1";
        else
            output += c;
    }
    return output;
}

void report(std::vector<Diagnostic>& errors, const std::string& path, std::string_view op,
            std::string message)
{
    errors.push_back({path, "semantic." + std::string(op), std::move(message)});
}

bool alpha(std::string_view value, std::size_t lo, std::size_t hi)
{
    return value.size() >= lo && value.size() <= hi &&
           std::all_of(value.begin(), value.end(), [](unsigned char c) {
               return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
           });
}

bool alnum(std::string_view value, std::size_t lo, std::size_t hi)
{
    return value.size() >= lo && value.size() <= hi &&
           std::all_of(value.begin(), value.end(), [](unsigned char c) {
               return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
           });
}

std::string lower(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

std::string upper(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return value;
}

std::optional<std::string> canonical_locale(std::string_view raw)
{
    std::vector<std::string> tags;
    std::size_t start = 0;
    for (;;) {
        const auto end = raw.find('-', start);
        if (end == start)
            return std::nullopt;
        tags.emplace_back(raw.substr(start, end == std::string_view::npos ? end : end - start));
        if (end == std::string_view::npos)
            break;
        start = end + 1;
    }
    if (tags.empty() || !alpha(tags.front(), 2, 8))
        return std::nullopt;
    std::size_t i = 1;
    std::vector<std::string> out{lower(tags.front())};
    const auto current = [&]() -> std::string_view {
        return i < tags.size() ? std::string_view(tags[i]) : std::string_view{};
    };
    if (tags.front().size() <= 3)
        for (int count = 0; count < 3 && alpha(current(), 3, 3); ++count)
            out.push_back(lower(tags[i++]));
    if (alpha(current(), 4, 4)) {
        auto script = lower(tags[i++]);
        script[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(script[0])));
        out.push_back(std::move(script));
    }
    if (alpha(current(), 2, 2) ||
        (current().size() == 3 &&
         std::all_of(current().begin(), current().end(),
                     [](unsigned char c) { return c >= '0' && c <= '9'; })))
        out.push_back(upper(tags[i++]));
    std::set<std::string> variants;
    while (alnum(current(), 5, 8) || (current().size() == 4 && current()[0] >= '0' &&
                                      current()[0] <= '9' && alnum(current(), 4, 4))) {
        auto value = lower(tags[i++]);
        if (!variants.insert(value).second)
            return std::nullopt;
        out.push_back(std::move(value));
    }
    std::set<std::string> extensions;
    while (alnum(current(), 1, 1) && lower(std::string(current())) != "x") {
        auto value = lower(tags[i++]);
        if (!extensions.insert(value).second)
            return std::nullopt;
        out.push_back(std::move(value));
        int count = 0;
        while (alnum(current(), 2, 8)) {
            out.push_back(lower(tags[i++]));
            ++count;
        }
        if (!count)
            return std::nullopt;
    }
    if (lower(std::string(current())) == "x") {
        out.push_back("x");
        ++i;
        int count = 0;
        while (alnum(current(), 1, 8)) {
            out.push_back(lower(tags[i++]));
            ++count;
        }
        if (!count)
            return std::nullopt;
    }
    if (i != tags.size())
        return std::nullopt;
    std::string joined;
    for (const auto& value : out) {
        if (!joined.empty())
            joined += '-';
        joined += value;
    }
    return joined;
}

// Category sets correspond to the vendored CLDR cardinal source used by the
// TypeScript generator. No plural number evaluator is needed for validation.
const std::map<std::string, std::set<std::string>>& cardinal_categories()
{
    static const auto categories = [] {
        std::map<std::string, std::set<std::string>> result;
        const auto add = [&](std::string_view locales, std::string_view cases) {
            std::string remaining(locales);
            std::istringstream locale_stream(remaining);
            std::string locale;
            std::set<std::string> required{"other"};
            std::istringstream case_stream{std::string(cases)};
            std::string category;
            while (case_stream >> category)
                required.insert(category);
            while (locale_stream >> locale) {
                std::replace(locale.begin(), locale.end(), '_', '-');
                result.emplace(lower(locale), required);
            }
        };
        add("bm bo dz hnj id ig ii in ja jbo jv jw kde kea km ko lkt lo ms my nqo osa root sah ses "
            "sg su th to tpi wo yo yue zh",
            "");
        add("am as bn doi fa gu hi kn kok kok_Latn pcm tg vi zu ff hy kab ast de en et fi fy ia ie "
            "io ji lij nl sc sv sw ur yi si ak bho csw guw ln mg nso pa ti wa tzm af an asa az bal "
            "bem bez bg brx ce cgg chr ckb dv ee el eo eu fo fur gsw ha haw hu jgo jmc ka kaj kcg "
            "kk kkj kl ks ksb ku ky lb lg mas mgo ml mn mr nah nb nd ne nn nnh no nr ny nyn om or "
            "os pap ps rm rof rwk saq sd sdh seh sn so sq ss ssy st syr ta te teo tig tk tn tr ts "
            "ug uz ve vo vun wae xh xog da is mk ceb fil tl",
            "one");
        add("lv prg lag blo cv ksh", "zero one");
        add("he iw iu naq sat se sma smi smj smn sms", "one two");
        add("shi", "one few");
        add("mo ro bs hr sh sr", "one few");
        add("gd sl dsb hsb", "one two few");
        add("fr pt ca gl it lld pt_PT scn vec es", "one many");
        add("cs sk pl lt ru uk", "one few many");
        add("sgs", "one two few many");
        add("br mt ga gv", "one two few many");
        add("kw ar ars cy", "zero one two few many");
        return result;
    }();
    return categories;
}

std::set<std::string> plural_categories(const std::string& locale)
{
    auto current = lower(locale);
    const auto& all = cardinal_categories();
    if (auto it = all.find(current); it != all.end())
        return it->second;
    const auto separator = current.find('-');
    if (separator != std::string::npos)
        current.resize(separator);
    if (auto it = all.find(current); it != all.end())
        return it->second;
    return {"other"};
}

std::set<std::string> placeholders(const std::string& source)
{
    static const std::regex valid(R"(^[A-Za-z_][A-Za-z0-9_-]*$)");
    std::set<std::string> found;
    for (std::size_t i = 0; i < source.size(); ++i) {
        if (source[i] != '{')
            continue;
        if (i + 1 < source.size() && source[i + 1] == '{') {
            ++i;
            continue;
        }
        const auto end = source.find('}', i + 1);
        if (end == std::string::npos)
            continue;
        const auto name = source.substr(i + 1, end - i - 1);
        if (std::regex_match(name, valid))
            found.insert(name);
        i = end;
    }
    return found;
}

struct Selector {
    std::string kind;
    std::set<std::string> cases;
};

void pattern_contract(const Json& node, const std::string& locale, std::set<std::string>& names,
                      std::map<std::string, Selector>& selectors,
                      std::vector<std::pair<std::string, std::string>>& gaps)
{
    if (node.at("kind") == "text") {
        names.merge(placeholders(node.at("text").as<std::string>()));
        return;
    }
    const auto kind = node.at("kind").as<std::string>();
    const auto argument = node.at("argument").as<std::string>();
    std::set<std::string> cases;
    const auto& branches = node.at("cases");
    for (const auto& entry : branches.object_range())
        cases.insert(std::string(entry.key()));
    if (kind == "plural")
        for (const auto& category : plural_categories(locale))
            if (!cases.contains(category))
                gaps.emplace_back(argument, category);
    Selector current{kind, kind == "select" ? cases : std::set<std::string>{}};
    const auto it = selectors.find(argument);
    if (it == selectors.end())
        selectors.emplace(argument, current);
    else if (it->second.kind != current.kind || it->second.cases != current.cases)
        it->second = {"select", {}};
    for (const auto& branch : branches.object_range())
        pattern_contract(branch.value(), locale, names, selectors, gaps);
}

std::vector<std::string> selector_signatures(const Json& root)
{
    std::vector<std::string> result;
    const auto walk = [&](const auto& self, const Json& node) -> void {
        if (node.at("kind") == "text")
            return;
        std::string signature =
            node.at("kind").as<std::string>() + ":" + node.at("argument").as<std::string>();
        if (node.at("kind") == "select") {
            std::vector<std::string> keys;
            for (const auto& branch : node.at("cases").object_range())
                keys.emplace_back(branch.key());
            std::sort(keys.begin(), keys.end());
            for (const auto& key : keys)
                signature += ":" + key;
        }
        result.push_back(std::move(signature));
        for (const auto& branch : node.at("cases").object_range())
            self(self, branch.value());
    };
    walk(walk, root);
    std::sort(result.begin(), result.end());
    return result;
}

const std::set<std::string>& system_keys()
{
    static const std::set<std::string> keys{"noveltea.shell.game_menu",
                                            "noveltea.shell.paused",
                                            "noveltea.shell.resume",
                                            "noveltea.shell.save",
                                            "noveltea.shell.load",
                                            "noveltea.shell.text_log",
                                            "noveltea.shell.settings",
                                            "noveltea.shell.title",
                                            "noveltea.shell.quit",
                                            "noveltea.shell.back",
                                            "noveltea.shell.menu",
                                            "noveltea.save.no_thumbnail",
                                            "noveltea.settings.ui_scale",
                                            "noveltea.settings.text_scale",
                                            "noveltea.settings.minimum",
                                            "noveltea.settings.default_scale",
                                            "noveltea.settings.maximum",
                                            "noveltea.text_log.history",
                                            "noveltea.text_log.title",
                                            "noveltea.text_log.empty",
                                            "noveltea.confirmation.confirm",
                                            "noveltea.confirmation.prompt",
                                            "noveltea.confirmation.cancel",
                                            "noveltea.verb_menu.actions",
                                            "noveltea.common.close",
                                            "noveltea.inventory.title",
                                            "noveltea.command_builder.command",
                                            "noveltea.game.nearby",
                                            "noveltea.status.saved",
                                            "noveltea.status.settings_updated",
                                            "noveltea.confirmation.return_to_title",
                                            "noveltea.confirmation.quit",
                                            "noveltea.confirmation.load",
                                            "noveltea.settings.language",
                                            "noveltea.status.language_updated",
                                            "noveltea.status.language_change_failed",
                                            "noveltea.shell.licenses",
                                            "noveltea.licenses.engine",
                                            "noveltea.licenses.project",
                                            "noveltea.licenses.empty",
                                            "noveltea.licenses.engine_unavailable",
                                            "noveltea.licenses.invalid",
                                            "noveltea.licenses.scroll_up",
                                            "noveltea.licenses.scroll_down"};
    return keys;
}

void validate_localization(const Json& model, const std::string& prefix,
                           std::vector<Diagnostic>& errors)
{
    constexpr std::string_view id = "localization.validate";
    const auto& locales = model.at("locales");
    const auto& source = model.at("sourceLocale").as<std::string>();
    const auto& default_locale = model.at("defaultLocale").as<std::string>();
    const auto& lock = model.at("sourceLocaleLock");
    const auto declared = [&](const std::string& locale) { return locales.contains(locale); };
    if (!declared(source))
        report(errors, prefix + "/locales/" + token(source), id,
               "Source locale '" + source + "' must be declared.");
    if (!lock.is_null()) {
        const auto value = lock.as<std::string>();
        if (!declared(value))
            report(errors, prefix + "/sourceLocaleLock", id,
                   "Source locale lock '" + value + "' must be a declared locale.");
        if (value != source)
            report(errors, prefix + "/sourceLocale", id,
                   "Source locale cannot change from locked locale '" + value +
                       "' after substantive localization work exists.");
    }
    if (!declared(default_locale))
        report(errors, prefix + "/locales/" + token(default_locale), id,
               "Default locale '" + default_locale + "' must be declared.");
    else if (!locales.at(default_locale).at("supported").as<bool>())
        report(errors, prefix + "/locales/" + token(default_locale) + "/supported", id,
               "Default locale '" + default_locale + "' must be Supported.");

    for (const auto& entry : model.at("sourceMessageTracking").object_range()) {
        const auto& tracking = entry.value();
        const auto expected = tracking.at("family").as<std::string>() + ":" +
                              tracking.at("ownerKey").as<std::string>() + ":" +
                              tracking.at("sourcePath").as<std::string>();
        if (entry.key() != expected)
            report(errors, prefix + "/sourceMessageTracking/" + token(entry.key()), id,
                   "Source Message tracking key must be '" + expected + "'.");
    }
    for (const auto& entry : model.at("orphanedMessages").object_range()) {
        const auto& orphan = entry.value();
        const auto base = prefix + "/orphanedMessages/" + token(entry.key());
        if (orphan.at("occurrence").at("messageId") != entry.key())
            report(errors, base + "/occurrence/messageId", id,
                   "Orphaned Message key '" + std::string(entry.key()) +
                       "' must match its occurrence Message ID.");
        for (const auto& translation : orphan.at("translations").object_range())
            if (!declared(std::string(translation.key())) || translation.key() == source)
                report(errors, base + "/translations/" + token(translation.key()), id,
                       "Orphaned Message translation locale '" + std::string(translation.key()) +
                           "' must be a declared target locale.");
    }

    std::map<std::string, std::string> named_keys;
    for (const auto& entry : model.at("messages").object_range()) {
        const auto& message = entry.value();
        const auto base = prefix + "/messages/" + token(entry.key());
        std::set<std::string> names = placeholders(message.at("source").as<std::string>());
        std::map<std::string, Selector> selectors;
        std::vector<std::pair<std::string, std::string>> gaps;
        const bool patterned = message.contains("pattern");
        if (patterned)
            pattern_contract(message.at("pattern"), source, names, selectors, gaps);
        const auto& args = message.contains("arguments") ? message.at("arguments") : Json::object();
        for (const auto& name : names)
            if (!args.contains(name))
                report(errors, base + (patterned ? "/pattern" : "/source"), id,
                       "Message placeholder '{" + name + "}' requires a declared argument.");
        for (const auto& [argument, selector] : selectors) {
            const auto required = selector.kind == "plural" ? "plural-number" : "string";
            if (!args.contains(argument) || args.at(argument) != required)
                report(errors, base + "/arguments/" + token(argument), id,
                       "Message " + selector.kind + " selector '" + argument +
                           "' requires argument type '" + required + "'.");
        }
        for (const auto& [argument, category] : gaps)
            report(errors, base + "/pattern", id,
                   "Plural selector '" + argument + "' requires '" + category + "' for locale '" +
                       source + "'.");
        if (message.at("kind") != "named")
            continue;
        const auto key = message.at("key").as<std::string>();
        if ((key == "noveltea" || key.starts_with("noveltea.")) && !system_keys().contains(key))
            report(errors, base + "/key", id,
                   "Named Message key '" + key +
                       "' is reserved for engine-owned NovelTea Messages.");
        if (system_keys().contains(key) && !args.empty())
            report(errors, base + "/arguments", id,
                   "System Message '" + key +
                       "' must preserve its engine-owned argument contract.");
        if (const auto [previous, inserted] = named_keys.emplace(key, std::string(entry.key()));
            !inserted)
            report(errors, base + "/key", id,
                   "Named Message key '" + key + "' is already used by Message '" +
                       previous->second + "'.");
    }

    for (const auto& entry : locales.object_range()) {
        const auto locale = std::string(entry.key());
        const auto& parent = entry.value().at("parentLocale");
        const auto prefix_locale = prefix + "/locales/" + token(locale) + "/parentLocale";
        if (!parent.is_null()) {
            const auto ancestor = parent.as<std::string>();
            if (!declared(ancestor))
                report(errors, prefix_locale, id,
                       "Parent locale '" + ancestor + "' must be declared.");
            else if (ancestor == locale)
                report(errors, prefix_locale, id, "A locale cannot inherit from itself.");
        }
    }
    for (const auto& entry : locales.object_range()) {
        const auto locale = std::string(entry.key());
        std::set<std::string> visited;
        std::string current = locale;
        while (declared(current)) {
            if (!visited.insert(current).second) {
                report(errors, prefix + "/locales/" + token(locale) + "/parentLocale", id,
                       "Locale inheritance for '" + locale + "' contains a cycle.");
                break;
            }
            const auto& parent = locales.at(current).at("parentLocale");
            if (parent.is_null())
                break;
            current = parent.as<std::string>();
        }
    }
    for (const auto& entry : model.at("translations").object_range()) {
        const auto locale = std::string(entry.key());
        if (!declared(locale))
            report(errors, prefix + "/translations/" + token(locale), id,
                   "Translation locale '" + locale + "' must be declared.");
        if (locale == source)
            report(errors, prefix + "/translations/" + token(locale), id,
                   "Source locale text is stored on Messages, not as target translations.");
    }
    // A translation is not valid just because its YAML matches its schema:
    // source Message identity, placeholders, selectors, and Dialogue Cues
    // impose cross-fragment requirements owned by the target locale file.
    std::set<std::string> known_message_ids;
    for (const auto& message : model.at("messages").object_range())
        known_message_ids.insert(std::string(message.key()));
    for (const auto& tracking : model.at("sourceMessageTracking").object_range())
        for (const auto& occurrence : tracking.value().at("occurrences").array_range())
            known_message_ids.insert(occurrence.at("messageId").as<std::string>());
    for (const auto& locales_entry : model.at("translations").object_range()) {
        const auto locale = std::string(locales_entry.key());
        for (const auto& translated : locales_entry.value().object_range()) {
            const auto message_id = std::string(translated.key());
            const auto path = prefix + "/translations/" + token(locale) + "/" + token(message_id);
            const auto& translation = translated.value();
            if (!known_message_ids.contains(message_id)) {
                report(errors, path, id,
                       "Translation references unknown Message '" + message_id + "'.");
                continue;
            }
            if (!model.at("messages").contains(message_id) ||
                (translation.contains("useSource") && translation.at("useSource") == true))
                continue;
            const auto& message = model.at("messages").at(message_id);
            const bool source_pattern = message.contains("pattern");
            const bool target_pattern = translation.contains("pattern");
            if (source_pattern != target_pattern)
                report(errors, path, id,
                       source_pattern ? "Translation must provide the Message selector pattern."
                                      : "Translation cannot introduce selector grammar absent from "
                                        "the source Message.");
            std::set<std::string> source_names;
            std::set<std::string> target_names;
            std::map<std::string, Selector> source_selectors, target_selectors;
            std::vector<std::pair<std::string, std::string>> gaps;
            if (source_pattern)
                pattern_contract(message.at("pattern"), source, source_names, source_selectors,
                                 gaps);
            else
                source_names = placeholders(message.at("source").as<std::string>());
            gaps.clear();
            if (target_pattern) {
                pattern_contract(translation.at("pattern"), locale, target_names, target_selectors,
                                 gaps);
                for (const auto& [argument, category] : gaps)
                    report(errors, path + "/pattern", id,
                           "Plural selector '" + argument + "' requires '" + category +
                               "' for locale '" + locale + "'.");
            } else
                target_names = placeholders(translation.at("text").as<std::string>());
            if (source_pattern && target_pattern) {
                if (selector_signatures(message.at("pattern")) !=
                    selector_signatures(translation.at("pattern")))
                    report(errors, path + "/pattern", id,
                           "Translation must preserve the source Message selector contract.");
            }
            for (const auto& name : source_names)
                if (!target_names.contains(name))
                    report(errors, path + "/text", id,
                           "Translation must preserve required placeholder '{" + name + "}'.");
            for (const auto& name : target_names)
                if (!source_names.contains(name))
                    report(errors, path + "/text", id,
                           "Translation introduces undeclared placeholder '{" + name + "}'.");
        }
    }
    for (const auto& entry : model.at("assets").object_range()) {
        const auto locale = std::string(entry.key());
        if (!declared(locale))
            report(errors, prefix + "/assets/" + token(locale), id,
                   "Localized Asset locale '" + locale + "' must be declared.");
        if (locale == source)
            report(errors, prefix + "/assets/" + token(locale), id,
                   "Source locale uses semantic base Assets directly.");
    }
}
} // namespace

bool is_canonical_localization_locale(std::string_view locale)
{
    const auto canonical = canonical_locale(locale);
    return canonical && *canonical == locale;
}

void apply_localization_operation(std::string_view operation, Json& value, const std::string& path,
                                  std::vector<Diagnostic>& errors)
{
    if (operation == "localization.locale-id") {
        if (!value.is_string())
            return;
        const auto locale = value.as<std::string>();
        const auto canonical = canonical_locale(locale);
        if (!canonical)
            report(errors, path, operation,
                   "Locale '" + locale + "' is not a valid BCP 47 locale tag.");
        else if (*canonical != locale)
            report(errors, path, operation,
                   "Locale '" + locale + "' must be a canonical BCP 47 locale tag ('" + *canonical +
                       "').");
    } else if (operation == "localization.pattern.plural" ||
               operation == "localization.pattern.select") {
        if (value.is_object() && value.contains("cases") && value.at("cases").is_object() &&
            !value.at("cases").contains("other"))
            report(errors, path + "/cases/other", operation,
                   operation == "localization.pattern.plural"
                       ? "Plural Message selector requires an 'other' case."
                       : "Select Message selector requires an 'other' fallback.");
    } else if (operation == "localization.validate") {
        if (value.is_object())
            validate_localization(value, path, errors);
    } else if (operation == "localization.lock-source") {
        if (!value.is_object() || !value.contains("sourceLocaleLock") ||
            !value.at("sourceLocaleLock").is_null())
            return;
        const auto substantive = [](const Json& entries) {
            for (const auto& locale : entries.object_range())
                if (!locale.value().empty())
                    return true;
            return false;
        };
        if (substantive(value.at("translations")) || substantive(value.at("assets")))
            value.insert_or_assign("sourceLocaleLock", value.at("sourceLocale"));
    }
}
bool is_localization_system_message_key(std::string_view key)
{
    return system_keys().contains(std::string(key));
}
} // namespace noveltea::authoring
