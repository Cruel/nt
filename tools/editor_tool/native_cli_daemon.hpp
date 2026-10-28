#pragma once

#include <nlohmann/json.hpp>

#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::cli {

// Production requests use the broker default; certification can isolate a
// daemon without changing the build/protocol identity.
std::optional<std::string> native_daemon_certification_runtime_root();

// Nullopt means the broker could not be started before dispatch, so the native
// caller may execute locally. An attempted invocation is never replayed.
std::optional<int> route_native_project_owner(const std::vector<std::string>& argv,
                                              std::string_view project_root, bool explicit_project,
                                              bool mutation, bool json, bool validation,
                                              std::string_view disposable_kind = {},
                                              std::optional<std::string> stdin_text = std::nullopt);

bool native_disposable_active();

// Immutable worker requests must resolve only against the pinned owner capture.
// A physical source proof may inspect disk, but never readmit Project semantics.
std::optional<nlohmann::ordered_json>
pinned_native_project_request(const nlohmann::ordered_json& request);

// Hidden broker/worker entrypoints of the same installed native executable.
// Returns nullopt for an ordinary public CLI invocation.
std::optional<int> run_native_daemon_process(
    const std::vector<std::string>& argv,
    const std::function<int(const std::vector<std::string>&)>& run_local,
    const std::function<nlohmann::ordered_json(const nlohmann::ordered_json&)>& project_request);

} // namespace noveltea::cli
