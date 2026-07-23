#pragma once

#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <memory>
#include <string>
#include <vector>

namespace noveltea::jobs {
class JobExecutor;
}

namespace noveltea::core {

enum class AssetTelemetryEventKind : std::uint8_t {
    AssetRequested,
    RequestCoalesced,
    PriorityPromoted,
    PriorityDemoted,
    CacheHit,
    CacheMiss,
    SourceReadStarted,
    SourceReadCompleted,
    SourceReadFailed,
    PreparationCompleted,
    PreparationFailed,
    OwnerFinalizationCompleted,
    OwnerFinalizationFailed,
    RequestFailed,
    RequestCanceled,
    PinAdded,
    PinReleased,
    Evicted,
    ReloadedAfterEviction,
    PrefetchUsed,
    PrefetchLate,
    PrefetchMiss,
    PrefetchUnused,
    BudgetPressure,
    MemoryPolicyResolved,
    Count,
};

inline constexpr std::size_t asset_telemetry_event_kind_count =
    static_cast<std::size_t>(AssetTelemetryEventKind::Count);

struct AssetTelemetryEvent {
    std::chrono::steady_clock::time_point timestamp{};
    AssetTelemetryEventKind kind = AssetTelemetryEventKind::AssetRequested;
    jobs::JobExecutionMode execution_mode = jobs::JobExecutionMode::Cooperative;
    std::optional<assets::AssetCacheKey> cache_key;
    jobs::JobId job_id;
    assets::AssetRequestId request_id;
    assets::PrefetchGenerationId prefetch_generation;
    std::optional<assets::AssetRequestReason> request_reason;
    std::optional<jobs::JobPriority> job_priority;
    assets::ResidencyCost memory;
    std::uint64_t compressed_bytes = 0;
    std::uint64_t uncompressed_bytes = 0;
    std::chrono::nanoseconds duration{};
    std::string diagnostic_code;
    std::optional<assets::ResidencyEvictionReason> eviction_reason;
    std::optional<assets::ResolvedAssetMemoryPolicy> memory_policy;
};

struct AssetTelemetryAggregates {
    std::uint64_t compressed_bytes_read = 0;
    std::uint64_t uncompressed_bytes_read = 0;
    std::chrono::nanoseconds source_read_duration{};
    std::chrono::nanoseconds preparation_duration{};
    std::chrono::nanoseconds owner_finalization_duration{};
};

struct AssetTelemetrySnapshot {
    std::array<std::uint64_t, asset_telemetry_event_kind_count> event_counts{};
    AssetTelemetryAggregates aggregates;
    assets::ResidencyAccountingSnapshot memory;
    std::vector<AssetTelemetryEvent> retained_events;
    std::uint64_t lost_event_count = 0;
    std::optional<assets::ResolvedAssetMemoryPolicy> memory_policy;
};

class AssetTelemetrySink {
public:
    virtual ~AssetTelemetrySink() = default;

    virtual void record(AssetTelemetryEvent event) noexcept = 0;
    [[nodiscard]] virtual AssetTelemetrySnapshot snapshot_on_owner() const = 0;
};

inline constexpr std::size_t production_asset_telemetry_event_capacity = 0;
inline constexpr std::size_t editor_asset_telemetry_event_capacity = 8192;
inline constexpr std::uint32_t asset_profiler_snapshot_schema_version = 2;

class AssetTelemetryRecorder final : public AssetTelemetrySink {
public:
    explicit AssetTelemetryRecorder(std::size_t event_capacity);
    ~AssetTelemetryRecorder() override;

    AssetTelemetryRecorder(const AssetTelemetryRecorder&) = delete;
    AssetTelemetryRecorder& operator=(const AssetTelemetryRecorder&) = delete;
    AssetTelemetryRecorder(AssetTelemetryRecorder&&) = delete;
    AssetTelemetryRecorder& operator=(AssetTelemetryRecorder&&) = delete;

    void record(AssetTelemetryEvent event) noexcept override;
    [[nodiscard]] AssetTelemetrySnapshot snapshot_on_owner() const override;
    [[nodiscard]] std::size_t event_capacity() const noexcept;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

struct AssetProfilerSnapshot {
    const std::uint32_t schema_version = asset_profiler_snapshot_schema_version;
    const std::chrono::steady_clock::time_point captured_at{};
    const jobs::JobExecutorSnapshot jobs;
    const AssetTelemetrySnapshot assets;
};

[[nodiscard]] AssetProfilerSnapshot
capture_asset_profiler_snapshot_on_owner(const jobs::JobExecutor& jobs,
                                         const AssetTelemetrySink& assets);

} // namespace noveltea::core
