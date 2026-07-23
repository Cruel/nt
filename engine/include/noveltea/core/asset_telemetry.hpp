#pragma once

#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

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
    OwnerFinalizationCompleted,
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
    std::optional<assets::ResolvedAssetMemoryPolicy> memory_policy;
};

struct AssetTelemetrySnapshot {
    std::array<std::uint64_t, asset_telemetry_event_kind_count> event_counts{};
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

} // namespace noveltea::core
