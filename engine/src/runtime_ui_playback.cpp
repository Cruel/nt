#include "noveltea/runtime_ui_playback.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/script/runtime_script_executor.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"

#include <filesystem>
#include <utility>

namespace noveltea {
namespace {

constexpr int kMaxDrainIterations = 8;

void mount_default_assets(assets::AssetManager& assets)
{
#ifdef NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT
    assets.mount_directory("system", std::filesystem::path(NOVELTEA_DEFAULT_RUNTIME_ASSET_ROOT));
#endif
#ifdef NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT
    assets.mount_directory("project", std::filesystem::path(NOVELTEA_DEFAULT_PROJECT_ASSET_ROOT));
#endif
}

core::RuntimeDiagnostic make_playback_diagnostic(std::uint64_t step_index, std::string message)
{
    core::RuntimeDiagnostic diagnostic;
    diagnostic.severity = core::RuntimeDiagnosticSeverity::Error;
    diagnostic.category = "ui-playback";
    diagnostic.message = std::move(message);
    diagnostic.playback_step_index = step_index;
    return diagnostic;
}

core::RuntimeOutput make_diagnostic_output(const core::RuntimeDiagnostic& diagnostic)
{
    core::RuntimeOutput output;
    output.type = core::RuntimeOutputType::Diagnostic;
    output.diagnostic = diagnostic;
    output.step_index = diagnostic.playback_step_index;
    output.payload = {{"category", diagnostic.category}, {"message", diagnostic.message}};
    return output;
}

std::string output_type_name(core::RuntimeOutputType type)
{
    switch (type) {
    case core::RuntimeOutputType::Command:
        return "command";
    case core::RuntimeOutputType::ModeChanged:
        return "mode_changed";
    case core::RuntimeOutputType::ViewUpdated:
        return "view_updated";
    case core::RuntimeOutputType::ScriptRequest:
        return "script_request";
    case core::RuntimeOutputType::ScriptResult:
        return "script_result";
    case core::RuntimeOutputType::SaveMutationRequest:
        return "save_mutation_request";
    case core::RuntimeOutputType::TextLogEntry:
        return "text_log_entry";
    case core::RuntimeOutputType::Notification:
        return "notification";
    case core::RuntimeOutputType::Diagnostic:
        return "diagnostic";
    case core::RuntimeOutputType::TestObservation:
        return "test_observation";
    case core::RuntimeOutputType::AudioCommand:
        return "audio_command";
    }
    return "unknown";
}

void append_runtime_output_traces(RuntimeUiPlaybackReport& report, std::uint64_t step_index,
                                  const std::vector<core::RuntimeOutput>& outputs)
{
    for (const auto& output : outputs) {
        RuntimeUiPlaybackTraceEvent trace;
        trace.step_index = step_index;
        trace.type = "runtime-output";
        trace.message = output_type_name(output.type);
        trace.payload = {{"output_type", trace.message}};
        if (output.command.has_value()) {
            trace.payload["command_type"] = static_cast<int>(output.command->type);
            trace.payload["command_text"] = output.command->text;
            trace.payload["command_data"] = output.command->data;
        }
        if (output.diagnostic.has_value()) {
            trace.payload["diagnostic_category"] = output.diagnostic->category;
            trace.payload["diagnostic_message"] = output.diagnostic->message;
        }
        report.trace.push_back(std::move(trace));
    }
}

void append_diagnostic_traces(RuntimeUiPlaybackReport& report, std::uint64_t step_index,
                              const std::vector<core::RuntimeDiagnostic>& diagnostics)
{
    for (const auto& diagnostic : diagnostics) {
        RuntimeUiPlaybackTraceEvent trace;
        trace.step_index = diagnostic.playback_step_index.value_or(step_index);
        trace.type = diagnostic.category == "runtime-command" ? "runtime-command" : "diagnostic";
        trace.message = diagnostic.message;
        trace.payload = {
            {"category", diagnostic.category},
            {"severity", static_cast<int>(diagnostic.severity)},
        };
        if (diagnostic.category == "runtime-command" &&
            diagnostic.message.find("source=layout-lua") != std::string::npos) {
            RuntimeUiPlaybackTraceEvent lua_trace = trace;
            lua_trace.type = "lua-game-call";
            report.trace.push_back(std::move(lua_trace));
        }
        report.trace.push_back(std::move(trace));
    }
}

void drain_after_step(RuntimeUiPlaybackReport& report, RuntimeShell& shell,
                      script::RuntimeScriptExecutor& script_executor, RuntimeUI& ui,
                      std::uint64_t step_index)
{
    append_diagnostic_traces(report, step_index, shell.last_diagnostics());
    append_runtime_output_traces(report, step_index, shell.host().last_outputs());

    for (int iteration = 0; iteration < kMaxDrainIterations; ++iteration) {
        auto flushed = shell.host().flush_pending_outputs(step_index);
        const auto before_scripts = flushed.outputs.size();
        script_executor.process(flushed);

        if (!flushed.outputs.empty()) {
            report.outputs.insert(report.outputs.end(), flushed.outputs.begin(),
                                  flushed.outputs.end());
            append_runtime_output_traces(report, step_index, flushed.outputs);
        }
        if (!flushed.diagnostics.empty()) {
            report.diagnostics.insert(report.diagnostics.end(), flushed.diagnostics.begin(),
                                      flushed.diagnostics.end());
            append_diagnostic_traces(report, step_index, flushed.diagnostics);
        }

        ui.apply_controller_commands(shell.host().last_commands());
        ui.begin_frame(0.0f);

        if (flushed.outputs.empty() && before_scripts == flushed.outputs.size()) {
            return;
        }
    }

    auto diagnostic =
        make_playback_diagnostic(step_index, "ui playback drain loop did not stabilize");
    report.diagnostics.push_back(diagnostic);
    report.outputs.push_back(make_diagnostic_output(diagnostic));
}

} // namespace

RuntimeUiPlaybackReport RuntimeUiPlaybackSession::run(core::ProjectDocument project,
                                                      const RuntimeUiPlaybackSpec& spec)
{
    return run(std::move(project), core::SaveDocument::new_save(), spec);
}

RuntimeUiPlaybackReport RuntimeUiPlaybackSession::run(core::ProjectDocument project,
                                                      core::SaveDocument save,
                                                      const RuntimeUiPlaybackSpec& spec)
{
    RuntimeUiPlaybackReport report;
    report.id = spec.id;

    assets::AssetManager assets;
    mount_default_assets(assets);

    script::ScriptRuntime script_runtime;
    auto script_init = script_runtime.initialize(script::ScriptRuntimeConfig{.assets = &assets});
    if (!script_init) {
        auto diagnostic = make_playback_diagnostic(
            0, script_init.error ? script_init.error->message : "failed to initialize Lua runtime");
        report.diagnostics.push_back(diagnostic);
        report.outputs.push_back(make_diagnostic_output(diagnostic));
        return report;
    }

    RuntimeShell shell;
    auto load_result = shell.load_project(std::move(project), std::move(save));
    if (!load_result.success) {
        for (const auto& diagnostic : shell.last_diagnostics()) {
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
        }
        return report;
    }

    RuntimeUI ui;
    if (!ui.initialize(&assets, nullptr, false, &script_runtime, nullptr, true)) {
        auto diagnostic = make_playback_diagnostic(0, "failed to initialize runtime UI");
        report.diagnostics.push_back(diagnostic);
        report.outputs.push_back(make_diagnostic_output(diagnostic));
        return report;
    }

    shell.bind_runtime_ui(&ui);
    ui.bind_runtime_host(&shell.host());
    ui.bind_runtime_command_dispatcher(&shell.dispatcher());
    script_runtime.bind_runtime_host(&shell.host());
    script_runtime.bind_runtime_command_dispatcher(&shell.dispatcher());

    script::RuntimeScriptExecutor script_executor;
    script_executor.initialize(&script_runtime, &shell.host());

    if (shell.mount_title_layout() == 0) {
        auto diagnostic = make_playback_diagnostic(0, "failed to mount title layout");
        report.diagnostics.push_back(diagnostic);
        report.outputs.push_back(make_diagnostic_output(diagnostic));
        return report;
    }
    ui.begin_frame(0.0f);

    bool passed = true;
    for (std::size_t i = 0; i < spec.steps.size(); ++i) {
        const auto step_index = static_cast<std::uint64_t>(i);
        const auto& step = spec.steps[i];
        if (step.input != RuntimeUiPlaybackInputType::UiClick) {
            auto diagnostic = make_playback_diagnostic(step_index, "unsupported ui playback step");
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
            passed = false;
            break;
        }

        RuntimeUiPlaybackClickRequest request;
        request.document_id = step.document_id;
        request.selector = step.target;
        auto click = ui.playback_click(request);

        RuntimeUiPlaybackTraceEvent trace;
        trace.step_index = step_index;
        trace.type = "ui-click";
        trace.message = click.message;
        trace.payload = {
            {"document_id", click.document_id},
            {"selector", click.selector},
            {"status", to_string(click.status)},
            {"target_id", click.target_id},
            {"target_tag", click.target_tag},
            {"x", click.x},
            {"y", click.y},
            {"width", click.width},
            {"height", click.height},
            {"dispatched", click.dispatched},
        };
        report.trace.push_back(std::move(trace));

        if (click.status != RuntimeUiPlaybackClickStatus::Dispatched) {
            auto diagnostic = make_playback_diagnostic(step_index, click.message);
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
            passed = false;
            break;
        }

        drain_after_step(report, shell, script_executor, ui, step_index);
    }

    report.shell_mode = shell.mode();
    report.final_view = shell.host().view_state();
    report.final_current_room_id = shell.host().session().current_room_id();
    report.final_save = shell.host().session().snapshot_save().root();
    report.passed = passed;
    for (const auto& diagnostic : report.diagnostics) {
        if (diagnostic.severity == core::RuntimeDiagnosticSeverity::Error) {
            report.passed = false;
            break;
        }
    }
    return report;
}

const char* to_string(RuntimeShellMode mode) noexcept
{
    switch (mode) {
    case RuntimeShellMode::Boot:
        return "boot";
    case RuntimeShellMode::Title:
        return "title";
    case RuntimeShellMode::Game:
        return "game";
    case RuntimeShellMode::Paused:
        return "paused";
    case RuntimeShellMode::Error:
        return "error";
    }
    return "unknown";
}

} // namespace noveltea
