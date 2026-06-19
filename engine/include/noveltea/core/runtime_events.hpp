#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea::core {

enum class RuntimeEventType : std::int32_t {
    All = 0,
    TimerCompleted = 1,
    GameLoaded = 2,
    GameSaving = 3,
    GameSaved = 4,
    Notification = 5,
    TextLogged = 6,
    RuntimeModeChanged = 7,
    Custom = 1000,
};

struct RuntimeEvent {
    RuntimeEventType type = RuntimeEventType::Custom;
    int int_value = 0;
    double number_value = 0.0;
    std::string text;
    nlohmann::json data = nlohmann::json::object();
};

using RuntimeEventListenerId = std::uint64_t;
using RuntimeEventListener = std::function<bool(const RuntimeEvent&)>;

class RuntimeEventBus {
public:
    [[nodiscard]] RuntimeEventListenerId listen(RuntimeEventListener listener);
    [[nodiscard]] RuntimeEventListenerId listen(RuntimeEventType type,
                                                RuntimeEventListener listener);
    [[nodiscard]] bool remove(RuntimeEventListenerId id);

    [[nodiscard]] bool trigger(const RuntimeEvent& event);
    [[nodiscard]] bool trigger(RuntimeEventType type);

    void push(RuntimeEvent event);
    void push(RuntimeEventType type);
    [[nodiscard]] std::size_t queued_count() const noexcept;
    [[nodiscard]] bool empty() const noexcept;

    [[nodiscard]] bool dispatch_queued();
    void clear();

private:
    struct ListenerRecord {
        RuntimeEventListenerId id = 0;
        RuntimeEventType type = RuntimeEventType::All;
        RuntimeEventListener listener;
    };

    RuntimeEventListenerId m_next_listener_id = 1;
    std::vector<ListenerRecord> m_listeners;
    std::vector<RuntimeEvent> m_queue;
};

using RuntimeTimerId = std::uint64_t;
using RuntimeTimerCallback = std::function<void(RuntimeTimerId)>;

struct RuntimeTimerHandle {
    RuntimeTimerId id = 0;
};

class RuntimeTimerScheduler {
public:
    [[nodiscard]] RuntimeTimerHandle start(double duration_seconds,
                                           RuntimeTimerCallback callback = {});
    [[nodiscard]] RuntimeTimerHandle start_repeat(double duration_seconds,
                                                  RuntimeTimerCallback callback = {});

    [[nodiscard]] bool cancel(RuntimeTimerId id);
    [[nodiscard]] bool active(RuntimeTimerId id) const;
    [[nodiscard]] std::size_t active_count() const noexcept;

    void reset();
    [[nodiscard]] bool update(double delta_seconds, RuntimeEventBus* events = nullptr);

private:
    struct Timer {
        RuntimeTimerId id = 0;
        double duration_seconds = 0.0;
        double elapsed_seconds = 0.0;
        bool repeat = false;
        bool completed = false;
        RuntimeTimerCallback callback;
    };

    RuntimeTimerId m_next_timer_id = 1;
    std::vector<Timer> m_timers;
};

} // namespace noveltea::core
