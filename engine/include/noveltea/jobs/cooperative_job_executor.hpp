#pragma once

#include "noveltea/jobs/job_clock.hpp"
#include "noveltea/jobs/job_executor.hpp"

#include <memory>

namespace noveltea::jobs {

class CooperativeJobExecutor final : public JobExecutor {
public:
    CooperativeJobExecutor();
    explicit CooperativeJobExecutor(JobClock& clock);
    ~CooperativeJobExecutor() override;

    CooperativeJobExecutor(const CooperativeJobExecutor&) = delete;
    CooperativeJobExecutor& operator=(const CooperativeJobExecutor&) = delete;
    CooperativeJobExecutor(CooperativeJobExecutor&&) = delete;
    CooperativeJobExecutor& operator=(CooperativeJobExecutor&&) = delete;

    [[nodiscard]] JobExecutionMode mode() const noexcept override;
    [[nodiscard]] core::Result<JobId, core::Diagnostic>
    submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept override;
    [[nodiscard]] bool request_cancel(JobId id) noexcept override;
    [[nodiscard]] std::optional<JobProgress> progress(JobId id) const noexcept override;
    [[nodiscard]] JobExecutorSnapshot snapshot_on_owner() const override;
    void pump(std::chrono::nanoseconds budget) noexcept override;
    std::size_t dispatch_owner_completions(std::size_t maximum) noexcept override;
    void begin_shutdown() noexcept override;
    [[nodiscard]] bool shutdown_complete() const noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::jobs
