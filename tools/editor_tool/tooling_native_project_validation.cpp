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
        std::map<std::string, std::string> source_revisions;

        bool matches(const std::map<std::string, std::string>* current) const
        {
            if (!current)
                return false;
            for (const auto& [path, revision] : source_revisions) {
                const auto found = current->find(path);
                if (found == current->end() || found->second != revision)
                    return false;
            }
            return true;
        }

        bool matches_portable(const std::map<std::string, std::string>* current) const
        {
            if (!matches(current))
                return false;
            // Workflow files are independent of the Project YAML projection.
            // A prior portable proof must cover the *complete current* loose
            // workflow inventory, not merely whichever members existed when
            // its paths were captured.
            for (auto it = current->lower_bound("workflows/");
                 it != current->end() && it->first.starts_with("workflows/"); ++it)
                if (it->second != "absent" && !source_revisions.contains(it->first))
                    return false;
            return true;
        }
    };
    std::mutex mutex;
    std::filesystem::path root;
    std::unique_ptr<ProjectSession> session;
    // Only the most recent valid public validation may be finalized. This
    // generation belongs to the resident session and is never persisted.
    std::string pending_generation;
    std::map<std::string, std::string> pending_exact_revisions;
    std::uint64_t session_admissions = 0;
    // Derived only from this session's last certified localization generation.
    // A new admission cannot borrow another Project's source projection.
    std::optional<Json> font_inputs;
    std::optional<Json> certified_font_result;
    std::optional<Json> certified_font_inputs;
    std::map<std::string, std::string> certified_font_sources;
    noveltea::tooling::FontCoverageSourceProofs font_source_proofs;
    noveltea::tooling::FontCoverageSourceProofs& current_font_proofs()
    {
        const auto epoch = session->source_watch_epoch();
        if (font_source_proofs.watch_epoch != epoch) {
            font_source_proofs.project_fonts.clear();
            font_source_proofs.watch_epoch = epoch;
        }
        return font_source_proofs;
    }
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
        certified_font_result.reset();
        certified_font_inputs.reset();
        certified_font_sources.clear();
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
        else
            shader_cache.discard_certified_stage();
    }
};

bool can_reuse_font_result(const OwnerValidation& state)
{
    if (!state.certified_font_result || !state.certified_font_inputs || !state.font_inputs ||
        *state.certified_font_inputs != *state.font_inputs ||
        !state.session->source_watcher_proof_available() ||
        !noveltea::tooling::retained_font_system_sources_current())
        return false;
    const auto* current = state.session->verified_source_revisions_view();
    if (!current)
        return false;
    for (const auto& [path, revision] : state.certified_font_sources) {
        const auto found = current->find(path);
        if (found == current->end() || found->second != revision)
            return false;
    }
    return true;
}

void validate_or_reuse_font_result(OwnerValidation& state, Json& result)
{
    if (can_reuse_font_result(state)) {
        result["fontCoverageResult"] = *state.certified_font_result;
        result["work"]["fontCoverageRuns"] = 0;
        result["work"]["fontCoverageReusedLocales"] = state.font_inputs->size();
        return;
    }
    const auto coverage = [&] {
        noveltea::authoring::ScopedValidationStageTime<
            noveltea::authoring::WorkCounter::FontCoverageMicros> timed;
        return noveltea::tooling::validate_font_coverage(
            Json{{"projectRoot", state.root.string()}, {"locales", *state.font_inputs}}.dump(),
            state.session->verified_source_revisions_view(), state.current_font_proofs());
    }();
    result["fontCoverageResult"] = Json::parse(coverage.response_json);
    const auto work = result["fontCoverageResult"].value("work", Json::object());
    result["work"]["fontCoverageRuns"] = work.value("executedLocales", 0);
    result["work"]["fontCoverageReusedLocales"] = work.value("reusedLocales", 0);
    state.certified_font_result.reset();
    state.certified_font_inputs.reset();
    state.certified_font_sources.clear();
    // A deterministic missing-glyph diagnostic is as reusable as successful
    // coverage. Only uncertain execution/source failures (ok=false) must
    // re-enter the tool when the Project and font generations are unchanged.
    if (!result["fontCoverageResult"].value("ok", false) ||
        !state.session->source_watcher_proof_available())
        return;
    const auto* revisions = state.session->verified_source_revisions_view();
    if (!revisions)
        return;
    for (const auto& locale : *state.font_inputs) {
        for (const auto& font : locale.value("fonts", Json::array())) {
            if (!font.is_string())
                return;
            const auto path = font.get<std::string>();
            if (!path.starts_with("project:/"))
                return; // Unknown external font binding: full physical check.
            const auto relative = path.substr(std::string_view("project:/").size());
            const auto found = revisions->find(relative);
            if (found == revisions->end() || !found->second.starts_with("physical:"))
                return;
            state.certified_font_sources.emplace(relative, found->second);
        }
    }
    state.certified_font_inputs = *state.font_inputs;
    state.certified_font_result = result["fontCoverageResult"];
}

OwnerValidation::ExternalCheck capture_external_check(
    Json inputs, std::set<std::string> watched,
    const std::map<std::string, std::string>& revisions)
{
    OwnerValidation::ExternalCheck check{std::move(inputs), std::move(watched), {}};
    for (const auto& path : check.watched_paths)
        check.source_revisions.emplace(path, revisions.at(path));
    return check;
}

Json stage_ledger(const OwnerValidation& state)
{
    noveltea::authoring::ScopedValidationStageTime<
        noveltea::authoring::WorkCounter::StageLedgerMicros> timed;
    noveltea::authoring::ScopedValidationStageTime<
        noveltea::authoring::WorkCounter::StageLedgerConstructionMicros> construction;
    if (!state.portable_check || !state.notice_check || !state.font_inputs ||
        !state.material_records || !state.material_assets)
        return nullptr;
    Json projection = {{"fontCoverageInputs", *state.font_inputs},
                       {"materialCompilerPrograms", state.material_programs},
                       {"materialEffectiveInputs", state.material_effective}};
    return {{"projection", projection},
            {"portable", {{"inputs", state.portable_check->inputs},
                           {"paths", state.portable_check->watched_paths},
                           {"revisions", state.portable_check->source_revisions}}},
            {"notices", {{"inputs", state.notice_check->inputs},
                          {"paths", state.notice_check->watched_paths},
                          {"revisions", state.notice_check->source_revisions}}},
            {"materials", *state.material_records}, {"assets", *state.material_assets},
            {"fonts", Json::parse(noveltea::tooling::font_coverage_ledger())},
            {"shaders", state.shader_cache.ledger()}};
}

std::string serialize_stage_ledger(const OwnerValidation& state)
{
    const auto stages = stage_ledger(state);
    noveltea::authoring::ScopedValidationStageTime<
        noveltea::authoring::WorkCounter::StageLedgerJsonSerializationMicros> timed;
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::StageLedgerSerializations>();
    auto serialized = stages.dump();
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::StageLedgerBytesSerialized>(serialized.size());
    return serialized;
}

void validate_material_stage(OwnerValidation& state, const std::filesystem::path& root,
                             const Json& programs, const Json& effective,
                             const std::map<std::string, std::string>& revisions, Json& result)
{
    noveltea::tooling::MaterialShaderValidationCache::Work shader_work;
    const auto stage = state.shader_cache.reuse_certified_stage(root, programs, effective, revisions);
    result["work"]["shaderStageReuses"] = stage ? 1 : 0;
    result["work"]["shaderValidationCalls"] = stage ? 0 : 1;
    result["materialCompilerResult"] = stage ? stage->compiled : [&] {
        noveltea::authoring::ScopedValidationStageTime<
            noveltea::authoring::WorkCounter::ShaderValidationMicros> timed;
        return state.shader_cache.validate(root, programs, revisions, shader_work);
    }();
    const auto& compiled = result.at("materialCompilerResult");
    if (compiled.value("ok", false) && compiled.value("success", false)) {
        result["materialReflectionDiagnostics"] =
            stage ? stage->reflections
                  : state.shader_cache.reflected_materials(compiled, effective, shader_work);
        if (!stage)
            state.shader_cache.certify_stage(root, programs, effective, revisions,
                                            {compiled, result.at("materialReflectionDiagnostics")},
                                            shader_work);
    }
    result["work"]["shaderCompileRuns"] = shader_work.compiler_runs;
    result["work"]["shaderProgramsReused"] = shader_work.reused_programs;
    result["work"]["shaderOutputProofs"] = shader_work.output_proofs;
    result["work"]["materialInterfaceValidations"] = shader_work.interface_validations;
    result["work"]["materialInterfaceReuses"] = shader_work.interface_reuses;
}

bool restore_stages(OwnerValidation& state, std::string_view serialized, Json& result,
                    bool retain_resident = false)
{
    if (retain_resident) {
        // An unchanged semantic generation or certified presentation-only
        // Room/Map edit cannot modify the portable, notice, Material or
        // localization source projections.
        // Retained external paths were proved by the authoritative source
        // observation and remain fenced, with a full exact-scan fallback when
        // the host monitor is unavailable. Font and shader byte proofs are
        // checked by their own stages below.
        const auto* current = state.session->verified_source_revisions_view();
        if (!current || !state.portable_check ||
            !state.notice_check || !state.font_inputs || !state.material_records ||
            !state.material_assets || !state.portable_check->matches_portable(current) ||
            !state.notice_check->matches(current))
            return false;
        result["fontCoverageInputs"] = *state.font_inputs;
        result["materialCompilerPrograms"] = state.material_programs;
        result["materialEffectiveInputs"] = state.material_effective;
        result["work"]["retainedStageProjections"] = 1;
    } else {
        if (serialized.empty())
            return false;
        try {
            const auto ledger = Json::parse(serialized);
            if (!ledger.is_object() || ledger.size() != 7 ||
                !ledger.at("projection").is_object() || ledger.at("projection").size() != 3 ||
                !ledger.at("materials").is_object() || !ledger.at("assets").is_object())
                throw std::runtime_error("Malformed external validation ledger.");
            const auto& projection = ledger.at("projection");
            if (!projection.at("fontCoverageInputs").is_array() ||
                !projection.at("materialCompilerPrograms").is_object() ||
                !projection.at("materialEffectiveInputs").is_object())
                throw std::runtime_error("Malformed external validation projection.");
            const auto* revisions = state.session->verified_source_revisions_view();
            if (!revisions)
                throw std::runtime_error("No verified external validation source revision.");
            const auto check = [&](const Json& value) -> OwnerValidation::ExternalCheck {
                if (!value.is_object() || value.size() != 3 || !value.at("inputs").is_object() ||
                    !value.at("paths").is_array() || !value.at("revisions").is_object())
                    throw std::runtime_error("Malformed external validation ledger.");
                auto paths = value.at("paths").get<std::set<std::string>>();
                auto saved = value.at("revisions").get<std::map<std::string, std::string>>();
                if (saved.size() != paths.size())
                    throw std::runtime_error("Malformed external validation source proofs.");
                for (const auto& path : paths) {
                    const auto current = revisions->find(path);
                    if (current == revisions->end() || !saved.contains(path) ||
                        current->second != saved.at(path))
                        throw std::runtime_error("Stale external validation source proof.");
                }
                return {value.at("inputs"), std::move(paths), std::move(saved)};
            };
            const auto portable = check(ledger.at("portable"));
            const auto notices = check(ledger.at("notices"));
            if (!portable.matches_portable(revisions))
                throw std::runtime_error("Stale portable workflow membership proof.");
            noveltea::tooling::MaterialShaderValidationCache restored_shaders;
            if (!restored_shaders.restore_ledger(state.root, ledger.at("shaders")) ||
                !noveltea::tooling::restore_font_coverage_ledger(ledger.at("fonts").dump()))
                throw std::runtime_error("Malformed font or shader validation evidence.");
            state.shader_cache = std::move(restored_shaders);
            state.portable_check = portable;
            state.notice_check = notices;
            state.material_records = ledger.at("materials");
            state.material_assets = ledger.at("assets");
            state.material_programs = projection.at("materialCompilerPrograms");
            state.material_effective = projection.at("materialEffectiveInputs");
            state.font_inputs = projection.at("fontCoverageInputs");
            result.update(projection);
        } catch (...) {
            // An optional, stale or malformed persisted stage cannot revoke
            // otherwise proven resident Material/shader candidates. The fallback
            // below rechecks every candidate against its exact current inputs.
            return false;
        }
    }
    result["work"]["portableSourceReuses"] = 1;
    result["work"]["noticeValidationReuses"] = 1;
    result["work"]["noticeValidationRuns"] = 0;
    result["work"]["fontInputReuses"] = 1;
    result["work"]["materialInputReuses"] = 1;
    if (result.at("entrypointConfigured").get<bool>()) {
        validate_or_reuse_font_result(state, result);
        const auto& font = result.at("fontCoverageResult");
        const auto font_diagnostics = font.value("diagnostics", Json::array());
        const bool coverage_valid = font.value("ok", false) && font.value("success", false) &&
            std::none_of(font_diagnostics.begin(), font_diagnostics.end(),
                         [](const Json& item) { return item.value("severity", "error") == "error"; });
        if (coverage_valid && !state.material_programs.empty()) {
            validate_material_stage(state, state.root, state.material_programs,
                                    state.material_effective,
                                    *state.session->verified_source_revisions_view(), result);
        }
    }
    return true;
}

void restore_independent_stage_evidence(OwnerValidation& state, std::string_view serialized)
{
    // An offline source edit invalidates the old Project-wide projections.
    // Only the font and shader ledgers carry independent input/output keys:
    // each validator re-proves those keys when its new inputs are submitted.
    // Never import the old portable, notice or Material projection here.
    try {
        const auto ledger = Json::parse(serialized);
        if (!ledger.is_object() || ledger.size() != 7)
            return;
        state.shader_cache.restore_ledger(state.root, ledger.at("shaders"));
        noveltea::tooling::restore_font_coverage_ledger(ledger.at("fonts").dump());
    } catch (...) {
        // Optional acceleration only; a malformed stage is a normal miss.
    }
}

OwnerValidation*& resident_slot()
{
    static OwnerValidation* owner = nullptr;
    return owner;
}

OwnerValidation& resident()
{
    static OwnerValidation value;
    resident_slot() = &value;
    return value;
}

bool fence_resident_sources(ProjectSession& session)
{
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::SourceGenerationFences>();
    // The native authority supplies a synchronous inotify/USN/FSEvents fence
    // when its coverage is reliable. Unsupported or inaccessible host monitors
    // must re-prove the entire source inventory by exact observation instead.
    if (session.source_watcher_proof_available())
        return session.fence_observed_sources();
    const auto observation = session.observe_sources();
    return observation.authoritative && observation.unchanged && !observation.full_rescan;
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
        noveltea::authoring::count_validation_work<
            noveltea::authoring::WorkCounter::FileByteReads>();
        noveltea::authoring::count_validation_work<
            noveltea::authoring::WorkCounter::FileBytesRead>(bytes.size());
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
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    Json result = Json::object();
    for (const auto& [field, value] : counts.fields())
        result[std::string(field)] = value;
    return result;
#else
    (void)counts;
    return Json::object();
#endif
}

Json response_for(const noveltea::authoring::RoomSessionSnapshot& snapshot, bool warm,
                  const ProjectSession::ValidationWork& work, bool cli_only = false)
{
    Json diagnostics = Json::array();
    Json cli_diagnostics = Json::array();
    for (const auto& diagnostic : snapshot.diagnostics) {
        if (!cli_only) {
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
        }

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
    Json result{{"ok", true},
            {"valid", snapshot.valid},
            {"exitCode", snapshot.valid ? 0 : 1},
            {"warm", warm},
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
              {"semanticFallbackReasons", work.semantic_fallback_reasons},
              {"coldValidationFallback", false},
              {"recheckedRecordOwners", work.rechecked_record_owners},
              {"recheckedContributionOwners", work.rechecked_contribution_owners},
              {"invalidatedOwners", work.invalidated_owners}}}};
    if (!cli_only)
        result["diagnostics"] = std::move(diagnostics);
    return result;
}

bool final_source_generation_matches(OwnerValidation& state, const std::filesystem::path& root,
                                     std::string_view expected)
{
    if (!state.session || state.pending_generation.empty() ||
        state.pending_generation != expected)
        return false;
    const auto unchanged = [&]() {
        noveltea::authoring::count_validation_work<
            noveltea::authoring::WorkCounter::DiskSafetyChecks>();
        noveltea::authoring::ScopedValidationStageTime<
            noveltea::authoring::WorkCounter::DiskSafetyMicros> timed;
        return native_project_disk_safety(root).value("ok", false) &&
               fence_resident_sources(*state.session);
    };
    try {
        // A final, independent proof after all semantic/external stages. The
        // earlier preparation proof alone cannot certify public publication.
        return unchanged() && [&] {
            noveltea::authoring::ScopedValidationStageTime<
                noveltea::authoring::WorkCounter::SourceGenerationMicros> timed;
            return native_project_source_generation(*state.session, root, true,
                                                    "validation-final-generation", nullptr,
#if defined(__APPLE__)
                                                    nullptr) ==
#else
                                                    &state.pending_exact_revisions) ==
#endif
                   expected;
        }() && unchanged();
    } catch (const std::exception&) {
        return false;
    }
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
    if (request.value("action", std::string("validate")) == "maintenance") {
        // The daemon owner calls this only while idle. The elected cache
        // writer uses its own resident SourceAuthority; a nonowner performs
        // only the five-second nonblocking OS lock retry.
        if (state.root != root) {
            state.session.reset();
            state.clear_preparations();
            state.root = root;
        }
        if (!state.session) {
            std::string error;
            state.session = ProjectSession::open(root, error);
            if (!state.session)
                return {{"ok", false}, {"error", error}};
            ++state.session_admissions;
            state.session->enable_resident_cache_maintenance();
        }
        state.session->maintain_clean_cache();
        return {{"ok", true}, {"writer", state.session->owns_clean_cache_lease()}};
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
        if (!final_source_generation_matches(
                state, root, request.at("expectedSourceGeneration").get<std::string>())) {
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
    state.pending_exact_revisions.clear();
    if (state.root != root) {
        state.session.reset();
        state.clear_preparations();
        state.root = root;
    }
    auto captures_before = state.session ? state.session->source_capture_count() : 0;
    auto record_hits_before = state.session ? state.session->localization_record_cache_hits() : 0;
    auto source_hits_before =
        state.session ? state.session->localization_source_path_cache_hits() : 0;
    std::string readmission_reason;
    if (state.session) {
        const auto observed = state.session->observe_sources();
        const bool unsafe_external_source = std::any_of(
            observed.invalid_sources.begin(), observed.invalid_sources.end(),
            [](const auto& source) {
                return source.error.find("not contained in the Project") != std::string::npos;
            });
        // A proven membership delta is owned by the existing ProjectSession:
        // its pending source revisions retire removed contributors while the
        // old reverse edges remain available for impact calculation. A scoped
        // observation of an invalid source is also sufficient to preserve the
        // other resident owners and their attributable diagnostics.
        if (observed.full_rescan || (!observed.authoritative && !observed.scoped_authority) ||
            unsafe_external_source) {
            readmission_reason = observed.full_rescan   ? "source-authority-recovery"
                                 : unsafe_external_source ? "unsafe-external-source"
                                                          : "source-authority-unproven";
            state.session.reset();
            state.clear_preparations(false, false);
            // The replacement authority starts its scan count at zero.
            captures_before = 0;
            record_hits_before = 0;
            source_hits_before = 0;
        } else {
            // Portable packaging includes loose watched source families even
            // when they have no YAML owner. A newly added workflow, for
            // example, was never in the previous stage's watched_paths and
            // cannot be detected by comparing only retained source revisions.
            // Record inventory changes in source-bearing collections can also
            // change portable/notice inputs on deletion without parsing any
            // surviving owner. Room/Map and localization membership alone do
            // not revoke otherwise independent external stages.
            const auto source_bearing_membership = [](const std::string& path) {
                if (path.starts_with("i18n/"))
                    return false;
                if (!path.starts_with("records/"))
                    return true;
                return path.starts_with("records/assets/") ||
                       path.starts_with("records/animations/") ||
                       path.starts_with("records/layouts/") ||
                       path.starts_with("records/materials/") ||
                       path.starts_with("records/scripts/");
            };
            const auto membership_changed = [&](const auto& paths) {
                return std::any_of(paths.begin(), paths.end(), source_bearing_membership);
            };
            if (membership_changed(observed.delta.added) ||
                membership_changed(observed.delta.removed))
                state.portable_check.reset();
            const auto asset_record = [](const std::string& path) {
                return path.starts_with("records/assets/") && path.ends_with(".yaml");
            };
            if (std::any_of(observed.delta.added.begin(), observed.delta.added.end(), asset_record) ||
                std::any_of(observed.delta.removed.begin(), observed.delta.removed.end(), asset_record))
                state.notice_check.reset();
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
                for (const auto& path : observed.delta.added)
                    if (changed(path)) {
                        cached.reset();
                        return;
                    }
                for (const auto& path : observed.delta.removed)
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
            // Resident cache maintenance can consume a watcher event before
            // the next public request. A retained stage must compare the
            // certified revision snapshot, not only this call's event list.
            const auto* current = state.session->verified_source_revisions_view();
            if (state.portable_check && !state.portable_check->matches_portable(current))
                state.portable_check.reset();
            if (state.notice_check && !state.notice_check->matches(current))
                state.notice_check.reset();
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
        state.font_source_proofs = {};
        if (state.session)
            state.session->enable_resident_cache_maintenance();
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
        auto result = response_for(*cold, false, {}, request.value("compactValidationResponse", false));
        result["work"]["coldValidationFallback"] = true;
        result["work"]["semanticFallbackReasons"] = Json::array({"cold-invalid-project-admission"});
        if (!readmission_reason.empty())
            result["work"]["semanticFallbackReasons"].push_back(readmission_reason);
        result["work"]["sessionAdmissions"] = state.session_admissions;
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        noveltea::authoring::count_validation_work<
            noveltea::authoring::WorkCounter::ValidationResponseSerializations>();
        result["work"]["endToEnd"] = work_counts_json(work_counts);
#endif
        return result;
    }
    trace_native_validation("starting resident Project validation");
    const auto validated = [&] {
        noveltea::authoring::ScopedValidationStageTime<
            noveltea::authoring::WorkCounter::SessionValidationMicros> timed;
        return state.session->validate_clean_project(true, true);
    }();
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
    auto result = response_for(validated.snapshot, warm, state.session->validation_work(),
                               request.value("compactValidationResponse", false));
    result["cacheHit"] = validated.cache_hit;
    result["work"]["sessionAdmissions"] = state.session_admissions;
    if (!readmission_reason.empty())
        result["work"]["semanticFallbackReasons"].push_back(readmission_reason);
    // A malformed physical source invalidates the mutable session's complete
    // source proof. Return its certified diagnostics without asking for that
    // proof: downstream preparation is only allowed for valid Projects.
    // Computing it for invalid validation turns a workspace error into an
    // internal CLI failure (and hides the actionable YAML location).
    if (validated.snapshot.valid) {
        if (!validated.cache_hit && !validated.stages_json.empty())
            restore_independent_stage_evidence(state, validated.stages_json);
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
        // A certified unchanged semantic generation, or a presentation-only
        // Room/Map update whose global contribution was reused, cannot modify
        // these downstream input projections. Reuse the *resident* proofs
        // rather than reassembling/serializing the entire Project. The watcher
        // separately revokes portable/notice paths changed outside semantics.
        const bool unchanged_semantics = semantic_work.rechecked_records == 0 &&
            semantic_work.rechecked_contributions == 0 &&
            semantic_work.reference_indexed_records == 0 &&
            semantic_work.localization_rebuilds == 0 &&
            semantic_work.global_stage_executions == 0;
        const bool presentation_only = semantic_work.rechecked_records != 0 &&
            semantic_work.global_stage_reuses == 1 &&
            semantic_work.global_stage_executions == 0 &&
            semantic_work.localization_rebuilds == 0;
        // Every host has either an authoritative watched source generation or
        // an exact full observation. Neither permits retained projections if
        // an external path changed or its proof is missing.
        const bool retain_stage_projections =
            !validated.cache_hit && (unchanged_semantics || presentation_only) &&
            state.session->verified_source_revisions_view() && state.portable_check &&
            state.notice_check && state.font_inputs && state.material_records &&
            state.material_assets;
        // A failed watcher epoch is not a license to re-admit external stage
        // results from an older disk ledger, even if the resulting path set
        // happens to match again (e.g. create, rename, then remove workflow).
        // Rebuild against the freshly certified physical generation instead.
        if (request.value("includeFontCoverageInputs", false) &&
            (!readmission_reason.empty() ||
             !restore_stages(state, validated.stages_json, result, retain_stage_projections))) {
            const auto prepared = [&] {
                noveltea::authoring::ScopedValidationStageTime<
                    noveltea::authoring::WorkCounter::CompleteProjectPreparationMicros> timed;
                return state.session->prepare_complete_working(
                    state.session->working_revision(), {}, true, true);
            }();
            if (!prepared.accepted)
                throw std::runtime_error("Native font coverage Project preparation failed: " +
                                         prepared.error);
            const auto [reused, projected] = state.session->complete_project_assembly_work();
            result["work"]["completeProjectReused"] = reused;
            result["work"]["completeProjectProjected"] = projected;
            result["work"]["completeProjectSnapshotReads"] =
                state.session->complete_project_snapshot_reads();
            const auto admitted = Json::parse(prepared.complete_project_json);
            const auto portable_key = [&] {
                noveltea::authoring::ScopedValidationStageTime<
                    noveltea::authoring::WorkCounter::PortableInputPreparationMicros> timed;
                return portable_inputs(admitted);
            }();
            const bool portable_reuse = state.portable_check &&
                                        state.portable_check->matches_portable(
                                            state.session->verified_source_revisions_view()) &&
                                        state.portable_check->inputs == portable_key;
            result["work"]["portableSourceReuses"] = portable_reuse ? 1 : 0;
            if (!portable_reuse) {
                state.portable_check.reset();
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::PortableSourceChecks>();
                const auto portable = [&] {
                    noveltea::authoring::ScopedValidationStageTime<
                        noveltea::authoring::WorkCounter::PortableSourceValidationMicros> timed;
                    return native_project_bundle(
                        {{"action", "validation-source-check"}, {"admittedProject", admitted}},
                        state.session.get(), root);
                }();
                if (!portable.value("ok", false)) {
                    result["portableFailure"] = portable.value(
                        "error", std::string("Native Project source preparation failed."));
                    return result;
                }
                // Persist only the paths backed by this source authority's
                // exact bytes. The next observation revokes changed paths;
                // hosts without a reliable watcher fully scan before reuse.
                if (const auto watched =
                        observed_external_paths(portable.at("sourcePaths"), *state.session))
                    state.portable_check = capture_external_check(
                        portable_key, *watched, *state.session->verified_source_revisions_view());
            }
            const auto notice_key = [&] {
                noveltea::authoring::ScopedValidationStageTime<
                    noveltea::authoring::WorkCounter::NoticeInputPreparationMicros> timed;
                return notice_inputs(admitted);
            }();
            const bool notice_reuse = state.notice_check &&
                                      state.notice_check->matches(
                                          state.session->verified_source_revisions_view()) &&
                                      state.notice_check->inputs == notice_key;
            result["work"]["noticeValidationReuses"] = notice_reuse ? 1 : 0;
            if (!notice_reuse) {
                state.notice_check.reset();
                result["work"]["noticeValidationRuns"] = 1;
                const auto notice_error = [&] {
                    noveltea::authoring::ScopedValidationStageTime<
                        noveltea::authoring::WorkCounter::NoticeValidationMicros> timed;
                    return native_distribution_notice_error(root, admitted);
                }();
                if (notice_error) {
                    result["noticeValidationFailure"] = *notice_error;
                } else {
                    Json paths = Json::array();
                    for (const auto& notice : notice_key.at("settings"))
                        paths.push_back(notice.at("path"));
                    for (const auto& [_, entries] : notice_key.at("assets").items())
                        for (const auto& notice : entries)
                            paths.push_back(notice.at("path"));
                    if (const auto watched = observed_external_paths(paths, *state.session))
                        state.notice_check = capture_external_check(
                            notice_key, *watched, *state.session->verified_source_revisions_view());
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
                noveltea::authoring::count_validation_work<
                    noveltea::authoring::WorkCounter::FontPreparations>();
                result["fontCoverageInputs"] =
                    native_font_coverage_inputs(*state.session, admitted);
                state.font_inputs = result["fontCoverageInputs"];
                result["work"]["fontInputReuses"] = 0;
            }
            // Font shaping is executed in this same serialized resident owner,
            // not anew in every short-lived public CLI client. The canonical
            // font tool retains exact byte proofs only within this watched
            // source authority; the public boundary still fences that epoch.
            if (result["entrypointConfigured"].get<bool>() &&
                !result.contains("noticeValidationFailure")) {
                validate_or_reuse_font_result(state, result);
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
                    noveltea::authoring::count_validation_work<
                        noveltea::authoring::WorkCounter::MaterialShaderPreparations>();
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
                validate_material_stage(state, root, material_programs, material_effective,
                                        *source_revisions, result);
            } else {
                result["work"]["shaderStageReuses"] = 0;
                result["work"]["shaderValidationCalls"] = 0;
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
            noveltea::authoring::ScopedValidationStageTime<
                noveltea::authoring::WorkCounter::SourceGenerationMicros> timed;
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
        // The Project session owns the exact generation and elected quiet-window
        // publication. Its callback references resident, already-certified stage
        // inputs rather than building and serializing the ledger on every edit.
        const bool stage_inputs_ready = request.value("includeFontCoverageInputs", false) &&
            state.portable_check && state.notice_check && state.font_inputs &&
            state.material_records && state.material_assets &&
            !result.contains("portableFailure") && !result.contains("noticeValidationFailure");
        const bool published = [&] {
            noveltea::authoring::ScopedValidationStageTime<
                noveltea::authoring::WorkCounter::DeferredPublicationMicros> timed;
            noveltea::authoring::count_validation_work<
                noveltea::authoring::WorkCounter::DeferredPublications>();
            return state.session->publish_deferred_clean_validation(
                validated, post_revisions, "null",
                stage_inputs_ready ? std::function<std::string()>([&state] {
                    return serialize_stage_ledger(state);
                }) : std::function<std::string()>{});
        }();
        if (!published)
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation preparation."}};
        state.pending_generation = result.at("sourceGeneration").get<std::string>();
        state.pending_exact_revisions = std::move(post_revisions);
    } else if (!fence_resident_sources(*state.session)) {
        return {{"ok", false},
                {"kind", "conflict"},
                {"error", "Project sources changed during validation."}};
    }
    work_counts.setSemanticWork(state.session->validation_work().rechecked_contributions,
                                state.session->validation_work().reference_indexed_records,
                                state.session->validation_work().localization_rebuilds);
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    noveltea::authoring::count_validation_work<
        noveltea::authoring::WorkCounter::ValidationResponseSerializations>();
    result["work"]["endToEnd"] = work_counts_json(work_counts);
#endif
    result["work"]["sourceCaptures"] = state.session->source_capture_count() - captures_before;
    result["work"]["localizationRecordsReused"] =
        state.session->localization_record_cache_hits() - record_hits_before;
    result["work"]["localizationSourcePathsReused"] =
        state.session->localization_source_path_cache_hits() - source_hits_before;
    if (request.value("finalizeSourceGenerationProof", false) && validated.snapshot.valid) {
        const auto started = std::chrono::steady_clock::now();
        if (!final_source_generation_matches(state, root, state.pending_generation)) {
            noveltea::authoring::trace_source_proof_event("validation-final", "conflict");
            state.session.reset();
            state.clear_preparations(false, false);
            state.pending_generation.clear();
            state.pending_exact_revisions.clear();
            return {{"ok", false},
                    {"kind", "conflict"},
                    {"error", "Project sources changed during validation."}};
        }
        result["finalSourceGenerationProven"] = true;
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        result["work"]["endToEnd"] = work_counts_json(work_counts);
        result["work"]["finalProofRequestMicros"] =
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - started).count();
#endif
    }
    if (request.value("compactValidationResponse", false)) {
        // The public CLI consumes final diagnostics/coverage/compiler evidence,
        // not the large intermediate Message and Material input projections.
        // The elected writer retains these independently in the owner state.
        if (result.contains("fontCoverageResult"))
            result.erase("fontCoverageInputs");
        if (result.contains("materialCompilerPrograms")) {
            result["hasMaterialCompilerPrograms"] =
                !result.at("materialCompilerPrograms").empty();
            result.erase("materialCompilerPrograms");
        }
        result.erase("materialEffectiveInputs");
    }
    return result;
}

} // namespace

namespace noveltea::tooling {

void release_native_disk_validation_owner() noexcept
{
    auto* owner = resident_slot();
    if (!owner)
        return;
    try {
        std::scoped_lock lock(owner->mutex);
        // Shutdown flush must run while record contracts, cached source
        // analyses and other function-local validation statics are alive.
        // Waiting for the OwnerValidation static destructor is too late.
        owner->session.reset();
        owner->clear_preparations();
        owner->root.clear();
        owner->pending_generation.clear();
    } catch (...) {
        // The optional ledger must not prevent a CLI process from exiting.
    }
}

} // namespace noveltea::tooling

extern "C" std::uint64_t noveltea_tooling_native_disk_project_validation_json(
    const std::uint8_t* request, std::uint64_t request_size, std::uint8_t* response,
    std::uint64_t response_capacity)
{
    std::string serialized;
    try {
        if (!request && request_size != 0)
            throw std::runtime_error("Native disk validation request is absent.");
        auto result = validate(std::string_view(reinterpret_cast<const char*>(request),
                                                static_cast<std::size_t>(request_size)));
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        // Serialize only once. The profiling field starts as zero; patch its
        // numeric value into the serialized bytes afterward instead of
        // traversing the entire diagnostic JSON a second time.
        const auto started = std::chrono::steady_clock::now();
        serialized = result.dump();
        if (result.contains("work") && result["work"].contains("endToEnd")) {
            constexpr std::string_view marker = "\"validationResponseSerializationMicros\":0";
            const auto position = serialized.find(marker);
            if (position != std::string::npos) {
                const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
                                        std::chrono::steady_clock::now() - started)
                                        .count();
                serialized.replace(position + marker.size() - 1, 1, std::to_string(micros));
            }
        }
#else
        serialized = result.dump();
#endif
    } catch (const std::exception& error) {
        serialized = Json{{"ok", false}, {"error", error.what()}}.dump();
    }
    const auto required = static_cast<std::uint64_t>(serialized.size());
    if (response && response_capacity >= required)
        std::memcpy(response, serialized.data(), serialized.size());
    return required;
}
