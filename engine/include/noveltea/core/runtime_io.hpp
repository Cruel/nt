#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <noveltea/core/entity_ref.hpp>
#include <noveltea/core/runtime_controller.hpp>
#include <noveltea/core/runtime_ui_view.hpp>

namespace noveltea::core {

enum class RuntimeInputType {
    Start,
    Stop,
    Reset,
    Tick,
    Continue,
    SelectDialogueOption,
    Navigate,
    SelectObject,
    ClearObjectSelection,
    RunAction,
    SetEntrypoint,
    LoadSave,
    ApplyTestStep,
};

struct RuntimeInput {
    RuntimeInputType type = RuntimeInputType::Tick;
    double delta_seconds = 0.0;
    int index = -1;
    int direction = -1;
    std::string verb_id;
    std::vector<std::string> object_ids;
    std::optional<EntityRef> entity_ref;
    nlohmann::json payload = nlohmann::json::object();
    std::optional<std::uint64_t> step_index;
};

enum class RuntimeDiagnosticSeverity {
    Info,
    Warning,
    Error,
};

struct RuntimeDiagnostic {
    RuntimeDiagnosticSeverity severity = RuntimeDiagnosticSeverity::Warning;
    std::string category;
    std::optional<EntityRef> source;
    std::string script_context;
    std::string hook_context;
    std::string message;
    std::string lua_traceback;
    std::optional<std::uint64_t> playback_step_index;
};

enum class RuntimeOutputType {
    Command,
    ModeChanged,
    ViewUpdated,
    ScriptRequest,
    ScriptResult,
    SaveMutationRequest,
    TextLogEntry,
    Notification,
    Diagnostic,
    TestObservation,
};

struct RuntimeOutput {
    RuntimeOutputType type = RuntimeOutputType::Command;
    std::optional<ControllerCommand> command;
    std::optional<RuntimeUIViewState> view;
    std::optional<RuntimeDiagnostic> diagnostic;
    nlohmann::json payload = nlohmann::json::object();
    std::optional<std::uint64_t> step_index;
};

struct RuntimeInputResult {
    bool handled = false;
    RuntimeUIViewState view;
    std::vector<RuntimeOutput> outputs;
    std::vector<RuntimeDiagnostic> diagnostics;
};

} // namespace noveltea::core
