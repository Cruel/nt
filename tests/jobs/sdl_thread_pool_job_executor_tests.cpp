#include <catch2/catch_test_macros.hpp>

#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <limits>
#include <memory>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

template<class Predicate>
bool wait_until(jobs::SdlThreadPoolJobExecutor& executor, Predicate&& predicate,
                std::chrono::milliseconds timeout = 5s)
{
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (!predicate()) {
        executor.pump(0ns);
        if (std::chrono::steady_clock::now() >= deadline)
            return false;
        std::this_thread::sleep_for(1ms);
    }
    return true;
}

void shutdown_and_drain(jobs::SdlThreadPoolJobExecutor& executor)
{
    executor.begin_shutdown();
    REQUIRE(wait_until(executor, [&] {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        return executor.shutdown_complete();
    }));
}

class ScriptedTask final : public jobs::JobTask {
public:
    ScriptedTask(std::vector<jobs::JobStepStatus> steps,
                 std::vector<jobs::JobTerminalStatus>& completions)
        : m_steps(std::move(steps)), m_completions(completions)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        const jobs::JobStepStatus status =
            m_next < m_steps.size() ? m_steps[m_next++] : jobs::JobStepStatus::Completed;
        if (status == jobs::JobStepStatus::Failed) {
            return {.status = status,
                    .diagnostics = {{.code = "jobs.threaded_test_failure",
                                     .message = "threaded scripted failure"}}};
        }
        return {.status = status};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completions.push_back(completion.status);
    }

private:
    std::vector<jobs::JobStepStatus> m_steps;
    std::vector<jobs::JobTerminalStatus>& m_completions;
    std::size_t m_next = 0;
};

class CancelAwareBlockingTask final : public jobs::JobTask {
public:
    CancelAwareBlockingTask(std::atomic<bool>& entered,
                            std::vector<jobs::JobTerminalStatus>& completions)
        : m_entered(entered), m_completions(completions)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        m_entered.store(true, std::memory_order_release);
        while (!context.cancellation_requested())
            std::this_thread::yield();
        return {.status = jobs::JobStepStatus::Completed};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completions.push_back(completion.status);
    }

private:
    std::atomic<bool>& m_entered;
    std::vector<jobs::JobTerminalStatus>& m_completions;
};

class SelfCheckingYieldTask final : public jobs::JobTask {
public:
    SelfCheckingYieldTask(std::size_t step_count, std::atomic<std::size_t>& total_steps,
                          std::atomic<std::size_t>& concurrent_entries,
                          std::atomic<std::size_t>& completed_tasks,
                          std::atomic<bool>& wrong_completion_thread, std::thread::id owner_thread)
        : m_remaining_steps(step_count), m_total_steps(total_steps),
          m_concurrent_entries(concurrent_entries), m_completed_tasks(completed_tasks),
          m_wrong_completion_thread(wrong_completion_thread), m_owner_thread(owner_thread)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        if (m_in_step.test_and_set(std::memory_order_acq_rel))
            m_concurrent_entries.fetch_add(1, std::memory_order_relaxed);

        m_total_steps.fetch_add(1, std::memory_order_relaxed);
        std::this_thread::yield();
        const std::size_t remaining = m_remaining_steps.fetch_sub(1, std::memory_order_relaxed);
        m_in_step.clear(std::memory_order_release);
        return {.status =
                    remaining == 1 ? jobs::JobStepStatus::Completed : jobs::JobStepStatus::Yielded};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        if (std::this_thread::get_id() != m_owner_thread)
            m_wrong_completion_thread.store(true, std::memory_order_relaxed);
        if (completion.status == jobs::JobTerminalStatus::Completed)
            m_completed_tasks.fetch_add(1, std::memory_order_relaxed);
    }

private:
    std::atomic<std::size_t> m_remaining_steps;
    std::atomic_flag m_in_step = ATOMIC_FLAG_INIT;
    std::atomic<std::size_t>& m_total_steps;
    std::atomic<std::size_t>& m_concurrent_entries;
    std::atomic<std::size_t>& m_completed_tasks;
    std::atomic<bool>& m_wrong_completion_thread;
    std::thread::id m_owner_thread;
};

class ReleaseGateTask final : public jobs::JobTask {
public:
    ReleaseGateTask(std::atomic<std::size_t>& entered, std::atomic<bool>& release,
                    std::vector<jobs::JobTerminalStatus>& completions)
        : m_entered(entered), m_release(release), m_completions(completions)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        m_entered.fetch_add(1, std::memory_order_release);
        while (!m_release.load(std::memory_order_acquire))
            std::this_thread::yield();
        return {.status = jobs::JobStepStatus::Completed};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completions.push_back(completion.status);
    }

private:
    std::atomic<std::size_t>& m_entered;
    std::atomic<bool>& m_release;
    std::vector<jobs::JobTerminalStatus>& m_completions;
};

std::vector<jobs::JobTerminalStatus> run_cooperative_equivalence_scenario()
{
    jobs::CooperativeJobExecutor executor;
    std::vector<jobs::JobTerminalStatus> completions;
    REQUIRE(
        executor.submit(jobs::JobPriority::Critical,
                        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Yielded,
                                                                   jobs::JobStepStatus::Completed},
                                                       completions)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Failed}, completions)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Prefetch,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Completed}, completions)));
    executor.pump(1s);
    REQUIRE(executor.dispatch_owner_completions(3) == 3);
    executor.begin_shutdown();
    REQUIRE(executor.shutdown_complete());
    return completions;
}

} // namespace

TEST_CASE("SDL worker pool matches cooperative terminal semantics")
{
    const auto cooperative = run_cooperative_equivalence_scenario();

    jobs::SdlThreadPoolJobExecutor executor(1);
    REQUIRE(executor.ready());
    CHECK(executor.mode() == jobs::JobExecutionMode::Threaded);
    CHECK(executor.worker_count() == 1);

    std::vector<jobs::JobTerminalStatus> threaded;
    REQUIRE(executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<ScriptedTask>(
            std::vector{jobs::JobStepStatus::Yielded, jobs::JobStepStatus::Completed}, threaded)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Failed}, threaded)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Prefetch,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Completed}, threaded)));

    REQUIRE(wait_until(executor, [&] {
        const auto snapshot = executor.snapshot_on_owner();
        return snapshot.critical.completions_queued + snapshot.normal.completions_queued +
                   snapshot.prefetch.completions_queued ==
               3;
    }));
    REQUIRE(executor.dispatch_owner_completions(3) == 3);
    CHECK(threaded == cooperative);
    shutdown_and_drain(executor);
}

TEST_CASE("SDL cancellation after terminal publication cannot replace completion")
{
    jobs::SdlThreadPoolJobExecutor executor(1);
    REQUIRE(executor.ready());
    std::vector<jobs::JobTerminalStatus> completions;
    auto accepted = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Completed}, completions));
    REQUIRE(accepted);
    REQUIRE(wait_until(
        executor, [&] { return executor.snapshot_on_owner().normal.completions_queued == 1; }));

    CHECK_FALSE(executor.request_cancel(accepted.value()));
    REQUIRE(executor.dispatch_owner_completions(1) == 1);
    CHECK(completions == std::vector{jobs::JobTerminalStatus::Completed});
    shutdown_and_drain(executor);
}

TEST_CASE("SDL shutdown cancels queued and running work then joins workers")
{
    jobs::SdlThreadPoolJobExecutor executor(1);
    REQUIRE(executor.ready());
    std::atomic<bool> entered = false;
    std::vector<jobs::JobTerminalStatus> completions;
    REQUIRE(executor.submit(jobs::JobPriority::Critical,
                            std::make_unique<CancelAwareBlockingTask>(entered, completions)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Completed}, completions)));
    REQUIRE(wait_until(executor, [&] { return entered.load(std::memory_order_acquire); }));

    executor.begin_shutdown();
    auto rejected = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedTask>(std::vector{jobs::JobStepStatus::Completed}, completions));
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().code == "jobs.submit_after_shutdown");
    REQUIRE(wait_until(executor, [&] {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        return executor.shutdown_complete();
    }));

    REQUIRE(completions.size() == 2);
    CHECK(completions[0] == jobs::JobTerminalStatus::Canceled);
    CHECK(completions[1] == jobs::JobTerminalStatus::Canceled);
}

TEST_CASE("SDL completion and cancellation race publishes exactly one terminal result")
{
    constexpr std::size_t task_count = 48;
    jobs::SdlThreadPoolJobExecutor executor(4);
    REQUIRE(executor.ready());
    std::atomic<std::size_t> entered = 0;
    std::atomic<bool> release = false;
    std::vector<jobs::JobTerminalStatus> completions;
    std::vector<jobs::JobId> ids;
    ids.reserve(task_count);

    for (std::size_t index = 0; index < task_count; ++index) {
        auto accepted =
            executor.submit(jobs::JobPriority::Normal,
                            std::make_unique<ReleaseGateTask>(entered, release, completions));
        REQUIRE(accepted);
        ids.push_back(accepted.value());
    }
    REQUIRE(wait_until(executor, [&] { return entered.load(std::memory_order_acquire) >= 4; }));

    release.store(true, std::memory_order_release);
    for (jobs::JobId id : ids)
        (void)executor.request_cancel(id);

    REQUIRE(wait_until(executor, [&] {
        return executor.snapshot_on_owner().normal.completions_queued == task_count;
    }));
    REQUIRE(executor.dispatch_owner_completions(task_count) == task_count);
    REQUIRE(completions.size() == task_count);
    for (jobs::JobTerminalStatus status : completions) {
        CHECK((status == jobs::JobTerminalStatus::Completed ||
               status == jobs::JobTerminalStatus::Canceled));
    }
    shutdown_and_drain(executor);
}

TEST_CASE("SDL stress never steps one task concurrently with itself")
{
    constexpr std::size_t task_count = 64;
    constexpr std::size_t steps_per_task = 40;

    jobs::SdlThreadPoolJobExecutor executor(4);
    REQUIRE(executor.ready());
    std::atomic<std::size_t> total_steps = 0;
    std::atomic<std::size_t> concurrent_entries = 0;
    std::atomic<std::size_t> completed_tasks = 0;
    std::atomic<bool> wrong_completion_thread = false;
    const std::thread::id owner_thread = std::this_thread::get_id();

    for (std::size_t index = 0; index < task_count; ++index) {
        REQUIRE(executor.submit(jobs::JobPriority::Normal,
                                std::make_unique<SelfCheckingYieldTask>(
                                    steps_per_task, total_steps, concurrent_entries,
                                    completed_tasks, wrong_completion_thread, owner_thread)));
    }

    REQUIRE(wait_until(executor, [&] {
        return executor.snapshot_on_owner().normal.completions_queued == task_count;
    }));
    REQUIRE(executor.dispatch_owner_completions(task_count) == task_count);
    CHECK(total_steps.load(std::memory_order_relaxed) == task_count * steps_per_task);
    CHECK(concurrent_entries.load(std::memory_order_relaxed) == 0);
    CHECK(completed_tasks.load(std::memory_order_relaxed) == task_count);
    CHECK_FALSE(wrong_completion_thread.load(std::memory_order_relaxed));
    shutdown_and_drain(executor);
}
