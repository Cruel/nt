#include <catch2/catch_test_macros.hpp>

#include "core/editor_asset_profiler_service.hpp"

#include <algorithm>
#include <array>
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

} // namespace
