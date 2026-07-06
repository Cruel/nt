#include "noveltea/runtime_shell.hpp"

#include <utility>

namespace noveltea {
namespace {
constexpr const char* kPauseMenuToken = "pause-menu";
constexpr const char* kRuntimePauseMenuDocumentId = "runtime_pause_menu";
} // namespace

RuntimeShell::RuntimeShell() : m_dispatcher(*this) {}

core::GameSessionLoadResult RuntimeShell::load_project(core::ProjectDocument project,
                                                       core::SaveDocument save)
{
    auto result = m_host.load(std::move(project), std::move(save));
    m_last_diagnostics.clear();
    for (const auto& diagnostic : result.diagnostics) {
        core::RuntimeDiagnostic runtime_diagnostic;
        runtime_diagnostic.category = diagnostic.path;
        runtime_diagnostic.message = diagnostic.message;
        switch (diagnostic.severity) {
        case core::SessionDiagnosticSeverity::Info:
            runtime_diagnostic.severity = core::RuntimeDiagnosticSeverity::Info;
            break;
        case core::SessionDiagnosticSeverity::Warning:
            runtime_diagnostic.severity = core::RuntimeDiagnosticSeverity::Warning;
            break;
        case core::SessionDiagnosticSeverity::Error:
            runtime_diagnostic.severity = core::RuntimeDiagnosticSeverity::Error;
            break;
        }
        m_last_diagnostics.push_back(std::move(runtime_diagnostic));
    }

    m_mode = result.success ? RuntimeShellMode::Title : RuntimeShellMode::Error;
    return result;
}

void RuntimeShell::reset()
{
    m_layouts.reset();
    m_host.reset();
    m_dispatcher.bind(this);
    m_pause_tokens.clear();
    m_last_diagnostics.clear();
    m_mode = RuntimeShellMode::Boot;
}

void RuntimeShell::bind_runtime_ui(RuntimeUI* ui) noexcept { m_layouts.bind_runtime_ui(ui); }

RuntimeLayoutInstanceId RuntimeShell::mount_title_layout()
{
    if (m_mode != RuntimeShellMode::Title) {
        return 0;
    }
    return m_layouts.mount_builtin_title(true);
}

RuntimeLayoutInstanceId RuntimeShell::mount_gameplay_layout()
{
    return m_layouts.mount_builtin_game_hud(true);
}

RuntimeLayoutInstanceId RuntimeShell::mount_gameplay_layout(std::string layout_id,
                                                            std::optional<int> z_index)
{
    return m_layouts.mount_game_hud_layout(std::move(layout_id), z_index);
}

RuntimeLayoutInstanceId RuntimeShell::mount_pause_menu_layout()
{
    if (const auto* mounted = m_layouts.find_document(kRuntimePauseMenuDocumentId)) {
        if (!mounted->visible) {
            (void)m_layouts.show(mounted->instance_id);
        }
        return mounted->instance_id;
    }
    return m_layouts.mount_builtin_pause_menu(true);
}

void RuntimeShell::pause()
{
    if (m_mode == RuntimeShellMode::Game) {
        m_pause_tokens.insert(kPauseMenuToken);
        (void)mount_pause_menu_layout();
        m_mode = RuntimeShellMode::Paused;
    }
}

void RuntimeShell::resume()
{
    const bool was_paused = paused();
    m_pause_tokens.erase(kPauseMenuToken);
    (void)m_layouts.unmount_document(kRuntimePauseMenuDocumentId);
    if (was_paused) {
        m_mode = RuntimeShellMode::Game;
    }
}

core::RuntimeInputResult RuntimeShell::start_game()
{
    if (!m_host.loaded()) {
        return make_unhandled("runtime project is not loaded");
    }
    if (m_mode != RuntimeShellMode::Title && m_mode != RuntimeShellMode::Paused) {
        return make_unhandled("runtime shell is not ready to start gameplay");
    }

    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Tick;
    input.delta_seconds = 0.0;
    auto result = m_host.apply_input(input);
    m_last_diagnostics = result.diagnostics;
    if (result.handled) {
        m_mode = RuntimeShellMode::Game;
        (void)m_layouts.unmount_layer(RuntimeLayoutLayer::Title);
        if (!m_layouts.find_document("runtime_game")) {
            (void)mount_gameplay_layout();
        } else if (const auto* mounted = m_layouts.find_document("runtime_game");
                   mounted && !mounted->visible) {
            (void)m_layouts.show(mounted->instance_id);
        }
    }
    return result;
}

core::RuntimeInputResult RuntimeShell::update(double delta_seconds)
{
    if (m_mode != RuntimeShellMode::Game || paused() || m_layouts.pauses_gameplay() ||
        !m_host.loaded()) {
        return {};
    }

    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Tick;
    input.delta_seconds = delta_seconds;
    auto result = m_host.apply_input(input);
    m_last_diagnostics = result.diagnostics;
    return result;
}

RuntimeCommandResult RuntimeShell::dispatch_command(RuntimeCommand command)
{
    return m_dispatcher.dispatch(std::move(command));
}

core::RuntimeInputResult RuntimeShell::make_unhandled(std::string message)
{
    core::RuntimeDiagnostic diagnostic;
    diagnostic.severity = core::RuntimeDiagnosticSeverity::Warning;
    diagnostic.category = "runtime-shell";
    diagnostic.message = std::move(message);

    core::RuntimeInputResult result;
    result.handled = false;
    result.diagnostics.push_back(std::move(diagnostic));
    m_last_diagnostics = result.diagnostics;
    return result;
}

} // namespace noveltea
