#include <catch2/catch_test_macros.hpp>

#include "core/editor_asset_profiler_service.hpp"

#include <cstddef>
#include <memory>

namespace {

using namespace noveltea;

TEST_CASE("Editor asset profiler service is composed only for preview widgets",
          "[assets][telemetry-matrix][profiler][composition]")
{
    CHECK_FALSE(core::make_editor_asset_profiler_service(false));

    auto service = core::make_editor_asset_profiler_service(true);
    REQUIRE(service != nullptr);

    core::AssetTelemetrySink* sink = service.get();
    REQUIRE(sink != nullptr);
    for (std::size_t index = 0; index < core::editor_asset_telemetry_event_capacity + 1; ++index)
        sink->record({.kind = core::AssetTelemetryEventKind::CacheHit});

    const auto snapshot = sink->snapshot_on_owner();
    CHECK(snapshot.retained_events.size() == core::editor_asset_telemetry_event_capacity);
    CHECK(snapshot.lost_event_count == 1);
    CHECK(
        snapshot.event_counts[static_cast<std::size_t>(core::AssetTelemetryEventKind::CacheHit)] ==
        core::editor_asset_telemetry_event_capacity + 1);
}

} // namespace
