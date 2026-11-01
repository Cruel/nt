#include "tooling_native_c.h"
#include "tooling_native.hpp"
#include "tooling_native_project_asset.hpp"
#include "tooling_native_project_bundle.hpp"
#include "tooling_native_project_localization.hpp"
#include "tooling_native_project_sync.hpp"
#include "tooling_native_project_shader_validation.hpp"

#include "../project_authoring/room_session.hpp"
#include "../project_authoring/validation_work_instrumentation.hpp"
#include "../project_authoring/material_semantics.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {
using Json = nlohmann::json;
using noveltea::authoring::ProjectSession;

#ifdef __linux__
constexpr bool external_watcher_cache_supported = true;
#else
// Other hosts perform full observation but have no notification trail for a
// same-size, restored-mtime binary change. Never reuse that negative evidence.
constexpr bool external_watcher_cache_supported = false;
#endif

void trace_native_validation(const char* stage)
{
    const char* trace = std::getenv("NOVELTEA_CLI_TRACE");
    if (trace != nullptr && std::strcmp(trace, "1") == 0) {
        std::fprintf(stderr, "[native-disk-validation] %s\n", stage);
        std::fflush(stderr);
    }
}

// Each existing daemon Project-owner process is single-root. This native state
// lives inside that owner, not in a parallel daemon or a persistent cache.
struct OwnerValidation {
    struct ExternalCheck {
        Json inputs;
        std::set<std::string> watched_paths;
    };
    std::mutex mutex;
    std::filesystem::path root;
    std::unique_ptr<ProjectSession> session;
    // Only the most recent valid public validation may be finalized. This
    // generation belongs to the resident session and is never persisted.
    std::string pending_generation;
    std::uint64_t session_admissions = 0;
    // Derived only from this session's last certified localization generation.
    // A new admission cannot borrow another Project's source projection.
    std::optional<Json> font_inputs;
    // Material resolution depends on the saved Material/Asset records and
    // source membership; shader contents are tracked separately by the
    // per-program compiler cache.
    std::optional<Json> material_records;
    std::optional<Json> material_assets;
    Json material_programs = Json::object();
    Json material_effective = Json::object();
    noveltea::tooling::MaterialShaderValidationCache shader_cache;
    std::optional<ExternalCheck> portable_check;
    std::optional<ExternalCheck> notice_check;
    void clear_preparations(bool clear_shaders = true, bool clear_materials = true)
    {
        font_inputs.reset();
        if (clear_materials) {
            material_records.reset();
            material_assets.reset();
            material_programs = Json::object();
            material_effective = Json::object();
        }
        portable_check.reset();
        notice_check.reset();
        if (clear_shaders)
            shader_cache.clear();
    }
};

OwnerValidation& resident()
{
    static OwnerValidation value;
    return value;
}

bool fence_resident_sources(ProjectSession& session)
{
#ifdef __linux__
    return session.fence_observed_sources();
#else
    const auto observation = session.observe_sources();
    return observation.authoritative && observation.unchanged && !observation.full_rescan;
#endif
}

// Distribution notices are physical authored inputs, not YAML fragments.
// Keep the CLI's text/size/control policy at the native Project admission
// boundary, rather than treating a successful portable copy as validation.
bool valid_notice_utf8(std::string_view bytes, bool& prohibited_controls)
{
    prohibited_controls = false;
    for (std::size_t i = 0; i < bytes.size();) {
        const auto lead = static_cast<unsigned char>(bytes[i]);
        std::size_t count = 1;
        char32_t codepoint = lead;
        if (lead >= 0xf0 && lead <= 0xf4) {
            count = 4;
            codepoint = lead & 0x07;
        } else if (lead >= 0xe0 && lead <= 0xef) {
            count = 3;
            codepoint = lead & 0x0f;
        } else if (lead >= 0xc2 && lead <= 0xdf) {
            count = 2;
            codepoint = lead & 0x1f;
        } else if (lead >= 0x80) {
            return false;
        }
        if (i + count > bytes.size())
            return false;
        for (std::size_t offset = 1; offset < count; ++offset) {
            const auto next = static_cast<unsigned char>(bytes[i + offset]);
            if ((next & 0xc0) != 0x80)
                return false;
            codepoint = (codepoint << 6) | (next & 0x3f);
        }
        if ((count == 2 && codepoint < 0x80) || (count == 3 && codepoint < 0x800) ||
            (count == 4 && codepoint < 0x10000) || codepoint > 0x10ffff ||
            (codepoint >= 0xd800 && codepoint <= 0xdfff))
            return false;
        if ((codepoint < 32 && codepoint != 9 && codepoint != 10 && codepoint != 13) ||
            (codepoint >= 127 && codepoint <= 159))
            prohibited_controls = true;
        i += count;
    }
    return true;
}

std::optional<std::string> native_distribution_notice_error(const std::filesystem::path& root,
                                                            const Json& project)
{
    std::map<std::string, std::pair<std::string, bool>> notices;
    const auto add = [&](const Json& notice) -> std::optional<std::string> {
        if (!notice.is_object() || !notice.contains("path") || !notice.at("path").is_string())
            return "Invalid distribution notice input.";
        const auto path = notice.at("path").get<std::string>();
        const auto name = notice.value("displayName", std::string{});
        const bool explicit_name = !name.empty();
        const auto extension = std::filesystem::path(path).extension().string();
        std::string lowered = extension;
        std::transform(lowered.begin(), lowered.end(), lowered.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        const auto relative = std::filesystem::path(path);
        if (relative.is_absolute() || relative != relative.lexically_normal() || path.empty() ||
            path.find_first_of(":\\") != std::string::npos ||
            (lowered != ".md" && lowered != ".txt"))
            return "Invalid distribution notice path '" + path + "'.";
        const auto found = notices.find(path);
        if (found != notices.end() && found->second.second && explicit_name &&
            found->second.first != name)
            return "Conflicting distribution notice names for '" + path + "'.";
        if (found == notices.end() || (!found->second.second && explicit_name))
            notices[path] = {name, explicit_name};
        return std::nullopt;
    };
    const auto& settings = project.at("settings");
    if (settings.contains("distributionNotices") && settings.at("distributionNotices").is_array())
        for (const auto& notice : settings.at("distributionNotices"))
            if (auto error = add(notice))
                return error;
    if (project.contains("assets") && project.at("assets").is_object())
        for (const auto& [_, record] : project.at("assets").items()) {
            if (!record.contains("data") || !record.at("data").is_object())
                continue;
            const auto& asset = record.at("data");
            if (!asset.contains("attachments") || !asset.at("attachments").is_array())
                continue;
            for (const auto& attachment : asset.at("attachments")) {
                if (attachment.value("purpose", std::string{}) != "distribution-notice")
                    continue;
                if (auto error = add(attachment))
                    return error;
            }
        }
    if (notices.size() > 512)
        return "Project distribution notices exceed the 512-entry runtime limit.";
    const auto canonical_root = std::filesystem::canonical(root);
    for (const auto& [relative, _] : notices) {
        const auto target = std::filesystem::weakly_canonical(root / relative);
        const auto contained = target.lexically_relative(canonical_root);
        if (contained.empty() || contained == "." || *contained.begin() == ".." ||
            !std::filesystem::is_regular_file(target))
            return "Distribution notice '" + relative + "' is missing, unsafe, or invalid UTF-8.";
        std::ifstream source(target, std::ios::binary | std::ios::ate);
        if (!source)
            return "Distribution notice '" + relative + "' is missing, unsafe, or invalid UTF-8.";
        const auto length = source.tellg();
        if (length <= 0 || length > 1024 * 1024)
            return "Distribution notice '" + relative +
                   "' is empty, too large, or contains prohibited controls.";
        source.seekg(0);
        std::string bytes(static_cast<std::size_t>(length), '\0');
        if (!source.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
            return "Distribution notice '" + relative + "' is missing, unsafe, or invalid UTF-8.";
        bool prohibited_controls = false;
        if (!valid_notice_utf8(bytes, prohibited_controls))
            return "Distribution notice '" + relative + "' is missing, unsafe, or invalid UTF-8.";
        if (prohibited_controls)
            return "Distribution notice '" + relative +
                   "' is empty, too large, or contains prohibited controls.";
    }
    return std::nullopt;
}

// These projections describe inputs to the external stages, not semantic
// validation's whole-Project revision. Room labels and unrelated record
// properties deliberately do not participate.
Json portable_inputs(const Json& project)
{
    Json result = Json::object();
    const Json empty = Json::object();
    const auto& assets = project.contains("assets") ? project.at("assets") : empty;
    const auto& layouts = project.contains("layouts") ? project.at("layouts") : empty;
    const auto& materials = project.contains("materials") ? project.at("materials") : empty;
    result["notices"] = project.at("settings").value("distributionNotices", Json::array());
    result["assets"] = Json::object();
    for (const auto& [id, record] : assets.items()) {
        const auto& data = record.at("data");
        result["assets"][id] = {{"source", data.value("source", Json())},
                                {"attachments", data.value("attachments", Json::array())}};
    }
    result["layouts"] = Json::object();
    for (const auto& [id, record] : layouts.items())
        if (const auto& data = record.at("data");
            data.contains("dependencies") && data.at("dependencies").is_object())
            result["layouts"][id] = data.at("dependencies").value("scripts", Json::array());
    result["materials"] = Json::object();
    for (const auto& [id, record] : materials.items()) {
        const auto& data = record.at("data");
        if (data.contains("shader"))
            result["materials"][id] = data.at("shader");
    }
    return result;
}

Json notice_inputs(const Json& project)
{
    Json result = Json::object();
    const Json empty = Json::object();
    const auto& assets = project.contains("assets") ? project.at("assets") : empty;
    result["settings"] = project.at("settings").value("distributionNotices", Json::array());
    result["assets"] = Json::object();
    for (const auto& [id, record] : assets.items()) {
        const auto& data = record.at("data");
        if (!data.contains("attachments") || !data.at("attachments").is_array())
            continue;
        for (const auto& attachment : data.at("attachments"))
            if (attachment.is_object() &&
                attachment.value("purpose", std::string{}) == "distribution-notice")
                result["assets"][id].push_back(attachment);
    }
    return result;
}

// An unobserved external input (such as an arbitrary referenced path outside
// the watched source families) is never sufficient proof for a resident hit.
std::optional<std::set<std::string>> observed_external_paths(const Json& paths,
                                                             const ProjectSession& session)
{
    const auto* revisions = session.verified_source_revisions_view();
    if (!revisions)
        return std::nullopt;
    std::set<std::string> watched;
    for (const auto& entry : paths) {
        const auto path = entry.get<std::string>();
        // Tracked YAML has its own exact native semantic/source authority.
        // A Room YAML label edit must not revoke the external-input stage.
        if (path == "project.yaml" || path == "editor.yaml" || path == "traits.yaml" ||
            (path.starts_with("records/") && path.ends_with(".yaml")) ||
            (path.starts_with("i18n/") && path.ends_with(".yaml")))
            continue;
        if (!revisions->contains(path) || revisions->at(path) == "absent")
            return std::nullopt;
        watched.insert(path);
    }
    return watched;
}

// Derive text inputs from the native localization source-view resolver rather
// than rediscovering Lua, RML, or structured Project Message identities in the CLI.
void append_pattern_texts(const Json& pattern, const std::string& id, const std::string& path,
                          Json& messages)
{
    if (!pattern.is_object())
        return;
    if (pattern.value("kind", std::string{}) == "text") {
        if (pattern.contains("text") && pattern.at("text").is_string())
            messages.push_back(
                {{"messageId", id}, {"sourcePath", path}, {"text", pattern.at("text")}});
    } else if (pattern.contains("cases") && pattern.at("cases").is_object()) {
        for (const auto& [_, value] : pattern.at("cases").items())
            append_pattern_texts(value, id, path, messages);
    }
}

Json effective_translation(const Json& localization, std::string locale, const std::string& id)
{
    std::set<std::string> visited;
    const auto source = localization.value("sourceLocale", std::string{});
    const auto& locales = localization.at("locales");
    // Look up a locale's entries without copying the entire translation DOM
    // for each Message. This projection is read-only for the whole request.
    const Json empty_translations = Json::object();
    const Json& translations = localization.contains("translations")
                                   ? localization.at("translations")
                                   : empty_translations;
    while (!locale.empty() && locale != source && visited.insert(locale).second) {
        if (translations.contains(locale) && translations.at(locale).is_object() &&
            translations.at(locale).contains(id))
            return translations.at(locale).at(id);
        if (!locales.contains(locale))
            break;
        const auto& parent = locales.at(locale).value("parentLocale", Json(nullptr));
        locale = parent.is_string() ? parent.get<std::string>() : std::string{};
    }
    return nullptr;
}

Json native_font_coverage_inputs(noveltea::authoring::ProjectSession& session, const Json& project)
{
    trace_native_validation("native font inputs: entering");
    const auto& localization = project.at("localization");
    const auto& locales = localization.at("locales");
    if (locales.empty())
        return Json::array();
    const auto source_locale = localization.at("sourceLocale").get<std::string>();
    trace_native_validation("native font inputs: resolving source localization views");
    // The internal opt-in source view also covers the source locale; the public
    // localization view command continues to reject source-locale requests.
    const auto sources = native_project_localization_view(
        {{"locale", source_locale}, {"allowSourceLocale", true}}, session, true);
    trace_native_validation("native font inputs: source views resolved");
    if (!sources.value("ok", false) || !sources.contains("messages"))
        throw std::runtime_error(sources.value(
            "error", std::string("Native localization source projection is unavailable.")));
    Json result = Json::array();
    // Locale names are rendered in the language selector even when the
    // authored Message inventory contains no text in that language. Keep the
    // native coverage projection aware of the runtime's deterministic autonyms.
    static const std::map<std::string, std::string> autonyms{
        {"ar", "العربية"},    {"de", "Deutsch"},    {"en", "English"},    {"es", "español"},
        {"fr", "français"},   {"he", "עברית"},      {"hi", "हिन्दी"},      {"it", "italiano"},
        {"ja", "日本語"},     {"ko", "한국어"},     {"nl", "Nederlands"}, {"pl", "polski"},
        {"pt", "português"},  {"ru", "русский"},    {"sv", "svenska"},    {"tr", "Türkçe"},
        {"uk", "українська"}, {"vi", "Tiếng Việt"}, {"zh", "中文"}};
    for (const auto& [locale, definition] : locales.items()) {
        trace_native_validation("native font inputs: projecting locale");
        const auto& selected = definition.value("fontStack", Json(nullptr));
        const auto& stack =
            selected.is_array() ? selected : project.at("settings").at("text").at("fontStack");
        Json fonts = Json::array();
        for (const auto& reference : stack) {
            if (!reference.is_object() || !reference.contains("$ref") ||
                !reference.at("$ref").is_object())
                continue;
            const auto id = reference.at("$ref").value("id", std::string{});
            if (!project.at("assets").contains(id))
                continue;
            const auto& asset = project.at("assets").at(id).at("data");
            if (asset.value("kind", std::string{}) != "font")
                continue;
            const auto& source = asset.at("source");
            if (source.contains("path") && source.at("path").is_string())
                fonts.push_back("project:/" + source.at("path").get<std::string>());
        }
        Json messages = Json::array();
        for (const auto& view : sources.at("messages")) {
            const auto id = view.at("id").get<std::string>();
            const bool named = view.value("kind", std::string{}) == "named";
            std::string path = "/localization/messages/" + id + "/source";
            if (!named && view.contains("usages") && view.at("usages").is_array() &&
                !view.at("usages").empty())
                path = view.at("usages")[0].get<std::string>();
            const auto target = effective_translation(localization, locale, id);
            const bool translated = target.is_object() && !target.value("useSource", false);
            const auto text = translated ? target.value("text", std::string{})
                                         : view.at("source").get<std::string>();
            messages.push_back({{"messageId", id}, {"sourcePath", path}, {"text", text}});
            const Json* pattern = nullptr;
            if (translated && target.contains("pattern"))
                pattern = &target.at("pattern");
            else if (!translated && named && localization.at("messages").contains(id)) {
                const auto& source = localization.at("messages").at(id);
                if (source.contains("pattern"))
                    pattern = &source.at("pattern");
            }
            if (pattern)
                append_pattern_texts(*pattern, id, path, messages);
        }
        auto language = locale.substr(0, locale.find('-'));
        std::transform(language.begin(), language.end(), language.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        const auto native_name = autonyms.contains(language) ? autonyms.at(language) : locale;
        messages.push_back({{"messageId", "locale-name:" + locale},
                            {"sourcePath", "/localization/locales/" + locale + "/displayName"},
                            {"text", native_name}});
        if (definition.contains("displayName") && definition.at("displayName").is_string() &&
            definition.at("displayName") != native_name)
            messages.push_back({{"messageId", "locale-display-name:" + locale},
                                {"sourcePath", "/localization/locales/" + locale + "/displayName"},
                                {"text", definition.at("displayName")}});
        result.push_back({{"locale", locale},
                          {"supported", definition.value("supported", false)},
                          {"fonts", std::move(fonts)},
                          {"fingerprint", std::string{}},
                          {"messages", std::move(messages)}});
    }
    return result;
}

Json work_counts_json(const noveltea::authoring::ValidationWorkCounters& counts)
{
    Json result = Json::object();
    for (const auto& [field, value] : counts.fields())
        result[std::string(field)] = value;
    return result;
}

Json response_for(const noveltea::authoring::RoomSessionSnapshot& snapshot, bool warm,
                  const ProjectSession::ValidationWork& work)
{
    Json diagnostics = Json::array();
    Json cli_diagnostics = Json::array();
    for (const auto& diagnostic : snapshot.diagnostics) {
        Json value{{"code", diagnostic.code},
                   {"path", diagnostic.path},
                   {"severity", diagnostic.severity},
                   {"message", diagnostic.message},
                   {"sourcePath", diagnostic.source_path}};
        if (diagnostic.line)
            value["line"] = *diagnostic.line;
        if (diagnostic.column)
            value["column"] = *diagnostic.column;
        diagnostics.push_back(std::move(value));

        // CLI validate has a narrower presentation policy than local
        // editor-native diagnostics. Conditional selectors are an authoring
        // explanation rather than a CLI validation finding. Preserve them in
        // diagnostics above but not in the separate CLI oracle projection.
        if (diagnostic.code == "authoring.interaction.selector-conditional")
            continue;
        const bool invalid_manifest_yaml =
            diagnostic.code == "source.project" && diagnostic.source_path == "project.yaml" &&
            diagnostic.message.starts_with("Invalid Project manifest YAML:");
        // The editor-native graph retains its precise diagnostic identity and
        // semantic owner pointer. The public CLI's disk-admission contract
        // instead reports an unparseable physical record source as a workspace
        // read failure at its actual tracked YAML path.
        const bool invalid_record_yaml =
            diagnostic.code == "source.yaml" && diagnostic.source_path.starts_with("records/");
        Json projected{{"code", invalid_manifest_yaml ? "WORKSPACE_MANIFEST_INVALID"
                                : invalid_record_yaml ? "WORKSPACE_SOURCE_READ"
                                                      : diagnostic.code},
                       {"severity", diagnostic.severity},
                       {"path", invalid_manifest_yaml ? "/project.yaml"
                                : invalid_record_yaml ? "/" + diagnostic.source_path
                                                      : diagnostic.path},
                       {"message", invalid_manifest_yaml
                                       ? "project.yaml is not valid restricted YAML."
                                   : invalid_record_yaml ? "Record is malformed."
                                                         : diagnostic.message}};
        if (!diagnostic.source_path.empty())
            projected["sourceUrl"] = "project:/" + diagnostic.source_path;
        if (diagnostic.line)
            projected["line"] = *diagnostic.line;
        if (diagnostic.column)
            projected["column"] = *diagnostic.column;
        // The compiler stage reports the same Hotspot no-target information
        // under its existing AUTHORING_* diagnostic identity as well.
        if (diagnostic.code == "hotspot.authoring.target.none") {
            auto compiler = projected;
            compiler["code"] = "AUTHORING_HOTSPOT_AUTHORING_TARGET_NONE";
            cli_diagnostics.push_back(std::move(compiler));
        }
        cli_diagnostics.push_back(std::move(projected));
    }
    return {{"ok", true},
            {"valid", snapshot.valid},
            {"exitCode", snapshot.valid ? 0 : 1},
            {"warm", warm},
            {"diagnostics", std::move(diagnostics)},
            {"cliDiagnostics", std::move(cli_diagnostics)},
            {"work",
             {{"recheckedRecords", work.rechecked_records},
              {"retainedRecords", work.retained_records},
              {"recheckedContributions", work.rechecked_contributions},
              {"retainedContributions", work.retained_contributions},
              {"referenceIndexedRecords", work.reference_indexed_records},
              {"localizationRebuilds", work.localization_rebuilds},
              {"globalStageExecutions", work.global_stage_executions},
              {"globalStageReuses", work.global_stage_reuses},
              {"diagnosticAssemblies", work.diagnostic_assemblies},
              {"sourceLocationRebuilds", work.source_location_rebuilds},
              {"semanticFallbackReasons", work.semantic_fallback_reasons}}}};
}

Json validate(std::string_view request_text)
{
    const auto request = Json::parse(request_text);
    if (!request.is_object() || !request.contains("projectRoot") ||
        !request["projectRoot"].is_string() || request["projectRoot"].get<std::string>().empty())
        return {{"ok", false}, {"error", "Native disk validation requires projectRoot."}};
    const auto root_utf8 = request["projectRoot"].get<std::string>();
    const auto requested = std::filesystem::path(std::u8string(root_utf8.begin(), root_utf8.end()));
    if (!requested.is_absolute())
        return {{"ok", false}, {"error", "Native disk validation requires an absolute root."}};
    const auto root = std::filesystem::canonical(requested);
    noveltea::authoring::ValidationWorkCounters work_counts;
    noveltea::authoring::ScopedValidationWork work_scope(work_counts);
    auto& state = resident();
    std::scoped_lock lock(state.mutex);
    if (request.value("action", std::string("validate")) == "release") {
        if (state.root == root) {
            state.session.reset();
            state.clear_preparations();
            state.root.clear();
            state.pending_generation.clear();
        }
        return {{"ok", true}};
    }
    if (request.value("action", std::string("validate")) == "source-generation-proof") {
        const auto conflict = [&]() -> Json {
            // Observation must not consume inventory changes that the next validation
            // would otherwise use to revoke its admitted Project.
            state.session.reset();
            // A newly added/removed shader source requires fresh Project
            // admission, not recompilation of unrelated resident programs.
            // The next proven inventory revokes affected compiler entries.
            state.clear_preparations(false, false);
            state.pending_generation.clear();
            return {{"ok", false}, {"kind", "conflict"}, {"error", "Project sources changed."}};
        };
        if (state.root != root || !state.session || !request.contains("expectedSourceGeneration") ||
            !request.at("expectedSourceGeneration").is_string() ||
            state.pending_generation.empty() ||
            request.at("expectedSourceGeneration").get<std::string>() != state.pending_generation)
            return conflict();
        const auto unchanged = [&]() {
            if (!native_project_disk_safety(root).value("ok", false))
                return false;
            return fence_resident_sources(*state.session);
        };
        // Bracket the independent exact binary-Asset proof with watcher/epoch
        // fences. This does not rescan or rehash the full authoring inventory.
        bool matching = false;
        try {
            matching = unchanged() &&
                       native_project_source_generation(*state.session, root, true,
                                                        "validation-final-generation") ==
                           request.at("expectedSourceGeneration").get<std::string>() &&
                       unchanged();
        } catch (const std::exception&) {
            matching = false;
        }
        if (!matching) {
            noveltea::authoring::trace_source_proof_event("validation-final", "conflict");
            return conflict();
        }
        return {{"ok", true},
                {"sessionAdmissions", state.session_admissions},
                {"work", work_counts_json(work_counts)}};
    }
    if (request.value("action", std::string("validate")) != "validate")
        return {{"ok", false}, {"error", "Unknown disk-validation action."}};
    state.pending_generation.clear();
    if (state.root != root) {
        state.session.reset();
        state.clear_preparations();
        state.root = root;
    }
    auto captures_before = state.session ? state.session->source_capture_count() : 0;
    auto record_hits_before = state.session ? state.session->localization_record_cache_hits() : 0;
    auto source_hits_before =
        state.session ? state.session->localization_source_path_cache_hits() : 0;
    if (state.session) {
        const auto observed = state.session->observe_sources();
        // The retained validator incrementally handles edits to existing
        // sources (including Lua), preserving its warm semantic work. A new
        // or removed source instead changes the inventory and requires fresh
        // Project admission; otherwise deleted records can remain in the view.
        if (observed.full_rescan || !observed.authoritative || !observed.delta.added.empty() ||
            !observed.delta.removed.empty()) {
            state.session.reset();
            state.clear_preparations(false, false);
            // The replacement authority starts its scan count at zero.
            captures_before = 0;
            record_hits_before = 0;
            source_hits_before = 0;
        } else {
            const auto revoke = [&](std::optional<OwnerValidation::ExternalCheck>& cached) {
                if (!cached)
                    return;
                const auto changed = [&](std::string_view path) {
                    for (const auto& source : cached->watched_paths)
                        if (source == path || source.starts_with(std::string(path) + "/"))
                            return true;
                    return false;
                };
                for (const auto& path : observed.delta.changed)
                    if (changed(path)) {
                        cached.reset();
                        return;
                    }
                // Even a same-size write with restored timestamps is a real
                // event; the metadata-only binary hint may compare equal.
                for (const auto& path : observed.watch_paths)
                    if (changed(path)) {
                        cached.reset();
                        return;
                    }
            };
            revoke(state.portable_check);
            revoke(state.notice_check);
        }
    }
    const bool warm = state.session != nullptr;
    std::string error;
    if (!state.session) {
        // Re-admission to this same canonical root certifies the new full
        // source generation. Keep previous Material data projections as
        // candidates and compare them to that new clean snapshot below.
        // Compiler proof and shader dependency invalidation remain separate.
        state.clear_preparations(false, false);
        trace_native_validation("opening mutable Project session");
        ++state.session_admissions;
        state.session = ProjectSession::open(root, error);
        trace_native_validation(state.session ? "mutable Project session opened"
                                              : "mutable Project session rejected");
        if (!state.session)
            trace_native_validation(error.c_str());
    }
    if (!state.session) {
        // The disk may be malformed, which strict mutable admission rejects.
        // Certification reads an invalid Project without admitting mutable state.
        trace_native_validation("starting cold invalid-Project validation");
        const auto cold = ProjectSession::validate_cold_project(root, error);
        trace_native_validation("cold invalid-Project validation returned");
        if (!cold)
            return {{"ok", false}, {"error", error}};
        auto result = response_for(*cold, false, {});
        result["work"]["endToEnd"] = work_counts_json(work_counts);
        return result;
    }
    trace_native_validation("starting resident Project validation");
    const auto validated = state.session->validate_clean_project(true, true);
    trace_native_validation("resident Project validation returned");
    // A request that did not ask for font inputs can still advance the
    // resident localization source generation. Invalidate its dependent
    // projection *now*, not only on the next request asking for coverage.
    // Otherwise a later unchanged request could reuse the prior generation.
    const auto semantic_work = state.session->validation_work();
    if (!validated.snapshot.valid || semantic_work.localization_rebuilds != 0 ||
        semantic_work.global_stage_executions != 0 ||
        (semantic_work.global_stage_reuses == 0 &&
         (semantic_work.rechecked_records != 0 || semantic_work.rechecked_contributions != 0 ||
          semantic_work.reference_indexed_records != 0)))
        state.font_inputs.reset();
    auto result = response_for(validated.snapshot, warm, state.session->validation_work());
    result["cacheHit"] = validated.cache_hit;
    result["work"]["sessionAdmissions"] = state.session_admissions;
    // A malformed physical source invalidates the mutable session's complete
    // source proof. Return its certified diagnostics without asking for that
    // proof: downstream preparation is only allowed for valid Projects.
    // Computing it for invalid validation turns a workspace error into an
    // internal CLI failure (and hides the actionable YAML location).
    if (validated.snapshot.valid) {
        if (!validated.deferred_exact_revisions)
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project source generation cannot be pinned."}};
        const auto effective = Json::parse(validated.snapshot.normalized_json, nullptr, false);
        if (!effective.is_object())
            throw std::runtime_error("Native validation returned no normalized Project.");
        // The CLI compiler preflight needs only this Project-authoritative fact.
        // Do not force a second complete shader/runtime preparation for it.
        result["entrypointConfigured"] =
            effective.contains("entrypoint") && !effective.at("entrypoint").is_null();
        if (request.value("includeFontCoverageInputs", false)) {
            const auto prepared = state.session->prepare_complete_working(
                state.session->working_revision(), {}, true, true);
            if (!prepared.accepted)
                throw std::runtime_error("Native font coverage Project preparation failed: " +
                                         prepared.error);
            const auto [reused, projected] = state.session->complete_project_assembly_work();
            result["work"]["completeProjectReused"] = reused;
            result["work"]["completeProjectProjected"] = projected;
            result["work"]["completeProjectSnapshotReads"] =
                state.session->complete_project_snapshot_reads();
            const auto admitted = Json::parse(prepared.complete_project_json);
            const auto portable_key = portable_inputs(admitted);
            const bool portable_reuse = external_watcher_cache_supported && state.portable_check &&
                                        state.portable_check->inputs == portable_key;
            result["work"]["portableSourceReuses"] = portable_reuse ? 1 : 0;
            if (!portable_reuse) {
                state.portable_check.reset();
                noveltea::authoring::count_validation_work(
                    &noveltea::authoring::ValidationWorkCounters::portable_source_checks);
                const auto portable = native_project_bundle(
                    {{"action", "validation-source-check"}, {"admittedProject", admitted}},
                    state.session.get(), root);
                if (!portable.value("ok", false)) {
                    result["portableFailure"] = portable.value(
                        "error", std::string("Native Project source preparation failed."));
                    return result;
                }
                if (external_watcher_cache_supported)
                    if (const auto watched =
                            observed_external_paths(portable.at("sourcePaths"), *state.session))
                        state.portable_check =
                            OwnerValidation::ExternalCheck{portable_key, *watched};
            }
            const auto notice_key = notice_inputs(admitted);
            const bool notice_reuse = external_watcher_cache_supported && state.notice_check &&
                                      state.notice_check->inputs == notice_key;
            result["work"]["noticeValidationReuses"] = notice_reuse ? 1 : 0;
            if (!notice_reuse) {
                state.notice_check.reset();
                result["work"]["noticeValidationRuns"] = 1;
                if (const auto notice_error = native_distribution_notice_error(root, admitted)) {
                    result["noticeValidationFailure"] = *notice_error;
                } else {
                    Json paths = Json::array();
                    for (const auto& notice : notice_key.at("settings"))
                        paths.push_back(notice.at("path"));
                    for (const auto& [_, entries] : notice_key.at("assets").items())
                        for (const auto& notice : entries)
                            paths.push_back(notice.at("path"));
                    if (external_watcher_cache_supported)
                        if (const auto watched = observed_external_paths(paths, *state.session))
                            state.notice_check =
                                OwnerValidation::ExternalCheck{notice_key, *watched};
                }
            } else {
                result["work"]["noticeValidationRuns"] = 0;
            }
            const auto work = state.session->validation_work();
            // Only an unchanged validated generation or the independently
            // certified Room/Map presentation-only path can reuse the exact
            // effective Message/translation source projection. Other changes
            // must rebuild it; font face bytes are proved separately below.
            const bool retain_inputs =
                state.font_inputs && work.localization_rebuilds == 0 &&
                work.global_stage_executions == 0 &&
                (work.global_stage_reuses == 1 ||
                 (work.rechecked_records == 0 && work.rechecked_contributions == 0 &&
                  work.reference_indexed_records == 0));
            if (retain_inputs) {
                result["fontCoverageInputs"] = *state.font_inputs;
                result["work"]["fontInputReuses"] = 1;
            } else {
                noveltea::authoring::count_validation_work(
                    &noveltea::authoring::ValidationWorkCounters::font_preparations);
                result["fontCoverageInputs"] =
                    native_font_coverage_inputs(*state.session, admitted);
                state.font_inputs = result["fontCoverageInputs"];
                result["work"]["fontInputReuses"] = 0;
            }
            // Font shaping is executed in this same serialized resident owner,
            // not anew in every short-lived public CLI client. The canonical
            // font tool itself verifies exact bytes and caches per locale.
            if (result["entrypointConfigured"].get<bool>() &&
                !result.contains("noticeValidationFailure")) {
                const auto font_request =
                    Json{{"projectRoot", root.string()}, {"locales", result["fontCoverageInputs"]}};
                const auto coverage =
                    noveltea::tooling::validate_font_coverage(font_request.dump());
                result["fontCoverageResult"] = Json::parse(coverage.response_json);
                if (result["fontCoverageResult"].contains("work")) {
                    const auto& font_work = result["fontCoverageResult"].at("work");
                    result["work"]["fontCoverageRuns"] = font_work.value("executedLocales", 0);
                    result["work"]["fontCoverageReusedLocales"] =
                        font_work.value("reusedLocales", 0);
                }
            }
            const Json materials = admitted.value("materials", Json::object());
            const Json assets = admitted.value("assets", Json::object());
            const bool same_assets = state.material_assets && *state.material_assets == assets;
            // The clean Project snapshot owns the canonical authored inputs.
            // Explorer labels/descriptions do not affect a Material's shader
            // request, but its base Material is a transitive dependency.
            const auto authored_shader_inputs = [](Json records) {
                for (auto& [id, record] : records.items()) {
                    (void)id;
                    if (record.is_object()) {
                        record.erase("label");
                        record.erase("description");
                    }
                }
                return records;
            };
            const Json previous_inputs = state.material_records
                                             ? authored_shader_inputs(*state.material_records)
                                             : Json::object();
            const Json current_inputs = authored_shader_inputs(materials);
            std::set<std::string> changed_materials;
            for (const auto& [id, authored] : current_inputs.items())
                if (!same_assets || !previous_inputs.contains(id) ||
                    previous_inputs.at(id) != authored || !state.material_effective.contains(id))
                    changed_materials.insert(id);
            // If a base is modified, its inheritors must resolve their
            // effective inputs again, even if their own YAML is unchanged.
            bool expanded;
            do {
                expanded = false;
                for (const auto& [id, authored] : current_inputs.items()) {
                    if (changed_materials.contains(id) || !authored.is_object())
                        continue;
                    const auto& data = authored.value("data", Json::object());
                    if (!data.is_object())
                        continue;
                    const auto& base = data.value("base", Json::object());
                    if (!base.is_object() || base.value("kind", std::string{}) != "material")
                        continue;
                    // Normalized native references are {$ref: {id: ...}},
                    // unlike the shorthand stored in authored YAML.
                    const auto reference = base.value("material", Json::object());
                    if (!reference.is_object())
                        continue;
                    const auto target = reference.value("$ref", Json::object());
                    if (target.is_object() &&
                        changed_materials.contains(target.value("id", std::string{})))
                        expanded = changed_materials.insert(id).second || expanded;
                }
            } while (expanded);

            // Retain the old verified results only for unchanged owners.
            // Stage the replacement locally so failures never leave a half-
            // updated resident Material cache.
            Json material_programs = Json::object();
            Json material_effective = Json::object();
            result["work"]["materialInputReuses"] = changed_materials.empty() ? 1 : 0;
            for (const auto& [id, _] : materials.items()) {
                if (!changed_materials.contains(id)) {
                    material_effective[id] = state.material_effective.at(id);
                    if (state.material_programs.contains(id))
                        material_programs[id] = state.material_programs.at(id);
                    continue;
                }
                {
                    noveltea::authoring::count_validation_work(
                        &noveltea::authoring::ValidationWorkCounters::material_shader_preparations);
                    const auto resolved = state.session->validated_material_compiler_effective(id);
                    if (!resolved)
                        throw std::runtime_error("Native validated Material resolution failed: " +
                                                 id);
                    const auto effective_material = Json::parse(*resolved);
                    material_effective[id] = effective_material;
                    // The effective Material has already been resolved,
                    // including inheritance and physical shader inputs.
                    // Do not resolve it a second time for compiler requests.
                    const auto compiler_request =
                        noveltea::authoring::material_shader_program_request(id, *resolved);
                    if (!compiler_request.empty()) {
                        const auto programs = Json::parse(compiler_request).at("programs");
                        if (!programs.empty())
                            material_programs[id] = programs;
                    }
                    // Public validate certifies preset programs too; unlike
                    // regular runtime lowering, it cannot trust preset binaries
                    // without the native stage's physical compiler evidence.
                    if (!effective_material.at("custom").get<bool>()) {
                        const auto& source = effective_material.at("shader");
                        Json program = Json::object();
                        for (const auto* field :
                             {"vertexSource", "fragmentSource", "varyingDefinition"})
                            program[field] = source.at(field);
                        program["interfaceContract"] = effective_material.at("interfaceContract");
                        program["interfaceFingerprint"] =
                            effective_material.at("interfaceFingerprint");
                        const auto key =
                            "preset-" + effective_material.at("preset").get<std::string>();
                        material_programs[id][key] = std::move(program);
                    }
                }
            }
            state.material_records = materials;
            state.material_assets = assets;
            state.material_programs = material_programs;
            state.material_effective = material_effective;
            result["materialCompilerPrograms"] = material_programs;
            result["materialEffectiveInputs"] = material_effective;
            const auto& coverage = result.value("fontCoverageResult", Json::object());
            const auto coverage_diagnostics = coverage.value("diagnostics", Json::array());
            const bool coverage_valid =
                coverage.value("ok", false) && coverage.value("success", false) &&
                std::none_of(
                    coverage_diagnostics.begin(), coverage_diagnostics.end(),
                    [](const Json& item) { return item.value("severity", "error") == "error"; });
            if (coverage_valid && result["entrypointConfigured"].get<bool>() &&
                !result.contains("noticeValidationFailure") && !material_programs.empty()) {
                const auto* source_revisions = state.session->verified_source_revisions_view();
                if (!source_revisions)
                    return {{"ok", false},
                            {"kind", "conflict"},
                            {"error", "Shader compiler source evidence is unavailable."}};
                noveltea::tooling::MaterialShaderValidationCache::Work shader_work;
                result["materialCompilerResult"] = state.shader_cache.validate(
                    root, material_programs, *source_revisions, shader_work);
                const auto& compiled = result["materialCompilerResult"];
                if (compiled.value("ok", false) && compiled.value("success", false))
                    result["materialReflectionDiagnostics"] =
                        state.shader_cache.reflected_materials(compiled, material_effective,
                                                               shader_work);
                result["work"]["shaderCompileRuns"] = shader_work.compiler_runs;
                result["work"]["shaderProgramsReused"] = shader_work.reused_programs;
                result["work"]["shaderOutputProofs"] = shader_work.output_proofs;
                result["work"]["materialInterfaceValidations"] = shader_work.interface_validations;
                result["work"]["materialInterfaceReuses"] = shader_work.interface_reuses;
            } else {
                result["work"]["shaderCompileRuns"] = 0;
                result["work"]["shaderProgramsReused"] = 0;
                result["work"]["shaderOutputProofs"] = 0;
                result["work"]["materialInterfaceValidations"] = 0;
                result["work"]["materialInterfaceReuses"] = 0;
            }
        }
        // Bind a successful diagnostic graph to the exact physical generation
        // consumed by downstream preparation; never mix separate admissions.
        // Validate the source generation after all source-derived work. The
        // observation certifies exact text hashes used by the fast generator;
        // the generator still hashes binary Assets independently.
        if (!fence_resident_sources(*state.session))
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
        std::map<std::string, std::string> post_revisions;
        try {
            result["sourceGeneration"] = native_project_source_generation(
                *state.session, root, true, "validation-preparation-generation", &post_revisions,
                &*validated.deferred_exact_revisions);
        } catch (const std::exception&) {
            state.session->source_watch_coverage_lost();
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
        }
        if (!fence_resident_sources(*state.session))
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
        if (!state.session->publish_deferred_clean_validation(validated, post_revisions))
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
        state.pending_generation = result.at("sourceGeneration").get<std::string>();
    } else if (!fence_resident_sources(*state.session)) {
        return {{"ok", false},
                {"kind", "conflict"},
                {"error", "Project sources changed during validation."}};
    }
    work_counts.record_contributions = state.session->validation_work().rechecked_contributions;
    work_counts.dependency_contributions =
        state.session->validation_work().reference_indexed_records;
    work_counts.localization_checks = state.session->validation_work().localization_rebuilds;
    result["work"]["endToEnd"] = work_counts_json(work_counts);
    result["work"]["sourceCaptures"] = state.session->source_capture_count() - captures_before;
    result["work"]["localizationRecordsReused"] =
        state.session->localization_record_cache_hits() - record_hits_before;
    result["work"]["localizationSourcePathsReused"] =
        state.session->localization_source_path_cache_hits() - source_hits_before;
    return result;
}

} // namespace

extern "C" std::uint64_t noveltea_tooling_native_disk_project_validation_json(
    const std::uint8_t* request, std::uint64_t request_size, std::uint8_t* response,
    std::uint64_t response_capacity)
{
    std::string serialized;
    try {
        if (!request && request_size != 0)
            throw std::runtime_error("Native disk validation request is absent.");
        serialized = validate(std::string_view(reinterpret_cast<const char*>(request),
                                               static_cast<std::size_t>(request_size)))
                         .dump();
    } catch (const std::exception& error) {
        serialized = Json{{"ok", false}, {"error", error.what()}}.dump();
    }
    const auto required = static_cast<std::uint64_t>(serialized.size());
    if (response && response_capacity >= required)
        std::memcpy(response, serialized.data(), serialized.size());
    return required;
}
