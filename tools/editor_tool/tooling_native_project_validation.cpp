#include "tooling_native_c.h"

#include "../project_authoring/room_session.hpp"

#include <nlohmann/json.hpp>

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
        Json projected{{"code", diagnostic.code},
                       {"severity", diagnostic.severity},
                       {"path", diagnostic.path},
                       {"message", diagnostic.message}};
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
    const auto requested = std::filesystem::path(request["projectRoot"].get<std::string>());
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
    if (!state.session)
        state.session = ProjectSession::open(root, error);
    if (!state.session) {
        // The disk may be malformed, which strict mutable admission rejects.
        // Certification reads an invalid Project without admitting mutable state.
        const auto cold = ProjectSession::validate_cold_project(root, error);
        if (!cold)
            return {{"ok", false}, {"error", error}};
        return response_for(*cold, false, {});
    }
    const auto validated = state.session->validate_clean_project();
    auto result = response_for(validated.snapshot, warm, state.session->validation_work());
    result["cacheHit"] = validated.cache_hit;
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
