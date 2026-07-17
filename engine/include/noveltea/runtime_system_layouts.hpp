#pragma once

#include "noveltea/core/compiled_project.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/runtime_messages.hpp"
#include "noveltea/core/runtime_shell_contracts.hpp"
#include "noveltea/runtime_layout_manager.hpp"

#include <optional>
#include <vector>

namespace noveltea {

class RuntimeSystemLayoutHost {
public:
    virtual ~RuntimeSystemLayoutHost() = default;

    [[nodiscard]] virtual core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
    mount_system_layout(core::compiled::SystemLayoutRole role,
                        core::MountedLayoutPolicy policy) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    set_system_layout_visible(core::MountedLayoutInstanceId instance, bool visible) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    unmount_system_layout(core::MountedLayoutInstanceId instance) = 0;
    [[nodiscard]] virtual bool dispatch_shell_runtime_input(core::RuntimeInputMessage input) = 0;
    [[nodiscard]] virtual core::Result<void, core::Diagnostics>
    set_runtime_user_settings(core::RuntimeUserSettings settings) = 0;
    [[nodiscard]] virtual core::RuntimeShellViewState
    build_runtime_shell_view(core::RuntimeShellScreen screen,
                             const std::optional<core::RuntimeShellConfirmation>& confirmation,
                             bool game_active) = 0;
    virtual void publish_runtime_shell_view(core::RuntimeShellViewState view) = 0;
    virtual void request_shell_quit() = 0;
};

[[nodiscard]] core::MountedLayoutPolicy
runtime_system_layout_policy(core::compiled::SystemLayoutRole role, bool visible = true);

class RuntimeSystemLayouts final {
public:
    explicit RuntimeSystemLayouts(RuntimeSystemLayoutHost& host) noexcept : m_host(host) {}

    [[nodiscard]] core::Result<void, core::Diagnostics> initialize(bool show_title);
    void reset() noexcept;
    [[nodiscard]] core::Result<void, core::Diagnostics>
    dispatch(const core::RuntimeShellCommand& command);
    [[nodiscard]] bool handle_escape();
    void refresh() { publish(); }
    [[nodiscard]] bool game_active() const noexcept { return m_game_active; }
    [[nodiscard]] core::RuntimeShellScreen current_screen() const noexcept;

private:
    struct StackEntry {
        core::RuntimeShellScreen screen;
        core::compiled::SystemLayoutRole role;
        core::MountedLayoutInstanceId instance;
    };

    [[nodiscard]] core::Result<void, core::Diagnostics> open(core::RuntimeShellScreen screen,
                                                             core::compiled::SystemLayoutRole role);
    [[nodiscard]] core::Result<void, core::Diagnostics> close_top();
    [[nodiscard]] core::Result<void, core::Diagnostics> clear_stack();
    [[nodiscard]] core::Result<void, core::Diagnostics>
    request_confirmation(core::RuntimeShellConfirmation confirmation);
    [[nodiscard]] core::Result<void, core::Diagnostics> confirm();
    [[nodiscard]] core::Result<void, core::Diagnostics> start_game();
    [[nodiscard]] core::Result<void, core::Diagnostics> return_to_title();
    void publish(std::string status = {});

    RuntimeSystemLayoutHost& m_host;
    std::optional<core::MountedLayoutInstanceId> m_title;
    std::optional<core::MountedLayoutInstanceId> m_game_hud;
    std::vector<StackEntry> m_stack;
    std::optional<core::RuntimeShellConfirmation> m_confirmation;
    bool m_game_active = false;
};

} // namespace noveltea
