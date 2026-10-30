#include "tooling_native_c.h"
#include "tooling_native_project_asset.hpp"
#include "tooling_native_project_bundle.hpp"
#include "tooling_native_project_localization.hpp"
#include "tooling_native_project_sync.hpp"

#include "../project_authoring/room_session.hpp"
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
    std::mutex mutex;
    std::filesystem::path root;
    std::unique_ptr<ProjectSession> session;
    std::uint64_t session_admissions = 0;
};

OwnerValidation& resident()
{
    static OwnerValidation value;
    return value;
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
              {"localizationRebuilds", work.localization_rebuilds}}}};
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
    auto& state = resident();
    std::scoped_lock lock(state.mutex);
    if (request.value("action", std::string("validate")) == "release") {
        if (state.root == root) {
            state.session.reset();
            state.root.clear();
        }
        return {{"ok", true}};
    }
    if (request.value("action", std::string("validate")) == "source-generation-proof") {
        const auto conflict = [&]() -> Json {
            // Observation must not consume inventory changes that the next validation
            // would otherwise use to revoke its admitted Project.
            state.session.reset();
            return {{"ok", false}, {"kind", "conflict"}, {"error", "Project sources changed."}};
        };
        if (state.root != root || !state.session || !request.contains("expectedSourceGeneration") ||
            !request.at("expectedSourceGeneration").is_string())
            return conflict();
        const auto unchanged = [&]() {
            if (!native_project_disk_safety(root).value("ok", false))
                return false;
            const auto observed = state.session->observe_sources();
            return observed.authoritative && observed.unchanged;
        };
        // Bracket exact content hashing (including binary Assets) with retained
        // membership/containment observations. Watcher hints never certify bytes.
        if (!unchanged() ||
            native_project_source_generation(*state.session, root, true,
                                             "validation-final-generation") !=
                request.at("expectedSourceGeneration").get<std::string>() ||
            !unchanged()) {
            noveltea::authoring::trace_source_proof_event("validation-final", "conflict");
            return conflict();
        }
        return {{"ok", true}, {"sessionAdmissions", state.session_admissions}};
    }
    if (request.value("action", std::string("validate")) != "validate")
        return {{"ok", false}, {"error", "Unknown disk-validation action."}};
    if (state.root != root) {
        state.session.reset();
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
            // The replacement authority starts its scan count at zero.
            captures_before = 0;
            record_hits_before = 0;
            source_hits_before = 0;
        }
    }
    const bool warm = state.session != nullptr;
    std::string error;
    if (!state.session) {
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
        return response_for(*cold, false, {});
    }
    trace_native_validation("starting resident Project validation");
    const auto validated = state.session->validate_clean_project(true, true);
    trace_native_validation("resident Project validation returned");
    auto result = response_for(validated.snapshot, warm, state.session->validation_work());
    result["cacheHit"] = validated.cache_hit;
    result["work"]["sessionAdmissions"] = state.session_admissions;
    // A malformed physical source invalidates the mutable session's complete
    // source proof. Return its certified diagnostics without asking for that
    // proof: downstream preparation is only allowed for valid Projects.
    // Computing it for invalid validation turns a workspace error into an
    // internal CLI failure (and hides the actionable YAML location).
    if (validated.snapshot.valid) {
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
            const auto admitted = Json::parse(prepared.complete_project_json);
            const auto portable = native_project_bundle(
                {{"action", "validation-source-check"}, {"admittedProject", admitted}},
                state.session.get(), root);
            if (!portable.value("ok", false)) {
                result["portableFailure"] = portable.value(
                    "error", std::string("Native Project source preparation failed."));
                return result;
            }
            if (const auto notice_error = native_distribution_notice_error(root, admitted))
                result["noticeValidationFailure"] = *notice_error;
            result["fontCoverageInputs"] = native_font_coverage_inputs(*state.session, admitted);
            Json material_programs = Json::object();
            Json material_effective = Json::object();
            if (admitted.contains("materials") && admitted.at("materials").is_object()) {
                for (const auto& [id, _] : admitted.at("materials").items()) {
                    const auto inspected = state.session->inspect_record("materials/" + id);
                    if (!inspected.accepted)
                        throw std::runtime_error("Native Material owner cannot be inspected: " +
                                                 id + ": " + inspected.error);
                    const auto resolved = state.session->material_compiler_effective(id);
                    if (!resolved)
                        throw std::runtime_error("Native Material resolution failed: " + id);
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
            result["materialCompilerPrograms"] = std::move(material_programs);
            result["materialEffectiveInputs"] = std::move(material_effective);
        }
        // Bind a successful diagnostic graph to the exact physical generation
        // consumed by downstream preparation; never mix separate admissions.
        // Validate the source generation after all source-derived work. The
        // observation certifies exact text hashes used by the fast generator;
        // the generator still hashes binary Assets independently.
        const auto final_observation = state.session->observe_sources();
        if (!final_observation.authoritative || !final_observation.unchanged ||
            final_observation.full_rescan)
            throw std::runtime_error("Project sources changed during validation preparation.");
        std::map<std::string, std::string> post_revisions;
        result["sourceGeneration"] = native_project_source_generation(
            *state.session, root, true, "validation-preparation-generation",
            validated.deferred_exact_revisions ? &post_revisions : nullptr);
        if (!state.session->publish_deferred_clean_validation(validated, post_revisions))
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
    }
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
