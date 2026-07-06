#include "noveltea/runtime_shell.hpp"

#include <utility>

namespace noveltea {

RuntimeShell::RuntimeShell() = default;

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
    m_host.reset();
    m_last_diagnostics.clear();
    m_mode = RuntimeShellMode::Boot;
}

void RuntimeShell::pause()
{
    if (m_mode == RuntimeShellMode::Game) {
        m_mode = RuntimeShellMode::Paused;
    }
}

void RuntimeShell::resume()
{
    if (m_mode == RuntimeShellMode::Paused) {
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

    m_mode = RuntimeShellMode::Game;
    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Tick;
    input.delta_seconds = 0.0;
    auto result = m_host.apply_input(input);
    m_last_diagnostics = result.diagnostics;
    return result;
}

core::RuntimeInputResult RuntimeShell::update(double delta_seconds)
{
    if (m_mode != RuntimeShellMode::Game || !m_host.loaded()) {
        return {};
    }

    core::RuntimeInput input;
    input.type = core::RuntimeInputType::Tick;
    input.delta_seconds = delta_seconds;
    auto result = m_host.apply_input(input);
    m_last_diagnostics = result.diagnostics;
    return result;
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
