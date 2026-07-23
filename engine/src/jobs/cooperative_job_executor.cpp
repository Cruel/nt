#include "noveltea/jobs/cooperative_job_executor.hpp"

#include "jobs/scheduler_core.hpp"

#include <utility>

namespace noveltea::jobs {

struct CooperativeJobExecutor::Impl {
    Impl() : scheduler(JobExecutionMode::Cooperative, default_clock) {}
    explicit Impl(JobClock& clock) : scheduler(JobExecutionMode::Cooperative, clock) {}

    detail::SteadyJobClock default_clock;
    detail::SchedulerCore scheduler;
};

CooperativeJobExecutor::CooperativeJobExecutor() : m_impl(std::make_unique<Impl>()) {}

CooperativeJobExecutor::CooperativeJobExecutor(JobClock& clock)
    : m_impl(std::make_unique<Impl>(clock))
{
}

CooperativeJobExecutor::~CooperativeJobExecutor() = default;

JobExecutionMode CooperativeJobExecutor::mode() const noexcept { return m_impl->scheduler.mode(); }

core::Result<JobId, core::Diagnostic>
CooperativeJobExecutor::submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept
{
    return m_impl->scheduler.submit(priority, std::move(task));
}

bool CooperativeJobExecutor::request_cancel(JobId id) noexcept
{
    return m_impl->scheduler.request_cancel(id);
}

std::optional<JobProgress> CooperativeJobExecutor::progress(JobId id) const noexcept
{
    return m_impl->scheduler.progress(id);
}

JobExecutorSnapshot CooperativeJobExecutor::snapshot_on_owner() const
{
    return m_impl->scheduler.snapshot_on_owner();
}

void CooperativeJobExecutor::pump(std::chrono::nanoseconds budget) noexcept
{
    m_impl->scheduler.pump(budget);
}

std::size_t CooperativeJobExecutor::dispatch_owner_completions(std::size_t maximum) noexcept
{
    return m_impl->scheduler.dispatch_owner_completions(maximum);
}

void CooperativeJobExecutor::begin_shutdown() noexcept { m_impl->scheduler.begin_shutdown(); }

bool CooperativeJobExecutor::shutdown_complete() const noexcept
{
    return m_impl->scheduler.shutdown_complete();
}

} // namespace noveltea::jobs
