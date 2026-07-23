#pragma once

#include "noveltea/jobs/job_executor.hpp"

#include <cstdint>
#include <memory>
#include <string_view>

namespace noveltea::jobs {

class SdlThreadPoolJobExecutor final : public JobExecutor {
public:
    explicit SdlThreadPoolJobExecutor(std::uint32_t worker_count);
    ~SdlThreadPoolJobExecutor() override;

    SdlThreadPoolJobExecutor(const SdlThreadPoolJobExecutor&) = delete;
    SdlThreadPoolJobExecutor& operator=(const SdlThreadPoolJobExecutor&) = delete;
    SdlThreadPoolJobExecutor(SdlThreadPoolJobExecutor&&) = delete;
    SdlThreadPoolJobExecutor& operator=(SdlThreadPoolJobExecutor&&) = delete;

    [[nodiscard]] bool ready() const noexcept;
    [[nodiscard]] std::string_view startup_error() const noexcept;
    [[nodiscard]] std::uint32_t worker_count() const noexcept;

    [[nodiscard]] JobExecutionMode mode() const noexcept override;
    [[nodiscard]] core::Result<JobId, core::Diagnostic>
    submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept override;
    [[nodiscard]] bool request_cancel(JobId id) noexcept override;
    [[nodiscard]] bool set_priority(JobId id, JobPriority priority) noexcept override;
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
