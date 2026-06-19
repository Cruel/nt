#include <catch2/catch_test_macros.hpp>

#include <noveltea/core/runtime_events.hpp>

using namespace noveltea::core;

TEST_CASE("RuntimeEventBus dispatches wildcard and typed listeners")
{
    RuntimeEventBus bus;
    int all_count = 0;
    int save_count = 0;

    const auto all_id = bus.listen([&](const RuntimeEvent& event) {
        CHECK(event.type == RuntimeEventType::GameSaving);
        ++all_count;
        return true;
    });
    const auto save_id = bus.listen(RuntimeEventType::GameSaving, [&](const RuntimeEvent& event) {
        CHECK(event.text == "slot");
        ++save_count;
        return false;
    });
    CHECK(all_id != save_id);

    const auto result = bus.trigger(RuntimeEvent {RuntimeEventType::GameSaving, 7, 0.0, "slot"});

    CHECK_FALSE(result);
    CHECK(all_count == 1);
    CHECK(save_count == 1);
}

TEST_CASE("RuntimeEventBus queues events and defers listener-queued work")
{
    RuntimeEventBus bus;
    std::vector<RuntimeEventType> seen;

    const auto listener_id = bus.listen([&](const RuntimeEvent& event) {
        seen.push_back(event.type);
        if (event.type == RuntimeEventType::Notification) {
            bus.push(RuntimeEventType::TextLogged);
        }
        return true;
    });
    CHECK(listener_id != 0);

    bus.push(RuntimeEventType::Notification);

    CHECK(bus.queued_count() == 1);
    CHECK(bus.dispatch_queued());
    CHECK(seen == std::vector<RuntimeEventType> {RuntimeEventType::Notification});
    CHECK(bus.queued_count() == 1);
    CHECK(bus.dispatch_queued());
    CHECK(seen == std::vector<RuntimeEventType> {RuntimeEventType::Notification, RuntimeEventType::TextLogged});
    CHECK(bus.empty());
}

TEST_CASE("RuntimeEventBus removes listeners by id")
{
    RuntimeEventBus bus;
    int count = 0;
    const auto id = bus.listen(RuntimeEventType::GameSaved, [&](const RuntimeEvent&) {
        ++count;
        return true;
    });

    CHECK(bus.trigger(RuntimeEventType::GameSaved));
    CHECK(bus.remove(id));
    CHECK_FALSE(bus.remove(id));
    CHECK(bus.trigger(RuntimeEventType::GameSaved));
    CHECK(count == 1);
}

TEST_CASE("RuntimeTimerScheduler fires one-shot timers and queues completion event")
{
    RuntimeTimerScheduler timers;
    RuntimeEventBus bus;
    int callback_count = 0;
    int event_count = 0;
    const auto listener_id = bus.listen(RuntimeEventType::TimerCompleted, [&](const RuntimeEvent&) {
        ++event_count;
        return true;
    });
    CHECK(listener_id != 0);

    RuntimeTimerId expected_id = 0;
    const auto timer = timers.start(0.5, [&](RuntimeTimerId id) {
        CHECK(id == expected_id);
        ++callback_count;
    });
    expected_id = timer.id;

    CHECK(timers.active(timer.id));
    CHECK_FALSE(timers.update(0.25, &bus));
    CHECK(callback_count == 0);
    CHECK(timers.update(0.25, &bus));
    CHECK(callback_count == 1);
    CHECK_FALSE(timers.active(timer.id));
    CHECK(bus.queued_count() == 1);
    CHECK(bus.dispatch_queued());
    CHECK(event_count == 1);
}

TEST_CASE("RuntimeTimerScheduler repeats timers for elapsed intervals")
{
    RuntimeTimerScheduler timers;
    int callback_count = 0;
    RuntimeTimerId expected_id = 0;
    const auto timer = timers.start_repeat(0.25, [&](RuntimeTimerId id) {
        CHECK(id == expected_id);
        ++callback_count;
    });
    expected_id = timer.id;

    CHECK(timers.update(0.8));
    CHECK(callback_count == 3);
    CHECK(timers.active(timer.id));
    CHECK(timers.active_count() == 1);
}

TEST_CASE("RuntimeTimerScheduler cancels and resets timers")
{
    RuntimeTimerScheduler timers;
    int callback_count = 0;
    const auto timer = timers.start(0.1, [&](RuntimeTimerId) {
        ++callback_count;
    });

    CHECK(timers.cancel(timer.id));
    CHECK_FALSE(timers.cancel(timer.id));
    CHECK_FALSE(timers.update(1.0));
    CHECK(callback_count == 0);
    CHECK(timers.active_count() == 0);

    const auto one = timers.start(0.1);
    const auto repeat = timers.start_repeat(0.1);
    CHECK(one.id != repeat.id);
    CHECK(timers.active_count() == 2);
    timers.reset();
    CHECK(timers.active_count() == 0);
}

TEST_CASE("RuntimeTimerScheduler defers timers created by callbacks until next update")
{
    RuntimeTimerScheduler timers;
    int callback_count = 0;

    const auto parent = timers.start(0.1, [&](RuntimeTimerId) {
        ++callback_count;
        const auto child = timers.start(0.0, [&](RuntimeTimerId) {
            ++callback_count;
        });
        CHECK(child.id != 0);
    });
    CHECK(parent.id != 0);

    CHECK(timers.update(0.1));
    CHECK(callback_count == 1);
    CHECK(timers.active_count() == 1);
    CHECK(timers.update(0.0));
    CHECK(callback_count == 2);
    CHECK(timers.active_count() == 0);
}
