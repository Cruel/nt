#pragma once

#include "noveltea/core/game_session.hpp"
#include "noveltea/core/runtime_io.hpp"
#include "noveltea/core/runtime_session_host.hpp"
#include "noveltea/core/save_document.hpp"
#include "noveltea/runtime_command.hpp"
#include "noveltea/runtime_layout_manager.hpp"
#include "noveltea/runtime_transition_manager.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

namespace noveltea {

enum class RuntimeShellMode {
    Boot,
    Title,
    Game,
    Paused,
    Error,
};

class RuntimeShell {
public:
    RuntimeShell();

    [[nodiscard]] RuntimeShellMode mode() const noexcept { return m_mode; }
    [[nodiscard]] bool loaded() const noexcept { return m_host.loaded(); }
    [[nodiscard]] bool paused() const noexcept
    {
        return m_mode == RuntimeShellMode::Paused || !m_pause_tokens.empty();
    }

    [[nodiscard]] core::RuntimeSessionHost& host() noexcept { return m_host; }
    [[nodiscard]] const core::RuntimeSessionHost& host() const noexcept { return m_host; }
    [[nodiscard]] RuntimeCommandDispatcher& dispatcher() noexcept { return m_dispatcher; }
    [[nodiscard]] const RuntimeCommandDispatcher& dispatcher() const noexcept
    {
        return m_dispatcher;
    }
    [[nodiscard]] RuntimeLayoutManager& layouts() noexcept { return m_layouts; }
    [[nodiscard]] const RuntimeLayoutManager& layouts() const noexcept { return m_layouts; }
    [[nodiscard]] RuntimeTransitionManager& transitions() noexcept { return m_transitions; }
    [[nodiscard]] const RuntimeTransitionManager& transitions() const noexcept
    {
        return m_transitions;
    }
    [[nodiscard]] const std::vector<core::RuntimeDiagnostic>& last_diagnostics() const noexcept
    {
        return m_last_diagnostics;
    }

    [[nodiscard]] core::GameSessionLoadResult
    load_project(core::ProjectDocument project,
                 core::SaveDocument save = core::SaveDocument::new_save());
    void reset();
    void bind_runtime_ui(RuntimeUI* ui) noexcept;
    [[nodiscard]] RuntimeLayoutInstanceId mount_title_layout();
    [[nodiscard]] RuntimeLayoutInstanceId mount_gameplay_layout();
    [[nodiscard]] RuntimeLayoutInstanceId
    mount_gameplay_layout(std::string layout_id, std::optional<int> z_index = std::nullopt);
    [[nodiscard]] RuntimeLayoutInstanceId mount_pause_menu_layout();
    void pause();
    void resume();
    [[nodiscard]] core::RuntimeInputResult start_game();
    [[nodiscard]] core::RuntimeInputResult
    start_room(std::string room_id,
               std::optional<std::uint64_t> playback_step_index = std::nullopt);
    [[nodiscard]] core::RuntimeInputResult update(double delta_seconds);
    [[nodiscard]] RuntimeCommandResult dispatch_command(RuntimeCommand command);

private:
    friend class RuntimeCommandDispatcher;

    [[nodiscard]] core::RuntimeInputResult make_unhandled(std::string message);

    core::RuntimeSessionHost m_host;
    RuntimeCommandDispatcher m_dispatcher;
    RuntimeLayoutManager m_layouts;
    RuntimeTransitionManager m_transitions;
    RuntimeShellMode m_mode = RuntimeShellMode::Boot;
    std::unordered_set<std::string> m_pause_tokens;
    std::vector<core::RuntimeDiagnostic> m_last_diagnostics;
};

} // namespace noveltea
