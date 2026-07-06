#pragma once

#include "noveltea/core/project_document.hpp"
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

struct RuntimeUiPlaybackReport {
    std::string id;
    bool passed = false;
    RuntimeShellMode shell_mode = RuntimeShellMode::Boot;
    core::RuntimeUIViewState final_view;
    std::optional<std::string> final_current_room_id;
    nlohmann::json final_save = nlohmann::json::object();
    std::vector<core::RuntimeOutput> outputs;
    std::vector<core::RuntimeDiagnostic> diagnostics;
    std::vector<RuntimeUiPlaybackTraceEvent> trace;
};

class RuntimeUiPlaybackSession {
public:
    [[nodiscard]] RuntimeUiPlaybackReport run(core::ProjectDocument project,
                                              const RuntimeUiPlaybackSpec& spec);
    [[nodiscard]] RuntimeUiPlaybackReport
    run(core::ProjectDocument project, core::SaveDocument save, const RuntimeUiPlaybackSpec& spec);
};

[[nodiscard]] const char* to_string(RuntimeShellMode mode) noexcept;

} // namespace noveltea
