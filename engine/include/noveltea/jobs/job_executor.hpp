#pragma once

#include "noveltea/core/result.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>

namespace noveltea::jobs {

class JobContext {
public:
    virtual ~JobContext() = default;

    [[nodiscard]] virtual bool cancellation_requested() const noexcept = 0;
    [[nodiscard]] virtual bool cooperative_budget_expired() const noexcept = 0;
    virtual void report_progress(JobProgress progress) noexcept = 0;
};

class JobTask {
public:
    virtual ~JobTask() = default;

    [[nodiscard]] virtual JobStepOutcome step(JobContext& context) noexcept = 0;
    virtual void complete_on_owner(JobCompletion completion) noexcept = 0;
};

class JobExecutor {
public:
    virtual ~JobExecutor() = default;

    [[nodiscard]] virtual JobExecutionMode mode() const noexcept = 0;
    [[nodiscard]] virtual core::Result<JobId, core::Diagnostic>
    submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept = 0;
    [[nodiscard]] virtual bool request_cancel(JobId id) noexcept = 0;
    [[nodiscard]] virtual bool set_priority(JobId id, JobPriority priority) noexcept = 0;
    [[nodiscard]] virtual std::optional<JobProgress> progress(JobId id) const noexcept = 0;
    [[nodiscard]] virtual JobExecutorSnapshot snapshot_on_owner() const = 0;
    virtual void pump(std::chrono::nanoseconds budget) noexcept = 0;
    virtual std::size_t dispatch_owner_completions(std::size_t maximum) noexcept = 0;
    virtual void begin_shutdown() noexcept = 0;
    [[nodiscard]] virtual bool shutdown_complete() const noexcept = 0;
};

} // namespace noveltea::jobs
