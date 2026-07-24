#include "core/editor_asset_profiler_json.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <limits>
#include <type_traits>

namespace noveltea::core {
namespace {

using Json = nlohmann::json;

std::string decimal(std::uint64_t value) { return std::to_string(value); }

Json array_with_capacity(std::size_t capacity)
{
    Json result = Json::array();
    result.get_ref<Json::array_t&>().reserve(capacity);
    return result;
}

Json optional_decimal(const std::optional<std::uint64_t>& value)
{
    return value ? Json(decimal(*value)) : Json(nullptr);
}

const char* severity_name(ErrorSeverity value)
{
    switch (value) {
    case ErrorSeverity::Info:
        return "info";
    case ErrorSeverity::Warning:
        return "warning";
    case ErrorSeverity::Error:
        return "error";
    case ErrorSeverity::Fatal:
        return "fatal";
    }
    return "error";
}

Json diagnostic_json(const Diagnostic& value)
{
    Json causes = array_with_capacity(value.causes.size());
    for (const auto& cause : value.causes)
        causes.push_back(diagnostic_json(cause));
    return Json{{"code", value.code},
                {"message", value.message},
                {"severity", severity_name(value.severity)},
                {"sourcePath", value.source_path},
                {"jsonPointer", value.json_pointer},
                {"causes", std::move(causes)}};
}

Json diagnostics_json(const Diagnostics& values)
{
    Json result = array_with_capacity(values.size());
    for (const auto& value : values)
        result.push_back(diagnostic_json(value));
    return result;
}

Json cost_json(const assets::ResidencyCost& value)
{
    return Json{{"sourceBytes", decimal(value.source_bytes)},
                {"preparedCpuBytes", decimal(value.prepared_cpu_bytes)},
                {"gpuBytes", decimal(value.gpu_bytes)},
                {"audioBytes", decimal(value.audio_bytes)},
                {"temporaryBytes", decimal(value.temporary_bytes)}};
}

Json cache_key_json(const assets::AssetCacheKey& value)
{
    return Json{{"stableIdentity", value.stable_identity},
                {"sourceGeneration", decimal(value.source_generation.value)}};
}

const char* asset_type_name(AssetProfilerAssetType value)
{
    switch (value) {
    case AssetProfilerAssetType::Image:
        return "image";
    case AssetProfilerAssetType::Audio:
        return "audio";
    case AssetProfilerAssetType::Font:
        return "font";
    case AssetProfilerAssetType::Shader:
        return "shader";
    case AssetProfilerAssetType::Material:
        return "material";
    }
    return "image";
}

const char* state_name(AssetProfilerState value)
{
    switch (value) {
    case AssetProfilerState::Loading:
        return "loading";
    case AssetProfilerState::Finishing:
        return "finishing";
    case AssetProfilerState::InUse:
        return "in-use";
    case AssetProfilerState::Prefetched:
        return "prefetched";
    case AssetProfilerState::Cached:
        return "cached";
    case AssetProfilerState::Failed:
        return "failed";
    }
    return "loading";
}

const char* origin_name(AssetProfilerRequestOrigin value)
{
    switch (value) {
    case AssetProfilerRequestOrigin::Startup:
        return "startup";
    case AssetProfilerRequestOrigin::Demand:
        return "demand";
    case AssetProfilerRequestOrigin::ExpectedNext:
        return "expected-next";
    case AssetProfilerRequestOrigin::PossibleNext:
        return "possible-next";
    case AssetProfilerRequestOrigin::Prefetched:
        return "prefetched";
    }
    return "demand";
}

const char* retention_name(AssetProfilerRetentionReason value)
{
    switch (value) {
    case AssetProfilerRetentionReason::RequiredNow:
        return "required-now";
    case AssetProfilerRetentionReason::ExpectedNext:
        return "expected-next";
    case AssetProfilerRetentionReason::PossibleNext:
        return "possible-next";
    case AssetProfilerRetentionReason::RetainedInCache:
        return "retained-in-cache";
    case AssetProfilerRetentionReason::Startup:
        return "startup";
    case AssetProfilerRetentionReason::Demand:
        return "demand";
    case AssetProfilerRetentionReason::Prefetched:
        return "prefetched";
    }
    return "demand";
}

const char* prediction_name(PrefetchPredictionKind value)
{
    switch (value) {
    case PrefetchPredictionKind::ExpectedNext:
        return "expected-next";
    case PrefetchPredictionKind::PossibleNext:
        return "possible-next";
    }
    return "expected-next";
}

const char* wait_result_name(AssetWaitResult value)
{
    switch (value) {
    case AssetWaitResult::Completed:
        return "completed";
    case AssetWaitResult::Failed:
        return "failed";
    case AssetWaitResult::Canceled:
        return "canceled";
    }
    return "failed";
}

const char* loading_phase_name_wire(LoadingPhase value)
{
    switch (value) {
    case LoadingPhase::DownloadingPackage:
        return "downloading-package";
    case LoadingPhase::VerifyingPackage:
        return "verifying-package";
    case LoadingPhase::OpeningPackageIndex:
        return "opening-package-index";
    case LoadingPhase::LoadingStartupContent:
        return "loading-startup-content";
    case LoadingPhase::LoadingRuntimeDemand:
        return "loading-runtime-demand";
    }
    return "loading-runtime-demand";
}

const char* event_kind_name(AssetTelemetryEventKind value)
{
    switch (value) {
    case AssetTelemetryEventKind::AssetRequested:
        return "asset-requested";
    case AssetTelemetryEventKind::RequestCoalesced:
        return "request-coalesced";
    case AssetTelemetryEventKind::PriorityPromoted:
        return "priority-promoted";
    case AssetTelemetryEventKind::PriorityDemoted:
        return "priority-demoted";
    case AssetTelemetryEventKind::CacheHit:
        return "cache-hit";
    case AssetTelemetryEventKind::CacheMiss:
        return "cache-miss";
    case AssetTelemetryEventKind::SourceReadStarted:
        return "source-read-started";
    case AssetTelemetryEventKind::SourceReadCompleted:
        return "source-read-completed";
    case AssetTelemetryEventKind::SourceReadFailed:
        return "source-read-failed";
    case AssetTelemetryEventKind::PreparationCompleted:
        return "preparation-completed";
    case AssetTelemetryEventKind::PreparationFailed:
        return "preparation-failed";
    case AssetTelemetryEventKind::OwnerFinalizationCompleted:
        return "owner-finalization-completed";
    case AssetTelemetryEventKind::OwnerFinalizationFailed:
        return "owner-finalization-failed";
    case AssetTelemetryEventKind::RequestFailed:
        return "request-failed";
    case AssetTelemetryEventKind::RequestCanceled:
        return "request-canceled";
    case AssetTelemetryEventKind::PinAdded:
        return "pin-added";
    case AssetTelemetryEventKind::PinReleased:
        return "pin-released";
    case AssetTelemetryEventKind::Evicted:
        return "evicted";
    case AssetTelemetryEventKind::ReloadedAfterEviction:
        return "reloaded-after-eviction";
    case AssetTelemetryEventKind::PrefetchUsed:
        return "prefetch-used";
    case AssetTelemetryEventKind::PrefetchLate:
        return "prefetch-late";
    case AssetTelemetryEventKind::PrefetchMiss:
        return "prefetch-miss";
    case AssetTelemetryEventKind::PrefetchUnused:
        return "prefetch-unused";
    case AssetTelemetryEventKind::BudgetPressure:
        return "budget-pressure";
    case AssetTelemetryEventKind::MemoryPolicyResolved:
        return "memory-policy-resolved";
    case AssetTelemetryEventKind::Count:
        break;
    }
    return "asset-requested";
}

const char* execution_mode_name(jobs::JobExecutionMode value)
{
    switch (value) {
    case jobs::JobExecutionMode::Threaded:
        return "threaded";
    case jobs::JobExecutionMode::Cooperative:
        return "cooperative";
    case jobs::JobExecutionMode::InlineTest:
        return "inline-test";
    }
    return "cooperative";
}

const char* priority_name(jobs::JobPriority value)
{
    switch (value) {
    case jobs::JobPriority::Critical:
        return "critical";
    case jobs::JobPriority::Normal:
        return "normal";
    case jobs::JobPriority::Prefetch:
        return "prefetch";
    }
    return "normal";
}

const char* request_reason_name(assets::AssetRequestReason value)
{
    switch (value) {
    case assets::AssetRequestReason::Startup:
        return "startup";
    case assets::AssetRequestReason::Demand:
        return "demand";
    case assets::AssetRequestReason::Prefetch:
        return "prefetch";
    }
    return "demand";
}

const char* eviction_reason_name(assets::ResidencyEvictionReason value)
{
    switch (value) {
    case assets::ResidencyEvictionReason::BudgetPressure:
        return "budget-pressure";
    case assets::ResidencyEvictionReason::ExplicitRelease:
        return "explicit-release";
    case assets::ResidencyEvictionReason::GenerationInvalidated:
        return "generation-invalidated";
    case assets::ResidencyEvictionReason::PrefetchRejected:
        return "prefetch-rejected";
    }
    return "budget-pressure";
}

Json policy_json(const assets::ResolvedAssetMemoryPolicy& value)
{
    return Json{
        {"target", assets::asset_memory_target_name(value.target)},
        {"preset", assets::asset_memory_preset_name(value.preset)},
        {"budget", Json{{"sourceBytes", decimal(value.budget.source_bytes)},
                        {"preparedCpuBytes", decimal(value.budget.prepared_cpu_bytes)},
                        {"gpuBytes", decimal(value.budget.gpu_bytes)},
                        {"audioBytes", decimal(value.budget.audio_bytes)},
                        {"temporaryBytes", decimal(value.budget.temporary_bytes)},
                        {"prefetchAllowancePercent", value.budget.prefetch_allowance_percent}}}};
}

Json renderer_json(const AssetProfilerRendererEstimate& value)
{
    return Json{{"ordinaryTextureBytes", optional_decimal(value.ordinary_texture_bytes)},
                {"renderTargetBytes", optional_decimal(value.render_target_bytes)}};
}

Json values_json(const AssetProfilerMemoryValues& value)
{
    return Json{{"asset", cost_json(value.asset)},
                {"warm", cost_json(value.warm)},
                {"assetRamBytes", decimal(value.asset_ram_bytes)},
                {"rendererEstimate", renderer_json(value.renderer_estimate)},
                {"totalGpuResourceBytes", optional_decimal(value.total_gpu_resource_bytes)}};
}

Json peaks_json(const AssetProfilerMemoryPeaks& value)
{
    return Json{{"asset", cost_json(value.asset)},
                {"assetRamBytes", decimal(value.asset_ram_bytes)},
                {"rendererEstimate", renderer_json(value.renderer_estimate)},
                {"totalGpuResourceBytes", optional_decimal(value.total_gpu_resource_bytes)}};
}

Json counts_json(const AssetProfilerStateCounts& value)
{
    return Json{{"inUse", decimal(value.in_use)},        {"prefetched", decimal(value.prefetched)},
                {"cached", decimal(value.cached)},       {"loading", decimal(value.loading)},
                {"finishing", decimal(value.finishing)}, {"failed", decimal(value.failed)}};
}

Json memory_json(const AssetProfilerMemorySnapshot& value)
{
    return Json{{"current", values_json(value.current)},
                {"peak", peaks_json(value.peak)},
                {"policy", policy_json(value.policy)},
                {"assetCounts", counts_json(value.asset_counts)},
                {"accountingRevision", decimal(value.accounting_revision)},
                {"rendererSampledAtNs", optional_decimal(value.renderer_sampled_at_ns)}};
}

Json outcomes_json(const AssetProfilerOutcomeTotals& value)
{
    return Json{{"readyBeforeUse", decimal(value.ready_before_use)},
                {"loadedTooLate", decimal(value.loaded_too_late)},
                {"notPrefetched", decimal(value.not_prefetched)},
                {"blockedByMemoryLimit", decimal(value.blocked_by_memory_limit)},
                {"prefetchedButUnused", decimal(value.prefetched_but_unused)},
                {"reloadedAfterRemoval", decimal(value.reloaded_after_removal)},
                {"assetWaitCount", decimal(value.asset_wait_count)},
                {"assetWaitTimeNs", decimal(value.asset_wait_time_ns)}};
}

Json entry_json(const AssetProfilerEntry& value)
{
    return Json{
        {"cacheKey", cache_key_json(value.cache_key)},
        {"assetType", asset_type_name(value.asset_type)},
        {"displayIdentity", value.display_identity},
        {"state", state_name(value.state)},
        {"requestOrigin", origin_name(value.request_origin)},
        {"retentionReason", retention_name(value.retention_reason)},
        {"committedCost", value.committed_cost ? cost_json(*value.committed_cost) : Json(nullptr)},
        {"estimatedCost", value.estimated_cost ? cost_json(*value.estimated_cost) : Json(nullptr)},
        {"loadingMemoryBytes", decimal(value.loading_memory_bytes)},
        {"jobId", value.job_id ? Json(decimal(value.job_id->value)) : Json(nullptr)},
        {"prefetchGeneration", value.prefetch_generation
                                   ? Json(decimal(value.prefetch_generation->value))
                                   : Json(nullptr)},
        {"completedPrefetchClaimed", value.completed_prefetch_claimed},
        {"removable", value.removable},
        {"reloadCount", decimal(value.reload_count)},
        {"diagnostics", diagnostics_json(value.diagnostics)}};
}

Json entries_json(const std::vector<AssetProfilerEntry>& values)
{
    Json result = array_with_capacity(values.size());
    for (const auto& value : values)
        result.push_back(entry_json(value));
    return result;
}

Json generation_json(const AssetProfilerPrefetchGenerationRecord& value)
{
    Json submitted = array_with_capacity(value.submitted_entries.size());
    for (const auto& entry : value.submitted_entries)
        submitted.push_back(Json{{"cacheKey", cache_key_json(entry.cache_key)},
                                 {"prediction", prediction_name(entry.prediction)}});
    Json failures = array_with_capacity(value.submission_failures.size());
    for (const auto& failure : value.submission_failures)
        failures.push_back(Json{{"cacheKey", cache_key_json(failure.cache_key)},
                                {"prediction", prediction_name(failure.prediction)},
                                {"diagnostic", diagnostic_json(failure.diagnostic)}});
    return Json{{"generation", decimal(value.generation.value)},
                {"timestampNs", decimal(value.timestamp_ns)},
                {"presentationRevision", value.presentation_revision
                                             ? Json(decimal(value.presentation_revision->number()))
                                             : Json(nullptr)},
                {"expectedNextCount", decimal(value.expected_next_count)},
                {"possibleNextCount", decimal(value.possible_next_count)},
                {"submittedEntries", std::move(submitted)},
                {"submissionFailures", std::move(failures)},
                {"usedCount", decimal(value.used_count)},
                {"lateCount", decimal(value.late_count)},
                {"unusedCount", decimal(value.unused_count)}};
}

Json wait_json(const AssetWaitRecord& value)
{
    Json participants = array_with_capacity(value.waiting_requests.size());
    for (const auto& participant : value.waiting_requests)
        participants.push_back(Json{{"cacheKey", cache_key_json(participant.cache_key)},
                                    {"requestId", decimal(participant.request_id.value)}});
    return Json{{"operationId", decimal(value.operation.value)},
                {"phase", loading_phase_name_wire(value.phase)},
                {"presentationRevision", value.presentation_revision
                                             ? Json(decimal(value.presentation_revision->number()))
                                             : Json(nullptr)},
                {"startedAtNs", decimal(value.started_at_ns)},
                {"durationNs", decimal(value.duration_ns)},
                {"result", wait_result_name(value.result)},
                {"waitingRequests", std::move(participants)},
                {"diagnostics", diagnostics_json(value.diagnostics)}};
}

Json telemetry_json(const AssetTelemetryEvent& value)
{
    Json result{
        {"eventKind", event_kind_name(value.kind)},
        {"executionMode", execution_mode_name(value.execution_mode)},
        {"cacheKey", value.cache_key ? cache_key_json(*value.cache_key) : Json(nullptr)},
        {"jobId", decimal(value.job_id.value)},
        {"requestId", decimal(value.request_id.value)},
        {"prefetchGeneration", decimal(value.prefetch_generation.value)},
        {"requestReason",
         value.request_reason ? Json(request_reason_name(*value.request_reason)) : Json(nullptr)},
        {"jobPriority",
         value.job_priority ? Json(priority_name(*value.job_priority)) : Json(nullptr)},
        {"memory", cost_json(value.memory)},
        {"compressedBytes", decimal(value.compressed_bytes)},
        {"uncompressedBytes", decimal(value.uncompressed_bytes)},
        {"durationNs",
         decimal(static_cast<std::uint64_t>(std::max<std::int64_t>(0, value.duration.count())))},
        {"diagnosticCode", value.diagnostic_code},
        {"evictionReason", value.eviction_reason
                               ? Json(eviction_reason_name(*value.eviction_reason))
                               : Json(nullptr)},
        {"memoryPolicy", value.memory_policy ? policy_json(*value.memory_policy) : Json(nullptr)}};
    return result;
}

Json change_json(const AssetProfilerChange& value)
{
    Json result{{"sequence", decimal(value.sequence.value)},
                {"timestampNs", decimal(value.timestamp_ns)}};
    std::visit(
        [&](const auto& payload) {
            using T = std::decay_t<decltype(payload)>;
            if constexpr (std::is_same_v<T, AssetTelemetryEvent>) {
                result["kind"] = "telemetry-event";
                result["event"] = telemetry_json(payload);
            } else if constexpr (std::is_same_v<T, AssetProfilerMemoryPoint>) {
                result["kind"] = "memory-point";
                result["memory"] = Json{{"values", values_json(payload.values)},
                                        {"assetCounts", counts_json(payload.asset_counts)}};
            } else if constexpr (std::is_same_v<T, AssetWaitRecord>) {
                result["kind"] = "asset-wait";
                result["wait"] = wait_json(payload);
            } else if constexpr (std::is_same_v<T, AssetProfilerPrefetchGenerationRecord>) {
                result["kind"] = "prefetch-generation-upsert";
                result["generation"] = generation_json(payload);
            } else {
                result["kind"] = "inventory-changed";
                result["inventoryRevision"] = decimal(payload.revision);
            }
        },
        value.payload);
    return result;
}

Json changes_json(const std::vector<AssetProfilerChange>& values)
{
    Json result = array_with_capacity(values.size());
    for (const auto& value : values)
        result.push_back(change_json(value));
    return result;
}

Json success(Json payload) { return Json{{"ok", true}, {"payload", std::move(payload)}}; }

} // namespace

bool parse_asset_profiler_decimal(std::string_view text, std::uint64_t& value) noexcept
{
    if (text.empty() || (text.front() == '0' && text.size() != 1))
        return false;
    std::uint64_t parsed = 0;
    for (const char character : text) {
        if (character < '0' || character > '9')
            return false;
        const auto digit = static_cast<std::uint64_t>(character - '0');
        if (parsed > (std::numeric_limits<std::uint64_t>::max() - digit) / 10)
            return false;
        parsed = parsed * 10 + digit;
    }
    value = parsed;
    return true;
}

std::string serialize_asset_profiler_snapshot(const AssetProfilerSnapshot& value)
{
    Json payload{{"kind", "full"},
                 {"schemaVersion", value.schema_version},
                 {"sessionId", decimal(value.session_id.value)},
                 {"latestSequence", decimal(value.latest_sequence.value)},
                 {"capturedAtNs", decimal(value.captured_at_ns)},
                 {"memory", memory_json(value.memory)},
                 {"outcomes", outcomes_json(value.outcomes)},
                 {"assets", entries_json(value.assets)},
                 {"inventoryRevision", decimal(value.inventory_revision)},
                 {"retainedChanges", changes_json(value.retained_changes)},
                 {"earliestRetainedSequence", decimal(value.earliest_retained_sequence.value)},
                 {"lostChangeCount", decimal(value.lost_change_count)},
                 {"historyComplete", value.history_complete}};
    return success(std::move(payload)).dump();
}

std::string serialize_asset_profiler_delta(const AssetProfilerDelta& value)
{
    Json payload{{"kind", "delta"},
                 {"schemaVersion", value.schema_version},
                 {"sessionId", decimal(value.session_id.value)},
                 {"afterSequence", decimal(value.after_sequence.value)},
                 {"latestSequence", decimal(value.latest_sequence.value)},
                 {"capturedAtNs", decimal(value.captured_at_ns)},
                 {"memory", memory_json(value.memory)},
                 {"outcomes", outcomes_json(value.outcomes)},
                 {"replacementInventory", value.replacement_inventory
                                              ? entries_json(*value.replacement_inventory)
                                              : Json(nullptr)},
                 {"inventoryRevision", decimal(value.inventory_revision)},
                 {"changes", changes_json(value.changes)},
                 {"earliestRetainedSequence", decimal(value.earliest_retained_sequence.value)},
                 {"lostChangeCount", decimal(value.lost_change_count)},
                 {"historyGap", value.history_gap}};
    return success(std::move(payload)).dump();
}

std::string serialize_asset_profiler_failure(const Diagnostic& diagnostic)
{
    return Json{{"ok", false},
                {"error", Json{{"code", diagnostic.code}, {"message", diagnostic.message}}}}
        .dump();
}

} // namespace noveltea::core
