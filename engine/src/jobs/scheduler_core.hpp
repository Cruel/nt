#pragma once

#include "noveltea/jobs/job_clock.hpp"
#include "noveltea/jobs/job_completion_queue.hpp"
#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <unordered_map>

namespace noveltea::jobs::detail {

class SteadyJobClock final : public JobClock {
public:
    [[nodiscard]] TimePoint now() const noexcept override { return Clock::now(); }
};

class SchedulerMutex {
public:
    virtual ~SchedulerMutex() = default;

    virtual void lock() noexcept = 0;
    virtual void unlock() noexcept = 0;
};

class StandardSchedulerMutex final : public SchedulerMutex {
public:
    void lock() noexcept override { m_mutex.lock(); }
    void unlock() noexcept override { m_mutex.unlock(); }

private:
    std::mutex m_mutex;
};

class SchedulerCore final {
public:
    SchedulerCore(JobExecutionMode mode, JobClock& clock, SchedulerMutex* mutex = nullptr) noexcept;
    ~SchedulerCore();

    SchedulerCore(const SchedulerCore&) = delete;
    SchedulerCore& operator=(const SchedulerCore&) = delete;

    [[nodiscard]] JobExecutionMode mode() const noexcept { return m_mode; }
    [[nodiscard]] core::Result<JobId, core::Diagnostic>
    submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept;
    [[nodiscard]] bool request_cancel(JobId id) noexcept;
    [[nodiscard]] std::optional<JobProgress> progress(JobId id) const noexcept;
    [[nodiscard]] JobExecutorSnapshot snapshot_on_owner() const;
    void pump(std::chrono::nanoseconds budget) noexcept;
    [[nodiscard]] bool advance_one_step() noexcept;
    [[nodiscard]] bool advance_one_step_from_worker() noexcept;
    std::size_t dispatch_owner_completions(std::size_t maximum) noexcept;
    void begin_shutdown() noexcept;
    [[nodiscard]] bool shutdown_complete() const noexcept;
    [[nodiscard]] bool idle_on_owner() const noexcept;
    [[nodiscard]] bool has_runnable_on_owner() const noexcept;
    [[nodiscard]] bool has_runnable() const noexcept;
    [[nodiscard]] bool shutting_down() const noexcept;

private:
    enum class State : std::uint8_t {
        Queued,
        RunningStep,
        CompletionQueued,
    };

    struct Record {
        JobId id;
        JobPriority priority = JobPriority::Normal;
        std::unique_ptr<JobTask> task;
        std::optional<JobProgress> progress;
        JobClock::TimePoint queued_at{};
        State state = State::Queued;
        bool cancellation_requested = false;
    };

    class Context final : public JobContext {
    public:
        Context(SchedulerCore& scheduler, JobId id,
                std::optional<JobClock::TimePoint> deadline) noexcept
            : m_scheduler(scheduler), m_id(id), m_deadline(deadline)
        {
        }

        [[nodiscard]] bool cancellation_requested() const noexcept override;
        [[nodiscard]] bool cooperative_budget_expired() const noexcept override;
        void report_progress(JobProgress progress) noexcept override;

    private:
        SchedulerCore& m_scheduler;
        JobId m_id;
        std::optional<JobClock::TimePoint> m_deadline;
    };

    using Queue = std::deque<JobId>;
    using Records = std::unordered_map<std::uint64_t, Record>;

    struct StepClaim {
        JobId id;
        JobTask* task = nullptr;
    };

    [[nodiscard]] static std::size_t priority_index(JobPriority priority) noexcept;
    [[nodiscard]] JobPrioritySnapshot& priority_snapshot(JobPriority priority) noexcept;
    [[nodiscard]] const JobPrioritySnapshot& priority_snapshot(JobPriority priority) const noexcept;
    [[nodiscard]] std::optional<JobId> pop_next_runnable_locked() noexcept;
    [[nodiscard]] std::optional<StepClaim> claim_next_step_locked() noexcept;
    [[nodiscard]] bool advance_one_step(std::optional<JobClock::TimePoint> deadline) noexcept;
    void finish_step_locked(JobId id, JobStepOutcome outcome) noexcept;
    void queue_terminal_locked(Record& record, JobTerminalStatus status,
                               core::Diagnostics diagnostics = {}) noexcept;
    void remove_from_runnable_queue_locked(const Record& record) noexcept;
    void on_completion_dispatched(JobId id, JobTerminalStatus status) noexcept;
    [[nodiscard]] bool cancellation_requested(JobId id) const noexcept;
    void report_progress(JobId id, JobProgress progress) noexcept;

    OwnerThreadGuard m_owner_thread;
    JobExecutionMode m_mode;
    JobClock& m_clock;
    StandardSchedulerMutex m_default_mutex;
    SchedulerMutex* m_mutex = nullptr;
    std::array<Queue, 3> m_runnable;
    Records m_records;
    JobCompletionQueue m_completions;
    JobExecutorSnapshot m_snapshot;
    bool m_shutting_down = false;
};

} // namespace noveltea::jobs::detail
