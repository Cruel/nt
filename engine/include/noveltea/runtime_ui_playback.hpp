#pragma once

#include "noveltea/core/project_document.hpp"
#include "noveltea/core/editor_api.hpp"
#include "noveltea/core/runtime_io.hpp"
#include "noveltea/core/runtime_ui_view.hpp"
#include "noveltea/core/save_document.hpp"
#include "noveltea/runtime_shell.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea {

enum class RuntimeUiPlaybackInputType {
    UiClick,
};

struct RuntimeUiPlaybackStep {
    RuntimeUiPlaybackInputType input = RuntimeUiPlaybackInputType::UiClick;
    std::optional<std::uint64_t> index;
    std::string document_id;
    std::string target;
};

struct RuntimeUiPlaybackSpec {
    std::string id;
    std::vector<RuntimeUiPlaybackStep> steps;
};

struct RuntimeUiPlaybackTraceEvent {
    std::uint64_t step_index = 0;
    std::string type;
    std::string message;
    nlohmann::json payload = nlohmann::json::object();
};

struct RuntimeUiPlaybackObservation {
    std::uint64_t step_index = 0;
    bool handled = false;
    bool passed = true;
    std::string input;
    nlohmann::json click = nlohmann::json::object();
    nlohmann::json state = nlohmann::json::object();
    std::vector<core::RuntimeOutput> outputs;
    std::vector<core::RuntimeDiagnostic> diagnostics;
    std::vector<RuntimeUiPlaybackTraceEvent> trace;
    std::vector<std::string> assertion_failures;
};

struct RuntimeUiPlaybackReport {
    std::string id;
    bool passed = false;
    RuntimeShellMode shell_mode = RuntimeShellMode::Boot;
    core::RuntimeUIViewState final_view;
    std::optional<std::string> final_current_room_id;
    nlohmann::json final_save = nlohmann::json::object();
    std::vector<RuntimeUiPlaybackObservation> observations;
    std::vector<core::RuntimeOutput> outputs;
    std::vector<core::RuntimeDiagnostic> diagnostics;
    std::vector<RuntimeUiPlaybackTraceEvent> trace;
    std::vector<std::string> failures;

    [[nodiscard]] nlohmann::json to_json() const;
};

class RuntimeUiPlaybackSession {
public:
    [[nodiscard]] static std::optional<RuntimeUiPlaybackSpec>
    parse_spec(const nlohmann::json& json, std::vector<core::editor::ToolDiagnostic>& diagnostics,
               std::string_view path = "/");
    [[nodiscard]] static std::vector<RuntimeUiPlaybackSpec>
    specs_from_project(const core::ProjectDocument& project,
                       std::vector<core::editor::ToolDiagnostic>& diagnostics);

    [[nodiscard]] RuntimeUiPlaybackReport run(core::ProjectDocument project,
                                              const RuntimeUiPlaybackSpec& spec);
    [[nodiscard]] RuntimeUiPlaybackReport
    run(core::ProjectDocument project, core::SaveDocument save, const RuntimeUiPlaybackSpec& spec);
};

[[nodiscard]] const char* to_string(RuntimeShellMode mode) noexcept;

} // namespace noveltea
