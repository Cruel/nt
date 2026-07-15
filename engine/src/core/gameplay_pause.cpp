#include "noveltea/core/gameplay_pause.hpp"

namespace noveltea::core {

EffectiveGameplayPause
derive_effective_gameplay_pause(bool explicit_session_pause,
                                std::span<const MountedLayoutInstance> mounted_layouts,
                                bool platform_suspended, bool engine_suspended)
{
    EffectiveGameplayPause result;
    if (explicit_session_pause) {
        result.active_sources.push_back(
            {.kind = GameplayPauseSourceKind::ExplicitSession, .layout_instance = std::nullopt});
    }
    for (const auto& mounted : mounted_layouts) {
        if (mounted.policy.visibility == LayoutVisibility::Visible &&
            mounted.policy.gameplay_pause == GameplayPausePolicy::PauseWhileVisible) {
            result.active_sources.push_back({.kind = GameplayPauseSourceKind::MountedLayout,
                                             .layout_instance = mounted.instance});
        }
    }
    if (platform_suspended) {
        result.active_sources.push_back(
            {.kind = GameplayPauseSourceKind::PlatformSuspension, .layout_instance = std::nullopt});
    }
    if (engine_suspended) {
        result.active_sources.push_back(
            {.kind = GameplayPauseSourceKind::EngineSuspension, .layout_instance = std::nullopt});
    }
    result.paused = !result.active_sources.empty();
    return result;
}

} // namespace noveltea::core
