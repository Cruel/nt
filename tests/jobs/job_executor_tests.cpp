#include <catch2/catch_test_macros.hpp>

#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

class FakeJobClock final : public jobs::JobClock {
public:
    [[nodiscard]] TimePoint now() const noexcept override { return m_now; }

    void advance(std::chrono::nanoseconds elapsed) noexcept { m_now += elapsed; }

private:
    TimePoint m_now{};
};

struct DeliveredCompletion {
    std::string name;
    jobs::JobTerminalStatus status = jobs::JobTerminalStatus::Canceled;
    core::Diagnostics diagnostics;
};

struct JobObservation {
    std::vector<std::thread::id> step_threads;
    std::vector<bool> budget_expired;
    std::thread::id completion_thread{};
};

class ScriptedJob final : public jobs::JobTask {
public:
    ScriptedJob(std::string name, std::vector<jobs::JobStepStatus> steps,
                std::vector<std::string>& step_order, std::vector<DeliveredCompletion>& completions,
                FakeJobClock* clock = nullptr, std::chrono::nanoseconds step_duration = {},
                std::shared_ptr<JobObservation> observation = {})
        : m_name(std::move(name)), m_steps(std::move(steps)), m_step_order(step_order),
          m_completions(completions), m_clock(clock), m_step_duration(step_duration),
          m_observation(observation ? std::move(observation) : std::make_shared<JobObservation>())
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        m_step_order.push_back(m_name);
        m_observation->step_threads.push_back(std::this_thread::get_id());
        if (m_clock)
            m_clock->advance(m_step_duration);
        m_observation->budget_expired.push_back(context.cooperative_budget_expired());

        const auto status =
            m_next_step < m_steps.size() ? m_steps[m_next_step++] : jobs::JobStepStatus::Completed;
        if (status == jobs::JobStepStatus::Failed) {
            return {.status = status,
                    .diagnostics = {{.code = "jobs.test_failure", .message = "scripted failure"}}};
        }
        return {.status = status};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_observation->completion_thread = std::this_thread::get_id();
        m_completions.push_back({.name = m_name,
                                 .status = completion.status,
                                 .diagnostics = std::move(completion.diagnostics)});
    }

private:
    std::string m_name;
    std::vector<jobs::JobStepStatus> m_steps;
    std::vector<std::string>& m_step_order;
    std::vector<DeliveredCompletion>& m_completions;
    FakeJobClock* m_clock = nullptr;
    std::chrono::nanoseconds m_step_duration{};
    std::shared_ptr<JobObservation> m_observation;
    std::size_t m_next_step = 0;
};

class ProgressJob final : public jobs::JobTask {
public:
    explicit ProgressJob(std::optional<jobs::JobCompletion>& completion) : m_completion(completion)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        if (m_step == 0) {
            context.report_progress({.completed_units = 3, .total_units = 10});
            ++m_step;
            return {.status = jobs::JobStepStatus::Yielded};
        }
        context.report_progress({.completed_units = 2, .total_units = 10});
        context.report_progress({.completed_units = 5, .total_units = 10});
        return {.status = jobs::JobStepStatus::Completed};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completion = std::move(completion);
    }

private:
    std::optional<jobs::JobCompletion>& m_completion;
    std::size_t m_step = 0;
};

class InvalidOutcomeJob final : public jobs::JobTask {
public:
    explicit InvalidOutcomeJob(std::optional<jobs::JobCompletion>& completion)
        : m_completion(completion)
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        return {.status = jobs::JobStepStatus::Completed,
                .diagnostics = {{.code = "jobs.unexpected", .message = "not legal on completion"}}};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completion = std::move(completion);
    }

private:
    std::optional<jobs::JobCompletion>& m_completion;
};

class ExecutorShutdownGuard final {
public:
    explicit ExecutorShutdownGuard(jobs::JobExecutor& executor) : m_executor(executor) {}

    ~ExecutorShutdownGuard()
    {
        m_executor.begin_shutdown();
        (void)m_executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    }

private:
    jobs::JobExecutor& m_executor;
};

struct PriorityScenarioResult {
    std::vector<std::string> step_order;
    std::vector<std::string> completion_order;
    std::vector<jobs::JobTerminalStatus> terminal_states;
};

struct LifecycleScenarioResult {
    std::vector<jobs::JobTerminalStatus> terminal_states;
    jobs::JobPrioritySnapshot critical;
    jobs::JobPrioritySnapshot normal;
    jobs::JobPrioritySnapshot prefetch;
    bool rejected_after_shutdown = false;
    bool shutdown_complete = false;
};

bool same_snapshot(const jobs::JobPrioritySnapshot& left,
                   const jobs::JobPrioritySnapshot& right) noexcept
{
    return left.queued == right.queued && left.running_steps == right.running_steps &&
           left.completions_queued == right.completions_queued &&
           left.submitted_total == right.submitted_total &&
           left.completed_total == right.completed_total &&
           left.failed_total == right.failed_total && left.canceled_total == right.canceled_total &&
           left.maximum_queue_latency == right.maximum_queue_latency;
}

template<class Executor, class Advance>
PriorityScenarioResult run_priority_scenario(Executor& executor, Advance&& advance,
                                             FakeJobClock* clock = nullptr,
                                             std::chrono::nanoseconds step_duration = {})
{
    PriorityScenarioResult result;
    std::vector<DeliveredCompletion> completions;
    auto submit = [&](jobs::JobPriority priority, std::string name,
                      std::vector<jobs::JobStepStatus> steps) {
        auto accepted = executor.submit(
            priority,
            std::make_unique<ScriptedJob>(std::move(name), std::move(steps), result.step_order,
                                          completions, clock, step_duration));
        REQUIRE(accepted);
    };

    submit(jobs::JobPriority::Prefetch, "prefetch-a",
           {jobs::JobStepStatus::Yielded, jobs::JobStepStatus::Completed});
    submit(jobs::JobPriority::Prefetch, "prefetch-b",
           {jobs::JobStepStatus::Yielded, jobs::JobStepStatus::Completed});
    submit(jobs::JobPriority::Normal, "normal", {jobs::JobStepStatus::Completed});
    submit(jobs::JobPriority::Critical, "critical", {jobs::JobStepStatus::Completed});

    advance();
    REQUIRE(executor.dispatch_owner_completions(8) == 4);
    for (const auto& completion : completions) {
        result.completion_order.push_back(completion.name);
        result.terminal_states.push_back(completion.status);
    }
    return result;
}

template<class Executor, class Advance>
LifecycleScenarioResult run_lifecycle_scenario(Executor& executor, Advance&& advance,
                                               FakeJobClock* clock = nullptr,
                                               std::chrono::nanoseconds step_duration = {})
{
    std::vector<std::string> step_order;
    std::vector<DeliveredCompletion> completions;

    auto canceled = executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<ScriptedJob>("canceled", std::vector{jobs::JobStepStatus::Completed},
                                      step_order, completions, clock, step_duration));
    REQUIRE(canceled);
    REQUIRE(executor.request_cancel(canceled.value()));

    REQUIRE(executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>(
            "completed", std::vector{jobs::JobStepStatus::Yielded, jobs::JobStepStatus::Completed},
            step_order, completions, clock, step_duration)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Prefetch,
        std::make_unique<ScriptedJob>("failed", std::vector{jobs::JobStepStatus::Failed},
                                      step_order, completions, clock, step_duration)));

    advance();
    const auto before_dispatch = executor.snapshot_on_owner();
    executor.begin_shutdown();
    auto rejected = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>("rejected", std::vector{jobs::JobStepStatus::Completed},
                                      step_order, completions, clock, step_duration));
    REQUIRE_FALSE(rejected);
    REQUIRE(executor.dispatch_owner_completions(3) == 3);

    LifecycleScenarioResult result{
        .terminal_states = {},
        .critical = before_dispatch.critical,
        .normal = before_dispatch.normal,
        .prefetch = before_dispatch.prefetch,
        .rejected_after_shutdown = rejected.error().code == "jobs.submit_after_shutdown",
        .shutdown_complete = executor.shutdown_complete(),
    };
    for (const auto& completion : completions)
        result.terminal_states.push_back(completion.status);
    return result;
}

} // namespace

TEST_CASE("Inline and cooperative submit only queue work")
{
    using namespace noveltea;

    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;

    SECTION("inline")
    {
        jobs::InlineJobExecutor executor;
        ExecutorShutdownGuard shutdown(executor);
        auto accepted = executor.submit(
            jobs::JobPriority::Normal,
            std::make_unique<ScriptedJob>("inline", std::vector{jobs::JobStepStatus::Completed},
                                          steps, completions));
        REQUIRE(accepted);
        CHECK(steps.empty());
        CHECK(completions.empty());
        CHECK(executor.snapshot_on_owner().normal.queued == 1);
    }

    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        ExecutorShutdownGuard shutdown(executor);
        auto accepted = executor.submit(
            jobs::JobPriority::Normal,
            std::make_unique<ScriptedJob>(
                "cooperative", std::vector{jobs::JobStepStatus::Completed}, steps, completions));
        REQUIRE(accepted);
        CHECK(steps.empty());
        CHECK(completions.empty());
        executor.pump(0ns);
        CHECK(steps.empty());
    }
}

TEST_CASE("Inline and cooperative share strict priority and FIFO yield semantics")
{
    using namespace noveltea;

    jobs::InlineJobExecutor inline_executor;
    ExecutorShutdownGuard inline_shutdown(inline_executor);
    auto inline_result = run_priority_scenario(inline_executor, [&] {
        for (int step = 0; step < 6; ++step)
            REQUIRE(inline_executor.advance_one_step());
    });

    FakeJobClock clock;
    jobs::CooperativeJobExecutor cooperative_executor(clock);
    ExecutorShutdownGuard cooperative_shutdown(cooperative_executor);
    auto cooperative_result = run_priority_scenario(
        cooperative_executor, [&] { cooperative_executor.pump(10ns); }, &clock, 1ns);

    const std::vector<std::string> expected_steps{"critical",   "normal",     "prefetch-a",
                                                  "prefetch-b", "prefetch-a", "prefetch-b"};
    const std::vector<std::string> expected_completions{"critical", "normal", "prefetch-a",
                                                        "prefetch-b"};
    CHECK(inline_result.step_order == expected_steps);
    CHECK(cooperative_result.step_order == expected_steps);
    CHECK(inline_result.completion_order == expected_completions);
    CHECK(cooperative_result.completion_order == expected_completions);
    CHECK(inline_result.terminal_states == cooperative_result.terminal_states);
}

TEST_CASE("Inline and cooperative share terminal, snapshot, and shutdown semantics")
{
    using namespace noveltea;

    FakeJobClock inline_clock;
    jobs::InlineJobExecutor inline_executor(inline_clock);
    const auto inline_result = run_lifecycle_scenario(
        inline_executor,
        [&] {
            for (int step = 0; step < 3; ++step)
                REQUIRE(inline_executor.advance_one_step());
        },
        &inline_clock, 1ns);

    FakeJobClock clock;
    jobs::CooperativeJobExecutor cooperative_executor(clock);
    const auto cooperative_result = run_lifecycle_scenario(
        cooperative_executor, [&] { cooperative_executor.pump(10ns); }, &clock, 1ns);

    const std::vector<jobs::JobTerminalStatus> expected{
        jobs::JobTerminalStatus::Canceled,
        jobs::JobTerminalStatus::Completed,
        jobs::JobTerminalStatus::Failed,
    };
    CHECK(inline_result.terminal_states == expected);
    CHECK(cooperative_result.terminal_states == expected);
    CHECK(same_snapshot(inline_result.critical, cooperative_result.critical));
    CHECK(same_snapshot(inline_result.normal, cooperative_result.normal));
    CHECK(same_snapshot(inline_result.prefetch, cooperative_result.prefetch));
    CHECK(inline_result.rejected_after_shutdown);
    CHECK(cooperative_result.rejected_after_shutdown);
    CHECK(inline_result.shutdown_complete);
    CHECK(cooperative_result.shutdown_complete);
}

TEST_CASE("Cooperative pump obeys a fake monotonic deadline")
{
    using namespace noveltea;

    FakeJobClock clock;
    jobs::CooperativeJobExecutor executor(clock);
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    std::vector<std::shared_ptr<JobObservation>> observations;

    for (int index = 0; index < 4; ++index) {
        auto observation = std::make_shared<JobObservation>();
        auto task = std::make_unique<ScriptedJob>("job-" + std::to_string(index),
                                                  std::vector{jobs::JobStepStatus::Completed},
                                                  steps, completions, &clock, 1ms, observation);
        observations.push_back(std::move(observation));
        REQUIRE(executor.submit(jobs::JobPriority::Normal, std::move(task)));
    }

    executor.pump(3ms);
    CHECK(steps.size() == 3);
    CHECK(observations[0]->budget_expired == std::vector<bool>{false});
    CHECK(observations[1]->budget_expired == std::vector<bool>{false});
    CHECK(observations[2]->budget_expired == std::vector<bool>{true});
    CHECK(executor.snapshot_on_owner().normal.queued == 1);
    CHECK(executor.snapshot_on_owner().normal.completions_queued == 3);
    CHECK(completions.empty());

    executor.pump(0ns);
    CHECK(steps.size() == 3);
    executor.pump(1ms);
    CHECK(steps.size() == 4);
    CHECK(executor.dispatch_owner_completions(4) == 4);
}

TEST_CASE("Progress is monotonic and remains observable until owner dispatch")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::optional<jobs::JobCompletion> completion;
    auto accepted =
        executor.submit(jobs::JobPriority::Normal, std::make_unique<ProgressJob>(completion));
    REQUIRE(accepted);

    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.progress(accepted.value()));
    CHECK(executor.progress(accepted.value())->completed_units == 3);
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.progress(accepted.value()));
    CHECK(executor.progress(accepted.value())->completed_units == 5);
    CHECK_FALSE(completion);
    REQUIRE(executor.dispatch_one_completion());
    REQUIRE(completion);
    CHECK(completion->status == jobs::JobTerminalStatus::Completed);
    CHECK_FALSE(executor.progress(accepted.value()));
}

TEST_CASE("Cancellation covers queued, yielded, and completion-queued jobs")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;

    auto before_start = executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<ScriptedJob>("before-start", std::vector{jobs::JobStepStatus::Completed},
                                      steps, completions));
    REQUIRE(before_start);
    CHECK(executor.request_cancel(before_start.value()));
    CHECK_FALSE(executor.request_cancel(before_start.value()));
    CHECK(steps.empty());

    auto yielded = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>(
            "yielded", std::vector{jobs::JobStepStatus::Yielded, jobs::JobStepStatus::Completed},
            steps, completions));
    REQUIRE(yielded);
    REQUIRE(executor.advance_one_step());
    CHECK(executor.request_cancel(yielded.value()));

    auto finished = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>("finished", std::vector{jobs::JobStepStatus::Completed},
                                      steps, completions));
    REQUIRE(finished);
    REQUIRE(executor.advance_one_step());
    CHECK_FALSE(executor.request_cancel(finished.value()));

    CHECK(executor.dispatch_owner_completions(3) == 3);
    REQUIRE(completions.size() == 3);
    CHECK(completions[0].status == jobs::JobTerminalStatus::Canceled);
    CHECK(completions[1].status == jobs::JobTerminalStatus::Canceled);
    CHECK(completions[2].status == jobs::JobTerminalStatus::Completed);
}

TEST_CASE("Failure and invalid step outcomes queue stable failed completions")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    std::optional<jobs::JobCompletion> invalid_completion;

    REQUIRE(executor.submit(jobs::JobPriority::Normal,
                            std::make_unique<ScriptedJob>("failed",
                                                          std::vector{jobs::JobStepStatus::Failed},
                                                          steps, completions)));
    REQUIRE(executor.submit(jobs::JobPriority::Normal,
                            std::make_unique<InvalidOutcomeJob>(invalid_completion)));
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.advance_one_step());
    CHECK(executor.dispatch_owner_completions(2) == 2);

    REQUIRE(completions.size() == 1);
    CHECK(completions[0].status == jobs::JobTerminalStatus::Failed);
    REQUIRE(completions[0].diagnostics.size() == 1);
    CHECK(completions[0].diagnostics[0].code == "jobs.test_failure");
    REQUIRE(invalid_completion);
    CHECK(invalid_completion->status == jobs::JobTerminalStatus::Failed);
    REQUIRE(invalid_completion->diagnostics.size() == 1);
    CHECK(invalid_completion->diagnostics[0].code == "jobs.invalid_step_outcome");
}

TEST_CASE("Shutdown cancels queued work and rejects follow-up submission")
{
    using namespace noveltea;

    jobs::CooperativeJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    REQUIRE(executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<ScriptedJob>("critical", std::vector{jobs::JobStepStatus::Completed},
                                      steps, completions)));
    REQUIRE(executor.submit(
        jobs::JobPriority::Prefetch,
        std::make_unique<ScriptedJob>("prefetch", std::vector{jobs::JobStepStatus::Completed},
                                      steps, completions)));

    executor.begin_shutdown();
    auto rejected = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>("rejected", std::vector{jobs::JobStepStatus::Completed},
                                      steps, completions));
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().code == "jobs.submit_after_shutdown");
    CHECK(steps.empty());
    CHECK_FALSE(executor.shutdown_complete());
    CHECK(executor.dispatch_owner_completions(2) == 2);
    CHECK(executor.shutdown_complete());
    REQUIRE(completions.size() == 2);
    CHECK(completions[0].status == jobs::JobTerminalStatus::Canceled);
    CHECK(completions[1].status == jobs::JobTerminalStatus::Canceled);
}

TEST_CASE("Inline deterministic drain honors its finite step guard")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    REQUIRE(
        executor.submit(jobs::JobPriority::Normal,
                        std::make_unique<ScriptedJob>("guarded",
                                                      std::vector{jobs::JobStepStatus::Yielded,
                                                                  jobs::JobStepStatus::Yielded,
                                                                  jobs::JobStepStatus::Completed},
                                                      steps, completions)));

    CHECK_FALSE(executor.run_until_idle(2));
    CHECK(steps.size() == 2);
    CHECK(completions.empty());
    CHECK(executor.run_until_idle(1));
    CHECK(steps.size() == 3);
    REQUIRE(completions.size() == 1);
    CHECK(completions[0].status == jobs::JobTerminalStatus::Completed);
}

TEST_CASE("Completion submission remains queued and dispatch does not recurse")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    std::size_t recursive_dispatch = 99;
    bool follow_up_submitted = false;

    class CompletingJob final : public jobs::JobTask {
    public:
        explicit CompletingJob(std::function<void()> completion)
            : m_completion(std::move(completion))
        {
        }
        [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
        {
            return {.status = jobs::JobStepStatus::Completed};
        }
        void complete_on_owner(jobs::JobCompletion) noexcept override { m_completion(); }

    private:
        std::function<void()> m_completion;
    };

    REQUIRE(executor.submit(jobs::JobPriority::Critical, std::make_unique<CompletingJob>([&] {
                                recursive_dispatch = executor.dispatch_owner_completions(8);
                                auto follow_up = executor.submit(
                                    jobs::JobPriority::Normal,
                                    std::make_unique<ScriptedJob>(
                                        "follow-up", std::vector{jobs::JobStepStatus::Completed},
                                        steps, completions));
                                follow_up_submitted = static_cast<bool>(follow_up);
                            })));
    REQUIRE(executor.advance_one_step());
    CHECK(executor.dispatch_one_completion());
    CHECK(recursive_dispatch == 0);
    CHECK(follow_up_submitted);
    CHECK(steps.empty());
    REQUIRE(executor.advance_one_step());
    CHECK(executor.dispatch_one_completion());
    REQUIRE(completions.size() == 1);
}

TEST_CASE("Cooperative yielded twenty-asset workload progresses over bounded native pumps")
{
    using namespace noveltea;

    FakeJobClock clock;
    jobs::CooperativeJobExecutor executor(clock);
    ExecutorShutdownGuard shutdown(executor);
    const auto owner_thread = std::this_thread::get_id();
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    std::vector<std::shared_ptr<JobObservation>> observations;

    for (int asset = 0; asset < 20; ++asset) {
        auto observation = std::make_shared<JobObservation>();
        auto task = std::make_unique<ScriptedJob>("asset-" + std::to_string(asset),
                                                  std::vector{jobs::JobStepStatus::Yielded,
                                                              jobs::JobStepStatus::Yielded,
                                                              jobs::JobStepStatus::Completed},
                                                  steps, completions, &clock, 250us, observation);
        observations.push_back(std::move(observation));
        REQUIRE(executor.submit(jobs::JobPriority::Prefetch, std::move(task)));
    }

    executor.pump(2ms);
    CHECK(steps.size() == 8);
    auto critical_observation = std::make_shared<JobObservation>();
    auto critical = std::make_unique<ScriptedJob>(
        "critical-demand", std::vector{jobs::JobStepStatus::Completed}, steps, completions, &clock,
        250us, critical_observation);
    REQUIRE(executor.submit(jobs::JobPriority::Critical, std::move(critical)));

    std::size_t pumps = 1;
    while (completions.size() < 21 && pumps < 20) {
        executor.pump(2ms);
        (void)executor.dispatch_owner_completions(64);
        ++pumps;
    }

    CHECK(pumps > 2);
    REQUIRE(steps.size() >= 9);
    CHECK(steps[8] == "critical-demand");
    REQUIRE(completions.size() == 21);
    for (const auto& completion : completions)
        CHECK(completion.status == jobs::JobTerminalStatus::Completed);
    for (const auto& observation : observations) {
        REQUIRE(observation->step_threads.size() == 3);
        for (const auto thread : observation->step_threads)
            CHECK(thread == owner_thread);
    }
    REQUIRE(critical_observation->step_threads.size() == 1);
    CHECK(critical_observation->step_threads[0] == owner_thread);
    CHECK(critical_observation->completion_thread == owner_thread);

    const auto snapshot = executor.snapshot_on_owner();
    CHECK(snapshot.critical.completed_total == 1);
    CHECK(snapshot.prefetch.completed_total == 20);
    CHECK(snapshot.prefetch.queued == 0);
    CHECK(snapshot.prefetch.completions_queued == 0);
}

TEST_CASE("Reprioritization moves queued jobs without executing work")
{
    using namespace noveltea;

    auto run = [](auto& executor, auto&& advance) {
        std::vector<std::string> steps;
        std::vector<DeliveredCompletion> completions;
        auto moved = executor.submit(
            jobs::JobPriority::Normal,
            std::make_unique<ScriptedJob>("moved", std::vector{jobs::JobStepStatus::Completed},
                                          steps, completions));
        REQUIRE(moved);
        auto existing = executor.submit(
            jobs::JobPriority::Critical,
            std::make_unique<ScriptedJob>("existing", std::vector{jobs::JobStepStatus::Completed},
                                          steps, completions));
        REQUIRE(existing);

        CHECK(executor.set_priority(moved.value(), jobs::JobPriority::Critical));
        CHECK(executor.set_priority(moved.value(), jobs::JobPriority::Critical));
        CHECK_FALSE(executor.set_priority(jobs::JobId{999999}, jobs::JobPriority::Prefetch));
        CHECK(steps.empty());
        CHECK(completions.empty());
        const auto reprioritized = executor.snapshot_on_owner();
        CHECK(reprioritized.normal.queued == 0);
        CHECK(reprioritized.critical.queued == 2);
        CHECK(reprioritized.critical.completions_queued == 0);

        advance();
        CHECK(steps == std::vector<std::string>{"existing", "moved"});
        CHECK(completions.empty());
        CHECK_FALSE(executor.set_priority(moved.value(), jobs::JobPriority::Prefetch));
        REQUIRE(executor.dispatch_owner_completions(2) == 2);
    };

    SECTION("inline")
    {
        jobs::InlineJobExecutor executor;
        ExecutorShutdownGuard shutdown(executor);
        run(executor, [&] {
            REQUIRE(executor.advance_one_step());
            REQUIRE(executor.advance_one_step());
        });
    }

    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        ExecutorShutdownGuard shutdown(executor);
        run(executor, [&] { executor.pump(1s); });
    }
}

TEST_CASE("A running inline job adopts its new priority when it yields")
{
    using namespace noveltea;

    jobs::InlineJobExecutor executor;
    ExecutorShutdownGuard shutdown(executor);
    std::vector<std::string> steps;
    std::vector<DeliveredCompletion> completions;
    jobs::JobId moving_id;

    class ReprioritizingJob final : public jobs::JobTask {
    public:
        ReprioritizingJob(jobs::InlineJobExecutor& executor, jobs::JobId& id,
                          std::vector<std::string>& steps,
                          std::vector<DeliveredCompletion>& completions)
            : m_executor(executor), m_id(id), m_steps(steps), m_completions(completions)
        {
        }

        [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
        {
            if (!m_yielded) {
                m_steps.push_back("moving-first");
                m_reprioritized = m_executor.set_priority(m_id, jobs::JobPriority::Prefetch);
                m_yielded = true;
                return {.status = jobs::JobStepStatus::Yielded};
            }
            m_steps.push_back("moving-second");
            return {.status = jobs::JobStepStatus::Completed};
        }

        void complete_on_owner(jobs::JobCompletion completion) noexcept override
        {
            m_completions.push_back({.name = "moving",
                                     .status = completion.status,
                                     .diagnostics = std::move(completion.diagnostics)});
        }

        [[nodiscard]] bool reprioritized() const noexcept { return m_reprioritized; }

    private:
        jobs::InlineJobExecutor& m_executor;
        jobs::JobId& m_id;
        std::vector<std::string>& m_steps;
        std::vector<DeliveredCompletion>& m_completions;
        bool m_yielded = false;
        bool m_reprioritized = false;
    };

    auto moving = std::make_unique<ReprioritizingJob>(executor, moving_id, steps, completions);
    auto* moving_observer = moving.get();
    auto accepted = executor.submit(jobs::JobPriority::Normal, std::move(moving));
    REQUIRE(accepted);
    moving_id = accepted.value();
    REQUIRE(executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<ScriptedJob>("normal", std::vector{jobs::JobStepStatus::Completed}, steps,
                                      completions)));

    REQUIRE(executor.advance_one_step());
    CHECK(moving_observer->reprioritized());
    const auto yielded = executor.snapshot_on_owner();
    CHECK(yielded.normal.queued == 1);
    CHECK(yielded.prefetch.queued == 1);
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.advance_one_step());
    CHECK(steps == std::vector<std::string>{"moving-first", "normal", "moving-second"});
    REQUIRE(executor.dispatch_owner_completions(2) == 2);
}
