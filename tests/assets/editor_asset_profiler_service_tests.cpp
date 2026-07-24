#include <catch2/catch_test_macros.hpp>

#include "core/editor_asset_profiler_service.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <memory>
#include <thread>
#include <variant>
#include <vector>

namespace {

using namespace noveltea;

TEST_CASE("Editor asset profiler service is composed only for preview widgets",
          "[assets][telemetry-matrix][profiler][composition]")
{
    CHECK_FALSE(core::make_editor_asset_profiler_service(false));

    auto service = core::make_editor_asset_profiler_service(true);
    REQUIRE(service != nullptr);
    auto second_service = core::make_editor_asset_profiler_service(true);
    REQUIRE(second_service != nullptr);
    CHECK(service->session_id_on_owner().value != 0);
    CHECK(second_service->session_id_on_owner().value != 0);
    CHECK(service->session_id_on_owner() != second_service->session_id_on_owner());

    core::AssetTelemetrySink* sink = service.get();
    REQUIRE(sink != nullptr);
    for (std::size_t index = 0; index < core::editor_asset_profiler_change_capacity + 1; ++index)
        sink->record({.kind = core::AssetTelemetryEventKind::CacheHit});

    const auto snapshot = sink->snapshot_on_owner();
    CHECK(snapshot.retained_events.empty());
    CHECK(snapshot.lost_event_count == 0);
    CHECK(
        snapshot.event_counts[static_cast<std::size_t>(core::AssetTelemetryEventKind::CacheHit)] ==
        core::editor_asset_profiler_change_capacity + 1);
}

TEST_CASE("Editor asset profiler retains one ordered filtered change history",
          "[assets][telemetry-matrix][profiler][history]")
{
    core::EditorAssetProfilerService service;
    constexpr std::size_t thread_count = 4;
    constexpr std::size_t events_per_thread = 64;
    std::vector<std::thread> threads;
    for (std::size_t thread = 0; thread < thread_count; ++thread) {
        threads.emplace_back([&service] {
            for (std::size_t event = 0; event < events_per_thread; ++event)
                service.record({.kind = core::AssetTelemetryEventKind::PreparationCompleted});
        });
    }
    for (auto& thread : threads)
        thread.join();

    const auto full = service.capture_on_owner();
    CHECK(full.schema_version == core::asset_profiler_snapshot_schema_version);
    REQUIRE(full.session_id.value != 0);
    REQUIRE(full.retained_changes.size() == thread_count * events_per_thread);
    CHECK(full.latest_sequence.value == full.retained_changes.size());
    for (std::size_t index = 0; index < full.retained_changes.size(); ++index) {
        CHECK(full.retained_changes[index].sequence.value == index + 1);
        CHECK(full.retained_changes[index].timestamp_ns <= full.captured_at_ns);
    }

    const auto delta = service.capture_delta_on_owner(full.session_id, {128});
    REQUIRE(delta);
    CHECK(delta.value().schema_version == core::asset_profiler_snapshot_schema_version);
    CHECK(delta.value().changes.size() == full.retained_changes.size() - 128);
    CHECK(delta.value().changes.front().sequence.value == 129);
    CHECK_FALSE(delta.value().history_gap);
    CHECK_FALSE(delta.value().replacement_inventory.has_value());
}

TEST_CASE("Editor asset profiler retains only the specified low-level event subset",
          "[assets][telemetry-matrix][profiler][history]")
{
    core::EditorAssetProfilerService service;
    const std::vector<core::AssetTelemetryEventKind> retained_kinds{
        core::AssetTelemetryEventKind::SourceReadCompleted,
        core::AssetTelemetryEventKind::SourceReadFailed,
        core::AssetTelemetryEventKind::PreparationCompleted,
        core::AssetTelemetryEventKind::PreparationFailed,
        core::AssetTelemetryEventKind::OwnerFinalizationCompleted,
        core::AssetTelemetryEventKind::OwnerFinalizationFailed,
        core::AssetTelemetryEventKind::RequestFailed,
        core::AssetTelemetryEventKind::Evicted,
        core::AssetTelemetryEventKind::ReloadedAfterEviction,
        core::AssetTelemetryEventKind::PrefetchUsed,
        core::AssetTelemetryEventKind::PrefetchLate,
        core::AssetTelemetryEventKind::PrefetchMiss,
        core::AssetTelemetryEventKind::PrefetchUnused,
    };
    for (const auto kind : retained_kinds)
        service.record({.kind = kind});

    constexpr std::array retained_prefetch_rejections{
        "assets.prefetch_allowance_exceeded",
        "assets.prefetch_preparation_rejected",
        "assets.prefetch_preparation_resize_rejected",
        "assets.prefetch_residency_rejected",
    };
    for (const auto* code : retained_prefetch_rejections) {
        service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                        .prefetch_generation = assets::PrefetchGenerationId{1},
                        .diagnostic_code = code});
    }

    service.record({.kind = core::AssetTelemetryEventKind::CacheHit});
    service.record({.kind = core::AssetTelemetryEventKind::SourceReadStarted});
    service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                    .prefetch_generation = assets::PrefetchGenerationId{1},
                    .diagnostic_code = "assets.oversized_mandatory_preparation"});
    service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                    .diagnostic_code = "assets.prefetch_residency_rejected"});

    const auto full = service.capture_on_owner();
    REQUIRE(full.retained_changes.size() ==
            retained_kinds.size() + retained_prefetch_rejections.size());
    CHECK(full.latest_sequence.value == full.retained_changes.size());
    CHECK(std::ranges::all_of(full.retained_changes, [](const auto& change) {
        return std::holds_alternative<core::AssetTelemetryEvent>(change.payload);
    }));
}

TEST_CASE("Editor asset profiler reports overwrite gaps and invalid cursors",
          "[assets][telemetry-matrix][profiler][history]")
{
    core::EditorAssetProfilerService service;
    for (std::size_t index = 0; index < core::editor_asset_profiler_change_capacity + 3; ++index)
        service.record({.kind = core::AssetTelemetryEventKind::Evicted});

    const auto full = service.capture_on_owner();
    CHECK_FALSE(full.history_complete);
    CHECK(full.lost_change_count == 3);
    CHECK(full.earliest_retained_sequence.value == 4);

    auto gap = service.capture_delta_on_owner(full.session_id, {0});
    REQUIRE(gap);
    CHECK(gap.value().history_gap);
    REQUIRE(gap.value().replacement_inventory.has_value());
    CHECK(gap.value().replacement_inventory->empty());
    CHECK(gap.value().changes.size() == core::editor_asset_profiler_change_capacity);

    auto boundary = service.capture_delta_on_owner(full.session_id, {3});
    REQUIRE(boundary);
    CHECK_FALSE(boundary.value().history_gap);
    CHECK_FALSE(boundary.value().replacement_inventory.has_value());
    CHECK(boundary.value().changes.size() == core::editor_asset_profiler_change_capacity);

    auto invalid =
        service.capture_delta_on_owner(full.session_id, {full.latest_sequence.value + 1});
    REQUIRE_FALSE(invalid);
    CHECK(invalid.error().code == "assets.editor_profiler_cursor_invalid");
}

TEST_CASE("Editor asset profiler rotates sessions in place",
          "[assets][telemetry-matrix][profiler][session]")
{
    core::EditorAssetProfilerService service;
    const auto* address = &service;
    service.record({.kind = core::AssetTelemetryEventKind::RequestFailed});
    const auto previous = service.capture_on_owner();
    const auto previous_aggregates = service.snapshot_on_owner();
    CHECK(previous_aggregates.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestFailed)] == 1);

    service.rotate_session_on_owner();
    CHECK(&service == address);
    const auto current = service.capture_on_owner();
    CHECK(current.session_id != previous.session_id);
    CHECK(current.latest_sequence.value == 0);
    CHECK(current.retained_changes.empty());
    CHECK(current.earliest_retained_sequence.value == 0);
    const auto current_aggregates = service.snapshot_on_owner();
    CHECK(current_aggregates.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestFailed)] == 0);

    const auto stale = service.capture_delta_on_owner(previous.session_id, {0});
    REQUIRE_FALSE(stale);
    CHECK(stale.error().code == "assets.editor_profiler_session_mismatch");
}

TEST_CASE("Gap-free profiler deltas reconstruct the retained full history",
          "[assets][telemetry-matrix][profiler][history]")
{
    core::EditorAssetProfilerService service;
    for (std::size_t index = 0; index < 12; ++index)
        service.record({.kind = core::AssetTelemetryEventKind::PreparationCompleted});

    const auto first = service.capture_on_owner();
    std::vector<core::AssetProfilerChange> reconstructed = first.retained_changes;
    auto cursor = first.latest_sequence;

    for (std::size_t index = 0; index < 7; ++index)
        service.record({.kind = core::AssetTelemetryEventKind::Evicted});
    const auto delta = service.capture_delta_on_owner(first.session_id, cursor);
    REQUIRE(delta);
    REQUIRE_FALSE(delta.value().history_gap);
    reconstructed.insert(reconstructed.end(), delta.value().changes.begin(),
                         delta.value().changes.end());
    cursor = delta.value().latest_sequence;

    const auto later = service.capture_on_owner();
    CHECK(cursor == later.latest_sequence);
    REQUIRE(reconstructed.size() == later.retained_changes.size());
    for (std::size_t index = 0; index < reconstructed.size(); ++index) {
        CHECK(reconstructed[index].sequence == later.retained_changes[index].sequence);
        CHECK(reconstructed[index].timestamp_ns == later.retained_changes[index].timestamp_ns);
    }
}

TEST_CASE("Editor asset profiler sends one authoritative inventory replacement per revision",
          "[assets][telemetry-matrix][profiler][inventory]")
{
    core::EditorAssetProfilerService service;
    std::vector<core::AssetProfilerEntry> inventory;
    service.set_inventory_provider([&inventory] { return inventory; });

    const auto empty = service.capture_on_owner();
    CHECK(empty.inventory_revision == 0);
    CHECK(empty.assets.empty());
    CHECK(empty.latest_sequence.value == 0);

    inventory.push_back(
        {.cache_key = {.stable_identity = "texture|project:/hero.png|0", .source_generation = {7}},
         .asset_type = core::AssetProfilerAssetType::Image,
         .display_identity = "project:/hero.png",
         .state = core::AssetProfilerState::Prefetched,
         .request_origin = core::AssetProfilerRequestOrigin::Prefetched,
         .retention_reason = core::AssetProfilerRetentionReason::Prefetched,
         .committed_cost = assets::ResidencyCost{.gpu_bytes = 4096},
         .removable = true});
    service.record_inventory_maybe_changed();
    service.flush_frame_on_owner();

    const auto changed = service.capture_delta_on_owner(empty.session_id, empty.latest_sequence);
    REQUIRE(changed);
    CHECK(changed.value().inventory_revision == 1);
    REQUIRE(changed.value().replacement_inventory.has_value());
    REQUIRE(changed.value().replacement_inventory->size() == 1);
    CHECK(changed.value().replacement_inventory->front().state ==
          core::AssetProfilerState::Prefetched);
    REQUIRE(changed.value().changes.size() == 2);
    CHECK(std::holds_alternative<core::AssetProfilerInventoryChanged>(
        changed.value().changes.front().payload));
    CHECK(std::holds_alternative<core::AssetProfilerMemoryPoint>(
        changed.value().changes.back().payload));
    CHECK(changed.value().memory.asset_counts.prefetched == 1);
    CHECK(std::get<core::AssetProfilerMemoryPoint>(changed.value().changes.back().payload)
              .asset_counts.prefetched == 1);

    service.record_inventory_maybe_changed();
    service.flush_frame_on_owner();
    const auto unchanged =
        service.capture_delta_on_owner(empty.session_id, changed.value().latest_sequence);
    REQUIRE(unchanged);
    CHECK(unchanged.value().inventory_revision == 1);
    CHECK_FALSE(unchanged.value().replacement_inventory.has_value());
    CHECK(unchanged.value().changes.empty());
}

TEST_CASE("Editor asset profiler tracks exact memory peaks and coalesces frame points",
          "[assets][telemetry-matrix][profiler][memory]")
{
    core::EditorAssetProfilerService service;
    assets::ResidencyAccountingSnapshot accounting;
    assets::ResidencyCost warm;
    service.set_memory_provider([&] { return std::pair{accounting, warm}; },
                                {.target = assets::AssetMemoryTarget::Desktop,
                                 .preset = assets::AssetMemoryPreset::Custom,
                                 .budget = {.source_bytes = 1000,
                                            .prepared_cpu_bytes = 2000,
                                            .gpu_bytes = 3000,
                                            .audio_bytes = 4000,
                                            .temporary_bytes = 5000,
                                            .prefetch_allowance_percent = 25}});

    accounting.current = {.source_bytes = 100,
                          .prepared_cpu_bytes = 300,
                          .gpu_bytes = 60,
                          .audio_bytes = 50,
                          .temporary_bytes = 700};
    service.record_accounting_change(accounting);
    const auto before_frame_flush = service.capture_on_owner();
    CHECK(before_frame_flush.memory.current.asset.source_bytes == 100);
    CHECK(before_frame_flush.memory.current.asset.temporary_bytes == 700);
    CHECK(before_frame_flush.memory.current.asset_ram_bytes == 450);
    CHECK(before_frame_flush.memory.peak.asset.temporary_bytes == 700);
    CHECK(before_frame_flush.retained_changes.empty());

    accounting.current = {.source_bytes = 50,
                          .prepared_cpu_bytes = 900,
                          .gpu_bytes = 80,
                          .audio_bytes = 25,
                          .temporary_bytes = 100};
    service.record_accounting_change(accounting);
    warm = {.source_bytes = 40, .prepared_cpu_bytes = 200, .gpu_bytes = 300, .audio_bytes = 400};
    service.flush_frame_on_owner();

    const auto first = service.capture_on_owner();
    CHECK(first.memory.current.asset.source_bytes == 50);
    CHECK(first.memory.current.asset.prepared_cpu_bytes == 900);
    CHECK(first.memory.current.asset.gpu_bytes == 80);
    CHECK(first.memory.current.asset.audio_bytes == 25);
    CHECK(first.memory.current.asset.temporary_bytes == 100);
    CHECK(first.memory.current.warm.source_bytes == 40);
    CHECK(first.memory.current.warm.prepared_cpu_bytes == 200);
    CHECK(first.memory.current.warm.gpu_bytes == 300);
    CHECK(first.memory.current.warm.audio_bytes == 400);
    CHECK(first.memory.current.warm.temporary_bytes == 0);
    CHECK(first.memory.current.asset_ram_bytes == 975);
    CHECK(first.memory.peak.asset.source_bytes == 100);
    CHECK(first.memory.peak.asset.prepared_cpu_bytes == 900);
    CHECK(first.memory.peak.asset.gpu_bytes == 80);
    CHECK(first.memory.peak.asset.audio_bytes == 50);
    CHECK(first.memory.peak.asset.temporary_bytes == 700);
    CHECK(first.memory.peak.asset_ram_bytes == 975);
    CHECK(first.memory.policy.budget.source_bytes == 1000);
    CHECK(first.memory.policy.budget.prepared_cpu_bytes == 2000);
    CHECK(first.memory.policy.budget.gpu_bytes == 3000);
    CHECK(first.memory.policy.budget.audio_bytes == 4000);
    CHECK(first.memory.policy.budget.prefetch_allowance_percent == 25);
    CHECK(first.memory.accounting_revision == 2);
    REQUIRE(first.retained_changes.size() == 1);
    CHECK(std::holds_alternative<core::AssetProfilerMemoryPoint>(
        first.retained_changes.front().payload));

    service.flush_frame_on_owner();
    const auto unchanged = service.capture_on_owner();
    CHECK(unchanged.retained_changes.size() == 1);

    accounting.current = {.source_bytes = 800, .prepared_cpu_bytes = 100};
    service.record_accounting_change(accounting);
    accounting.current = {.source_bytes = 100, .prepared_cpu_bytes = 800};
    service.record_accounting_change(accounting);
    service.flush_frame_on_owner();
    const auto combined = service.capture_on_owner();
    CHECK(combined.memory.peak.asset.source_bytes == 800);
    CHECK(combined.memory.peak.asset.prepared_cpu_bytes == 900);
    CHECK(combined.memory.peak.asset_ram_bytes == 975);

    accounting.current = {.source_bytes = 40, .prepared_cpu_bytes = 60, .audio_bytes = 20};
    service.record_accounting_change(accounting);
    const auto old_session = combined.session_id;
    service.rotate_session_on_owner();
    const auto rotated = service.capture_on_owner();
    CHECK(rotated.session_id != old_session);
    CHECK(rotated.memory.current.asset_ram_bytes == 120);
    CHECK(rotated.memory.peak.asset_ram_bytes == 120);
    CHECK(rotated.memory.peak.asset.source_bytes == 40);
    CHECK(rotated.memory.peak.asset.prepared_cpu_bytes == 60);
    CHECK(rotated.memory.peak.asset.audio_bytes == 20);
    CHECK(rotated.memory.accounting_revision == 0);
}

TEST_CASE("Editor asset profiler reports renderer estimates without double counting asset GPU cost",
          "[assets][telemetry-matrix][profiler][memory]")
{
    auto now = std::chrono::steady_clock::time_point{};
    core::EditorAssetProfilerService service([&] { return now; });
    assets::ResidencyAccountingSnapshot accounting{.current = {.gpu_bytes = 1234},
                                                   .high_water = {.gpu_bytes = 1234}};
    service.set_memory_provider([&] { return std::pair{accounting, assets::ResidencyCost{}}; }, {});
    core::AssetProfilerRendererEstimate estimate{.ordinary_texture_bytes = 4000,
                                                 .render_target_bytes = 6000};
    std::uint64_t sample_count = 0;
    service.set_renderer_statistics_provider([&] {
        ++sample_count;
        return estimate;
    });
    service.record_accounting_change(accounting);
    service.flush_frame_on_owner();
    const auto available = service.capture_on_owner();
    CHECK(sample_count == 1);
    CHECK(available.memory.current.renderer_estimate.ordinary_texture_bytes == 4000);
    CHECK(available.memory.current.renderer_estimate.render_target_bytes == 6000);
    CHECK(available.memory.current.renderer_estimate.total_bytes() == 10000);
    CHECK(available.memory.current.total_gpu_resource_bytes == 10000);
    CHECK(available.memory.current.asset.gpu_bytes == 1234);
    CHECK(available.memory.peak.total_gpu_resource_bytes == 10000);
    CHECK(available.memory.renderer_sampled_at_ns == 0);
    REQUIRE(available.retained_changes.size() == 1);

    now += std::chrono::milliseconds(999);
    estimate = {.ordinary_texture_bytes = 5000, .render_target_bytes = 5500};
    service.flush_frame_on_owner();
    CHECK(sample_count == 1);

    now += std::chrono::milliseconds(1);
    const auto resampled_before_flush = service.capture_on_owner();
    CHECK(sample_count == 2);
    CHECK(resampled_before_flush.retained_changes.size() == 1);
    CHECK(resampled_before_flush.memory.current.total_gpu_resource_bytes == 10500);
    service.flush_frame_on_owner();
    const auto resampled = service.capture_on_owner();
    CHECK(resampled.retained_changes.size() == 2);
    CHECK(resampled.memory.current.total_gpu_resource_bytes == 10500);
    CHECK(resampled.memory.peak.renderer_estimate.ordinary_texture_bytes == 5000);
    CHECK(resampled.memory.peak.renderer_estimate.render_target_bytes == 6000);
    CHECK(resampled.memory.peak.total_gpu_resource_bytes == 10500);
    CHECK(resampled.memory.renderer_sampled_at_ns == 1'000'000'000);

    now += std::chrono::seconds(1);
    estimate = {.ordinary_texture_bytes = 7000, .render_target_bytes = std::nullopt};
    service.flush_frame_on_owner();
    const auto partial = service.capture_on_owner();
    CHECK(partial.memory.current.renderer_estimate.ordinary_texture_bytes == 7000);
    CHECK_FALSE(partial.memory.current.renderer_estimate.render_target_bytes.has_value());
    CHECK_FALSE(partial.memory.current.total_gpu_resource_bytes.has_value());
    CHECK(partial.memory.peak.renderer_estimate.ordinary_texture_bytes == 7000);
    CHECK(partial.memory.peak.renderer_estimate.render_target_bytes == 6000);
    CHECK(partial.memory.peak.total_gpu_resource_bytes == 10500);

    now += std::chrono::seconds(1);
    estimate = {};
    service.flush_frame_on_owner();
    const auto unavailable = service.capture_on_owner();
    CHECK_FALSE(unavailable.memory.current.renderer_estimate.ordinary_texture_bytes.has_value());
    CHECK_FALSE(unavailable.memory.current.renderer_estimate.render_target_bytes.has_value());
    CHECK_FALSE(unavailable.memory.current.total_gpu_resource_bytes.has_value());
}

TEST_CASE("Editor asset profiler retains bucket-aware generation upserts and outcome totals",
          "[assets][telemetry-matrix][profiler][prefetch]")
{
    core::EditorAssetProfilerService service;
    const assets::AssetCacheKey expected{.stable_identity = "texture|project:/expected.png|0",
                                         .source_generation = {3}};
    const assets::AssetCacheKey possible{.stable_identity = "texture|project:/possible.png|0",
                                         .source_generation = {3}};
    std::vector<core::AssetProfilerEntry> inventory{
        {.cache_key = expected,
         .asset_type = core::AssetProfilerAssetType::Image,
         .display_identity = "project:/expected.png",
         .state = core::AssetProfilerState::Prefetched,
         .request_origin = core::AssetProfilerRequestOrigin::Prefetched,
         .retention_reason = core::AssetProfilerRetentionReason::Prefetched},
        {.cache_key = possible,
         .asset_type = core::AssetProfilerAssetType::Image,
         .display_identity = "project:/possible.png",
         .state = core::AssetProfilerState::Prefetched,
         .request_origin = core::AssetProfilerRequestOrigin::Prefetched,
         .retention_reason = core::AssetProfilerRetentionReason::Prefetched},
    };
    service.set_inventory_provider([&] { return inventory; });

    service.record_prefetch_generation(
        {.generation = {9},
         .expected_next_count = 1,
         .possible_next_count = 1,
         .submitted_entries = {
             {.cache_key = expected, .prediction = core::PrefetchPredictionKind::ExpectedNext},
             {.cache_key = possible, .prediction = core::PrefetchPredictionKind::PossibleNext}}});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchUsed,
                    .cache_key = expected,
                    .prefetch_generation = {9},
                    .request_reason = assets::AssetRequestReason::Demand});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchLate,
                    .cache_key = possible,
                    .prefetch_generation = {9},
                    .request_reason = assets::AssetRequestReason::Demand});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchMiss,
                    .request_reason = assets::AssetRequestReason::Demand});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchUnused,
                    .cache_key = possible,
                    .prefetch_generation = {9}});
    service.record({.kind = core::AssetTelemetryEventKind::ReloadedAfterEviction});

    const auto snapshot = service.capture_on_owner();
    CHECK(snapshot.outcomes.ready_before_use == 1);
    CHECK(snapshot.outcomes.loaded_too_late == 1);
    CHECK(snapshot.outcomes.not_prefetched == 1);
    CHECK(snapshot.outcomes.prefetched_but_unused == 1);
    CHECK(snapshot.outcomes.reloaded_after_removal == 1);
    REQUIRE(snapshot.assets.size() == 2);
    CHECK(snapshot.assets[0].request_origin == core::AssetProfilerRequestOrigin::ExpectedNext);
    CHECK(snapshot.assets[0].retention_reason == core::AssetProfilerRetentionReason::ExpectedNext);
    CHECK(snapshot.assets[1].request_origin == core::AssetProfilerRequestOrigin::PossibleNext);
    CHECK(snapshot.assets[1].retention_reason == core::AssetProfilerRetentionReason::PossibleNext);

    std::vector<core::AssetProfilerPrefetchGenerationRecord> generations;
    for (const auto& change : snapshot.retained_changes) {
        if (const auto* generation =
                std::get_if<core::AssetProfilerPrefetchGenerationRecord>(&change.payload)) {
            generations.push_back(*generation);
        }
    }
    REQUIRE(generations.size() == 4);
    CHECK(generations.back().used_count == 1);
    CHECK(generations.back().late_count == 1);
    CHECK(generations.back().unused_count == 1);

    service.record_prefetch_generation_released({9});
    const auto released = service.capture_on_owner();
    REQUIRE(released.assets.size() == 2);
    CHECK(released.assets[0].request_origin == core::AssetProfilerRequestOrigin::Prefetched);
    CHECK(released.assets[0].retention_reason == core::AssetProfilerRetentionReason::Prefetched);
    CHECK(released.assets[1].request_origin == core::AssetProfilerRequestOrigin::Prefetched);
    CHECK(released.assets[1].retention_reason == core::AssetProfilerRetentionReason::Prefetched);
}

TEST_CASE("Editor asset profiler counts exactly the defined prefetch outcomes and rejections",
          "[assets][telemetry-matrix][profiler][prefetch]")
{
    core::EditorAssetProfilerService service;
    const core::AssetProfilerPrefetchGenerationRecord generation{
        .generation = {14},
        .expected_next_count = 2,
        .submission_failures = {
            {.cache_key = {.stable_identity = "texture|project:/blocked.png|0",
                           .source_generation = {3}},
             .prediction = core::PrefetchPredictionKind::ExpectedNext,
             .diagnostic = {.code = "assets.prefetch_allowance_exceeded", .message = "blocked"}},
            {.cache_key = {.stable_identity = "texture|project:/invalid.png|0",
                           .source_generation = {3}},
             .prediction = core::PrefetchPredictionKind::ExpectedNext,
             .diagnostic = {.code = "assets.invalid_prefetch_request", .message = "invalid"}}}};
    service.record_prefetch_generation(generation);
    service.record_prefetch_generation(generation);
    for (const auto* code :
         {"assets.prefetch_preparation_rejected", "assets.prefetch_preparation_resize_rejected",
          "assets.prefetch_residency_rejected"}) {
        service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                        .prefetch_generation = {14},
                        .diagnostic_code = code});
    }
    service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                    .prefetch_generation = {14},
                    .diagnostic_code = "assets.preparation_deferred"});
    service.record({.kind = core::AssetTelemetryEventKind::BudgetPressure,
                    .diagnostic_code = "assets.prefetch_residency_rejected"});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchUsed,
                    .request_reason = assets::AssetRequestReason::Startup});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchLate,
                    .request_reason = assets::AssetRequestReason::Startup});
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchMiss,
                    .request_reason = assets::AssetRequestReason::Startup});

    const auto snapshot = service.capture_on_owner();
    CHECK(snapshot.outcomes.blocked_by_memory_limit == 4);
    CHECK(snapshot.outcomes.ready_before_use == 0);
    CHECK(snapshot.outcomes.loaded_too_late == 0);
    CHECK(snapshot.outcomes.not_prefetched == 0);
}

TEST_CASE("Editor asset profiler bounds detailed prefetch generation retention",
          "[assets][telemetry-matrix][profiler][prefetch]")
{
    core::EditorAssetProfilerService service;
    for (std::size_t index = 1; index <= core::editor_asset_profiler_change_capacity + 1; ++index) {
        service.record_prefetch_generation({.generation = {static_cast<std::uint64_t>(index)}});
    }

    const auto before_outcome = service.capture_on_owner();
    service.record({.kind = core::AssetTelemetryEventKind::PrefetchUsed,
                    .prefetch_generation = {1},
                    .request_reason = assets::AssetRequestReason::Demand});
    const auto after_outcome = service.capture_on_owner();

    CHECK(after_outcome.latest_sequence.value == before_outcome.latest_sequence.value + 1);
    CHECK(after_outcome.outcomes.ready_before_use == 1);
    REQUIRE_FALSE(after_outcome.retained_changes.empty());
    CHECK(std::holds_alternative<core::AssetTelemetryEvent>(
        after_outcome.retained_changes.back().payload));
}

TEST_CASE("Editor asset profiler retains generations referenced by live inventory",
          "[assets][telemetry-matrix][profiler][prefetch]")
{
    core::EditorAssetProfilerService service;
    std::vector<core::AssetProfilerEntry> inventory{
        {.cache_key = {.stable_identity = "texture|project:/retained.png|0",
                       .source_generation = {1}},
         .asset_type = core::AssetProfilerAssetType::Image,
         .display_identity = "project:/retained.png",
         .state = core::AssetProfilerState::Prefetched,
         .prefetch_generation = assets::PrefetchGenerationId{1}}};
    service.set_inventory_provider([&] { return inventory; });
    service.record_prefetch_generation({.generation = {1}});
    service.record_prefetch_generation({.generation = {2}});
    const auto before_outcome = service.capture_on_owner();

    service.record({.kind = core::AssetTelemetryEventKind::PrefetchUsed,
                    .prefetch_generation = {1},
                    .request_reason = assets::AssetRequestReason::Demand});
    const auto after_outcome = service.capture_on_owner();

    CHECK(after_outcome.latest_sequence.value == before_outcome.latest_sequence.value + 2);
    CHECK(std::holds_alternative<core::AssetProfilerPrefetchGenerationRecord>(
        after_outcome.retained_changes[after_outcome.retained_changes.size() - 2].payload));
}

TEST_CASE("Canceled asset waits remain history but do not inflate overview totals",
          "[assets][telemetry-matrix][profiler][wait]")
{
    auto now = std::chrono::steady_clock::time_point{};
    core::EditorAssetProfilerService service([&] { return now; });
    const core::AssetWaitStart completed{
        .operation = {1},
        .started_at = now,
        .waiting_requests = {
            {.cache_key = {.stable_identity = "texture|project:/a.png|0", .source_generation = {1}},
             .request_id = {7}}}};
    service.record_asset_wait_started(completed);
    CHECK(service.capture_on_owner().retained_changes.empty());
    now += std::chrono::nanoseconds{25};
    service.record_asset_wait_finished(
        {.operation = {1}, .finished_at = now, .result = core::AssetWaitResult::Completed});
    service.record_asset_wait_finished(
        {.operation = {1}, .finished_at = now, .result = core::AssetWaitResult::Completed});

    auto canceled = completed;
    canceled.operation = {2};
    canceled.started_at = now;
    service.record_asset_wait_started(canceled);
    now += std::chrono::nanoseconds{100};
    service.record_asset_wait_finished(
        {.operation = {2}, .finished_at = now, .result = core::AssetWaitResult::Canceled});

    const auto snapshot = service.capture_on_owner();
    CHECK(snapshot.outcomes.asset_wait_count == 1);
    CHECK(snapshot.outcomes.asset_wait_time_ns == 25);
    REQUIRE(snapshot.retained_changes.size() == 2);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[0].payload).result ==
          core::AssetWaitResult::Completed);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[0].payload).started_at_ns == 0);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[0].payload).duration_ns == 25);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[1].payload).result ==
          core::AssetWaitResult::Canceled);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[1].payload).started_at_ns ==
          25);
    CHECK(std::get<core::AssetWaitRecord>(snapshot.retained_changes[1].payload).duration_ns == 100);
}

} // namespace
