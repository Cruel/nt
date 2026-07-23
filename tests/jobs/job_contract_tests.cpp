#include <catch2/catch_test_macros.hpp>

#include "noveltea/jobs/job_completion_queue.hpp"
#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;

class RecordingJob final : public jobs::JobTask {
public:
    RecordingJob(int& step_calls, std::function<void(jobs::JobCompletion)> completion)
        : m_step_calls(step_calls), m_completion(std::move(completion))
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        ++m_step_calls;
        return {.status = jobs::JobStepStatus::Completed};
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_completion(std::move(completion));
    }

private:
    int& m_step_calls;
    std::function<void(jobs::JobCompletion)> m_completion;
};

class ContractFakeExecutor final : public jobs::JobExecutor {
public:
    [[nodiscard]] jobs::JobExecutionMode mode() const noexcept override
    {
        return jobs::JobExecutionMode::InlineTest;
    }

    [[nodiscard]] core::Result<jobs::JobId, core::Diagnostic>
    submit(jobs::JobPriority priority, std::unique_ptr<jobs::JobTask> task) noexcept override
    {
        m_owner_thread.assert_owner_thread();
        if (m_shutting_down) {
            return core::Result<jobs::JobId, core::Diagnostic>::failure(
                {.code = "jobs.submit_after_shutdown", .message = "executor is shutting down"});
        }
        if (task == nullptr) {
            return core::Result<jobs::JobId, core::Diagnostic>::failure(
                {.code = "jobs.null_task", .message = "task is required"});
        }

        const jobs::JobId id{m_next_id++};
        m_pending.push_back(Pending{.id = id, .priority = priority, .task = std::move(task)});
        ++m_submitted;
        return core::Result<jobs::JobId, core::Diagnostic>::success(id);
    }

    [[nodiscard]] bool request_cancel(jobs::JobId id) noexcept override
    {
        m_owner_thread.assert_owner_thread();
        const auto found = find(id);
        if (found == m_pending.end() || found->terminal_queued || found->cancellation_requested)
            return false;
        found->cancellation_requested = true;
        return true;
    }

    [[nodiscard]] std::optional<jobs::JobProgress> progress(jobs::JobId id) const noexcept override
    {
        m_owner_thread.assert_owner_thread();
        const auto found = std::find_if(m_pending.begin(), m_pending.end(),
                                        [id](const Pending& pending) { return pending.id == id; });
        return found == m_pending.end() ? std::nullopt : found->progress;
    }

    [[nodiscard]] jobs::JobExecutorSnapshot snapshot_on_owner() const override
    {
        m_owner_thread.assert_owner_thread();
        jobs::JobExecutorSnapshot snapshot;
        snapshot.mode = mode();
        snapshot.critical.queued = count(jobs::JobPriority::Critical);
        snapshot.normal.queued = count(jobs::JobPriority::Normal);
        snapshot.prefetch.queued = count(jobs::JobPriority::Prefetch);
        snapshot.critical.submitted_total = m_submitted;
        snapshot.critical.completions_queued = m_completions.queued_count_on_owner();
        return snapshot;
    }

    void pump(std::chrono::nanoseconds) noexcept override { m_owner_thread.assert_owner_thread(); }

    std::size_t dispatch_owner_completions(std::size_t maximum) noexcept override
    {
        m_owner_thread.assert_owner_thread();
        return m_completions.dispatch_on_owner(maximum);
    }

    void begin_shutdown() noexcept override
    {
        m_owner_thread.assert_owner_thread();
        m_shutting_down = true;
    }

    [[nodiscard]] bool shutdown_complete() const noexcept override
    {
        m_owner_thread.assert_owner_thread();
        return m_shutting_down && m_pending.empty() && m_completions.empty_on_owner();
    }

    void queue_terminal(jobs::JobId id, jobs::JobTerminalStatus status,
                        core::Diagnostics diagnostics = {})
    {
        m_owner_thread.assert_owner_thread();
        const auto found = find(id);
        REQUIRE(found != m_pending.end());
        found->terminal_queued = true;
        auto task = std::move(found->task);
        m_pending.erase(found);
        m_completions.enqueue(
            std::move(task),
            jobs::JobCompletion{.id = id, .status = status, .diagnostics = std::move(diagnostics)});
    }

    [[nodiscard]] std::uint64_t submitted_count() const noexcept { return m_submitted; }

private:
    struct Pending {
        jobs::JobId id;
        jobs::JobPriority priority = jobs::JobPriority::Normal;
        std::unique_ptr<jobs::JobTask> task;
        std::optional<jobs::JobProgress> progress;
        bool cancellation_requested = false;
        bool terminal_queued = false;
    };

    using PendingIterator = std::vector<Pending>::iterator;

    [[nodiscard]] PendingIterator find(jobs::JobId id)
    {
        return std::find_if(m_pending.begin(), m_pending.end(),
                            [id](const Pending& pending) { return pending.id == id; });
    }

    [[nodiscard]] std::uint64_t count(jobs::JobPriority priority) const noexcept
    {
        return static_cast<std::uint64_t>(
            std::count_if(m_pending.begin(), m_pending.end(), [priority](const Pending& pending) {
                return pending.priority == priority;
            }));
    }

    jobs::OwnerThreadGuard m_owner_thread;
    jobs::JobCompletionQueue m_completions;
    std::vector<Pending> m_pending;
    std::uint64_t m_next_id = 1;
    std::uint64_t m_submitted = 0;
    bool m_shutting_down = false;
};

} // namespace

TEST_CASE("Job contract IDs and terminal diagnostics preserve the normative states")
{
    using namespace noveltea;

    CHECK_FALSE(jobs::JobId{}.valid());
    CHECK(jobs::JobId{1}.valid());

    CHECK(jobs::JobStepOutcome{.status = jobs::JobStepStatus::Yielded}.contract_valid());
    CHECK(jobs::JobStepOutcome{.status = jobs::JobStepStatus::Completed}.contract_valid());
    CHECK_FALSE(jobs::JobStepOutcome{.status = jobs::JobStepStatus::Failed}.contract_valid());
    CHECK(jobs::JobStepOutcome{
        .status = jobs::JobStepStatus::Failed,
        .diagnostics = {{.code = "jobs.fake_failure", .message = "fake failure"}},
    }
              .contract_valid());

    CHECK(jobs::JobCompletion{.id = jobs::JobId{4}, .status = jobs::JobTerminalStatus::Canceled}
              .contract_valid());
    CHECK_FALSE(jobs::JobCompletion{.id = jobs::JobId{4}, .status = jobs::JobTerminalStatus::Failed}
                    .contract_valid());
}

TEST_CASE("Executor-owned completions never execute from submit or recurse during dispatch")
{
    using namespace noveltea;

    ContractFakeExecutor executor;
    int step_calls = 0;
    int callback_depth = 0;
    int maximum_callback_depth = 0;
    std::size_t recursive_dispatch_count = 99;
    std::vector<jobs::JobId> completed;
    jobs::JobId follow_up_id;

    auto first = executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<RecordingJob>(step_calls, [&](jobs::JobCompletion completion) {
            ++callback_depth;
            maximum_callback_depth = std::max(maximum_callback_depth, callback_depth);
            completed.push_back(completion.id);
            recursive_dispatch_count = executor.dispatch_owner_completions(8);
            auto follow_up = executor.submit(
                jobs::JobPriority::Normal,
                std::make_unique<RecordingJob>(step_calls, [&](jobs::JobCompletion nested) {
                    ++callback_depth;
                    maximum_callback_depth = std::max(maximum_callback_depth, callback_depth);
                    completed.push_back(nested.id);
                    --callback_depth;
                }));
            REQUIRE(follow_up);
            follow_up_id = follow_up.value();
            --callback_depth;
        }));
    REQUIRE(first);

    auto second = executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<RecordingJob>(step_calls, [&](jobs::JobCompletion completion) {
            ++callback_depth;
            maximum_callback_depth = std::max(maximum_callback_depth, callback_depth);
            completed.push_back(completion.id);
            --callback_depth;
        }));
    REQUIRE(second);

    CHECK(step_calls == 0);
    CHECK(completed.empty());
    CHECK(executor.submitted_count() == 2);

    executor.queue_terminal(first.value(), jobs::JobTerminalStatus::Completed);
    executor.queue_terminal(second.value(), jobs::JobTerminalStatus::Canceled);

    CHECK(executor.dispatch_owner_completions(2) == 2);
    CHECK(recursive_dispatch_count == 0);
    CHECK(maximum_callback_depth == 1);
    CHECK(step_calls == 0);
    REQUIRE(completed.size() == 2);
    CHECK(completed[0] == first.value());
    CHECK(completed[1] == second.value());
    CHECK(executor.submitted_count() == 3);

    executor.queue_terminal(follow_up_id, jobs::JobTerminalStatus::Completed);
    CHECK(executor.dispatch_owner_completions(1) == 1);
    CHECK(maximum_callback_depth == 1);
}

TEST_CASE("Completion dispatch honors the owner-provided limit and terminal FIFO")
{
    using namespace noveltea;

    ContractFakeExecutor executor;
    int step_calls = 0;
    std::vector<std::uint64_t> completed;

    for (std::uint64_t index = 0; index < 3; ++index) {
        auto submitted = executor.submit(
            jobs::JobPriority::Prefetch,
            std::make_unique<RecordingJob>(step_calls, [&](jobs::JobCompletion completion) {
                completed.push_back(completion.id.value);
            }));
        REQUIRE(submitted);
        executor.queue_terminal(submitted.value(), jobs::JobTerminalStatus::Completed);
    }

    CHECK(executor.dispatch_owner_completions(2) == 2);
    CHECK(completed == std::vector<std::uint64_t>{1, 2});
    CHECK(executor.snapshot_on_owner().critical.completions_queued == 1);
    CHECK(executor.dispatch_owner_completions(2) == 1);
    CHECK(completed == std::vector<std::uint64_t>{1, 2, 3});
}

TEST_CASE("Job cancellation is explicit and terminal publication remains queued")
{
    using namespace noveltea;

    ContractFakeExecutor executor;
    int step_calls = 0;
    std::optional<jobs::JobCompletion> completion;
    auto submitted = executor.submit(
        jobs::JobPriority::Normal,
        std::make_unique<RecordingJob>(
            step_calls, [&](jobs::JobCompletion delivered) { completion = std::move(delivered); }));
    REQUIRE(submitted);

    CHECK(executor.request_cancel(submitted.value()));
    CHECK_FALSE(executor.request_cancel(submitted.value()));
    CHECK_FALSE(completion);
    CHECK(step_calls == 0);

    executor.queue_terminal(submitted.value(), jobs::JobTerminalStatus::Canceled);
    CHECK_FALSE(completion);
    CHECK(executor.dispatch_owner_completions(1) == 1);
    REQUIRE(completion);
    CHECK(completion->status == jobs::JobTerminalStatus::Canceled);
    CHECK(completion->diagnostics.empty());
}

TEST_CASE("Owner-thread guards identify the constructing thread")
{
    using namespace noveltea;

    jobs::OwnerThreadGuard guard;
    CHECK(guard.is_owner_thread());

    bool worker_observed_owner = true;
    std::thread observer([&] { worker_observed_owner = guard.is_owner_thread(); });
    observer.join();
    CHECK_FALSE(worker_observed_owner);
}

TEST_CASE("Shutdown rejects new submissions and preserves queued terminal delivery")
{
    using namespace noveltea;

    ContractFakeExecutor executor;
    int step_calls = 0;
    std::optional<jobs::JobCompletion> completion;
    auto accepted = executor.submit(
        jobs::JobPriority::Critical,
        std::make_unique<RecordingJob>(
            step_calls, [&](jobs::JobCompletion delivered) { completion = std::move(delivered); }));
    REQUIRE(accepted);

    executor.begin_shutdown();
    auto rejected =
        executor.submit(jobs::JobPriority::Normal,
                        std::make_unique<RecordingJob>(step_calls, [](jobs::JobCompletion) {}));
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().code == "jobs.submit_after_shutdown");
    CHECK_FALSE(executor.shutdown_complete());

    executor.queue_terminal(accepted.value(), jobs::JobTerminalStatus::Canceled);
    CHECK_FALSE(executor.shutdown_complete());
    CHECK(executor.dispatch_owner_completions(1) == 1);
    REQUIRE(completion);
    CHECK(completion->status == jobs::JobTerminalStatus::Canceled);
    CHECK(executor.shutdown_complete());
}
