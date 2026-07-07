#include "noveltea/runtime_ui_playback.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/core/project_ids.hpp"
#include "noveltea/script/runtime_script_executor.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "noveltea/ui_runtime.hpp"

#include <algorithm>
#include <filesystem>
#include <utility>

namespace noveltea {
namespace {

constexpr int kMaxDrainIterations = 8;

core::editor::ToolDiagnostic tool_error(std::string path, std::string message)
{
    return core::editor::ToolDiagnostic{core::editor::DiagnosticSeverity::Error, std::move(path),
                                        std::move(message)};
}

std::string runtime_diagnostic_severity_to_string(core::RuntimeDiagnosticSeverity severity)
{
    switch (severity) {
    case core::RuntimeDiagnosticSeverity::Info:
        return "info";
    case core::RuntimeDiagnosticSeverity::Warning:
        return "warning";
    case core::RuntimeDiagnosticSeverity::Error:
        return "error";
    }
    return "error";
}

std::string runtime_output_type_to_string(core::RuntimeOutputType type)
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

nlohmann::json runtime_diagnostic_to_json(const core::RuntimeDiagnostic& diagnostic)
{
    nlohmann::json json = {
        {"severity", runtime_diagnostic_severity_to_string(diagnostic.severity)},
        {"category", diagnostic.category},
        {"message", diagnostic.message},
    };
    if (!diagnostic.script_context.empty())
        json["script_context"] = diagnostic.script_context;
    if (!diagnostic.hook_context.empty())
        json["hook_context"] = diagnostic.hook_context;
    if (!diagnostic.lua_traceback.empty())
        json["lua_traceback"] = diagnostic.lua_traceback;
    if (diagnostic.playback_step_index)
        json["step_index"] = *diagnostic.playback_step_index;
    return json;
}

nlohmann::json runtime_output_to_json(const core::RuntimeOutput& output)
{
    nlohmann::json json = {{"type", runtime_output_type_to_string(output.type)},
                           {"payload", output.payload}};
    if (output.step_index)
        json["step_index"] = *output.step_index;
    if (output.command) {
        json["command_type"] = static_cast<int>(output.command->type);
        json["command_text"] = output.command->text;
        json["command_data"] = output.command->data;
    }
    if (output.diagnostic)
        json["diagnostic"] = runtime_diagnostic_to_json(*output.diagnostic);
    return json;
}

nlohmann::json view_state_to_json(const core::RuntimeUIViewState& view, RuntimeShellMode shell_mode,
                                  const std::optional<std::string>& current_room_id,
                                  const nlohmann::json& save)
{
    return {{"loaded", true},
            {"running", shell_mode == RuntimeShellMode::Game},
            {"mode", to_string(shell_mode)},
            {"title", view.title},
            {"current_room", current_room_id.value_or(view.map_view.current_room_id)},
            {"save_snapshot", save}};
}

std::optional<RuntimeUiPlaybackInputType> ui_playback_input_from_string(std::string_view value)
{
    if (value == "ui_click" || value == "ui-click")
        return RuntimeUiPlaybackInputType::UiClick;
    return std::nullopt;
}

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
    return runtime_output_type_to_string(type);
}

const nlohmann::json* system_layout_metadata(const core::ProjectDocument& project,
                                             std::string_view role)
{
    const auto root = project.root().find("__editor_ui_playback");
    if (root == project.root().end() || !root->is_object())
        return nullptr;
    const auto layouts = root->find("systemLayouts");
    if (layouts == root->end() || !layouts->is_object())
        return nullptr;
    const auto layout = layouts->find(std::string(role));
    return layout != layouts->end() && layout->is_object() ? &*layout : nullptr;
}

void install_virtual_layout(RuntimeUI& ui, const nlohmann::json& layout)
{
    const auto set_file = [&](const char* path_key, const char* source_key) {
        const auto path = layout.value(path_key, std::string{});
        const auto source = layout.value(source_key, std::string{});
        if (!path.empty())
            ui.set_preview_virtual_file(path, source);
    };
    set_file("assetPath", "rml");
    set_file("stylesheetPath", "rcss");
    set_file("scriptPath", "lua");
}

void install_system_layout_virtual_files(RuntimeUI& ui, const core::ProjectDocument& project)
{
    const auto root = project.root().find("__editor_ui_playback");
    if (root == project.root().end() || !root->is_object())
        return;
    const auto layouts = root->find("systemLayouts");
    if (layouts == root->end() || !layouts->is_object())
        return;
    for (const auto& [role, layout] : layouts->items()) {
        if (!layout.is_object())
            continue;
        install_virtual_layout(ui, layout);
        if (role == "game-hud") {
            ui.set_preview_virtual_file("project:/ui/runtime/runtime_game.rml",
                                        layout.value("rml", std::string{}));
        }
    }
}

RuntimeLayoutInstanceId mount_system_layout(RuntimeShell& shell, RuntimeUI& ui,
                                            const core::ProjectDocument& project,
                                            std::string_view role)
{
    if (const auto* layout = system_layout_metadata(project, role)) {
        if (role == "title") {
            RuntimeLayoutMountRequest request;
            request.layout_id = layout->value("id", std::string("editor:title"));
            request.document_id = layout->value("documentId", std::string("runtime_title"));
            request.asset_path = layout->value("assetPath", std::string{});
            request.layer = RuntimeLayoutLayer::Title;
            request.z_index = 0;
            request.visible = true;
            request.modal = true;
            request.blocks_game_input = true;
            request.pauses_gameplay = true;
            return shell.layouts().mount(std::move(request));
        }
    }
    if (role == "title")
        return shell.mount_title_layout();
    return 0;
}

void execute_system_layout_lua(script::ScriptRuntime& runtime, const core::ProjectDocument& project,
                               RuntimeUiPlaybackReport& report)
{
    const auto root = project.root().find("__editor_ui_playback");
    if (root == project.root().end() || !root->is_object())
        return;
    const auto layouts = root->find("systemLayouts");
    if (layouts == root->end() || !layouts->is_object())
        return;
    for (const auto& [role, layout] : layouts->items()) {
        if (!layout.is_object())
            continue;
        const auto lua = layout.value("lua", std::string{});
        if (lua.empty())
            continue;
        auto result = runtime.execute(lua, "@editor-ui-playback:" + role);
        if (!result) {
            auto diagnostic = make_playback_diagnostic(
                0, result.error ? result.error->message : "layout Lua failed");
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
        }
    }
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
        shell.transitions().complete_immediately();
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

std::optional<RuntimeUiPlaybackSpec>
RuntimeUiPlaybackSession::parse_spec(const nlohmann::json& json,
                                     std::vector<core::editor::ToolDiagnostic>& diagnostics,
                                     std::string_view path)
{
    const auto base_path = std::string(path);
    if (!json.is_object()) {
        diagnostics.push_back(tool_error(base_path, "UI playback spec must be an object."));
        return std::nullopt;
    }

    RuntimeUiPlaybackSpec spec;
    spec.id = json.value("id", std::string{});
    if (spec.id.empty())
        diagnostics.push_back(tool_error(base_path + "/id", "UI playback spec requires an id."));

    const auto steps_key = std::string(core::project_ids::test_steps);
    auto steps_it = json.find(steps_key);
    if (steps_it == json.end() || !steps_it->is_array()) {
        diagnostics.push_back(
            tool_error(base_path + "/" + steps_key, "UI playback spec requires a steps array."));
    } else {
        for (std::size_t i = 0; i < steps_it->size(); ++i) {
            const auto step_path = base_path + "/" + steps_key + "/" + std::to_string(i);
            const auto& step_json = (*steps_it)[i];
            if (!step_json.is_object()) {
                diagnostics.push_back(tool_error(step_path, "UI playback step must be an object."));
                continue;
            }

            auto input =
                ui_playback_input_from_string(step_json.value("input", std::string{"ui_click"}));
            if (!input) {
                diagnostics.push_back(
                    tool_error(step_path + "/input", "Unknown UI playback input type."));
                continue;
            }

            RuntimeUiPlaybackStep step;
            step.input = *input;
            if (step_json.contains("index") && step_json["index"].is_number_unsigned())
                step.index = step_json["index"].get<std::uint64_t>();
            step.document_id = step_json.value("document_id", std::string{});
            step.target = step_json.value("target", step_json.value("selector", std::string{}));

            if (step.document_id.empty())
                diagnostics.push_back(
                    tool_error(step_path + "/document_id", "ui_click requires document_id."));
            if (step.target.empty())
                diagnostics.push_back(
                    tool_error(step_path + "/target", "ui_click requires target."));

            spec.steps.push_back(std::move(step));
        }
    }

    if (std::any_of(diagnostics.begin(), diagnostics.end(),
                    [&base_path](const core::editor::ToolDiagnostic& diagnostic) {
                        return diagnostic.severity == core::editor::DiagnosticSeverity::Error &&
                               diagnostic.path.rfind(base_path, 0) == 0;
                    })) {
        return std::nullopt;
    }
    return spec;
}

std::vector<RuntimeUiPlaybackSpec>
RuntimeUiPlaybackSession::specs_from_project(const core::ProjectDocument& project,
                                             std::vector<core::editor::ToolDiagnostic>& diagnostics)
{
    std::vector<RuntimeUiPlaybackSpec> specs;
    const auto& root = project.root();
    auto tests_it = root.find(std::string(core::project_ids::tests));
    if (tests_it == root.end() || tests_it->is_null())
        return specs;

    if (tests_it->is_array()) {
        for (std::size_t i = 0; i < tests_it->size(); ++i) {
            auto parsed =
                parse_spec((*tests_it)[i], diagnostics,
                           "/" + std::string(core::project_ids::tests) + "/" + std::to_string(i));
            if (parsed)
                specs.push_back(std::move(*parsed));
        }
        return specs;
    }

    if (tests_it->is_object()) {
        for (auto it = tests_it->begin(); it != tests_it->end(); ++it) {
            auto test_json = it.value();
            if (test_json.is_object() && !test_json.contains("id"))
                test_json["id"] = it.key();
            auto parsed = parse_spec(test_json, diagnostics,
                                     "/" + std::string(core::project_ids::tests) + "/" + it.key());
            if (parsed)
                specs.push_back(std::move(*parsed));
        }
        return specs;
    }

    diagnostics.push_back(tool_error("/" + std::string(core::project_ids::tests),
                                     "Project UI playback tests must be an object or array."));
    return specs;
}

nlohmann::json RuntimeUiPlaybackReport::to_json() const
{
    nlohmann::json observations_json = nlohmann::json::array();
    for (const auto& observation : observations) {
        nlohmann::json outputs_json = nlohmann::json::array();
        for (const auto& output : observation.outputs)
            outputs_json.push_back(runtime_output_to_json(output));

        nlohmann::json diagnostics_json = nlohmann::json::array();
        for (const auto& diagnostic : observation.diagnostics)
            diagnostics_json.push_back(runtime_diagnostic_to_json(diagnostic));

        nlohmann::json trace_json = nlohmann::json::array();
        for (const auto& trace_event : observation.trace) {
            trace_json.push_back({{"step_index", trace_event.step_index},
                                  {"type", trace_event.type},
                                  {"message", trace_event.message},
                                  {"payload", trace_event.payload}});
        }

        observations_json.push_back({{"step_index", observation.step_index},
                                     {"input", observation.input},
                                     {"handled", observation.handled},
                                     {"passed", observation.passed},
                                     {"click", observation.click},
                                     {"state", observation.state},
                                     {"outputs", std::move(outputs_json)},
                                     {"diagnostics", std::move(diagnostics_json)},
                                     {"trace", std::move(trace_json)},
                                     {"assertion_failures", observation.assertion_failures}});
    }

    nlohmann::json outputs_json = nlohmann::json::array();
    for (const auto& output : outputs)
        outputs_json.push_back(runtime_output_to_json(output));

    nlohmann::json diagnostics_json = nlohmann::json::array();
    for (const auto& diagnostic : diagnostics)
        diagnostics_json.push_back(runtime_diagnostic_to_json(diagnostic));

    nlohmann::json trace_json = nlohmann::json::array();
    for (const auto& trace_event : trace) {
        trace_json.push_back({{"step_index", trace_event.step_index},
                              {"type", trace_event.type},
                              {"message", trace_event.message},
                              {"payload", trace_event.payload}});
    }

    return {{"id", id},
            {"passed", passed},
            {"failures", failures},
            {"shell_mode", to_string(shell_mode)},
            {"final_state",
             view_state_to_json(final_view, shell_mode, final_current_room_id, final_save)},
            {"observations", std::move(observations_json)},
            {"outputs", std::move(outputs_json)},
            {"diagnostics", std::move(diagnostics_json)},
            {"trace", std::move(trace_json)}};
}

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
    auto load_result = shell.load_project(project, std::move(save));
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
    install_system_layout_virtual_files(ui, project);

    shell.bind_runtime_ui(&ui);
    ui.bind_runtime_host(&shell.host());
    ui.bind_runtime_command_dispatcher(&shell.dispatcher());
    script_runtime.bind_runtime_host(&shell.host());
    script_runtime.bind_runtime_command_dispatcher(&shell.dispatcher());
    execute_system_layout_lua(script_runtime, project, report);

    script::RuntimeScriptExecutor script_executor;
    script_executor.initialize(&script_runtime, &shell.host());

    if (mount_system_layout(shell, ui, project, "title") == 0) {
        auto diagnostic = make_playback_diagnostic(0, "failed to mount title layout");
        report.diagnostics.push_back(diagnostic);
        report.outputs.push_back(make_diagnostic_output(diagnostic));
        return report;
    }
    ui.begin_frame(0.0f);

    bool passed = true;
    for (std::size_t i = 0; i < spec.steps.size(); ++i) {
        const auto step_index = spec.steps[i].index.value_or(static_cast<std::uint64_t>(i));
        const auto& step = spec.steps[i];
        const auto outputs_before = report.outputs.size();
        const auto diagnostics_before = report.diagnostics.size();
        const auto trace_before = report.trace.size();

        RuntimeUiPlaybackObservation observation;
        observation.step_index = step_index;
        observation.input = "ui_click";

        if (step.input != RuntimeUiPlaybackInputType::UiClick) {
            auto diagnostic = make_playback_diagnostic(step_index, "unsupported ui playback step");
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
            observation.diagnostics.push_back(diagnostic);
            observation.outputs.push_back(make_diagnostic_output(diagnostic));
            observation.passed = false;
            passed = false;
            report.failures.push_back("step " + std::to_string(step_index) +
                                      ": unsupported ui playback step");
            report.observations.push_back(std::move(observation));
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
        observation.click = report.trace.back().payload;

        if (click.status != RuntimeUiPlaybackClickStatus::Dispatched) {
            auto diagnostic = make_playback_diagnostic(step_index, click.message);
            report.diagnostics.push_back(diagnostic);
            report.outputs.push_back(make_diagnostic_output(diagnostic));
            observation.diagnostics.push_back(diagnostic);
            observation.outputs.push_back(make_diagnostic_output(diagnostic));
            observation.passed = false;
            observation.assertion_failures.push_back(click.message);
            report.failures.push_back("step " + std::to_string(step_index) + ": " + click.message);
            passed = false;
            observation.trace.insert(observation.trace.end(), report.trace.begin() + trace_before,
                                     report.trace.end());
            observation.state = view_state_to_json(shell.host().view_state(), shell.mode(),
                                                   shell.host().session().current_room_id(),
                                                   shell.host().session().snapshot_save().root());
            report.observations.push_back(std::move(observation));
            break;
        }

        observation.handled = true;
        drain_after_step(report, shell, script_executor, ui, step_index);

        observation.outputs.insert(observation.outputs.end(),
                                   report.outputs.begin() + outputs_before, report.outputs.end());
        observation.diagnostics.insert(observation.diagnostics.end(),
                                       report.diagnostics.begin() + diagnostics_before,
                                       report.diagnostics.end());
        observation.trace.insert(observation.trace.end(), report.trace.begin() + trace_before,
                                 report.trace.end());
        observation.passed =
            std::none_of(observation.diagnostics.begin(), observation.diagnostics.end(),
                         [](const core::RuntimeDiagnostic& diagnostic) {
                             return diagnostic.severity == core::RuntimeDiagnosticSeverity::Error;
                         });
        observation.state = view_state_to_json(shell.host().view_state(), shell.mode(),
                                               shell.host().session().current_room_id(),
                                               shell.host().session().snapshot_save().root());
        report.observations.push_back(std::move(observation));
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
