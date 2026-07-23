#include "jobs/scheduler_core.hpp"

#include <algorithm>
#include <atomic>
#include <cassert>
#include <limits>
#include <utility>

namespace noveltea::jobs::detail {
namespace {

std::atomic<std::uint64_t> g_next_job_id{1};

std::optional<JobId> allocate_job_id() noexcept
{
    std::uint64_t candidate = g_next_job_id.load(std::memory_order_relaxed);
    while (candidate != 0 && candidate != std::numeric_limits<std::uint64_t>::max()) {
        if (g_next_job_id.compare_exchange_weak(candidate, candidate + 1, std::memory_order_relaxed,
                                                std::memory_order_relaxed)) {
            return JobId{candidate};
        }
    }
    return std::nullopt;
}

core::Diagnostic invalid_step_outcome_diagnostic()
{
    return {.code = "jobs.invalid_step_outcome",
            .message = "Job step returned diagnostics inconsistent with its status"};
}

} // namespace

SchedulerCore::SchedulerCore(JobExecutionMode mode, JobClock& clock, SchedulerMutex* mutex) noexcept
    : m_mode(mode), m_clock(clock), m_mutex(mutex != nullptr ? mutex : &m_default_mutex)
{
    m_snapshot.mode = mode;
}

SchedulerCore::~SchedulerCore()
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    assert(m_shutting_down && "job executor must begin shutdown before destruction");
    assert(m_records.empty() &&
           "job executor tasks must complete owner dispatch before destruction");
}

core::Result<JobId, core::Diagnostic> SchedulerCore::submit(JobPriority priority,
                                                            std::unique_ptr<JobTask> task) noexcept
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    if (m_shutting_down) {
        return core::Result<JobId, core::Diagnostic>::failure(
            {.code = "jobs.submit_after_shutdown", .message = "executor is shutting down"});
    }
    if (task == nullptr) {
        return core::Result<JobId, core::Diagnostic>::failure(
            {.code = "jobs.null_task", .message = "task is required"});
    }

    const auto id = allocate_job_id();
    if (!id) {
        return core::Result<JobId, core::Diagnostic>::failure(
            {.code = "jobs.id_exhausted", .message = "process job ID space is exhausted"});
    }

    Record record{
        .id = *id,
        .priority = priority,
        .task = std::move(task),
        .progress = std::nullopt,
        .queued_at = m_clock.now(),
        .state = State::Queued,
        .cancellation_requested = false,
    };
    m_records.emplace(id->value, std::move(record));
    m_runnable[priority_index(priority)].push_back(*id);
    auto& snapshot = priority_snapshot(priority);
    ++snapshot.queued;
    ++snapshot.submitted_total;
    return core::Result<JobId, core::Diagnostic>::success(*id);
}

bool SchedulerCore::request_cancel(JobId id) noexcept
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    if (found == m_records.end() || found->second.state == State::CompletionQueued ||
        found->second.cancellation_requested) {
        return false;
    }

    auto& record = found->second;
    record.cancellation_requested = true;
    if (record.state == State::Queued) {
        remove_from_runnable_queue_locked(record);
        queue_terminal_locked(record, JobTerminalStatus::Canceled);
    }
    return true;
}

bool SchedulerCore::set_priority(JobId id, JobPriority priority) noexcept
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    if (found == m_records.end() || found->second.state == State::CompletionQueued ||
        found->second.cancellation_requested) {
        return false;
    }

    auto& record = found->second;
    if (record.priority == priority)
        return true;

    auto& old_snapshot = priority_snapshot(record.priority);
    auto& new_snapshot = priority_snapshot(priority);
    if (record.state == State::Queued) {
        auto& old_queue = m_runnable[priority_index(record.priority)];
        const auto queued = std::find(old_queue.begin(), old_queue.end(), record.id);
        assert(queued != old_queue.end());
        old_queue.erase(queued);
        assert(old_snapshot.queued > 0);
        --old_snapshot.queued;
        record.priority = priority;
        record.queued_at = m_clock.now();
        m_runnable[priority_index(priority)].push_back(record.id);
        ++new_snapshot.queued;
        return true;
    }

    assert(record.state == State::RunningStep);
    assert(old_snapshot.running_steps > 0);
    --old_snapshot.running_steps;
    ++new_snapshot.running_steps;
    record.priority = priority;
    return true;
}

std::optional<JobProgress> SchedulerCore::progress(JobId id) const noexcept
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    return found == m_records.end() ? std::nullopt : found->second.progress;
}

JobExecutorSnapshot SchedulerCore::snapshot_on_owner() const
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    return m_snapshot;
}

void SchedulerCore::pump(std::chrono::nanoseconds budget) noexcept
{
    m_owner_thread.assert_owner_thread();
    if (budget <= std::chrono::nanoseconds::zero())
        return;

    const auto started = m_clock.now();
    const auto maximum_budget = JobClock::TimePoint::max() - started;
    const auto deadline = budget >= maximum_budget ? JobClock::TimePoint::max() : started + budget;
    while (m_clock.now() < deadline) {
        if (!advance_one_step(deadline))
            break;
    }
}

bool SchedulerCore::advance_one_step() noexcept
{
    m_owner_thread.assert_owner_thread();
    return advance_one_step(std::nullopt);
}

bool SchedulerCore::advance_one_step_from_worker() noexcept
{
    return advance_one_step(std::nullopt);
}

std::size_t SchedulerCore::dispatch_owner_completions(std::size_t maximum) noexcept
{
    m_owner_thread.assert_owner_thread();
    return m_completions.dispatch_on_owner(maximum,
                                           [this](JobId id, JobTerminalStatus status) noexcept {
                                               on_completion_dispatched(id, status);
                                           });
}

void SchedulerCore::begin_shutdown() noexcept
{
    m_owner_thread.assert_owner_thread();
    std::lock_guard lock(*m_mutex);
    if (m_shutting_down)
        return;

    m_shutting_down = true;
    for (auto& [_, record] : m_records) {
        if (record.state == State::RunningStep)
            record.cancellation_requested = true;
    }

    for (auto& queue : m_runnable) {
        while (!queue.empty()) {
            const JobId id = queue.front();
            queue.pop_front();
            auto found = m_records.find(id.value);
            if (found == m_records.end() || found->second.state != State::Queued)
                continue;
            auto& record = found->second;
            record.cancellation_requested = true;
            auto& snapshot = priority_snapshot(record.priority);
            assert(snapshot.queued > 0);
            --snapshot.queued;
            queue_terminal_locked(record, JobTerminalStatus::Canceled);
        }
    }
}

bool SchedulerCore::shutdown_complete() const noexcept
{
    m_owner_thread.assert_owner_thread();
    {
        std::lock_guard lock(*m_mutex);
        if (!m_shutting_down || !m_records.empty())
            return false;
    }
    return m_completions.empty_on_owner();
}

bool SchedulerCore::idle_on_owner() const noexcept
{
    m_owner_thread.assert_owner_thread();
    {
        std::lock_guard lock(*m_mutex);
        if (!m_records.empty())
            return false;
    }
    return m_completions.empty_on_owner();
}

bool SchedulerCore::has_runnable_on_owner() const noexcept
{
    m_owner_thread.assert_owner_thread();
    return has_runnable();
}

bool SchedulerCore::has_runnable() const noexcept
{
    std::lock_guard lock(*m_mutex);
    return std::any_of(m_runnable.begin(), m_runnable.end(),
                       [](const Queue& queue) { return !queue.empty(); });
}

bool SchedulerCore::shutting_down() const noexcept
{
    std::lock_guard lock(*m_mutex);
    return m_shutting_down;
}

bool SchedulerCore::Context::cancellation_requested() const noexcept
{
    return m_scheduler.cancellation_requested(m_id);
}

bool SchedulerCore::Context::cooperative_budget_expired() const noexcept
{
    return m_deadline && m_scheduler.m_clock.now() >= *m_deadline;
}

void SchedulerCore::Context::report_progress(JobProgress progress) noexcept
{
    m_scheduler.report_progress(m_id, std::move(progress));
}

std::size_t SchedulerCore::priority_index(JobPriority priority) noexcept
{
    switch (priority) {
    case JobPriority::Critical:
        return 0;
    case JobPriority::Normal:
        return 1;
    case JobPriority::Prefetch:
        return 2;
    }
    return 1;
}

JobPrioritySnapshot& SchedulerCore::priority_snapshot(JobPriority priority) noexcept
{
    switch (priority) {
    case JobPriority::Critical:
        return m_snapshot.critical;
    case JobPriority::Normal:
        return m_snapshot.normal;
    case JobPriority::Prefetch:
        return m_snapshot.prefetch;
    }
    return m_snapshot.normal;
}

const JobPrioritySnapshot& SchedulerCore::priority_snapshot(JobPriority priority) const noexcept
{
    switch (priority) {
    case JobPriority::Critical:
        return m_snapshot.critical;
    case JobPriority::Normal:
        return m_snapshot.normal;
    case JobPriority::Prefetch:
        return m_snapshot.prefetch;
    }
    return m_snapshot.normal;
}

std::optional<JobId> SchedulerCore::pop_next_runnable_locked() noexcept
{
    for (auto& queue : m_runnable) {
        while (!queue.empty()) {
            const JobId id = queue.front();
            queue.pop_front();
            const auto found = m_records.find(id.value);
            if (found != m_records.end() && found->second.state == State::Queued)
                return id;
        }
    }
    return std::nullopt;
}

std::optional<SchedulerCore::StepClaim> SchedulerCore::claim_next_step_locked() noexcept
{
    const auto id = pop_next_runnable_locked();
    if (!id)
        return std::nullopt;

    auto found = m_records.find(id->value);
    assert(found != m_records.end());
    auto& record = found->second;
    auto& snapshot = priority_snapshot(record.priority);
    assert(snapshot.queued > 0);
    --snapshot.queued;
    ++snapshot.running_steps;

    const auto started = m_clock.now();
    if (started >= record.queued_at) {
        snapshot.maximum_queue_latency = std::max(
            snapshot.maximum_queue_latency,
            std::chrono::duration_cast<std::chrono::nanoseconds>(started - record.queued_at));
    }

    record.state = State::RunningStep;
    return StepClaim{.id = record.id, .task = record.task.get()};
}

bool SchedulerCore::advance_one_step(std::optional<JobClock::TimePoint> deadline) noexcept
{
    std::optional<StepClaim> claim;
    {
        std::lock_guard lock(*m_mutex);
        claim = claim_next_step_locked();
    }
    if (!claim)
        return false;

    Context context(*this, claim->id, deadline);
    JobStepOutcome outcome = claim->task->step(context);

    std::lock_guard lock(*m_mutex);
    finish_step_locked(claim->id, std::move(outcome));
    return true;
}

void SchedulerCore::finish_step_locked(JobId id, JobStepOutcome outcome) noexcept
{
    auto found = m_records.find(id.value);
    assert(found != m_records.end());
    auto& record = found->second;
    assert(record.state == State::RunningStep);
    auto& snapshot = priority_snapshot(record.priority);

    assert(snapshot.running_steps > 0);
    --snapshot.running_steps;
    if (record.cancellation_requested) {
        queue_terminal_locked(record, JobTerminalStatus::Canceled);
        return;
    }
    if (!outcome.contract_valid()) {
        queue_terminal_locked(record, JobTerminalStatus::Failed,
                              {invalid_step_outcome_diagnostic()});
        return;
    }

    switch (outcome.status) {
    case JobStepStatus::Yielded:
        record.state = State::Queued;
        record.queued_at = m_clock.now();
        m_runnable[priority_index(record.priority)].push_back(record.id);
        ++snapshot.queued;
        return;
    case JobStepStatus::Completed:
        queue_terminal_locked(record, JobTerminalStatus::Completed);
        return;
    case JobStepStatus::Failed:
        queue_terminal_locked(record, JobTerminalStatus::Failed, std::move(outcome.diagnostics));
        return;
    }
}

void SchedulerCore::queue_terminal_locked(Record& record, JobTerminalStatus status,
                                          core::Diagnostics diagnostics) noexcept
{
    assert(record.state != State::CompletionQueued);
    record.state = State::CompletionQueued;
    auto& snapshot = priority_snapshot(record.priority);
    ++snapshot.completions_queued;
    switch (status) {
    case JobTerminalStatus::Completed:
        ++snapshot.completed_total;
        break;
    case JobTerminalStatus::Failed:
        ++snapshot.failed_total;
        break;
    case JobTerminalStatus::Canceled:
        ++snapshot.canceled_total;
        break;
    }

    m_completions.enqueue(
        std::move(record.task),
        JobCompletion{.id = record.id, .status = status, .diagnostics = std::move(diagnostics)});
}

void SchedulerCore::remove_from_runnable_queue_locked(const Record& record) noexcept
{
    auto& queue = m_runnable[priority_index(record.priority)];
    const auto found = std::find(queue.begin(), queue.end(), record.id);
    if (found != queue.end()) {
        queue.erase(found);
        auto& snapshot = priority_snapshot(record.priority);
        assert(snapshot.queued > 0);
        --snapshot.queued;
    }
}

void SchedulerCore::on_completion_dispatched(JobId id, JobTerminalStatus) noexcept
{
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    assert(found != m_records.end());
    auto& snapshot = priority_snapshot(found->second.priority);
    assert(snapshot.completions_queued > 0);
    --snapshot.completions_queued;
    m_records.erase(found);
}

bool SchedulerCore::cancellation_requested(JobId id) const noexcept
{
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    return found != m_records.end() && found->second.cancellation_requested;
}

void SchedulerCore::report_progress(JobId id, JobProgress progress) noexcept
{
    std::lock_guard lock(*m_mutex);
    const auto found = m_records.find(id.value);
    if (found == m_records.end() || found->second.state == State::CompletionQueued)
        return;
    if (progress.total_units && *progress.total_units < progress.completed_units)
        return;
    if (found->second.progress &&
        progress.completed_units < found->second.progress->completed_units) {
        return;
    }
    found->second.progress = std::move(progress);
}

} // namespace noveltea::jobs::detail
