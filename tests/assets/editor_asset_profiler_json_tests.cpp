#include "core/editor_asset_profiler_json.hpp"

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <unordered_set>

namespace noveltea::tests {
namespace {

using Json = nlohmann::json;

constexpr std::uint64_t beyond_javascript_safe_integer = 9'007'199'254'740'993ULL;

core::Diagnostic diagnostic(std::string code, std::string message)
{
    return {.code = std::move(code),
            .message = std::move(message),
            .severity = core::ErrorSeverity::Warning};
}

assets::ResidencyCost cost(std::uint64_t base)
{
    return {.source_bytes = base,
            .prepared_cpu_bytes = base + 1,
            .gpu_bytes = base + 2,
            .audio_bytes = base + 3,
            .temporary_bytes = base + 4};
}

core::AssetProfilerMemorySnapshot memory_snapshot()
{
    return {
        .current = {.asset = cost(beyond_javascript_safe_integer),
                    .warm = cost(20),
                    .asset_ram_bytes = beyond_javascript_safe_integer,
                    .renderer_estimate = {.ordinary_texture_bytes = beyond_javascript_safe_integer,
                                          .render_target_bytes = std::nullopt},
                    .total_gpu_resource_bytes = std::nullopt},
        .peak = {.asset = cost(30),
                 .asset_ram_bytes = 31,
                 .renderer_estimate = {.ordinary_texture_bytes = 32, .render_target_bytes = 33},
                 .total_gpu_resource_bytes = 65},
        .policy = {.target = assets::AssetMemoryTarget::Web,
                   .preset = assets::AssetMemoryPreset::Balanced,
                   .budget = {.source_bytes = 100,
                              .prepared_cpu_bytes = 101,
                              .gpu_bytes = 102,
                              .audio_bytes = 103,
                              .temporary_bytes = 104,
                              .prefetch_allowance_percent = 25}},
        .asset_counts =
            {.in_use = 1, .prefetched = 2, .cached = 3, .loading = 4, .finishing = 5, .failed = 6},
        .accounting_revision = beyond_javascript_safe_integer,
        .renderer_sampled_at_ns = beyond_javascript_safe_integer,
    };
}

core::AssetProfilerEntry asset_entry()
{
    return {
        .cache_key = {.stable_identity = "texture|project:/hero.png|0",
                      .source_generation = {beyond_javascript_safe_integer}},
        .asset_type = core::AssetProfilerAssetType::Image,
        .display_identity = "project:/hero.png",
        .state = core::AssetProfilerState::Prefetched,
        .request_origin = core::AssetProfilerRequestOrigin::ExpectedNext,
        .retention_reason = core::AssetProfilerRetentionReason::ExpectedNext,
        .committed_cost = cost(40),
        .estimated_cost = cost(50),
        .loading_memory_bytes = beyond_javascript_safe_integer,
        .job_id = jobs::JobId{beyond_javascript_safe_integer},
        .prefetch_generation = assets::PrefetchGenerationId{beyond_javascript_safe_integer},
        .completed_prefetch_claimed = false,
        .removable = true,
        .reload_count = beyond_javascript_safe_integer,
        .diagnostics = {diagnostic("assets.test", "test diagnostic")},
    };
}

core::AssetProfilerPrefetchGenerationRecord generation_record()
{
    const assets::AssetCacheKey key{.stable_identity = "texture|project:/hero.png|0",
                                    .source_generation = {beyond_javascript_safe_integer}};
    return {
        .generation = {beyond_javascript_safe_integer},
        .timestamp_ns = beyond_javascript_safe_integer,
        .expected_next_count = beyond_javascript_safe_integer,
        .possible_next_count = 2,
        .submitted_entries = {{.cache_key = key,
                               .prediction = core::PrefetchPredictionKind::ExpectedNext},
                              {.cache_key = key,
                               .prediction = core::PrefetchPredictionKind::PossibleNext}},
        .submission_failures = {{.cache_key = key,
                                 .prediction = core::PrefetchPredictionKind::PossibleNext,
                                 .diagnostic =
                                     diagnostic("assets.prefetch_allowance_exceeded", "blocked")}},
        .used_count = beyond_javascript_safe_integer,
        .late_count = 3,
        .unused_count = 4,
    };
}

core::AssetWaitRecord wait_record(core::AssetWaitResult result, std::uint64_t operation)
{
    return {
        .operation = {operation},
        .phase = core::LoadingPhase::LoadingRuntimeDemand,
        .started_at_ns = beyond_javascript_safe_integer,
        .duration_ns = beyond_javascript_safe_integer,
        .result = result,
        .waiting_requests = {{.cache_key = {.stable_identity = "texture|project:/hero.png|0",
                                            .source_generation = {beyond_javascript_safe_integer}},
                              .request_id = {beyond_javascript_safe_integer}}},
        .diagnostics = result == core::AssetWaitResult::Failed
                           ? core::Diagnostics{diagnostic("assets.wait_failed", "wait failed")}
                           : core::Diagnostics{},
    };
}

core::AssetTelemetryEvent telemetry_event()
{
    return {
        .kind = core::AssetTelemetryEventKind::SourceReadFailed,
        .execution_mode = jobs::JobExecutionMode::Threaded,
        .cache_key = assets::AssetCacheKey{.stable_identity = "texture|project:/hero.png|0",
                                           .source_generation = {beyond_javascript_safe_integer}},
        .job_id = {beyond_javascript_safe_integer},
        .request_id = {beyond_javascript_safe_integer},
        .prefetch_generation = {beyond_javascript_safe_integer},
        .request_reason = assets::AssetRequestReason::Demand,
        .job_priority = jobs::JobPriority::Critical,
        .memory = cost(60),
        .compressed_bytes = beyond_javascript_safe_integer,
        .uncompressed_bytes = beyond_javascript_safe_integer,
        .duration = std::chrono::nanoseconds{static_cast<std::int64_t>(7)},
        .diagnostic_code = "assets.source_read_failed",
    };
}

std::vector<core::AssetProfilerChange> changes()
{
    auto generation_update = generation_record();
    ++generation_update.used_count;
    return {
        {.sequence = {1}, .timestamp_ns = 10, .payload = telemetry_event()},
        {.sequence = {2}, .timestamp_ns = 20, .payload = generation_record()},
        {.sequence = {3}, .timestamp_ns = 30, .payload = generation_update},
        {.sequence = {4},
         .timestamp_ns = 40,
         .payload = wait_record(core::AssetWaitResult::Completed, 31)},
        {.sequence = {5},
         .timestamp_ns = 50,
         .payload = wait_record(core::AssetWaitResult::Failed, 32)},
        {.sequence = {6},
         .timestamp_ns = 60,
         .payload = wait_record(core::AssetWaitResult::Canceled, 33)},
        {.sequence = {7},
         .timestamp_ns = 70,
         .payload = core::AssetProfilerInventoryChanged{beyond_javascript_safe_integer}},
    };
}

void require_decimal_wire_fields(const Json& value)
{
    static const std::unordered_set<std::string> decimal_fields{
        "sessionId",
        "latestSequence",
        "afterSequence",
        "sequence",
        "capturedAtNs",
        "timestampNs",
        "startedAtNs",
        "durationNs",
        "sourceBytes",
        "preparedCpuBytes",
        "gpuBytes",
        "audioBytes",
        "temporaryBytes",
        "assetRamBytes",
        "ordinaryTextureBytes",
        "renderTargetBytes",
        "totalGpuResourceBytes",
        "accountingRevision",
        "rendererSampledAtNs",
        "inUse",
        "prefetched",
        "cached",
        "loading",
        "finishing",
        "failed",
        "readyBeforeUse",
        "loadedTooLate",
        "notPrefetched",
        "blockedByMemoryLimit",
        "prefetchedButUnused",
        "reloadedAfterRemoval",
        "assetWaitCount",
        "assetWaitTimeNs",
        "sourceGeneration",
        "loadingMemoryBytes",
        "jobId",
        "prefetchGeneration",
        "reloadCount",
        "generation",
        "presentationRevision",
        "expectedNextCount",
        "possibleNextCount",
        "usedCount",
        "lateCount",
        "unusedCount",
        "operationId",
        "requestId",
        "compressedBytes",
        "uncompressedBytes",
        "inventoryRevision",
        "earliestRetainedSequence",
        "lostChangeCount",
    };

    if (value.is_object()) {
        for (const auto& [key, child] : value.items()) {
            if (decimal_fields.contains(key) && !child.is_null() && !child.is_object() &&
                !child.is_array()) {
                INFO("Expected canonical decimal string at field " << key);
                REQUIRE(child.is_string());
            }
            require_decimal_wire_fields(child);
        }
    } else if (value.is_array()) {
        for (const auto& child : value)
            require_decimal_wire_fields(child);
    }
}

core::AssetProfilerSnapshot full_snapshot()
{
    return {
        .session_id = {std::numeric_limits<std::uint64_t>::max()},
        .latest_sequence = {7},
        .captured_at_ns = beyond_javascript_safe_integer,
        .memory = memory_snapshot(),
        .outcomes = {.ready_before_use = beyond_javascript_safe_integer,
                     .loaded_too_late = 2,
                     .not_prefetched = 3,
                     .blocked_by_memory_limit = 4,
                     .prefetched_but_unused = 5,
                     .reloaded_after_removal = 6,
                     .asset_wait_count = 7,
                     .asset_wait_time_ns = beyond_javascript_safe_integer},
        .assets = {asset_entry()},
        .inventory_revision = beyond_javascript_safe_integer,
        .retained_changes = changes(),
        .earliest_retained_sequence = {1},
        .lost_change_count = beyond_javascript_safe_integer,
        .history_complete = false,
    };
}

} // namespace

TEST_CASE("Editor asset profiler full JSON uses the exact version 3 wire contract",
          "[assets][telemetry-matrix][profiler][json]")
{
    const auto root = Json::parse(core::serialize_asset_profiler_snapshot(full_snapshot()));
    REQUIRE(root == Json{{"ok", true}, {"payload", root.at("payload")}});
    const auto& payload = root.at("payload");
    CHECK(payload.at("kind") == "full");
    CHECK(payload.at("schemaVersion") == 3);
    CHECK(payload.at("sessionId") == "18446744073709551615");
    CHECK(payload.at("capturedAtNs") == "9007199254740993");
    CHECK(payload.at("assets").at(0).at("jobId") == "9007199254740993");
    CHECK(payload.at("retainedChanges").at(1).at("kind") == "prefetch-generation-upsert");
    CHECK(payload.at("retainedChanges")
              .at(1)
              .at("generation")
              .at("submittedEntries")
              .at(0)
              .at("prediction") == "expected-next");
    CHECK(payload.at("retainedChanges")
              .at(1)
              .at("generation")
              .at("submittedEntries")
              .at(1)
              .at("prediction") == "possible-next");
    CHECK(payload.at("retainedChanges").at(2).at("generation").at("generation") ==
          payload.at("retainedChanges").at(1).at("generation").at("generation"));
    CHECK(payload.at("retainedChanges").at(2).at("generation").at("usedCount") ==
          "9007199254740994");
    CHECK(payload.at("retainedChanges").at(3).at("wait").at("result") == "completed");
    CHECK(payload.at("retainedChanges").at(4).at("wait").at("result") == "failed");
    CHECK(payload.at("retainedChanges").at(5).at("wait").at("result") == "canceled");
    CHECK(payload.at("retainedChanges").at(0).at("event").at("eventKind") == "source-read-failed");
    require_decimal_wire_fields(payload);
}

TEST_CASE("Editor asset profiler delta JSON preserves cursor and replacement semantics",
          "[assets][telemetry-matrix][profiler][json]")
{
    auto delta_memory = memory_snapshot();
    delta_memory.current.renderer_estimate.ordinary_texture_bytes.reset();
    delta_memory.current.renderer_estimate.render_target_bytes.reset();
    delta_memory.current.total_gpu_resource_bytes.reset();
    const core::AssetProfilerDelta delta{
        .session_id = {std::numeric_limits<std::uint64_t>::max()},
        .after_sequence = {beyond_javascript_safe_integer},
        .latest_sequence = {beyond_javascript_safe_integer + 1},
        .captured_at_ns = beyond_javascript_safe_integer,
        .memory = delta_memory,
        .outcomes = {.asset_wait_count = 2, .asset_wait_time_ns = beyond_javascript_safe_integer},
        .replacement_inventory = std::vector<core::AssetProfilerEntry>{asset_entry()},
        .inventory_revision = beyond_javascript_safe_integer,
        .changes = changes(),
        .earliest_retained_sequence = {1},
        .lost_change_count = 2,
        .history_gap = true,
    };

    const auto root = Json::parse(core::serialize_asset_profiler_delta(delta));
    REQUIRE(root.at("ok") == true);
    const auto& payload = root.at("payload");
    CHECK(payload.at("kind") == "delta");
    CHECK(payload.at("afterSequence") == "9007199254740993");
    CHECK(payload.at("historyGap") == true);
    REQUIRE(payload.at("replacementInventory").is_array());
    CHECK(payload.at("changes").at(2).at("generation").at("generation") ==
          payload.at("changes").at(1).at("generation").at("generation"));
    CHECK(payload.at("changes").at(3).at("wait").at("result") == "completed");
    CHECK(payload.at("changes").at(4).at("wait").at("result") == "failed");
    CHECK(payload.at("changes").at(5).at("wait").at("result") == "canceled");
    CHECK(payload.at("memory")
              .at("current")
              .at("rendererEstimate")
              .at("ordinaryTextureBytes")
              .is_null());
    CHECK(payload.at("memory")
              .at("current")
              .at("rendererEstimate")
              .at("renderTargetBytes")
              .is_null());
    CHECK(payload.at("memory").at("current").at("totalGpuResourceBytes").is_null());
    require_decimal_wire_fields(payload);
}

TEST_CASE("Editor asset profiler JSON preserves complete and partial renderer estimates",
          "[assets][telemetry-matrix][profiler][json]")
{
    auto complete = full_snapshot();
    complete.memory.current.renderer_estimate.ordinary_texture_bytes = 100;
    complete.memory.current.renderer_estimate.render_target_bytes = 200;
    complete.memory.current.total_gpu_resource_bytes = 300;
    const auto complete_payload =
        Json::parse(core::serialize_asset_profiler_snapshot(complete)).at("payload");
    CHECK(complete_payload.at("memory").at("current").at("rendererEstimate") ==
          Json{{"ordinaryTextureBytes", "100"}, {"renderTargetBytes", "200"}});
    CHECK(complete_payload.at("memory").at("current").at("totalGpuResourceBytes") == "300");

    const auto partial_payload =
        Json::parse(core::serialize_asset_profiler_snapshot(full_snapshot())).at("payload");
    CHECK(partial_payload.at("memory").at("current").at("rendererEstimate") ==
          Json{{"ordinaryTextureBytes", "9007199254740993"}, {"renderTargetBytes", nullptr}});
    CHECK(partial_payload.at("memory").at("current").at("totalGpuResourceBytes").is_null());
}

TEST_CASE("Editor asset profiler failure JSON is a stable typed envelope",
          "[assets][telemetry-matrix][profiler][json]")
{
    const auto root = Json::parse(core::serialize_asset_profiler_failure(
        {.code = "assets.editor_profiler_cursor_invalid", .message = "invalid cursor"}));
    CHECK(root == Json{{"ok", false},
                       {"error", Json{{"code", "assets.editor_profiler_cursor_invalid"},
                                      {"message", "invalid cursor"}}}});
}

TEST_CASE("Editor asset profiler decimal parser rejects noncanonical and overflowing cursors",
          "[assets][telemetry-matrix][profiler][json]")
{
    std::uint64_t value = 99;
    CHECK(core::parse_asset_profiler_decimal("0", value));
    CHECK(value == 0);
    CHECK(core::parse_asset_profiler_decimal("18446744073709551615", value));
    CHECK(value == std::numeric_limits<std::uint64_t>::max());
    CHECK_FALSE(core::parse_asset_profiler_decimal("", value));
    CHECK_FALSE(core::parse_asset_profiler_decimal("00", value));
    CHECK_FALSE(core::parse_asset_profiler_decimal("01", value));
    CHECK_FALSE(core::parse_asset_profiler_decimal("-1", value));
    CHECK_FALSE(core::parse_asset_profiler_decimal("1.0", value));
    CHECK_FALSE(core::parse_asset_profiler_decimal("18446744073709551616", value));
}

} // namespace noveltea::tests
