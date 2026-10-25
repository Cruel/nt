#include "tooling_native_c.h"
#include "tooling_native_project_sync.hpp"

#include "../project_authoring/room_session.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <memory>
#include <mutex>
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
};

OwnerValidation& resident()
{
    static OwnerValidation value;
    return value;
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
              {"retainedContributions", work.retained_contributions}}}};
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
    if (request.value("action", std::string("validate")) != "validate")
        return {{"ok", false}, {"error", "Unknown disk-validation action."}};
    if (state.root != root) {
        state.session.reset();
        state.root = root;
    }
    const bool warm = state.session != nullptr;
    std::string error;
    if (!state.session) {
        trace_native_validation("opening mutable Project session");
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
    const auto validated = state.session->validate_clean_project();
    trace_native_validation("resident Project validation returned");
    auto result = response_for(validated.snapshot, warm, state.session->validation_work());
    result["cacheHit"] = validated.cache_hit;
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
        // Bind a successful diagnostic graph to the exact physical generation
        // consumed by downstream preparation; never mix separate admissions.
        result["sourceGeneration"] = native_project_source_generation(*state.session, root);
    }
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
