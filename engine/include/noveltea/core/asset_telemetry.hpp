#pragma once

#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace noveltea::core {

class EditorAssetProfilerService;

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
    virtual void
    record_accounting_change(const assets::ResidencyAccountingSnapshot& current) noexcept
    {
        (void)current;
    }
    virtual void record_inventory_maybe_changed() noexcept {}
};

inline constexpr std::size_t production_asset_telemetry_event_capacity = 0;
inline constexpr std::size_t editor_asset_profiler_change_capacity = 8192;
inline constexpr std::uint32_t asset_profiler_snapshot_schema_version = 3;

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
    friend class EditorAssetProfilerService;

    void reset_on_owner();

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

struct AssetProfilerSessionId {
    std::uint64_t value = 0;

    friend bool operator==(AssetProfilerSessionId, AssetProfilerSessionId) = default;
};

struct AssetProfilerSequence {
    std::uint64_t value = 0;

    friend bool operator==(AssetProfilerSequence, AssetProfilerSequence) = default;
};

struct AssetProfilerRendererEstimate {
    std::optional<std::uint64_t> ordinary_texture_bytes;
    std::optional<std::uint64_t> render_target_bytes;

    [[nodiscard]] std::optional<std::uint64_t> total_bytes() const noexcept
    {
        if (!ordinary_texture_bytes || !render_target_bytes)
            return std::nullopt;
        return *ordinary_texture_bytes + *render_target_bytes;
    }

    friend bool operator==(const AssetProfilerRendererEstimate&,
                           const AssetProfilerRendererEstimate&) = default;
};

struct AssetProfilerMemoryValues {
    assets::ResidencyCost asset;
    assets::ResidencyCost warm;
    std::uint64_t asset_ram_bytes = 0;
    AssetProfilerRendererEstimate renderer_estimate;
    std::optional<std::uint64_t> total_gpu_resource_bytes;

    friend bool operator==(const AssetProfilerMemoryValues&,
                           const AssetProfilerMemoryValues&) = default;
};

struct AssetProfilerMemoryPeaks {
    assets::ResidencyCost asset;
    std::uint64_t asset_ram_bytes = 0;
    AssetProfilerRendererEstimate renderer_estimate;
    std::optional<std::uint64_t> total_gpu_resource_bytes;

    friend bool operator==(const AssetProfilerMemoryPeaks&,
                           const AssetProfilerMemoryPeaks&) = default;
};

struct AssetProfilerStateCounts {
    std::uint64_t in_use = 0;
    std::uint64_t prefetched = 0;
    std::uint64_t cached = 0;
    std::uint64_t loading = 0;
    std::uint64_t finishing = 0;
    std::uint64_t failed = 0;

    friend bool operator==(const AssetProfilerStateCounts&,
                           const AssetProfilerStateCounts&) = default;
};

struct AssetProfilerMemorySnapshot {
    AssetProfilerMemoryValues current;
    AssetProfilerMemoryPeaks peak;
    assets::ResolvedAssetMemoryPolicy policy;
    AssetProfilerStateCounts asset_counts;
    std::uint64_t accounting_revision = 0;
    std::optional<std::uint64_t> renderer_sampled_at_ns;
};
struct AssetProfilerOutcomeTotals {};
enum class AssetProfilerAssetType : std::uint8_t {
    Image,
    Audio,
    Font,
    Shader,
    Material,
};

enum class AssetProfilerState : std::uint8_t {
    Loading,
    Finishing,
    InUse,
    Prefetched,
    Cached,
    Failed,
};

enum class AssetProfilerRequestOrigin : std::uint8_t {
    Startup,
    Demand,
    ExpectedNext,
    PossibleNext,
    Prefetched,
};

enum class AssetProfilerRetentionReason : std::uint8_t {
    RequiredNow,
    ExpectedNext,
    PossibleNext,
    RetainedInCache,
    Startup,
    Demand,
    Prefetched,
};

struct AssetProfilerEntry {
    assets::AssetCacheKey cache_key;
    AssetProfilerAssetType asset_type = AssetProfilerAssetType::Image;
    std::string display_identity;
    AssetProfilerState state = AssetProfilerState::Loading;
    AssetProfilerRequestOrigin request_origin = AssetProfilerRequestOrigin::Demand;
    AssetProfilerRetentionReason retention_reason = AssetProfilerRetentionReason::Demand;
    std::optional<assets::ResidencyCost> committed_cost;
    std::optional<assets::ResidencyCost> estimated_cost;
    std::uint64_t loading_memory_bytes = 0;
    std::optional<jobs::JobId> job_id;
    std::optional<assets::PrefetchGenerationId> prefetch_generation;
    bool completed_prefetch_claimed = false;
    bool removable = false;
    std::uint64_t reload_count = 0;
    core::Diagnostics diagnostics;

    friend bool operator==(const AssetProfilerEntry&, const AssetProfilerEntry&) = default;
};
struct AssetProfilerMemoryPoint {
    AssetProfilerMemoryValues values;
    AssetProfilerStateCounts asset_counts;

    friend bool operator==(const AssetProfilerMemoryPoint&,
                           const AssetProfilerMemoryPoint&) = default;
};
struct AssetWaitRecord {};
struct AssetProfilerPrefetchGenerationRecord {};
struct AssetProfilerInventoryChanged {
    std::uint64_t revision = 0;
};

using AssetProfilerChangePayload =
    std::variant<AssetTelemetryEvent, AssetProfilerMemoryPoint, AssetWaitRecord,
                 AssetProfilerPrefetchGenerationRecord, AssetProfilerInventoryChanged>;

struct AssetProfilerChange {
    AssetProfilerSequence sequence;
    std::uint64_t timestamp_ns = 0;
    AssetProfilerChangePayload payload;
};

struct AssetProfilerSnapshot {
    std::uint32_t schema_version = asset_profiler_snapshot_schema_version;
    AssetProfilerSessionId session_id;
    AssetProfilerSequence latest_sequence;
    std::uint64_t captured_at_ns = 0;
    AssetProfilerMemorySnapshot memory;
    AssetProfilerOutcomeTotals outcomes;
    std::vector<AssetProfilerEntry> assets;
    std::uint64_t inventory_revision = 0;
    std::vector<AssetProfilerChange> retained_changes;
    AssetProfilerSequence earliest_retained_sequence;
    std::uint64_t lost_change_count = 0;
    bool history_complete = true;
};

struct AssetProfilerDelta {
    std::uint32_t schema_version = asset_profiler_snapshot_schema_version;
    AssetProfilerSessionId session_id;
    AssetProfilerSequence after_sequence;
    AssetProfilerSequence latest_sequence;
    std::uint64_t captured_at_ns = 0;
    AssetProfilerMemorySnapshot memory;
    AssetProfilerOutcomeTotals outcomes;
    std::optional<std::vector<AssetProfilerEntry>> replacement_inventory;
    std::uint64_t inventory_revision = 0;
    std::vector<AssetProfilerChange> changes;
    AssetProfilerSequence earliest_retained_sequence;
    std::uint64_t lost_change_count = 0;
    bool history_gap = false;
};

} // namespace noveltea::core
