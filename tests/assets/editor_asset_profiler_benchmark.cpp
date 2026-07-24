#include "core/editor_asset_profiler_json.hpp"
#include "core/editor_asset_profiler_service.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

namespace {

using namespace noveltea;

constexpr std::size_t inventory_size = 1'000;
constexpr std::size_t history_size = 8'192;
constexpr std::size_t rich_history_iterations = 256;
constexpr std::size_t sample_count = 25;

assets::AssetCacheKey key(std::uint64_t value)
{
    return {.stable_identity = "project:/stress/asset-" + std::to_string(value) + ".png",
            .source_generation = assets::AssetSourceGeneration{1}};
}

core::Diagnostic nested_diagnostic(std::uint64_t value)
{
    core::Diagnostic cause{.code = "assets.stress.cause",
                           .message = "Nested stress-fixture cause " + std::to_string(value),
                           .severity = core::ErrorSeverity::Warning,
                           .source_path = "project:/stress/project.json",
                           .json_pointer = "/assets/" + std::to_string(value)};
    return core::Diagnostic{.code = "assets.prefetch_allowance_exceeded",
                            .message = "Representative memory-limit rejection",
                            .severity = core::ErrorSeverity::Error,
                            .source_path = "project:/stress/project.json",
                            .json_pointer = "/assets/" + std::to_string(value),
                            .causes = {std::move(cause)}};
}

std::vector<core::AssetProfilerEntry> inventory()
{
    std::vector<core::AssetProfilerEntry> rows;
    rows.reserve(inventory_size);
    for (std::size_t index = 0; index < inventory_size; ++index) {
        core::AssetProfilerEntry row;
        row.cache_key = key(index);
        row.asset_type = static_cast<core::AssetProfilerAssetType>(index % 5);
        row.display_identity = "Stress asset " + std::to_string(index);
        row.state = static_cast<core::AssetProfilerState>(index % 6);
        row.request_origin = static_cast<core::AssetProfilerRequestOrigin>(index % 5);
        row.retention_reason = static_cast<core::AssetProfilerRetentionReason>(index % 7);
        row.committed_cost = assets::ResidencyCost{.source_bytes = 1024 + index,
                                                   .prepared_cpu_bytes = 2048 + index,
                                                   .gpu_bytes = 4096 + index,
                                                   .audio_bytes = index % 2 == 0 ? 0U : 8192U};
        row.estimated_cost = row.committed_cost;
        row.loading_memory_bytes = 512 + index;
        row.job_id = jobs::JobId{index + 1};
        row.prefetch_generation = assets::PrefetchGenerationId{index / 4 + 1};
        row.completed_prefetch_claimed = index % 3 == 0;
        row.removable = index % 2 == 0;
        row.reload_count = index % 4;
        if (row.state == core::AssetProfilerState::Failed) {
            row.diagnostics.push_back(nested_diagnostic(index));
        }
        rows.push_back(std::move(row));
    }
    return rows;
}

std::vector<core::AssetProfilerEntry> marker_inventory(std::uint64_t revision)
{
    core::AssetProfilerEntry row;
    row.cache_key = key(0);
    row.display_identity = "Marker inventory " + std::to_string(revision);
    row.state = core::AssetProfilerState::Cached;
    row.retention_reason = core::AssetProfilerRetentionReason::RetainedInCache;
    row.committed_cost = assets::ResidencyCost{.source_bytes = 1};
    row.removable = true;
    return {std::move(row)};
}

void fill_history(core::EditorAssetProfilerService& service,
                  std::chrono::steady_clock::time_point epoch, std::uint64_t& marker_revision)
{
    for (std::uint64_t index = 0; index < rich_history_iterations; ++index) {
        core::AssetProfilerPrefetchGenerationRecord generation;
        generation.generation = assets::PrefetchGenerationId{index + 1};
        generation.expected_next_count = 3;
        generation.possible_next_count = 2;
        generation.submitted_entries = {
            {.cache_key = key(index * 5), .prediction = core::PrefetchPredictionKind::ExpectedNext},
            {.cache_key = key(index * 5 + 1),
             .prediction = core::PrefetchPredictionKind::ExpectedNext},
            {.cache_key = key(index * 5 + 2),
             .prediction = core::PrefetchPredictionKind::PossibleNext},
        };
        generation.submission_failures = {
            {.cache_key = key(index * 5 + 3),
             .prediction = core::PrefetchPredictionKind::ExpectedNext,
             .diagnostic = nested_diagnostic(index)},
            {.cache_key = key(index * 5 + 4),
             .prediction = core::PrefetchPredictionKind::PossibleNext,
             .diagnostic = nested_diagnostic(index + 1)},
        };
        generation.used_count = index % 7;
        generation.late_count = index % 5;
        generation.unused_count = index % 3;
        service.record_prefetch_generation(generation);

        core::AssetWaitStart wait;
        wait.operation = core::LoadingOperationId{index + 1};
        wait.started_at = epoch + std::chrono::nanoseconds(index * 1'000);
        wait.waiting_requests = {
            {.cache_key = key(index * 3), .request_id = assets::AssetRequestId{index * 3 + 1}},
            {.cache_key = key(index * 3 + 1), .request_id = assets::AssetRequestId{index * 3 + 2}},
            {.cache_key = key(index * 3 + 2), .request_id = assets::AssetRequestId{index * 3 + 3}},
        };
        service.record_asset_wait_started(wait);
        service.record_asset_wait_finished(
            {.operation = wait.operation,
             .finished_at = wait.started_at + std::chrono::milliseconds(2),
             .result =
                 index % 4 == 0 ? core::AssetWaitResult::Failed : core::AssetWaitResult::Completed,
             .diagnostics = {nested_diagnostic(index)}});

        core::AssetTelemetryEvent event;
        event.kind = index % 2 == 0 ? core::AssetTelemetryEventKind::PrefetchMiss
                                    : core::AssetTelemetryEventKind::PrefetchLate;
        event.cache_key = key(index);
        service.record(std::move(event));

        service.record_accounting_change(
            {.current = assets::ResidencyCost{.source_bytes = index + 1,
                                              .prepared_cpu_bytes = index + 2,
                                              .gpu_bytes = index + 3,
                                              .audio_bytes = index + 4,
                                              .temporary_bytes = index + 5}});
        service.flush_frame_on_owner();
    }

    for (std::uint64_t index = rich_history_iterations * 4; index < history_size; ++index) {
        ++marker_revision;
        service.record_inventory_maybe_changed();
        service.flush_frame_on_owner();
    }
}

double p95_ms(std::vector<double> values)
{
    std::sort(values.begin(), values.end());
    return values[(values.size() * 95 + 99) / 100 - 1];
}

template<class Function> std::pair<double, std::size_t> measure(Function&& function)
{
    std::vector<double> samples;
    samples.reserve(sample_count);
    std::size_t bytes = 0;
    for (std::size_t index = 0; index < sample_count; ++index) {
        const auto started = std::chrono::steady_clock::now();
        bytes = function().size();
        const auto finished = std::chrono::steady_clock::now();
        samples.push_back(std::chrono::duration<double, std::milli>(finished - started).count());
    }
    return {p95_ms(std::move(samples)), bytes};
}

} // namespace

int main()
{
    const auto epoch = std::chrono::steady_clock::now();
    core::EditorAssetProfilerService service([epoch] { return epoch; });
    std::uint64_t marker_revision = 0;
    service.set_inventory_provider(
        [&marker_revision] { return marker_inventory(marker_revision); });
    fill_history(service, epoch, marker_revision);

    const auto rows = inventory();
    service.set_inventory_provider([rows] { return rows; });
    service.record_inventory_maybe_changed();
    service.flush_frame_on_owner();

    const auto baseline = service.capture_on_owner();
    if (baseline.assets.size() != inventory_size ||
        baseline.retained_changes.size() != history_size) {
        std::cerr << "stress fixture shape mismatch\n";
        return 2;
    }

    const auto [full_ms, full_bytes] = measure(
        [&] { return core::serialize_asset_profiler_snapshot(service.capture_on_owner()); });

    for (std::uint64_t index = 0; index < 100; ++index) {
        core::AssetTelemetryEvent event;
        event.kind = index % 2 == 0 ? core::AssetTelemetryEventKind::PrefetchLate
                                    : core::AssetTelemetryEventKind::PrefetchMiss;
        event.cache_key = key(history_size + index);
        event.request_id = assets::AssetRequestId{history_size + index + 1};
        service.record(std::move(event));
    }
    const auto after_changes = service.capture_on_owner();
    const auto [delta_ms, delta_bytes] = measure([&] {
        const auto delta =
            service.capture_delta_on_owner(baseline.session_id, baseline.latest_sequence);
        return core::serialize_asset_profiler_delta(delta.value());
    });
    const auto [idle_ms, idle_bytes] = measure([&] {
        const auto delta =
            service.capture_delta_on_owner(baseline.session_id, after_changes.latest_sequence);
        return core::serialize_asset_profiler_delta(delta.value());
    });

    std::cout << "asset-profiler-stress inventory=" << inventory_size << " history=" << history_size
              << " samples=" << sample_count << '\n'
              << "full p95_ms=" << full_ms << " bytes=" << full_bytes << '\n'
              << "delta100 p95_ms=" << delta_ms << " bytes=" << delta_bytes << '\n'
              << "idle p95_ms=" << idle_ms << " bytes=" << idle_bytes << '\n';

    const bool passed = full_ms <= 50.0 && full_bytes <= 8U * 1024U * 1024U && delta_ms <= 8.0 &&
                        delta_bytes <= 512U * 1024U && idle_ms <= 2.0 && idle_bytes <= 16U * 1024U;
    return passed ? 0 : 1;
}
