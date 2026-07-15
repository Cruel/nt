#pragma once

#include "noveltea/core/presentation_contracts.hpp"

#include <optional>
#include <span>
#include <vector>

namespace noveltea::core {

enum class GameplayPauseSourceKind {
    ExplicitSession,
    MountedLayout,
    PlatformSuspension,
    EngineSuspension,
};

struct GameplayPauseSource {
    GameplayPauseSourceKind kind = GameplayPauseSourceKind::ExplicitSession;
    std::optional<MountedLayoutInstanceId> layout_instance;

    auto operator<=>(const GameplayPauseSource&) const = default;
};

struct EffectiveGameplayPause {
    bool paused = false;
    std::vector<GameplayPauseSource> active_sources;

    auto operator<=>(const EffectiveGameplayPause&) const = default;
};

[[nodiscard]] EffectiveGameplayPause
derive_effective_gameplay_pause(bool explicit_session_pause,
                                std::span<const MountedLayoutInstance> mounted_layouts,
                                bool platform_suspended, bool engine_suspended = false);

} // namespace noveltea::core
