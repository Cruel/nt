#include "host/job_executor_bootstrap.hpp"

#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cstdint>
#include <memory>
#include <string>

#ifndef NOVELTEA_ENABLE_THREADS
#error "NOVELTEA_ENABLE_THREADS must be defined for host bootstrap composition"
#endif

#ifndef NOVELTEA_JOB_WORKER_COUNT
#error "NOVELTEA_JOB_WORKER_COUNT must be defined for host bootstrap composition"
#endif

namespace noveltea::host {
namespace {

#if NOVELTEA_ENABLE_THREADS
std::uint32_t resolve_native_worker_count() noexcept
{
    constexpr std::uint32_t configured = NOVELTEA_JOB_WORKER_COUNT;
    if constexpr (configured != 0)
        return configured;

    const int logical_cores = SDL_GetNumLogicalCPUCores();
    const int available = std::max(logical_cores - 1, 1);
    return static_cast<std::uint32_t>(std::clamp(available, 1, 4));
}
#endif

} // namespace

JobExecutorBootstrap make_job_executor_bootstrap()
{
#if NOVELTEA_ENABLE_THREADS
    const std::uint32_t worker_count = resolve_native_worker_count();
    auto executor = std::make_unique<jobs::SdlThreadPoolJobExecutor>(worker_count);
    std::optional<core::Diagnostic> startup_failure;
    if (!executor->ready()) {
        startup_failure = core::Diagnostic{
            .code = "jobs.thread_pool_startup_failed",
            .message = std::string(executor->startup_error()),
        };
    }
    return {
        .executor = std::move(executor),
        .config = {.mode = jobs::JobExecutionMode::Threaded, .worker_count = worker_count},
        .startup_failure = std::move(startup_failure),
    };
#else
    return {
        .executor = std::make_unique<jobs::CooperativeJobExecutor>(),
        .config = {.mode = jobs::JobExecutionMode::Cooperative, .worker_count = 0},
        .startup_failure = std::nullopt,
    };
#endif
}

} // namespace noveltea::host
