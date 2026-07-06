#include "noveltea/runtime_transition_manager.hpp"

#include <algorithm>
#include <utility>

namespace noveltea {

void RuntimeTransitionManager::set_policy(RuntimeTransitionPolicy policy) noexcept
{
    m_policy = policy;
    if (!m_policy.timed_transitions_enabled) {
        complete_immediately();
    }
}

void RuntimeTransitionManager::set_timed_transitions_enabled(bool enabled) noexcept
{
    set_policy(RuntimeTransitionPolicy{.timed_transitions_enabled = enabled});
}

void RuntimeTransitionManager::start(RuntimeTransitionRequest request)
{
    m_on_midpoint = std::move(request.on_midpoint);

    if (request.kind == RuntimeTransitionKind::Cut || !m_policy.timed_transitions_enabled ||
        request.duration_seconds <= 0.0) {
        m_state = RuntimeTransitionState{
            .kind = request.kind,
            .phase = RuntimeTransitionPhase::Idle,
            .elapsed_seconds = 0.0,
            .duration_seconds = 0.0,
            .black_opacity = 0.0f,
            .midpoint_reached = false,
            .label = std::move(request.label),
        };
        reach_midpoint();
        finish();
        return;
    }

    m_state = RuntimeTransitionState{
        .kind = request.kind,
        .phase = RuntimeTransitionPhase::FadeOut,
        .elapsed_seconds = 0.0,
        .duration_seconds = request.duration_seconds,
        .black_opacity = 0.0f,
        .midpoint_reached = false,
        .label = std::move(request.label),
    };
}

void RuntimeTransitionManager::update(double delta_seconds)
{
    if (!active()) {
        return;
    }
    if (!m_policy.timed_transitions_enabled) {
        complete_immediately();
        return;
    }
    if (delta_seconds <= 0.0) {
        return;
    }

    const double half_duration = std::max(m_state.duration_seconds * 0.5, 0.000001);
    m_state.elapsed_seconds += delta_seconds;

    if (m_state.phase == RuntimeTransitionPhase::FadeOut) {
        const double progress = std::clamp(m_state.elapsed_seconds / half_duration, 0.0, 1.0);
        m_state.black_opacity = static_cast<float>(progress);
        if (progress >= 1.0) {
            reach_midpoint();
            m_state.phase = RuntimeTransitionPhase::FadeIn;
            m_state.elapsed_seconds -= half_duration;
            m_state.black_opacity = 1.0f;
        }
    }

    if (m_state.phase == RuntimeTransitionPhase::FadeIn) {
        const double progress = std::clamp(m_state.elapsed_seconds / half_duration, 0.0, 1.0);
        m_state.black_opacity = static_cast<float>(1.0 - progress);
        if (progress >= 1.0) {
            finish();
        }
    }
}

void RuntimeTransitionManager::complete_immediately()
{
    if (!active() && m_state.midpoint_reached) {
        m_state.black_opacity = 0.0f;
        return;
    }
    reach_midpoint();
    finish();
}

void RuntimeTransitionManager::reset()
{
    m_state = {};
    m_on_midpoint = nullptr;
}

void RuntimeTransitionManager::reach_midpoint()
{
    if (m_state.midpoint_reached) {
        return;
    }
    m_state.midpoint_reached = true;
    if (m_on_midpoint) {
        auto callback = std::move(m_on_midpoint);
        m_on_midpoint = nullptr;
        callback();
    }
}

void RuntimeTransitionManager::finish()
{
    m_state.phase = RuntimeTransitionPhase::Idle;
    m_state.elapsed_seconds = 0.0;
    m_state.duration_seconds = 0.0;
    m_state.black_opacity = 0.0f;
    m_on_midpoint = nullptr;
}

} // namespace noveltea
