#include "noveltea/presentation/runtime_system_layouts.hpp"

#include <type_traits>
#include <utility>

namespace noveltea::presentation {
namespace {

core::Diagnostics shell_diagnostic(std::string code, std::string message)
{
    return {{.code = std::move(code), .message = std::move(message)}};
}

} // namespace

core::MountedLayoutPolicy runtime_system_layout_policy(core::compiled::SystemLayoutRole role,
                                                       bool visible)
{
    core::MountedLayoutPolicy policy;
    policy.visibility = visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
    policy.clock = core::LayoutClockDomain::UnscaledPresentation;
    policy.escape_dismissal = core::EscapeDismissalPolicy::Dismiss;

    switch (role) {
    case core::compiled::SystemLayoutRole::Title:
        policy.plane = core::PresentationPlane::MenuOverlay;
        policy.local_order = 0;
        policy.input = core::LayoutInputMode::Modal;
        policy.gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible;
        policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        break;
    case core::compiled::SystemLayoutRole::GameHud:
        policy.plane = core::PresentationPlane::GameUi;
        policy.local_order = 0;
        policy.clock = core::LayoutClockDomain::Gameplay;
        policy.input = core::LayoutInputMode::Normal;
        policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        policy.escape_dismissal = core::EscapeDismissalPolicy::Ignore;
        break;
    case core::compiled::SystemLayoutRole::PauseMenu:
        policy.plane = core::PresentationPlane::MenuOverlay;
        policy.local_order = 100;
        policy.input = core::LayoutInputMode::Modal;
        policy.gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible;
        break;
    case core::compiled::SystemLayoutRole::SettingsMenu:
        policy.plane = core::PresentationPlane::MenuOverlay;
        policy.local_order = 200;
        policy.input = core::LayoutInputMode::Modal;
        policy.gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible;
        break;
    case core::compiled::SystemLayoutRole::SaveMenu:
    case core::compiled::SystemLayoutRole::LoadMenu:
        policy.plane = core::PresentationPlane::MenuOverlay;
        policy.local_order = 220;
        policy.input = core::LayoutInputMode::Modal;
        policy.gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible;
        break;
    case core::compiled::SystemLayoutRole::TextLog:
        policy.plane = core::PresentationPlane::MenuOverlay;
        policy.local_order = 180;
        policy.input = core::LayoutInputMode::BlockGameplay;
        policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        break;
    case core::compiled::SystemLayoutRole::Modal:
        policy.plane = core::PresentationPlane::Modal;
        policy.local_order = 0;
        policy.input = core::LayoutInputMode::Modal;
        policy.gameplay_pause = core::GameplayPausePolicy::PauseWhileVisible;
        break;
    case core::compiled::SystemLayoutRole::DebugOverlay:
        policy.plane = core::PresentationPlane::Debug;
        policy.local_order = 0;
        policy.input = core::LayoutInputMode::Normal;
        policy.gameplay_pause = core::GameplayPausePolicy::Continue;
        break;
    }
    return policy;
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::initialize(bool show_title)
{
    reset();
    auto title = m_host.mount_system_layout(
        core::compiled::SystemLayoutRole::Title,
        runtime_system_layout_policy(core::compiled::SystemLayoutRole::Title, show_title));
    if (!title)
        return core::Result<void, core::Diagnostics>::failure(std::move(title).error());
    m_title = *title.value_if();

    auto hud = m_host.mount_system_layout(
        core::compiled::SystemLayoutRole::GameHud,
        runtime_system_layout_policy(core::compiled::SystemLayoutRole::GameHud, !show_title));
    if (!hud) {
        (void)m_host.unmount_system_layout(*m_title);
        m_title.reset();
        return core::Result<void, core::Diagnostics>::failure(std::move(hud).error());
    }
    m_game_hud = *hud.value_if();
    m_game_active = !show_title;
    publish();
    return core::Result<void, core::Diagnostics>::success();
}

void RuntimeSystemLayouts::reset() noexcept
{
    for (auto it = m_stack.rbegin(); it != m_stack.rend(); ++it)
        (void)m_host.unmount_system_layout(it->instance);
    m_stack.clear();
    if (m_game_hud)
        (void)m_host.unmount_system_layout(*m_game_hud);
    if (m_title)
        (void)m_host.unmount_system_layout(*m_title);
    m_game_hud.reset();
    m_title.reset();
    m_confirmation.reset();
    m_game_active = false;
}

core::RuntimeShellScreen RuntimeSystemLayouts::current_screen() const noexcept
{
    if (!m_stack.empty())
        return m_stack.back().screen;
    return m_game_active ? core::RuntimeShellScreen::None : core::RuntimeShellScreen::Title;
}

void RuntimeSystemLayouts::publish(std::string status)
{
    auto view = m_host.build_runtime_shell_view(current_screen(), m_confirmation, m_game_active);
    view.status = std::move(status);
    m_host.publish_runtime_shell_view(std::move(view));
}

core::Result<void, core::Diagnostics>
RuntimeSystemLayouts::open(core::RuntimeShellScreen screen, core::compiled::SystemLayoutRole role)
{
    if (!m_stack.empty() && m_stack.back().screen == screen) {
        publish();
        return core::Result<void, core::Diagnostics>::success();
    }
    auto mounted = m_host.mount_system_layout(role, runtime_system_layout_policy(role));
    if (!mounted)
        return core::Result<void, core::Diagnostics>::failure(std::move(mounted).error());
    m_stack.push_back({screen, role, *mounted.value_if()});
    publish();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::close_top()
{
    if (m_stack.empty())
        return core::Result<void, core::Diagnostics>::success();
    const auto entry = m_stack.back();
    auto unmounted = m_host.unmount_system_layout(entry.instance);
    if (!unmounted)
        return unmounted;
    m_stack.pop_back();
    if (entry.screen == core::RuntimeShellScreen::Confirmation)
        m_confirmation.reset();
    publish();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::clear_stack()
{
    while (!m_stack.empty()) {
        auto closed = close_top();
        if (!closed)
            return closed;
    }
    m_confirmation.reset();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::start_game()
{
    if (!m_game_active &&
        !m_host.dispatch_shell_runtime_input(core::RuntimeInputMessage{core::StartRuntimeInput{}}))
        return core::Result<void, core::Diagnostics>::failure(
            shell_diagnostic("runtime_shell.start_failed", "Runtime rejected the start request"));
    auto cleared = clear_stack();
    if (!cleared)
        return cleared;
    if (m_title) {
        auto hidden = m_host.set_system_layout_visible(*m_title, false);
        if (!hidden)
            return hidden;
    }
    if (m_game_hud) {
        auto shown = m_host.set_system_layout_visible(*m_game_hud, true);
        if (!shown)
            return shown;
    }
    m_game_active = true;
    publish();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::return_to_title()
{
    auto cleared = clear_stack();
    if (!cleared)
        return cleared;
    if (!m_host.dispatch_shell_runtime_input(
            core::RuntimeInputMessage{core::ResetRuntimeInput{}}) ||
        !m_host.dispatch_shell_runtime_input(core::RuntimeInputMessage{core::StopRuntimeInput{}}))
        return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
            "runtime_shell.return_to_title_failed", "Runtime rejected the return-to-title reset"));
    if (m_game_hud) {
        auto hidden = m_host.set_system_layout_visible(*m_game_hud, false);
        if (!hidden)
            return hidden;
    }
    if (m_title) {
        auto shown = m_host.set_system_layout_visible(*m_title, true);
        if (!shown)
            return shown;
    }
    m_game_active = false;
    publish();
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeSystemLayouts::request_confirmation(core::RuntimeShellConfirmation confirmation)
{
    if (current_screen() == core::RuntimeShellScreen::Confirmation) {
        m_confirmation = std::move(confirmation);
        publish();
        return core::Result<void, core::Diagnostics>::success();
    }
    m_confirmation = std::move(confirmation);
    auto opened =
        open(core::RuntimeShellScreen::Confirmation, core::compiled::SystemLayoutRole::Modal);
    if (!opened)
        m_confirmation.reset();
    return opened;
}

core::Result<void, core::Diagnostics> RuntimeSystemLayouts::confirm()
{
    if (!m_confirmation)
        return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
            "runtime_shell.confirmation_missing", "No shell confirmation is pending"));
    const auto confirmation = *m_confirmation;
    if (!m_stack.empty() && m_stack.back().screen == core::RuntimeShellScreen::Confirmation) {
        auto closed = close_top();
        if (!closed)
            return closed;
    }
    switch (confirmation.kind) {
    case core::RuntimeShellConfirmationKind::ReturnToTitle:
        return return_to_title();
    case core::RuntimeShellConfirmationKind::Quit:
        m_host.request_shell_quit();
        return core::Result<void, core::Diagnostics>::success();
    case core::RuntimeShellConfirmationKind::LoadSlot:
        if (!confirmation.slot)
            return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                "runtime_shell.load_slot_missing", "Load confirmation has no save slot"));
        if (!m_host.dispatch_shell_runtime_input(
                core::RuntimeInputMessage{core::LoadRuntimeInput{*confirmation.slot}}))
            return core::Result<void, core::Diagnostics>::failure(
                shell_diagnostic("runtime_shell.load_failed", "Runtime rejected the load request"));
        if (!m_game_active && !m_host.dispatch_shell_runtime_input(
                                  core::RuntimeInputMessage{core::StartRuntimeInput{}}))
            return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                "runtime_shell.loaded_start_failed", "Loaded runtime could not be started"));
        m_game_active = true;
        if (m_title)
            (void)m_host.set_system_layout_visible(*m_title, false);
        if (m_game_hud)
            (void)m_host.set_system_layout_visible(*m_game_hud, true);
        return clear_stack();
    }
    return core::Result<void, core::Diagnostics>::success();
}

core::Result<void, core::Diagnostics>
RuntimeSystemLayouts::dispatch(const core::RuntimeShellCommand& command)
{
    return std::visit(
        [this](const auto& value) -> core::Result<void, core::Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::StartGameShellCommand>) {
                return start_game();
            } else if constexpr (std::is_same_v<T, core::OpenPauseShellCommand>) {
                if (!m_game_active)
                    return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                        "runtime_shell.pause_unavailable", "Pause menu requires active gameplay"));
                if (!m_stack.empty())
                    return core::Result<void, core::Diagnostics>::success();
                return open(core::RuntimeShellScreen::Pause,
                            core::compiled::SystemLayoutRole::PauseMenu);
            } else if constexpr (std::is_same_v<T, core::ResumeGameShellCommand>) {
                return clear_stack();
            } else if constexpr (std::is_same_v<T, core::OpenSettingsShellCommand>) {
                return open(core::RuntimeShellScreen::Settings,
                            core::compiled::SystemLayoutRole::SettingsMenu);
            } else if constexpr (std::is_same_v<T, core::OpenSaveShellCommand>) {
                if (!m_game_active)
                    return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                        "runtime_shell.save_unavailable", "Save menu requires active gameplay"));
                return open(core::RuntimeShellScreen::Save,
                            core::compiled::SystemLayoutRole::SaveMenu);
            } else if constexpr (std::is_same_v<T, core::OpenLoadShellCommand>) {
                return open(core::RuntimeShellScreen::Load,
                            core::compiled::SystemLayoutRole::LoadMenu);
            } else if constexpr (std::is_same_v<T, core::OpenTextLogShellCommand>) {
                if (!m_game_active)
                    return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                        "runtime_shell.text_log_unavailable", "Text log requires active gameplay"));
                return open(core::RuntimeShellScreen::TextLog,
                            core::compiled::SystemLayoutRole::TextLog);
            } else if constexpr (std::is_same_v<T, core::OpenDebugShellCommand>) {
                return open(core::RuntimeShellScreen::Debug,
                            core::compiled::SystemLayoutRole::DebugOverlay);
            } else if constexpr (std::is_same_v<T, core::CloseShellScreenCommand> ||
                                 std::is_same_v<T, core::CancelShellCommand>) {
                return close_top();
            } else if constexpr (std::is_same_v<T, core::RequestReturnToTitleShellCommand>) {
                return request_confirmation(
                    {core::RuntimeShellConfirmationKind::ReturnToTitle, std::nullopt,
                     "Return to the title screen? Unsaved progress will be lost."});
            } else if constexpr (std::is_same_v<T, core::RequestQuitShellCommand>) {
                return request_confirmation(
                    {core::RuntimeShellConfirmationKind::Quit, std::nullopt, "Quit NovelTea?"});
            } else if constexpr (std::is_same_v<T, core::SaveShellSlotCommand>) {
                if (!m_game_active)
                    return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                        "runtime_shell.save_unavailable", "Saving requires active gameplay"));
                if (!m_host.dispatch_shell_runtime_input(
                        core::RuntimeInputMessage{core::SaveRuntimeInput{value.slot}}))
                    return core::Result<void, core::Diagnostics>::failure(shell_diagnostic(
                        "runtime_shell.save_failed", "Runtime rejected the save request"));
                publish("Saved.");
                return core::Result<void, core::Diagnostics>::success();
            } else if constexpr (std::is_same_v<T, core::RequestLoadShellSlotCommand>) {
                return request_confirmation(
                    {core::RuntimeShellConfirmationKind::LoadSlot, value.slot,
                     "Load this save? Current unsaved progress will be lost."});
            } else if constexpr (std::is_same_v<T, core::SetRuntimeUiScaleShellCommand>) {
                auto changed = m_host.set_runtime_ui_scale(value.scale);
                if (!changed)
                    return changed;
                publish("Settings updated.");
                return core::Result<void, core::Diagnostics>::success();
            } else if constexpr (std::is_same_v<T, core::SetRuntimeTextScaleShellCommand>) {
                auto changed = m_host.set_runtime_text_scale(value.scale);
                if (!changed)
                    return changed;
                publish("Settings updated.");
                return core::Result<void, core::Diagnostics>::success();
            } else if constexpr (std::is_same_v<T, core::ConfirmShellCommand>) {
                return confirm();
            }
            return core::Result<void, core::Diagnostics>::success();
        },
        command);
}

bool RuntimeSystemLayouts::handle_escape()
{
    if (!m_stack.empty())
        return static_cast<bool>(close_top());
    if (m_game_active)
        return static_cast<bool>(
            dispatch(core::RuntimeShellCommand{core::OpenPauseShellCommand{}}));
    return static_cast<bool>(dispatch(core::RuntimeShellCommand{core::RequestQuitShellCommand{}}));
}

} // namespace noveltea::presentation
