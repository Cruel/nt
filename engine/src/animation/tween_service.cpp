#include "noveltea/animation/tween_service.hpp"

#include <twink/twink.hpp>

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

namespace noveltea::animation {
namespace {

constexpr int kScalarProperty = 1;

struct ScalarAccessor {
    int getValues(float& target, int property, float* values)
    {
        if (property != kScalarProperty)
            return 0;
        values[0] = target;
        return 1;
    }

    void setValues(float& target, int property, const float* values)
    {
        if (property == kScalarProperty)
            target = values[0];
    }
};

twink::TweenEquation& equation(TweenEasing easing) noexcept
{
    switch (easing) {
    case TweenEasing::Linear:
        return twink::TweenEquations::easeInOutLinear;
    case TweenEasing::QuadraticIn:
        return twink::TweenEquations::easeInQuad;
    case TweenEasing::QuadraticOut:
        return twink::TweenEquations::easeOutQuad;
    case TweenEasing::QuadraticInOut:
        return twink::TweenEquations::easeInOutQuad;
    case TweenEasing::CubicIn:
        return twink::TweenEquations::easeInCubic;
    case TweenEasing::CubicOut:
        return twink::TweenEquations::easeOutCubic;
    case TweenEasing::CubicInOut:
        return twink::TweenEquations::easeInOutCubic;
    case TweenEasing::QuarticIn:
        return twink::TweenEquations::easeInQuart;
    case TweenEasing::QuarticOut:
        return twink::TweenEquations::easeOutQuart;
    case TweenEasing::QuarticInOut:
        return twink::TweenEquations::easeInOutQuart;
    case TweenEasing::QuinticIn:
        return twink::TweenEquations::easeInQuint;
    case TweenEasing::QuinticOut:
        return twink::TweenEquations::easeOutQuint;
    case TweenEasing::QuinticInOut:
        return twink::TweenEquations::easeInOutQuint;
    case TweenEasing::SineIn:
        return twink::TweenEquations::easeInSine;
    case TweenEasing::SineOut:
        return twink::TweenEquations::easeOutSine;
    case TweenEasing::SineInOut:
        return twink::TweenEquations::easeInOutSine;
    case TweenEasing::ExponentialIn:
        return twink::TweenEquations::easeInExpo;
    case TweenEasing::ExponentialOut:
        return twink::TweenEquations::easeOutExpo;
    case TweenEasing::ExponentialInOut:
        return twink::TweenEquations::easeInOutExpo;
    case TweenEasing::CircularIn:
        return twink::TweenEquations::easeInCirc;
    case TweenEasing::CircularOut:
        return twink::TweenEquations::easeOutCirc;
    case TweenEasing::CircularInOut:
        return twink::TweenEquations::easeInOutCirc;
    case TweenEasing::BackIn:
        return twink::TweenEquations::easeInBack;
    case TweenEasing::BackOut:
        return twink::TweenEquations::easeOutBack;
    case TweenEasing::BackInOut:
        return twink::TweenEquations::easeInOutBack;
    case TweenEasing::BounceIn:
        return twink::TweenEquations::easeInBounce;
    case TweenEasing::BounceOut:
        return twink::TweenEquations::easeOutBounce;
    case TweenEasing::BounceInOut:
        return twink::TweenEquations::easeInOutBounce;
    case TweenEasing::ElasticIn:
        return twink::TweenEquations::easeInElastic;
    case TweenEasing::ElasticOut:
        return twink::TweenEquations::easeOutElastic;
    case TweenEasing::ElasticInOut:
        return twink::TweenEquations::easeInOutElastic;
    }
    return twink::TweenEquations::easeInOutLinear;
}

core::Diagnostic invalid_spec(std::string message)
{
    return {.code = "animation.tween_spec_invalid", .message = std::move(message)};
}

} // namespace

struct TweenService::Impl {
    struct Entry {
        TweenHandle handle;
        float value = 0.0f;
        float target = 0.0f;
        std::chrono::microseconds duration{0};
        std::chrono::microseconds elapsed{0};
        twink::BaseTween* tween = nullptr;
        bool completed = false;
        bool retire = false;
    };

    [[nodiscard]] Entry* find(TweenHandle handle) noexcept
    {
        const auto found = std::find_if(entries.begin(), entries.end(), [&](const auto& entry) {
            return entry->handle == handle && !entry->retire;
        });
        return found == entries.end() ? nullptr : found->get();
    }

    [[nodiscard]] const Entry* find(TweenHandle handle) const noexcept
    {
        const auto found = std::find_if(entries.begin(), entries.end(), [&](const auto& entry) {
            return entry->handle == handle && !entry->retire;
        });
        return found == entries.end() ? nullptr : found->get();
    }

    [[nodiscard]] TweenHandle allocate_handle() noexcept
    {
        TweenHandle handle{next_handle++};
        if (next_handle == 0)
            next_handle = 1;
        if (!handle)
            handle.value = next_handle++;
        return handle;
    }

    twink::TweenManager manager;
    std::vector<std::unique_ptr<Entry>> entries;
    std::uint64_t next_handle = 1;
};

TweenService::TweenService() : m_impl(std::make_unique<Impl>()) {}

TweenService::~TweenService() { reset(); }

core::Result<TweenHandle, core::Diagnostic> TweenService::start_scalar(const ScalarTweenSpec& spec)
{
    if (!std::isfinite(spec.from) || !std::isfinite(spec.to)) {
        return core::Result<TweenHandle, core::Diagnostic>::failure(
            invalid_spec("Scalar tween endpoints must be finite"));
    }
    if (spec.duration < std::chrono::microseconds{0}) {
        return core::Result<TweenHandle, core::Diagnostic>::failure(
            invalid_spec("Scalar tween duration cannot be negative"));
    }

    auto entry = std::make_unique<Impl::Entry>();
    entry->handle = m_impl->allocate_handle();
    entry->value = spec.from;
    entry->target = spec.to;
    entry->duration = spec.duration;
    const auto handle = entry->handle;

    if (spec.duration == std::chrono::microseconds{0}) {
        entry->value = spec.to;
        entry->completed = true;
        m_impl->entries.push_back(std::move(entry));
        return core::Result<TweenHandle, core::Diagnostic>::success(handle);
    }

    const float duration_seconds =
        std::chrono::duration_cast<std::chrono::duration<float>>(spec.duration).count();
    if (!std::isfinite(duration_seconds) || duration_seconds <= 0.0f) {
        return core::Result<TweenHandle, core::Diagnostic>::failure(
            invalid_spec("Scalar tween duration is outside Twink's supported range"));
    }
    auto& tween =
        twink::Tween::to<float, ScalarAccessor>(entry->value, kScalarProperty, duration_seconds)
            .target(spec.to)
            .ease(equation(spec.easing))
            .setCallback(twink::TweenCallback::Complete,
                         [entry_ptr = entry.get()](twink::BaseTween*) {
                             entry_ptr->value = entry_ptr->target;
                             entry_ptr->elapsed = entry_ptr->duration;
                             entry_ptr->completed = true;
                         });
    entry->tween = &tween;
    tween.start(m_impl->manager);
    m_impl->entries.push_back(std::move(entry));
    return core::Result<TweenHandle, core::Diagnostic>::success(handle);
}

void TweenService::advance(std::chrono::microseconds delta)
{
    delta = std::max(delta, std::chrono::microseconds{0});

    // Twink auto-removes completed/killed objects at the start of update(). Clear our non-owning
    // pointers first so retained completed samples never observe a dangling backend pointer.
    for (auto& entry : m_impl->entries) {
        if (entry->completed && entry->tween)
            entry->tween = nullptr;
    }

    const float delta_seconds =
        std::chrono::duration_cast<std::chrono::duration<float>>(delta).count();
    m_impl->manager.update(delta_seconds);

    for (auto& entry : m_impl->entries) {
        if (entry->completed || entry->retire)
            continue;
        entry->elapsed = std::min(entry->elapsed + delta, entry->duration);
        if (entry->elapsed >= entry->duration) {
            entry->value = entry->target;
            entry->completed = true;
            if (entry->tween)
                entry->tween->kill();
        }
    }

    m_impl->entries.erase(
        std::remove_if(m_impl->entries.begin(), m_impl->entries.end(),
                       [](const auto& entry) { return entry->retire && !entry->tween; }),
        m_impl->entries.end());
}

std::optional<ScalarTweenSample> TweenService::sample(TweenHandle handle) const noexcept
{
    const auto* entry = m_impl->find(handle);
    if (!entry)
        return std::nullopt;
    const float normalized_time =
        entry->duration <= std::chrono::microseconds{0}
            ? 1.0f
            : static_cast<float>(std::clamp(static_cast<double>(entry->elapsed.count()) /
                                                static_cast<double>(entry->duration.count()),
                                            0.0, 1.0));
    return ScalarTweenSample{entry->value, normalized_time, entry->completed};
}

bool TweenService::cancel(TweenHandle handle) noexcept
{
    auto* entry = m_impl->find(handle);
    if (!entry)
        return false;
    if (entry->tween)
        entry->tween->kill();
    entry->completed = true;
    entry->retire = true;
    return true;
}

bool TweenService::release(TweenHandle handle) noexcept
{
    auto* entry = m_impl->find(handle);
    if (!entry || !entry->completed)
        return false;
    entry->retire = true;
    return true;
}

void TweenService::reset() noexcept
{
    m_impl->manager.killAll();
    m_impl->manager.update(0.0f);
    m_impl->entries.clear();
}

std::size_t TweenService::active_count() const noexcept
{
    return static_cast<std::size_t>(
        std::count_if(m_impl->entries.begin(), m_impl->entries.end(),
                      [](const auto& entry) { return !entry->completed && !entry->retire; }));
}

} // namespace noveltea::animation
