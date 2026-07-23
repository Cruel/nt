#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/jobs/job_executor.hpp"

#include <memory>
#include <optional>

namespace noveltea::host {

struct JobExecutorBootstrap {
    std::unique_ptr<jobs::JobExecutor> executor;
    jobs::JobExecutionConfig config;
    std::optional<core::Diagnostic> startup_failure;
};

[[nodiscard]] JobExecutorBootstrap make_job_executor_bootstrap();

} // namespace noveltea::host
