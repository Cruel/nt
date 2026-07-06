#pragma once

#include <functional>
#include <string>

namespace noveltea {

enum class RuntimeTransitionKind {
    Cut,
    BlackFade,
};

enum class RuntimeTransitionPhase {
    Idle,
    FadeOut,
    FadeIn,
};

struct RuntimeTransitionPolicy {
    bool timed_transitions_enabled = false;
};

struct RuntimeTransitionRequest {
    RuntimeTransitionKind kind = RuntimeTransitionKind::Cut;
    double duration_seconds = 0.25;
    std::string label;
    std::function<void()> on_midpoint;
};

struct RuntimeTransitionState {
    RuntimeTransitionKind kind = RuntimeTransitionKind::Cut;
    RuntimeTransitionPhase phase = RuntimeTransitionPhase::Idle;
    double elapsed_seconds = 0.0;
    double duration_seconds = 0.0;
    float black_opacity = 0.0f;
    bool midpoint_reached = false;
    std::string label;
};

class RuntimeTransitionManager {
public:
    [[nodiscard]] const RuntimeTransitionPolicy& policy() const noexcept { return m_policy; }
    void set_policy(RuntimeTransitionPolicy policy) noexcept;
    void set_timed_transitions_enabled(bool enabled) noexcept;

    void start(RuntimeTransitionRequest request);
    void update(double delta_seconds);
    void complete_immediately();
    void reset();

    [[nodiscard]] bool active() const noexcept
    {
        return m_state.phase != RuntimeTransitionPhase::Idle;
    }
    [[nodiscard]] float opacity() const noexcept { return m_state.black_opacity; }
    [[nodiscard]] float black_opacity() const noexcept { return m_state.black_opacity; }
    [[nodiscard]] const RuntimeTransitionState& state() const noexcept { return m_state; }

private:
    void reach_midpoint();
    void finish();

    RuntimeTransitionPolicy m_policy;
    RuntimeTransitionState m_state;
    std::function<void()> m_on_midpoint;
};

} // namespace noveltea
