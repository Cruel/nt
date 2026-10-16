#include "localization_semantics.hpp"

#include "localization_operations.hpp"
#include "yaml_codec.hpp"

#include <jsoncons/json.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
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

ValidationResult
validate_project_localization(const std::filesystem::path& project_root,
                              const std::map<std::string, std::string>& source_overlays)
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
        const auto validation = validate_record("WorkspaceLocalization", model.to_string());
        for (const auto& issue : validation.diagnostics) {
            auto diagnostic = issue;
            diagnostic.path = "/localization" + diagnostic.path;
            diagnostic.source_path = owner_for_path(diagnostic.path);
            result.diagnostics.push_back(std::move(diagnostic));
        }
        result.accepted = result.diagnostics.empty();
        if (result.accepted)
            result.effective_json = validation.effective_json;
    } catch (const std::exception& error) {
        add(result, "/localization", "localization.source.failure", error.what(),
            "i18n/project.yaml");
    }
    return result;
}
} // namespace noveltea::authoring
