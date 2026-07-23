#include "noveltea/jobs/inline_job_executor.hpp"

#include "jobs/scheduler_core.hpp"

#include <utility>

namespace noveltea::jobs {

struct InlineJobExecutor::Impl {
    Impl() : scheduler(JobExecutionMode::InlineTest, default_clock) {}
    explicit Impl(JobClock& clock) : scheduler(JobExecutionMode::InlineTest, clock) {}

    detail::SteadyJobClock default_clock;
    detail::SchedulerCore scheduler;
};

InlineJobExecutor::InlineJobExecutor() : m_impl(std::make_unique<Impl>()) {}

InlineJobExecutor::InlineJobExecutor(JobClock& clock) : m_impl(std::make_unique<Impl>(clock)) {}

InlineJobExecutor::~InlineJobExecutor() = default;

JobExecutionMode InlineJobExecutor::mode() const noexcept { return m_impl->scheduler.mode(); }

core::Result<JobId, core::Diagnostic>
InlineJobExecutor::submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept
{
    return m_impl->scheduler.submit(priority, std::move(task));
}

bool InlineJobExecutor::request_cancel(JobId id) noexcept
{
    return m_impl->scheduler.request_cancel(id);
}

bool InlineJobExecutor::set_priority(JobId id, JobPriority priority) noexcept
{
    return m_impl->scheduler.set_priority(id, priority);
}

std::optional<JobProgress> InlineJobExecutor::progress(JobId id) const noexcept
{
    return m_impl->scheduler.progress(id);
}

JobExecutorSnapshot InlineJobExecutor::snapshot_on_owner() const
{
    return m_impl->scheduler.snapshot_on_owner();
}

void InlineJobExecutor::pump(std::chrono::nanoseconds budget) noexcept
{
    m_impl->scheduler.pump(budget);
}

std::size_t InlineJobExecutor::dispatch_owner_completions(std::size_t maximum) noexcept
{
    return m_impl->scheduler.dispatch_owner_completions(maximum);
}

void InlineJobExecutor::begin_shutdown() noexcept { m_impl->scheduler.begin_shutdown(); }

bool InlineJobExecutor::shutdown_complete() const noexcept
{
    return m_impl->scheduler.shutdown_complete();
}

bool InlineJobExecutor::advance_one_step() noexcept { return m_impl->scheduler.advance_one_step(); }

bool InlineJobExecutor::dispatch_one_completion() noexcept
{
    return m_impl->scheduler.dispatch_owner_completions(1) == 1;
}

bool InlineJobExecutor::run_until_idle(std::size_t maximum_steps) noexcept
{
    std::size_t steps = 0;
    while (!m_impl->scheduler.idle_on_owner()) {
        if (m_impl->scheduler.has_runnable_on_owner()) {
            if (steps == maximum_steps)
                return false;
            if (m_impl->scheduler.advance_one_step())
                ++steps;
        }
        (void)m_impl->scheduler.dispatch_owner_completions(1);
    }
    return true;
}

} // namespace noveltea::jobs
