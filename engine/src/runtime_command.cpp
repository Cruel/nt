#include "noveltea/runtime_command.hpp"

#include "noveltea/runtime_shell.hpp"

#include <utility>

namespace noveltea {
namespace {

core::RuntimeOutput make_diagnostic_output(const core::RuntimeDiagnostic& diagnostic,
                                           nlohmann::json payload)
{
    core::RuntimeOutput output;
    output.type = core::RuntimeOutputType::Diagnostic;
    output.diagnostic = diagnostic;
    output.payload = std::move(payload);
    output.step_index = diagnostic.playback_step_index;
    return output;
}

void append_diagnostic(RuntimeCommandResult& result, core::RuntimeDiagnostic diagnostic,
                       nlohmann::json payload = nlohmann::json::object())
{
    result.outputs.push_back(make_diagnostic_output(diagnostic, std::move(payload)));
    result.diagnostics.push_back(std::move(diagnostic));
}

core::RuntimeDiagnostic make_trace(const RuntimeCommand& command)
{
    core::RuntimeDiagnostic diagnostic;
    diagnostic.severity = core::RuntimeDiagnosticSeverity::Info;
    diagnostic.category = "runtime-command";
    diagnostic.message = std::string("dispatch source=") + to_string(command.source) +
                         " domain=" + to_string(command.domain) + " name=" + command.name +
                         " payload=" + command.payload.dump();
    diagnostic.playback_step_index = command.playback_step_index;
    return diagnostic;
}

core::RuntimeDiagnostic make_warning(const RuntimeCommand& command, std::string message)
{
    core::RuntimeDiagnostic diagnostic;
    diagnostic.severity = core::RuntimeDiagnosticSeverity::Warning;
    diagnostic.category = "runtime-command";
    diagnostic.message = std::move(message);
    diagnostic.playback_step_index = command.playback_step_index;
    return diagnostic;
}

void append_input_result(RuntimeCommandResult& result, core::RuntimeInputResult input_result)
{
    result.handled = input_result.handled;
    result.input_result = std::move(input_result);
    result.outputs.insert(result.outputs.end(), result.input_result.outputs.begin(),
                          result.input_result.outputs.end());
    result.diagnostics.insert(result.diagnostics.end(), result.input_result.diagnostics.begin(),
                              result.input_result.diagnostics.end());
}

std::optional<int> int_payload(const nlohmann::json& payload, const char* key)
{
    if (!payload.is_object() || !payload.contains(key)) {
        return std::nullopt;
    }
    const auto& value = payload.at(key);
    if (!value.is_number_integer()) {
        return std::nullopt;
    }
    return value.get<int>();
}

std::optional<std::string> string_payload(const nlohmann::json& payload, const char* key)
{
    if (!payload.is_object() || !payload.contains(key)) {
        return std::nullopt;
    }
    const auto& value = payload.at(key);
    if (!value.is_string()) {
        return std::nullopt;
    }
    return value.get<std::string>();
}

std::vector<std::string> object_ids_payload(const nlohmann::json& payload)
{
    std::vector<std::string> ids;
    if (!payload.is_object()) {
        return ids;
    }
    if (const auto object_id = string_payload(payload, "object_id")) {
        ids.push_back(*object_id);
        return ids;
    }
    auto it = payload.find("object_ids");
    if (it == payload.end() || !it->is_array()) {
        return ids;
    }
    for (const auto& value : *it) {
        if (value.is_string()) {
            ids.push_back(value.get<std::string>());
        }
    }
    return ids;
}

RuntimeCommandResult make_unhandled(RuntimeCommand command, std::string message)
{
    RuntimeCommandResult result;
    append_diagnostic(result, make_trace(command),
                      {{"source", to_string(command.source)},
                       {"domain", to_string(command.domain)},
                       {"name", command.name},
                       {"payload", command.payload}});
    append_diagnostic(result, make_warning(command, std::move(message)),
                      {{"source", to_string(command.source)},
                       {"domain", to_string(command.domain)},
                       {"name", command.name},
                       {"payload", command.payload}});
    return result;
}

} // namespace

RuntimeCommandDispatcher::RuntimeCommandDispatcher(RuntimeShell& shell) : m_shell(&shell) {}

void RuntimeCommandDispatcher::bind(RuntimeShell* shell) noexcept { m_shell = shell; }

RuntimeCommandResult RuntimeCommandDispatcher::dispatch(RuntimeCommand command)
{
    if (!m_shell) {
        return make_unhandled(std::move(command), "runtime command dispatcher is not bound");
    }

    auto finish = [this](RuntimeCommandResult result) {
        m_shell->m_last_diagnostics = result.diagnostics;
        return result;
    };

    RuntimeCommandResult result;
    append_diagnostic(result, make_trace(command),
                      {{"source", to_string(command.source)},
                       {"domain", to_string(command.domain)},
                       {"name", command.name},
                       {"payload", command.payload}});

    if (command.name == "game.start") {
        append_input_result(result, m_shell->start_game());
        return finish(std::move(result));
    }
    if (command.name == "game.pause") {
        m_shell->pause();
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "game.resume") {
        m_shell->resume();
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "menu.close") {
        if (m_shell->paused()) {
            m_shell->resume();
        }
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "menu.load") {
        append_diagnostic(result, make_warning(command, "Load menu is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "menu.settings") {
        append_diagnostic(result, make_warning(command, "Settings menu is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "menu.save") {
        append_diagnostic(result, make_warning(command, "Save menu is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "menu.text-log") {
        append_diagnostic(result, make_warning(command, "Text log menu is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "game.return-to-title") {
        append_diagnostic(result, make_warning(command, "Return to title is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "game.quit") {
        append_diagnostic(result, make_warning(command, "Quit command is not implemented yet"),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "layout.add-layer") {
        const auto layout_id = string_payload(command.payload, "layout_id");
        if (!layout_id || layout_id->empty()) {
            append_diagnostic(
                result, make_warning(command, "layout.add-layer requires a non-empty layout_id"),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        const auto instance_id =
            m_shell->mount_gameplay_layout(*layout_id, int_payload(command.payload, "z_index"));
        if (instance_id == 0) {
            append_diagnostic(
                result, make_warning(command, "failed to mount gameplay layout: " + *layout_id),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        result.handled = true;
        return finish(std::move(result));
    }
    if (command.name == "runtime.start-room") {
        const auto room_id = string_payload(command.payload, "room_id");
        if (!room_id || room_id->empty()) {
            append_diagnostic(
                result, make_warning(command, "runtime.start-room requires a non-empty room_id"),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        append_input_result(result,
                            m_shell->host().start_room(*room_id, command.playback_step_index));
        return finish(std::move(result));
    }
    if (command.name == "runtime.run-script") {
        const auto script_id = string_payload(command.payload, "script_id");
        if (!script_id || script_id->empty()) {
            append_diagnostic(
                result, make_warning(command, "runtime.run-script requires a non-empty script_id"),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        append_input_result(result,
                            m_shell->host().run_script(*script_id, command.playback_step_index));
        return finish(std::move(result));
    }
    if (command.name == "runtime.start-dialogue") {
        const auto dialogue_id = string_payload(command.payload, "dialogue_id");
        if (!dialogue_id || dialogue_id->empty()) {
            append_diagnostic(
                result,
                make_warning(command, "runtime.start-dialogue requires a non-empty dialogue_id"),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        append_input_result(
            result, m_shell->host().start_dialogue(*dialogue_id, command.playback_step_index));
        return finish(std::move(result));
    }
    if (command.name == "runtime.start-scene") {
        const auto scene_id = string_payload(command.payload, "scene_id");
        if (!scene_id || scene_id->empty()) {
            append_diagnostic(
                result, make_warning(command, "runtime.start-scene requires a non-empty scene_id"),
                {{"source", to_string(command.source)},
                 {"domain", to_string(command.domain)},
                 {"name", command.name},
                 {"payload", command.payload}});
            return finish(std::move(result));
        }
        append_input_result(result,
                            m_shell->host().start_scene(*scene_id, command.playback_step_index));
        return finish(std::move(result));
    }

    core::RuntimeInput input;
    input.step_index = command.playback_step_index;
    bool valid_gameplay_input = true;
    if (command.name == "runtime.continue") {
        input.type = core::RuntimeInputType::Continue;
    } else if (command.name == "runtime.dialogue-option") {
        input.type = core::RuntimeInputType::SelectDialogueOption;
        if (const auto index = int_payload(command.payload, "index")) {
            input.index = *index;
        } else {
            valid_gameplay_input = false;
        }
    } else if (command.name == "runtime.navigate") {
        input.type = core::RuntimeInputType::Navigate;
        if (const auto direction = int_payload(command.payload, "direction")) {
            input.direction = *direction;
        } else {
            valid_gameplay_input = false;
        }
    } else if (command.name == "runtime.select-object") {
        input.type = core::RuntimeInputType::SelectObject;
        input.object_ids = object_ids_payload(command.payload);
        valid_gameplay_input = !input.object_ids.empty();
    } else if (command.name == "runtime.clear-selection") {
        input.type = core::RuntimeInputType::ClearObjectSelection;
    } else if (command.name == "runtime.run-action") {
        input.type = core::RuntimeInputType::RunAction;
        if (const auto verb_id = string_payload(command.payload, "verb_id")) {
            input.verb_id = *verb_id;
            input.object_ids = object_ids_payload(command.payload);
        } else {
            valid_gameplay_input = false;
        }
    } else {
        append_diagnostic(result, make_warning(command, "unknown runtime command: " + command.name),
                          {{"source", to_string(command.source)},
                           {"domain", to_string(command.domain)},
                           {"name", command.name},
                           {"payload", command.payload}});
        return finish(std::move(result));
    }

    if (!valid_gameplay_input) {
        append_diagnostic(
            result, make_warning(command, "runtime command has invalid payload: " + command.name),
            {{"source", to_string(command.source)},
             {"domain", to_string(command.domain)},
             {"name", command.name},
             {"payload", command.payload}});
        return finish(std::move(result));
    }

    append_input_result(result, m_shell->host().apply_input(input));
    return finish(std::move(result));
}

const char* to_string(RuntimeCommandSource source) noexcept
{
    switch (source) {
    case RuntimeCommandSource::Engine:
        return "engine";
    case RuntimeCommandSource::Platform:
        return "platform";
    case RuntimeCommandSource::RmlUiEvent:
        return "rmlui-event";
    case RuntimeCommandSource::LayoutLua:
        return "layout-lua";
    case RuntimeCommandSource::GameplayLua:
        return "gameplay-lua";
    case RuntimeCommandSource::EditorPreview:
        return "editor-preview";
    case RuntimeCommandSource::Playback:
        return "playback";
    }
    return "unknown";
}

const char* to_string(RuntimeCommandDomain domain) noexcept
{
    switch (domain) {
    case RuntimeCommandDomain::Shell:
        return "shell";
    case RuntimeCommandDomain::Gameplay:
        return "gameplay";
    case RuntimeCommandDomain::Layout:
        return "layout";
    case RuntimeCommandDomain::Audio:
        return "audio";
    case RuntimeCommandDomain::Save:
        return "save";
    case RuntimeCommandDomain::Debug:
        return "debug";
    }
    return "unknown";
}

RuntimeCommandDomain domain_from_command_name(const std::string& name) noexcept
{
    if (name.rfind("runtime.", 0) == 0) {
        return RuntimeCommandDomain::Gameplay;
    }
    if (name.rfind("menu.", 0) == 0 || name.rfind("game.", 0) == 0) {
        return RuntimeCommandDomain::Shell;
    }
    if (name.rfind("audio.", 0) == 0) {
        return RuntimeCommandDomain::Audio;
    }
    if (name.rfind("save.", 0) == 0 || name.rfind("load.", 0) == 0) {
        return RuntimeCommandDomain::Save;
    }
    if (name.rfind("debug.", 0) == 0) {
        return RuntimeCommandDomain::Debug;
    }
    return RuntimeCommandDomain::Layout;
}

} // namespace noveltea
