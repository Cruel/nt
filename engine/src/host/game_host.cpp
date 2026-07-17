#include "host/game_host.hpp"

#include "noveltea/world_transition.hpp"

namespace noveltea::host {

GameHost::GameHost(Dependencies dependencies) noexcept
    : m_dependencies(dependencies), m_save_slots(&dependencies.save_slots),
      m_runtime_audio_adapter(dependencies.audio, m_runtime_ui_asset_resolver),
      m_runtime_presentation(m_runtime_audio_adapter),
      m_system_layouts(dependencies.system_layout_host)
{
    m_runtime_presentation.bind_world_transition_backend(dependencies.world_transitions);
}

GameHost::~GameHost() = default;

void GameHost::replace_running_game(std::unique_ptr<runtime::RunningGame> running_game) noexcept
{
    m_running_game = std::move(running_game);
    advance_session_generation();
    m_lifecycle_state =
        m_running_game ? LoadedGameLifecycleState::Loaded : LoadedGameLifecycleState::Empty;
}

void GameHost::release_running_game() noexcept
{
    if (m_running_game)
        advance_session_generation();
    m_running_game.reset();
    m_lifecycle_state = LoadedGameLifecycleState::Empty;
}

void GameHost::mark_running() noexcept
{
    if (m_running_game)
        m_lifecycle_state = LoadedGameLifecycleState::Running;
}

void GameHost::mark_stopped() noexcept
{
    if (m_running_game)
        m_lifecycle_state = LoadedGameLifecycleState::Stopped;
}

void GameHost::advance_session_generation() noexcept
{
    if (const auto next = m_session_generation.next())
        m_session_generation = *next;
}

} // namespace noveltea::host
