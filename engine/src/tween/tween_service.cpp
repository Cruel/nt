#include <noveltea/tween_service.hpp>

#include <algorithm>
#include <utility>

#if defined(NOVELTEA_HAS_TWINK)
#include <twink/twink.hpp>
#endif

namespace noveltea {

namespace {

constexpr int kFloatProperty = 1;

#if defined(NOVELTEA_HAS_TWINK)
struct FloatAccessor {
    int getValues(float& target, int property, float* values)
    {
        if (property != kFloatProperty)
            return 0;
        values[0] = target;
        return 1;
    }

    void setValues(float& target, int property, const float* values)
    {
        if (property == kFloatProperty)
            target = values[0];
    }
};
#endif

} // namespace

struct TweenService::Entry {
    std::string owner_id;
    std::string channel;
    double duration_seconds = 0.0;
    double elapsed_seconds = 0.0;
    float* target = nullptr;
    float final_value = 0.0f;
    bool paused = false;
    bool finished = false;
    CompletionCallback on_complete;
#if defined(NOVELTEA_HAS_TWINK)
    twink::BaseTween* tween = nullptr;
#endif
};

struct TweenService::Impl {
#if defined(NOVELTEA_HAS_TWINK)
    twink::TweenManager manager;
#endif
};

TweenService::TweenService() : m_impl(std::make_unique<Impl>()) {}
TweenService::~TweenService() { reset(); }

void TweenService::tween_float(std::string owner_id, std::string channel, float& target, float from,
                               float to, double duration_seconds, CompletionCallback on_complete)
{
    kill_channel(channel);
    target = from;

    auto entry = std::make_unique<Entry>();
    entry->owner_id = std::move(owner_id);
    entry->channel = std::move(channel);
    entry->duration_seconds = std::max(0.0, duration_seconds);
    entry->target = &target;
    entry->final_value = to;
    entry->on_complete = std::move(on_complete);

#if defined(NOVELTEA_HAS_TWINK)
    auto& tween = twink::Tween::to<float, FloatAccessor>(
                      target, kFloatProperty, static_cast<float>(entry->duration_seconds))
                      .target(to)
                      .ease(twink::TweenEquations::easeInOutLinear)
                      .setCallback(twink::TweenCallback::Complete,
                                   [entry_ptr = entry.get()](twink::BaseTween*) {
                                       if (entry_ptr->finished)
                                           return;
                                       entry_ptr->finished = true;
                                       if (entry_ptr->on_complete)
                                           entry_ptr->on_complete();
                                   });
    entry->tween = &tween;
    tween.start(m_impl->manager);
#else
    target = to;
    entry->finished = true;
    if (entry->on_complete)
        entry->on_complete();
#endif

    if (!entry->finished) {
        m_entries.push_back(std::move(entry));
    }
}

void TweenService::advance(double delta_seconds)
{
    if (m_advancing)
        return;
    m_advancing = true;
    if (delta_seconds < 0.0)
        delta_seconds = 0.0;
#if defined(NOVELTEA_HAS_TWINK)
    m_impl->manager.update(static_cast<float>(delta_seconds));
#else
    (void)delta_seconds;
#endif
    for (auto& entry : m_entries) {
        if (entry->finished || entry->paused)
            continue;
        entry->elapsed_seconds += delta_seconds;
        if (entry->elapsed_seconds >= entry->duration_seconds) {
            if (entry->target)
                *entry->target = entry->final_value;
            entry->finished = true;
            if (entry->on_complete)
                entry->on_complete();
#if defined(NOVELTEA_HAS_TWINK)
            if (entry->tween)
                entry->tween->kill();
#endif
        }
    }
    m_advancing = false;
    prune_finished();
}

void TweenService::prune_finished()
{
    m_entries.erase(std::remove_if(m_entries.begin(), m_entries.end(),
                                   [](const auto& entry) { return entry->finished; }),
                    m_entries.end());
}

void TweenService::reset()
{
#if defined(NOVELTEA_HAS_TWINK)
    m_impl->manager.killAll();
    m_impl->manager.update(0.0f);
#endif
    m_entries.clear();
}

void TweenService::pause_owner(const std::string& owner_id)
{
    for (auto& entry : m_entries) {
        if (entry->owner_id != owner_id || entry->finished)
            continue;
        entry->paused = true;
#if defined(NOVELTEA_HAS_TWINK)
        if (entry->tween)
            entry->tween->pause();
#endif
    }
}

void TweenService::resume_owner(const std::string& owner_id)
{
    for (auto& entry : m_entries) {
        if (entry->owner_id != owner_id || entry->finished)
            continue;
        entry->paused = false;
#if defined(NOVELTEA_HAS_TWINK)
        if (entry->tween)
            entry->tween->resume();
#endif
    }
}

void TweenService::kill_owner(const std::string& owner_id)
{
    for (auto& entry : m_entries) {
        if (entry->owner_id != owner_id)
            continue;
        entry->finished = true;
#if defined(NOVELTEA_HAS_TWINK)
        if (entry->tween)
            entry->tween->kill();
#endif
    }
    if (!m_advancing)
        advance(0.0);
}

void TweenService::kill_channel(const std::string& channel)
{
    for (auto& entry : m_entries) {
        if (entry->channel != channel)
            continue;
        entry->finished = true;
#if defined(NOVELTEA_HAS_TWINK)
        if (entry->tween)
            entry->tween->kill();
#endif
    }
    if (!m_advancing)
        advance(0.0);
}

std::size_t TweenService::active_count() const
{
    return static_cast<std::size_t>(std::count_if(
        m_entries.begin(), m_entries.end(), [](const auto& entry) { return !entry->finished; }));
}

std::vector<TweenDebugInfo> TweenService::debug_snapshot() const
{
    std::vector<TweenDebugInfo> snapshot;
    snapshot.reserve(m_entries.size());
    for (const auto& entry : m_entries) {
        if (entry->finished)
            continue;
        snapshot.push_back(TweenDebugInfo{entry->owner_id, entry->channel, entry->duration_seconds,
                                          entry->paused, entry->finished});
    }
    return snapshot;
}

} // namespace noveltea
