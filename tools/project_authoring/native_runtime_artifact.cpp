#include "native_runtime_artifact.hpp"

#include "native_authoring_messages.hpp"
#include "native_runtime_materials.hpp"
#include "tooling_native_project_localization.hpp"
#include "localization_semantics.hpp"

#include <noveltea/core/compiled_project_codec.hpp>
#include <noveltea/core/message_realization.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <iomanip>
#include <map>
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
    const auto it = value.find(std::string(key));
    return it != value.end() && it->is_object() ? *it : empty;
}

const Json& array(const Json& value, std::string_view key)
{
    static const Json empty = Json::array();
    if (!value.is_object())
        return empty;
    const auto it = value.find(std::string(key));
    return it != value.end() && it->is_array() ? *it : empty;
}

std::string string(const Json& value, std::string_view key, std::string fallback = {})
{
    if (!value.is_object())
        return fallback;
    const auto it = value.find(std::string(key));
    return it != value.end() && it->is_string() ? it->get<std::string>() : fallback;
}

std::string ref_id(const Json& reference) { return string(object(reference, "$ref"), "id"); }

std::string physical_source_path(std::string_view root, const std::string& relative)
{
    if (relative.empty() || relative.front() == '\\' ||
        (relative.size() > 1 && std::isalpha(static_cast<unsigned char>(relative.front())) &&
         relative[1] == ':'))
        throw std::runtime_error("Runtime package source path is empty or external: '" + relative +
                                 "'.");
    const auto path = std::filesystem::u8path(relative);
    if (path.is_absolute() || path.has_root_name())
        throw std::runtime_error("Runtime package source must be Project-relative: '" + relative +
                                 "'.");
    for (const auto& component : path)
        if (component == ".." || component == ".")
            throw std::runtime_error("Runtime package source contains traversal: '" + relative +
                                     "'.");
    return root.empty() ? relative
                        : (std::filesystem::u8path(std::string(root)) / path).generic_string();
}

// TypeScript's hashString operates on UTF-16 code units, not UTF-8 bytes.
std::string js_fingerprint(std::string_view utf8)
{
    std::uint32_t hash = 2166136261u;
    for (std::size_t i = 0; i < utf8.size();) {
        const auto lead = static_cast<unsigned char>(utf8[i++]);
        std::uint32_t codepoint = lead;
        unsigned continuation = 0;
        if ((lead & 0xe0) == 0xc0) {
            codepoint = lead & 0x1f;
            continuation = 1;
        } else if ((lead & 0xf0) == 0xe0) {
            codepoint = lead & 0x0f;
            continuation = 2;
        } else if ((lead & 0xf8) == 0xf0) {
            codepoint = lead & 0x07;
            continuation = 3;
        }
        for (unsigned j = 0; j < continuation && i < utf8.size(); ++j)
            codepoint = (codepoint << 6) | (static_cast<unsigned char>(utf8[i++]) & 0x3f);
        const auto consume = [&](std::uint32_t codeunit) {
            hash ^= codeunit;
            hash *= 16777619u;
        };
        if (codepoint >= 0x10000) {
            codepoint -= 0x10000;
            consume(0xd800 + (codepoint >> 10));
            consume(0xdc00 + (codepoint & 0x3ff));
        } else {
            consume(codepoint);
        }
    }
    std::ostringstream result;
    result << "fnv1a:" << std::hex << std::setfill('0') << std::setw(8) << hash;
    return result.str();
}

Json diagnostic(std::string code, std::string severity, std::string path, std::string message,
                std::string category = "Localization export")
{
    return {{"code", std::move(code)},
            {"severity", std::move(severity)},
            {"path", path},
            {"message", std::move(message)},
            {"category", std::move(category)},
            {"boundaries", Json::array({"runtime-package", "platform-export"})},
            {"ownerPaths", Json::array({path})}};
}

Json effective_target(const Json& project, std::string locale, const std::string& id,
                      std::string_view family)
{
    const auto& localization = object(project, "localization");
    const auto& targets = object(localization, family);
    const auto& locales = object(localization, "locales");
    const auto source = string(localization, "sourceLocale");
    std::set<std::string> visited;
    while (!locale.empty() && locale != source && visited.insert(locale).second) {
        const auto& translations = object(targets, locale);
        if (translations.contains(id))
            return translations.at(id);
        locale = string(object(locales, locale), "parentLocale");
    }
    return nullptr;
}

std::string fingerprint(const Json& project, const Json& profile, const Json& recovery)
{
    Json content = project;
    content.erase("editor");
    content["tests"] = Json::object();
    for (const auto* collection :
         {"assets", "animations", "variables", "materials", "layouts", "archetypes", "characters",
          "rooms", "interactables", "verbs", "interactions", "dialogues", "scenes", "maps",
          "scripts", "tests"})
        if (!content.contains(collection))
            content[collection] = Json::object();
    return js_fingerprint(
        Json{{"content", content.dump()}, {"profile", profile}, {"recovery", recovery}}.dump());
}

Json presentation(const Json& compiled)
{
    const auto& display = compiled.at("settings").at("display");
    return {{"reference_resolution", display.at("referenceResolution")},
            {"world_raster_policy", display.at("worldRasterPolicy")},
            {"bar_color", display.at("barColor")}};
}

Json accessibility(const Json& compiled)
{
    const auto& source = compiled.at("settings").at("accessibility");
    return {{"ui_scale", source.at("uiScale")}, {"text_scale", source.at("textScale")}};
}

Json platform(const Json& display)
{
    const auto& resolution = display.at("reference_resolution");
    const bool portrait =
        resolution.at("height").get<double>() > resolution.at("width").get<double>();
    const std::string orientation = portrait ? "portrait" : "landscape";
    return {{"orientation", orientation},
            {"desktop",
             {{"initialWidth", portrait ? 720 : 1280},
              {"initialHeight", portrait ? 1280 : 720},
              {"arguments", Json::array({"--display-orientation", orientation})}}},
            {"web", {{"orientation", orientation}, {"query", "orientation=" + orientation}}},
            {"android",
             {{"orientation", orientation},
              {"gradleProperty", "novelteaOrientation=" + orientation},
              {"screenOrientation", portrait ? "sensorPortrait" : "sensorLandscape"}}}};
}

void append_entry(Json& entries, Json& files, std::string source, std::string path,
                  std::string storage, std::string id, std::string kind)
{
    entries.push_back({{"source", source},
                       {"packagePath", path},
                       {"storage", storage},
                       {"assetId", std::move(id)},
                       {"kind", std::move(kind)}});
    files.push_back({{"source", std::move(source)},
                     {"packagePath", std::move(path)},
                     {"storage", std::move(storage)}});
}

bool has_errors(const Json& diagnostics)
{
    return std::any_of(diagnostics.begin(), diagnostics.end(),
                       [](const Json& d) { return d.value("severity", "") == "error"; });
}

void normalize_diagnostics(Json& diagnostics)
{
    const auto key = [](const Json& value) {
        return std::tuple(value.value("code", ""), value.value("path", ""),
                          value.value("severity", ""), value.value("message", ""));
    };
    std::sort(diagnostics.begin(), diagnostics.end(),
              [&](const Json& a, const Json& b) { return key(a) < key(b); });
    diagnostics.erase(std::unique(diagnostics.begin(), diagnostics.end(),
                                  [&](const Json& a, const Json& b) {
                                      return a.at("code") == b.at("code") &&
                                             a.at("path") == b.at("path") &&
                                             a.at("severity") == b.at("severity") &&
                                             a.at("ownerPaths") == b.at("ownerPaths") &&
                                             a.at("boundaries") == b.at("boundaries");
                                  }),
                      diagnostics.end());
}

} // namespace

Json prepare_native_runtime_artifact(const Json& project, const Json& compiled_project,
                                     const Json& referenced_asset_ids, const Json& profile,
                                     const Json& effective_materials,
                                     const std::string& project_root, const Json& recovery)
{
    Json diagnostics = Json::array();
    const auto blocked = [&]() {
        normalize_diagnostics(diagnostics);
        return Json{{"status", "blocked"}, {"diagnostics", diagnostics}};
    };
    try {
        if (!project.is_object() || !compiled_project.is_object() || !profile.is_object() ||
            !referenced_asset_ids.is_array()) {
            diagnostics.push_back(
                diagnostic("runtime-artifact.admission.required", "error", "/",
                           "A complete native Project, compiled wire, profile and admitted Asset "
                           "reference closure are required."));
            return blocked();
        }
        if (!noveltea::core::decode_compiled_project(compiled_project,
                                                     "native-runtime-preparation")) {
            diagnostics.push_back(diagnostic("runtime-artifact.compiled.invalid", "error",
                                             "/compiledProject",
                                             "The compiled gameplay wire is invalid."));
            return blocked();
        }
        const auto& localization = project.at("localization");
        const auto& policy = object(profile, "localization");
        const auto& selected = array(policy, "locales");
        const auto source_locale = string(localization, "sourceLocale");
        const auto default_locale = string(policy, "defaultLocale");
        const auto quality = string(policy, "quality");
        const auto& defined_locales = object(localization, "locales");
        std::set<std::string> unique;
        for (const auto& locale_value : selected) {
            if (!locale_value.is_string()) {
                diagnostics.push_back(diagnostic("localization.export.locale_not_supported",
                                                 "error", "/export/localization/locales",
                                                 "Export locale is not a string."));
                continue;
            }
            const auto locale = locale_value.get<std::string>();
            if (!unique.insert(locale).second)
                diagnostics.push_back(diagnostic(
                    "localization.export.duplicate_locale", "error", "/export/localization/locales",
                    "Export locale selections must not contain duplicates."));
            if (!object(defined_locales, locale).value("supported", false))
                diagnostics.push_back(diagnostic("localization.export.locale_not_supported",
                                                 "error", "/export/localization/locales",
                                                 "Export locale '" + locale +
                                                     "' must be a declared Supported locale."));
        }
        if (!unique.contains(default_locale))
            diagnostics.push_back(diagnostic("localization.export.default_not_included", "error",
                                             "/export/localization/defaultLocale",
                                             "Export default locale '" + default_locale +
                                                 "' must be included in the export locale set."));
        if (unique.empty() ||
            (quality != "development" && quality != "release" && quality != "reviewed-release") ||
            (string(profile, "kind") != "runtime" && string(profile, "kind") != "editable"))
            diagnostics.push_back(diagnostic("runtime-artifact.profile.invalid", "error", "/export",
                                             "Native runtime export profile is malformed."));
        if (has_errors(diagnostics))
            return blocked();
        if (!project.contains("entrypoint") || project.at("entrypoint").is_null()) {
            auto missing =
                diagnostic("runtime-package.entrypoint.required", "error", "/entrypoint",
                           "Choose a gameplay entrypoint before running or packaging the project.",
                           "Runtime package readiness");
            missing["boundaries"] = Json::array({"runtime-package"});
            diagnostics.push_back(std::move(missing));
            return blocked();
        }

        Json wire = compiled_project;
        const auto& compiled_localization = wire.at("localization");
        std::map<std::string, Json> by_locale;
        for (const auto& catalog : compiled_localization.at("catalogs"))
            by_locale[catalog.at("locale").get<std::string>()] = catalog.at("entries");
        std::map<std::uint64_t, Json> source_entries;
        for (const auto& entry : by_locale[source_locale])
            source_entries[entry.at("messageId").get<std::uint64_t>()] = entry;
        std::set<std::uint64_t> fallback_messages;
        Json catalogs = Json::array();
        for (const auto& locale_value : selected) {
            const auto locale = locale_value.get<std::string>();
            std::map<std::uint64_t, Json> translated;
            for (const auto& entry : by_locale[locale])
                translated[entry.at("messageId").get<std::uint64_t>()] = entry;
            Json entries = Json::array();
            for (const auto& [numeric, entry] : source_entries) {
                if (translated.contains(numeric))
                    entries.push_back(translated.at(numeric));
                else {
                    entries.push_back(entry);
                    fallback_messages.insert(numeric);
                }
            }
            catalogs.push_back({{"locale", locale}, {"entries", std::move(entries)}});
        }

        // The raw authoring workflow's message number space excludes Lua-local
        // messages; compilation includes those messages in its catalog IDs.
        const auto messages = lower_authoring_messages(project);
        const auto& message_ids = messages.ids;
        const auto& authored_messages = object(localization, "messages");
        std::set<std::string> non_workflow_ids;
        for (const auto& [source, tracking] :
             object(localization, "sourceMessageTracking").items()) {
            if (!source.starts_with("lua:record:scenes:"))
                continue;
            for (const auto& occurrence : array(tracking, "occurrences"))
                if (occurrence.is_object() && occurrence.contains("messageId") &&
                    occurrence.at("messageId").is_string())
                    non_workflow_ids.insert(occurrence.at("messageId").get<std::string>());
        }
        std::set<std::string> lua_local_ids;
        for (const auto& id : messages.managed_lua_local_ids) {
            lua_local_ids.insert(id.get<std::string>());
            non_workflow_ids.insert(id.get<std::string>());
        }
        for (const auto& [id, value] : message_ids.items()) {
            if (!value.is_number_integer() && !value.is_number_unsigned())
                continue;
            const auto numeric = value.get<std::uint64_t>();
            for (const auto& locale_value : selected) {
                const auto locale = locale_value.get<std::string>();
                if (locale == source_locale)
                    continue;
                const auto target = effective_target(project, locale, id, "translations");
                const auto path = "/localization/translations/" + locale + "/" + id;
                if (target.is_object() && target.value("useSource", false)) {
                    fallback_messages.insert(numeric);
                    continue;
                }
                if (target.is_null()) {
                    fallback_messages.insert(numeric);
                    if (!non_workflow_ids.contains(id))
                        diagnostics.push_back(diagnostic(
                            "localization.export.message_missing", "warning", path,
                            "Locale '" + locale + "' is missing Message '" + id +
                                "'; the source realization will be packaged as fallback."));
                    continue;
                }
                if (non_workflow_ids.contains(id))
                    continue;
                const auto source_fingerprint =
                    authored_messages.contains(id)
                        ? native_authoring_message_semantic_fingerprint(authored_messages.at(id))
                        : string(messages.rml_workflow_fingerprints, id);
                if (quality != "development" && !source_fingerprint.empty() &&
                    target.value("sourceFingerprint", std::string{}) != source_fingerprint)
                    diagnostics.push_back(
                        diagnostic("localization.export.message_outdated", "warning", path,
                                   "Locale '" + locale +
                                       "' has an outdated translation for Message '" + id + "'."));
                if (quality == "reviewed-release" &&
                    target.value("review", std::string{}) == "needs-review")
                    diagnostics.push_back(diagnostic(
                        "localization.export.message_needs_review", "warning", path,
                        "Locale '" + locale + "' has a translation needing review for Message '" +
                            id + "'."));
            }
        }

        std::vector<std::pair<std::uint64_t, std::string>> raw_order;
        for (const auto& [id, numeric] : message_ids.items()) {
            if (lua_local_ids.contains(id))
                continue;
            const auto& authored = object(authored_messages, id);
            if (string(authored, "kind") == "named" &&
                core::system_message_id(string(authored, "key")))
                continue;
            raw_order.emplace_back(numeric.get<std::uint64_t>(), id);
        }
        std::sort(raw_order.begin(), raw_order.end());
        std::uint64_t raw_numeric = 0;
        for (const auto& [compiled_numeric, id] : raw_order) {
            (void)compiled_numeric;
            for (const auto& locale_value : selected) {
                const auto locale = locale_value.get<std::string>();
                if (locale == source_locale)
                    continue;
                const auto target = effective_target(project, locale, id, "translations");
                if (target.is_null() || (target.is_object() && target.value("useSource", false)))
                    fallback_messages.insert(raw_numeric);
            }
            ++raw_numeric;
        }

        // Resolve localization variants and source fallback against the
        // admitted base-Asset reference closure, independent of export pruning.
        const auto& authored_assets = object(project, "assets");
        const auto& translated_assets = object(localization, "assets");
        std::set<std::string> all_variants;
        for (const auto& [locale, targets] : translated_assets.items())
            for (const auto& [base, target] : targets.items()) {
                (void)base;
                if (target.is_object() && !target.contains("useSource"))
                    all_variants.insert(ref_id(target.value("asset", Json::object())));
            }
        std::set<std::string> referenced;
        for (const auto& asset : referenced_asset_ids)
            if (asset.is_string())
                referenced.insert(asset.get<std::string>());
        std::set<std::string> selected_variants;
        std::set<std::string> fallback_assets;
        std::set<std::string> payload_assets;
        Json projected_assets = Json::array();
        for (const auto& asset : wire.at("resources").at("assets")) {
            const auto id = asset.at("id").get<std::string>();
            Json entry = asset;
            const auto& data = object(object(authored_assets, id), "data");
            const auto kind = string(data, "kind");
            Json mappings = Json::array();
            bool has_mappings = false;
            bool all_variant = true;
            if ((!all_variants.contains(id) || referenced.contains(id)) &&
                referenced.contains(id) &&
                (kind == "image" || kind == "audio" || kind == "video")) {
                for (const auto& locale_value : selected) {
                    const auto locale = locale_value.get<std::string>();
                    has_mappings = true;
                    if (locale == source_locale) {
                        mappings.push_back({{"locale", locale}, {"state", "source"}});
                        all_variant = false;
                        continue;
                    }
                    const auto target = effective_target(project, locale, id, "assets");
                    if (target.is_object() && !target.contains("useSource")) {
                        const auto variant = ref_id(target.at("asset"));
                        selected_variants.insert(variant);
                        mappings.push_back({{"locale", locale},
                                            {"state", "variant"},
                                            {"asset", {{"kind", "asset"}, {"id", variant}}}});
                        const auto hash =
                            string(data, "contentHash", string(object(data, "source"), "path"));
                        const auto source_fingerprint =
                            authoring::native_localization_tracking_fingerprint(
                                Json::array({kind, hash}).dump());
                        const auto path = "/localization/assets/" + locale + "/" + id;
                        if (quality != "development" &&
                            target.value("sourceFingerprint", std::string{}) != source_fingerprint)
                            diagnostics.push_back(diagnostic(
                                "localization.export.asset_outdated", "warning", path,
                                "Locale '" + locale +
                                    "' has an outdated localized Asset variant for '" + id + "'."));
                        if (quality == "reviewed-release" &&
                            target.value("review", std::string{}) == "needs-review")
                            diagnostics.push_back(diagnostic(
                                "localization.export.asset_needs_review", "warning", path,
                                "Locale '" + locale +
                                    "' has a localized Asset variant needing review for '" + id +
                                    "'."));
                    } else {
                        mappings.push_back({{"locale", locale}, {"state", "source"}});
                        all_variant = false;
                        fallback_assets.insert(id);
                        if (target.is_null())
                            diagnostics.push_back(diagnostic(
                                "localization.export.asset_missing", "warning",
                                "/localization/assets/" + locale + "/" + id,
                                "Locale '" + locale +
                                    "' is missing a localized realization for Asset '" + id +
                                    "'; the source Asset will be packaged as fallback."));
                    }
                }
            }
            if (has_mappings)
                entry["localized"] = std::move(mappings);
            else
                entry.erase("localized");
            if (!has_mappings || !all_variant)
                payload_assets.insert(id);
            projected_assets.push_back(std::move(entry));
        }

        for (const auto& id : selected_variants)
            payload_assets.insert(id);
        for (const auto& locale_value : selected) {
            for (const auto& definition : wire.at("localization").at("locales")) {
                if (definition.at("locale") != locale_value)
                    continue;
                for (const auto& font : definition.at("fontStack")) {
                    const auto id = string(font, "id");
                    referenced.insert(id);
                    payload_assets.insert(id);
                }
            }
        }
        referenced.insert(selected_variants.begin(), selected_variants.end());
        referenced.insert(fallback_assets.begin(), fallback_assets.end());

        std::size_t excluded = 0;
        Json selected_assets = Json::array();
        for (const auto& asset : projected_assets) {
            const auto id = asset.at("id").get<std::string>();
            if (profile.value("excludeUnusedAssets", true) && !referenced.contains(id)) {
                ++excluded;
                continue;
            }
            selected_assets.push_back(asset);
        }
        wire["resources"]["assets"] = selected_assets;
        Json prepared_locales = Json::array();
        for (const auto& locale : selected)
            for (const auto& definition : compiled_project.at("localization").at("locales"))
                if (definition.at("locale") == locale) {
                    Json item = definition;
                    item["parentLocale"] = nullptr;
                    item["supported"] = true;
                    prepared_locales.push_back(std::move(item));
                }
        wire["localization"]["sourceLocale"] = default_locale;
        wire["localization"]["defaultLocale"] = default_locale;
        wire["localization"]["locales"] = std::move(prepared_locales);
        wire["localization"]["catalogs"] = Json::array();
        Json text_entries = Json::array();
        for (const auto& catalog : catalogs) {
            const auto locale = catalog.at("locale").get<std::string>();
            if (locale == default_locale) {
                wire["localization"]["catalogs"].push_back(catalog);
            } else {
                const auto path = "localization/" + locale + ".json";
                for (auto& definition : wire["localization"]["locales"])
                    if (definition.at("locale") == locale)
                        definition["catalogPath"] = path;
                text_entries.push_back({{"text", catalog.dump() + "\n"},
                                        {"packagePath", path},
                                        {"storage", "compressed"}});
            }
        }
        // Distribution license/notice contents and physical shader/media
        // obligations are attached by #559, not fabricated at this seam.
        text_entries.push_back(
            {{"text", "{\"schema\":\"noveltea.project-notices\",\"notices\":[]}"},
             {"packagePath", "licenses/index.json"},
             {"storage", "compressed"}});

        Json entries = Json::array();
        Json files = Json::array();
        Json seekable = Json::array();
        for (const auto& asset : selected_assets) {
            const auto id = asset.at("id").get<std::string>();
            if (!payload_assets.contains(id))
                continue;
            const auto& data = object(object(authored_assets, id), "data");
            const auto path = string(object(data, "source"), "path");
            if (path.empty())
                continue;
            const auto kind = string(data, "kind");
            const auto storage = kind == "audio" ? "stored" : "auto";
            const auto package_path = string(asset, "path");
            append_entry(entries, files, physical_source_path(project_root, path), package_path,
                         storage, id, kind);
            if (kind == "audio")
                seekable.push_back(package_path);
        }
        std::set<std::string> packaged_source_paths;
        for (const auto& [id, record] : object(project, "scripts").items()) {
            const auto& source = object(object(record, "data"), "source");
            if (string(source, "kind") != "project-file")
                continue;
            const auto path = string(source, "path");
            packaged_source_paths.insert(path);
            append_entry(entries, files, physical_source_path(project_root, path), path, "auto", id,
                         "script-source");
        }
        for (const auto& [id, record] : object(project, "layouts").items()) {
            (void)id;
            for (const auto& source :
                 array(object(object(record, "data"), "dependencies"), "scripts")) {
                const auto path = source.get<std::string>();
                if (!packaged_source_paths.insert(path).second)
                    continue;
                append_entry(entries, files, physical_source_path(project_root, path), path, "auto",
                             "source:" + path, "script-source");
            }
        }

        const auto metadata = native_runtime_material_metadata(project, effective_materials);
        const bool has_materials = !metadata.at("materials").empty();
        if (has_materials) {
            Json interfaces = Json::array();
            for (const auto& [id, material] : metadata.at("materials").items()) {
                const auto& shader =
                    metadata.at("shaders").at(material.at("shader").get<std::string>());
                Json parameters = Json::array();
                for (const auto& [name, uniform] : shader.at("uniforms").items())
                    parameters.push_back(
                        {{"name", name},
                         {"type", uniform.at("type")},
                         {"rendererBinding", uniform.value("binding", Json(nullptr))}});
                interfaces.push_back(
                    {{"id", id}, {"role", material.at("role")}, {"parameters", parameters}});
            }
            wire["resources"]["materialInterfaces"] = std::move(interfaces);
        }
        if (!profile.value("stripShaderSources", true)) {
            std::set<std::string> shader_paths;
            for (const auto& [id, material] : effective_materials.items()) {
                (void)id;
                for (const auto* key : {"vertexSource", "fragmentSource", "varyingDefinition"}) {
                    const auto identity = material.at("shader").at(key).get<std::string>();
                    if (identity.starts_with("project:/shaders/"))
                        shader_paths.insert(identity.substr(9));
                }
            }
            for (const auto& path : shader_paths)
                if (packaged_source_paths.insert(path).second)
                    append_entry(entries, files, physical_source_path(project_root, path), path,
                                 "auto", "source:" + path, "shader-source");
        }

        // Package metadata must identify exactly the same project as the
        // compiled gameplay. Revalidating or normalizing the authoring version
        // here can silently turn a valid version into "0.0.0" and produce a
        // runtime package that the player rejects at startup.
        const auto name = wire.at("project").at("name").get<std::string>();
        const auto version = wire.at("project").at("version").get<std::string>();
        const auto display = presentation(wire);
        const auto access = accessibility(wire);
        const auto targets = platform(display);
        const Json shader_variants = has_materials ? profile.at("shaderVariants") : Json::array();
        const Json required_shader_binaries = Json::array();
        const Json preview{
            {"projectName", name},
            {"projectVersion", version},
            {"entryCount", 1 + entries.size() + text_entries.size() + (has_materials ? 1 : 0)},
            {"assetCount", entries.size()},
            {"shaderVariants", shader_variants},
            {"requiredShaderBinaryPaths", required_shader_binaries},
            {"display", display},
            {"accessibility", access},
            {"platform", targets}};
        Json options{{"kind", profile.at("kind")},
                     {"projectName", name},
                     {"projectVersion", version},
                     {"createdBy", "noveltea-editor"},
                     {"includeChecksums", profile.at("includeChecksums")},
                     {"stripShaderSources", profile.at("stripShaderSources")},
                     {"shaderVariants", shader_variants},
                     {"requiredShaderBinaryPaths", required_shader_binaries},
                     {"fileEntries", files},
                     {"textEntries", text_entries},
                     {"requiredSeekablePaths", seekable},
                     {"display", display},
                     {"accessibility", access},
                     {"platform", targets}};
        if (has_materials)
            options["shaderMaterialMetadata"] = metadata;
        if (has_errors(diagnostics))
            return blocked();
        normalize_diagnostics(diagnostics);
        Json artifact{{"schema", "noveltea.prepared-runtime-artifact"},
                      {"sourceFingerprint", fingerprint(project, profile, recovery)},
                      {"profile", profile},
                      {"compiledProject", wire},
                      {"gameplayJson", wire.dump()},
                      {"requiredShaderBinaryPaths", required_shader_binaries},
                      {"fileEntries", entries},
                      {"manifestPreview", preview},
                      {"packageOptions", options},
                      {"localization",
                       {{"includedLocales", selected},
                        {"defaultLocale", default_locale},
                        {"quality", quality},
                        {"sourceFallback",
                         {{"messageCount", fallback_messages.size()},
                          {"assetCount", fallback_assets.size()}}}}},
                      {"diagnostics", diagnostics}};
        if (has_materials)
            artifact["shaderMaterialMetadata"] = metadata;
        if (!recovery.is_null())
            artifact["recoveryFingerprint"] = recovery;
        return {
            {"status", "prepared"}, {"artifact", artifact}, {"excludedUnusedAssetCount", excluded}};
    } catch (const std::exception& error) {
        diagnostics.push_back(diagnostic("runtime-artifact.preparation.invalid", "error",
                                         "/artifact", error.what(), "Runtime package readiness"));
        return blocked();
    }
}

} // namespace noveltea::cli
