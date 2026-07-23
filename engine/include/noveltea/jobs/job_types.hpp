#pragma once

#include "noveltea/core/diagnostic.hpp"

#include <chrono>
#include <compare>
#include <cstdint>
#include <optional>

namespace noveltea::jobs {

enum class JobPriority : std::uint8_t {
    Critical,
    Normal,
    Prefetch,
};

enum class JobStepStatus : std::uint8_t {
    Yielded,
    Completed,
    Failed,
};

enum class JobTerminalStatus : std::uint8_t {
    Completed,
    Failed,
    Canceled,
};

enum class JobExecutionMode : std::uint8_t {
    Threaded,
    Cooperative,
    InlineTest,
};

struct JobExecutionConfig {
    JobExecutionMode mode = JobExecutionMode::Cooperative;
    std::uint32_t worker_count = 0;
};

struct JobId {
    std::uint64_t value = 0;

    [[nodiscard]] bool valid() const noexcept { return value != 0; }
    auto operator<=>(const JobId&) const = default;
};

struct JobProgress {
    std::uint64_t completed_units = 0;
    std::optional<std::uint64_t> total_units;

    auto operator<=>(const JobProgress&) const = default;
};

struct JobStepOutcome {
    JobStepStatus status = JobStepStatus::Yielded;
    core::Diagnostics diagnostics;

    [[nodiscard]] bool contract_valid() const noexcept
    {
        return status == JobStepStatus::Failed ? !diagnostics.empty() : diagnostics.empty();
    }
};

struct JobCompletion {
    JobId id;
    JobTerminalStatus status = JobTerminalStatus::Canceled;
    core::Diagnostics diagnostics;

    [[nodiscard]] bool contract_valid() const noexcept
    {
        if (!id.valid())
            return false;
        return status == JobTerminalStatus::Failed ? !diagnostics.empty() : diagnostics.empty();
    }
};

struct JobPrioritySnapshot {
    std::uint64_t queued = 0;
    std::uint64_t running_steps = 0;
    std::uint64_t completions_queued = 0;
    std::uint64_t submitted_total = 0;
    std::uint64_t completed_total = 0;
    std::uint64_t failed_total = 0;
    std::uint64_t canceled_total = 0;
    std::chrono::nanoseconds maximum_queue_latency{};
};

struct JobExecutorSnapshot {
    JobExecutionMode mode = JobExecutionMode::Cooperative;
    JobPrioritySnapshot critical;
    JobPrioritySnapshot normal;
    JobPrioritySnapshot prefetch;
};

} // namespace noveltea::jobs
