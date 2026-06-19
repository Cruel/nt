#include <noveltea/core/runtime_events.hpp>

#include <algorithm>
#include <utility>

namespace noveltea::core {

RuntimeEventListenerId RuntimeEventBus::listen(RuntimeEventListener listener)
{
    return listen(RuntimeEventType::All, std::move(listener));
}

RuntimeEventListenerId RuntimeEventBus::listen(RuntimeEventType type, RuntimeEventListener listener)
{
    const auto id = m_next_listener_id++;
    m_listeners.push_back(ListenerRecord{id, type, std::move(listener)});
    return id;
}

bool RuntimeEventBus::remove(RuntimeEventListenerId id)
{
    const auto it =
        std::find_if(m_listeners.begin(), m_listeners.end(),
                     [id](const ListenerRecord& listener) { return listener.id == id; });
    if (it == m_listeners.end()) {
        return false;
    }
    m_listeners.erase(it);
    return true;
}

bool RuntimeEventBus::trigger(const RuntimeEvent& event)
{
    bool result = true;
    const auto listeners = m_listeners;
    for (const auto& listener : listeners) {
        if (!listener.listener) {
            continue;
        }
        if (listener.type == RuntimeEventType::All || listener.type == event.type) {
            result = listener.listener(event) && result;
        }
    }
    return result;
}

bool RuntimeEventBus::trigger(RuntimeEventType type)
{
    RuntimeEvent event;
    event.type = type;
    return trigger(event);
}

void RuntimeEventBus::push(RuntimeEvent event) { m_queue.push_back(std::move(event)); }

void RuntimeEventBus::push(RuntimeEventType type)
{
    RuntimeEvent event;
    event.type = type;
    push(std::move(event));
}

std::size_t RuntimeEventBus::queued_count() const noexcept { return m_queue.size(); }

bool RuntimeEventBus::empty() const noexcept { return m_queue.empty(); }

bool RuntimeEventBus::dispatch_queued()
{
    auto events = std::move(m_queue);
    m_queue.clear();

    bool result = true;
    for (const auto& event : events) {
        result = trigger(event) && result;
    }
    return result;
}

void RuntimeEventBus::clear() { m_queue.clear(); }

RuntimeTimerHandle RuntimeTimerScheduler::start(double duration_seconds,
                                                RuntimeTimerCallback callback)
{
    if (duration_seconds < 0.0) {
        duration_seconds = 0.0;
    }
    const auto id = m_next_timer_id++;
    m_timers.push_back(Timer{id, duration_seconds, 0.0, false, false, std::move(callback)});
    return RuntimeTimerHandle{id};
}

RuntimeTimerHandle RuntimeTimerScheduler::start_repeat(double duration_seconds,
                                                       RuntimeTimerCallback callback)
{
    if (duration_seconds <= 0.0) {
        duration_seconds = 0.001;
    }
    const auto id = m_next_timer_id++;
    m_timers.push_back(Timer{id, duration_seconds, 0.0, true, false, std::move(callback)});
    return RuntimeTimerHandle{id};
}

bool RuntimeTimerScheduler::cancel(RuntimeTimerId id)
{
    for (auto& timer : m_timers) {
        if (timer.id == id && !timer.completed) {
            timer.completed = true;
            return true;
        }
    }
    return false;
}

bool RuntimeTimerScheduler::active(RuntimeTimerId id) const
{
    return std::any_of(m_timers.begin(), m_timers.end(),
                       [id](const Timer& timer) { return timer.id == id && !timer.completed; });
}

std::size_t RuntimeTimerScheduler::active_count() const noexcept
{
    return static_cast<std::size_t>(std::count_if(
        m_timers.begin(), m_timers.end(), [](const Timer& timer) { return !timer.completed; }));
}

void RuntimeTimerScheduler::reset() { m_timers.clear(); }

bool RuntimeTimerScheduler::update(double delta_seconds, RuntimeEventBus* events)
{
    if (delta_seconds < 0.0) {
        delta_seconds = 0.0;
    }

    bool fired_any = false;
    std::vector<RuntimeTimerId> initial_timer_ids;
    initial_timer_ids.reserve(m_timers.size());
    for (const auto& timer : m_timers) {
        initial_timer_ids.push_back(timer.id);
    }

    for (const auto id : initial_timer_ids) {
        auto find_timer = [&]() {
            return std::find_if(m_timers.begin(), m_timers.end(),
                                [id](const Timer& timer) { return timer.id == id; });
        };

        auto it = find_timer();
        if (it == m_timers.end() || it->completed) {
            continue;
        }

        it->elapsed_seconds += delta_seconds;
        while (it != m_timers.end() && !it->completed &&
               it->elapsed_seconds >= it->duration_seconds) {
            const auto callback = it->callback;
            const auto repeat = it->repeat;
            const auto duration = it->duration_seconds;
            fired_any = true;
            if (callback) {
                callback(id);
            }

            it = find_timer();
            if (it == m_timers.end() || it->completed) {
                break;
            }
            if (!repeat) {
                it->completed = true;
                break;
            }
            it->elapsed_seconds -= duration;
        }
    }

    m_timers.erase(std::remove_if(m_timers.begin(), m_timers.end(),
                                  [](const Timer& timer) { return timer.completed; }),
                   m_timers.end());

    if (fired_any && events != nullptr) {
        events->push(RuntimeEventType::TimerCompleted);
    }
    return fired_any;
}

} // namespace noveltea::core
