#include <noveltea/script/runtime_script_executor.hpp>

#include <noveltea/core/runtime_session_host.hpp>
#include <noveltea/core/json_access.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <cstddef>
#include <utility>

namespace noveltea::script {
namespace {

std::string script_context(const core::ControllerCommand& command)
{
    if (command.data.is_object()) {
        if (auto it = command.data.find("context"); it != command.data.end() && it->is_string()) {
            return it->get<std::string>();
        }
        if (auto it = command.data.find("desc"); it != command.data.end() && it->is_string()) {
            return it->get<std::string>();
        }
    }
    return "script";
}

std::string chunk_name(const core::ControllerCommand& command)
{
    const auto context = script_context(command);
    if (command.entity.has_value() && command.entity->has_id()) {
        return context + ":" + command.entity->id;
    }
    return context;
}

core::RuntimeOutput make_script_result(const core::ControllerCommand& command,
                                       std::optional<std::uint64_t> step_index)
{
    core::RuntimeOutput output;
    output.type = core::RuntimeOutputType::ScriptResult;
    output.command = command;
    output.step_index = step_index;
    output.payload = {
        {"ok", true},
        {"chunk", chunk_name(command)},
        {"context", script_context(command)},
    };
    if (command.entity.has_value()) {
        output.payload["source_entity"] = command.entity->to_json();
    }
    return output;
}

core::RuntimeDiagnostic make_diagnostic(const core::ControllerCommand& command,
                                        const ScriptError& error,
                                        std::optional<std::uint64_t> step_index)
{
    core::RuntimeDiagnostic diagnostic;
    diagnostic.severity = core::RuntimeDiagnosticSeverity::Error;
    diagnostic.category = "lua";
    diagnostic.source = command.entity;
    diagnostic.script_context = error.chunk.empty() ? chunk_name(command) : error.chunk;
    diagnostic.hook_context = script_context(command);
    diagnostic.message = error.message;
    diagnostic.lua_traceback = error.traceback;
    diagnostic.playback_step_index = step_index;
    return diagnostic;
}

core::RuntimeOutput make_diagnostic_output(const core::ControllerCommand& command,
                                           const ScriptError& error,
                                           std::optional<std::uint64_t> step_index)
{
    auto diagnostic = make_diagnostic(command, error, step_index);
    core::RuntimeOutput output;
    output.type = core::RuntimeOutputType::Diagnostic;
    output.command = command;
    output.diagnostic = diagnostic;
    output.step_index = step_index;
    output.payload = {
        {"ok", false},
        {"chunk", diagnostic.script_context},
        {"context", diagnostic.hook_context},
        {"message", diagnostic.message},
    };
    if (command.entity.has_value()) {
        output.payload["source_entity"] = command.entity->to_json();
    }
    return output;
}

} // namespace

void RuntimeScriptExecutor::initialize(ScriptRuntime* runtime, core::RuntimeSessionHost* host)
{
    m_runtime = runtime;
    m_host = host;
    if (m_runtime && m_host) {
        m_runtime->bind_runtime_host(m_host);
    }
}

void RuntimeScriptExecutor::shutdown()
{
    if (m_runtime) {
        m_runtime->clear_game_bindings();
    }
    m_runtime = nullptr;
    m_host = nullptr;
}

void RuntimeScriptExecutor::process(core::RuntimeInputResult& result)
{
    const auto previous_size = result.outputs.size();
    process_outputs(result.outputs);
    for (auto it = result.outputs.begin() + static_cast<std::ptrdiff_t>(previous_size);
         it != result.outputs.end(); ++it) {
        if (it->diagnostic.has_value()) {
            result.diagnostics.push_back(*it->diagnostic);
        }
    }
    result.view = m_host ? m_host->view_state() : result.view;
}

void RuntimeScriptExecutor::process_outputs(std::vector<core::RuntimeOutput>& outputs,
                                            std::optional<std::uint64_t> step_index)
{
    if (!ready() || !m_runtime->is_initialized()) {
        return;
    }

    const auto initial_outputs = outputs;
    bool ran_script = false;
    bool should_autosave = false;
    for (const auto& output : initial_outputs) {
        if (output.command.has_value()) {
            const auto& command = *output.command;
            if (command.type == core::ControllerCommandType::ActionResolved) {
                should_autosave = true;
            } else if (command.type == core::ControllerCommandType::ScriptDeferred &&
                       command.data.is_object()) {
                const bool dialogue_autosave =
                    core::json_access::value_or(command.data, "autosave", false);
                const bool cutscene_before =
                    core::json_access::value_or(command.data, "autosave_before", false);
                const bool cutscene_after =
                    core::json_access::value_or(command.data, "autosave_after", false);
                should_autosave =
                    should_autosave || dialogue_autosave || cutscene_before || cutscene_after;
            }
        }

        if (output.type != core::RuntimeOutputType::ScriptRequest || !output.command.has_value() ||
            output.command->type != core::ControllerCommandType::ScriptDeferred) {
            continue;
        }

        const auto& command = *output.command;
        const auto effective_step = output.step_index.has_value() ? output.step_index : step_index;
        m_runtime->bind_runtime_host(m_host);
        auto result = m_runtime->execute(command.text, chunk_name(command));
        ran_script = true;
        if (result) {
            outputs.push_back(make_script_result(command, effective_step));
        } else if (result.error.has_value()) {
            outputs.push_back(make_diagnostic_output(command, *result.error, effective_step));
        }
    }

    if (ran_script) {
        auto flushed = m_host->flush_pending_outputs(step_index);
        outputs.insert(outputs.end(), flushed.outputs.begin(), flushed.outputs.end());
    }

    if (should_autosave && m_host->has_save_slot_store()) {
        auto saved = m_host->autosave();
        outputs.insert(outputs.end(), saved.outputs.begin(), saved.outputs.end());
    }
}

} // namespace noveltea::script
