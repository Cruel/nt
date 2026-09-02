#pragma once

#include <cstdint>

namespace noveltea::assets {

class AssetManager;

enum class AssetProgressUrgency : std::uint8_t {
    Idle,
    Background,
    Blocking,
};

// Owner-frame policy boundary for asynchronous asset progress. Presentation consumers never retry
// deferred requests directly; they create typed requests and this orchestrator keeps viable
// request work moving while exposing only semantic urgency to the host scheduler.
class AssetProgressOrchestrator final {
public:
    explicit AssetProgressOrchestrator(AssetManager& assets) noexcept;

    [[nodiscard]] AssetProgressUrgency urgency_on_owner() const noexcept;
    void service_owner_frame() noexcept;

private:
    AssetManager& m_assets;
};

} // namespace noveltea::assets
