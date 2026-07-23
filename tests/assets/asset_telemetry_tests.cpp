#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_request_orchestrator.hpp"
#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <thread>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

struct TelemetryAsset {
    std::uint32_t value = 0;
};

class TelemetryPreparationTask final : public assets::AssetPreparationTask<TelemetryAsset> {
public:
    explicit TelemetryPreparationTask(std::uint32_t value,
                                      assets::ResidencyCost cost = {.prepared_cpu_bytes = 16,
                                                                    .temporary_bytes = 8})
        : m_value(value), m_cost(cost)
    {
    }

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return m_cost;
    }

    [[nodiscard]] assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return m_read_complete ? assets::AssetCacheState::Preparing
                               : assets::AssetCacheState::Reading;
    }

    [[nodiscard]] assets::AssetPreparationTelemetry telemetry_on_owner() const noexcept override
    {
        return {.compressed_bytes = 11, .uncompressed_bytes = 22};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        if (!m_read_complete) {
            m_read_complete = true;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>::success(
            {.asset = TelemetryAsset{.value = m_value}, .cost = m_cost});
    }

private:
    std::uint32_t m_value = 0;
    assets::ResidencyCost m_cost;
    bool m_read_complete = false;
};

class FailingReadPreparationTask final : public assets::AssetPreparationTask<TelemetryAsset> {
public:
    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 4, .temporary_bytes = 4};
    }

    [[nodiscard]] assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return assets::AssetCacheState::Reading;
    }

    [[nodiscard]] assets::AssetPreparationTelemetry telemetry_on_owner() const noexcept override
    {
        return {.compressed_bytes = 3, .uncompressed_bytes = 7};
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.telemetry_fixture_read_failed",
                                 .message = "fixture source read failed"}}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>::failure(
            {{.code = "assets.telemetry_fixture_unreachable_finalize",
              .message = "failed fixture must not finalize"}});
    }
};

assets::AssetCacheKey telemetry_key(std::string identity, std::uint64_t generation)
{
    return {.stable_identity = std::move(identity),
            .source_generation = assets::AssetSourceGeneration{generation}};
}

assets::ResidencyBudget generous_budget()
{
    return {.source_bytes = 4096,
            .prepared_cpu_bytes = 4096,
            .gpu_bytes = 4096,
            .audio_bytes = 4096,
            .temporary_bytes = 4096};
}

template<class Orchestrator>
void drive_until_resident(jobs::InlineJobExecutor& executor, Orchestrator& orchestrator,
                          const assets::AssetCacheKey& key)
{
    for (std::size_t iteration = 0; iteration < 16; ++iteration) {
        (void)executor.advance_one_step();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (orchestrator.cache_state_on_owner(key) == assets::AssetCacheState::Resident)
            return;
    }
    FAIL("asset did not become resident");
}

const core::AssetTelemetryEvent* find_event(const core::AssetTelemetrySnapshot& snapshot,
                                            core::AssetTelemetryEventKind kind,
                                            const std::string& identity)
{
    for (const auto& event : snapshot.retained_events) {
        if (event.kind == kind && event.cache_key && event.cache_key->stable_identity == identity) {
            return &event;
        }
    }
    return nullptr;
}

} // namespace

TEST_CASE("Production asset telemetry recorder preserves aggregates with bounded retention",
          "[assets][phase-8][telemetry]")
{
    core::AssetTelemetryRecorder aggregate_only(core::production_asset_telemetry_event_capacity);
    aggregate_only.record({.kind = core::AssetTelemetryEventKind::SourceReadCompleted,
                           .memory = {.prepared_cpu_bytes = 12, .temporary_bytes = 24},
                           .compressed_bytes = 7,
                           .uncompressed_bytes = 19,
                           .duration = 3ns});
    aggregate_only.record({.kind = core::AssetTelemetryEventKind::PreparationCompleted,
                           .memory = {.prepared_cpu_bytes = 12},
                           .duration = 5ns});

    const auto aggregate_snapshot = aggregate_only.snapshot_on_owner();
    CHECK(aggregate_snapshot.retained_events.empty());
    CHECK(aggregate_snapshot.lost_event_count == 0);
    CHECK(aggregate_snapshot.aggregates.compressed_bytes_read == 7);
    CHECK(aggregate_snapshot.aggregates.uncompressed_bytes_read == 19);
    CHECK(aggregate_snapshot.aggregates.source_read_duration == 3ns);
    CHECK(aggregate_snapshot.aggregates.preparation_duration == 5ns);
    CHECK(aggregate_snapshot.memory.high_water.temporary_bytes == 24);

    core::AssetTelemetryRecorder ring(2);
    ring.record({.kind = core::AssetTelemetryEventKind::CacheMiss});
    ring.record({.kind = core::AssetTelemetryEventKind::PrefetchLate});
    ring.record({.kind = core::AssetTelemetryEventKind::PrefetchUsed});
    const auto ring_snapshot = ring.snapshot_on_owner();
    REQUIRE(ring_snapshot.retained_events.size() == 2);
    CHECK(ring_snapshot.retained_events[0].kind == core::AssetTelemetryEventKind::PrefetchLate);
    CHECK(ring_snapshot.retained_events[1].kind == core::AssetTelemetryEventKind::PrefetchUsed);
    CHECK(ring_snapshot.lost_event_count == 1);
    CHECK(core::editor_asset_telemetry_event_capacity == 8192);

    core::AssetTelemetryRecorder concurrent(32);
    std::vector<std::thread> workers;
    for (std::size_t worker = 0; worker < 4; ++worker) {
        workers.emplace_back([&concurrent]() {
            for (std::size_t event = 0; event < 100; ++event)
                concurrent.record({.kind = core::AssetTelemetryEventKind::CacheHit});
        });
    }
    for (auto& worker : workers)
        worker.join();
    const auto concurrent_snapshot = concurrent.snapshot_on_owner();
    CHECK(concurrent_snapshot
              .event_counts[static_cast<std::size_t>(core::AssetTelemetryEventKind::CacheHit)] ==
          400);
    CHECK(concurrent_snapshot.retained_events.size() == 32);
    CHECK(concurrent_snapshot.lost_event_count == 368);
}

TEST_CASE("Asset telemetry reports exact prefetch outcomes and profiler evidence",
          "[assets][phase-8][telemetry][prefetch]")
{
    jobs::InlineJobExecutor executor;
    core::AssetTelemetryRecorder recorder(256);

    {
        auto residency = std::make_shared<assets::AssetResidencyManager>(
            generous_budget(), &recorder, executor.mode());
        assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency,
                                                                      &recorder);

        const auto miss_key = telemetry_key("telemetry:miss", 1);
        auto missed = orchestrator.request_on_owner(miss_key, assets::AssetRequestReason::Demand,
                                                    std::make_unique<TelemetryPreparationTask>(1));
        REQUIRE(missed);
        auto miss_handle = std::move(missed).value();
        std::this_thread::sleep_for(1ms);
        drive_until_resident(executor, orchestrator, miss_key);
        auto miss_lease = std::move(miss_handle).take_ready();
        REQUIRE(miss_lease);
        miss_lease.reset();
        CHECK(
            residency->evict_on_owner(miss_key, assets::ResidencyEvictionReason::ExplicitRelease));

        auto reloaded =
            orchestrator.request_on_owner(miss_key, assets::AssetRequestReason::Demand,
                                          std::make_unique<TelemetryPreparationTask>(2));
        REQUIRE(reloaded);
        auto reload_handle = std::move(reloaded).value();
        drive_until_resident(executor, orchestrator, miss_key);
        auto reload_lease = std::move(reload_handle).take_ready();
        REQUIRE(reload_lease);
        reload_lease.reset();
        CHECK(
            residency->evict_on_owner(miss_key, assets::ResidencyEvictionReason::ExplicitRelease));

        const auto late_key = telemetry_key("telemetry:late", 1);
        auto late_prefetch =
            orchestrator.prefetch_on_owner(late_key, assets::PrefetchGenerationId{101},
                                           std::make_unique<TelemetryPreparationTask>(3));
        REQUIRE(late_prefetch);
        auto late_ticket = std::move(late_prefetch).value();
        auto late_demand =
            orchestrator.request_on_owner(late_key, assets::AssetRequestReason::Demand,
                                          std::make_unique<TelemetryPreparationTask>(3));
        REQUIRE(late_demand);
        auto late_handle = std::move(late_demand).value();
        drive_until_resident(executor, orchestrator, late_key);
        auto late_lease = std::move(late_handle).take_ready();
        REQUIRE(late_lease);
        late_lease.reset();
        CHECK(
            residency->evict_on_owner(late_key, assets::ResidencyEvictionReason::ExplicitRelease));
        late_ticket.reset();

        const auto used_key = telemetry_key("telemetry:used", 1);
        auto used_prefetch =
            orchestrator.prefetch_on_owner(used_key, assets::PrefetchGenerationId{102},
                                           std::make_unique<TelemetryPreparationTask>(4));
        REQUIRE(used_prefetch);
        auto used_ticket = std::move(used_prefetch).value();
        drive_until_resident(executor, orchestrator, used_key);
        auto used_demand =
            orchestrator.request_on_owner(used_key, assets::AssetRequestReason::Demand,
                                          std::make_unique<TelemetryPreparationTask>(4));
        REQUIRE(used_demand);
        auto used_handle = std::move(used_demand).value();
        auto used_lease = std::move(used_handle).take_ready();
        REQUIRE(used_lease);
        used_lease.reset();
        CHECK(
            residency->evict_on_owner(used_key, assets::ResidencyEvictionReason::ExplicitRelease));
        used_ticket.reset();

        const auto unused_key = telemetry_key("telemetry:unused", 1);
        auto unused_prefetch =
            orchestrator.prefetch_on_owner(unused_key, assets::PrefetchGenerationId{103},
                                           std::make_unique<TelemetryPreparationTask>(5));
        REQUIRE(unused_prefetch);
        auto unused_ticket = std::move(unused_prefetch).value();
        drive_until_resident(executor, orchestrator, unused_key);
        CHECK(residency->evict_on_owner(unused_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));
        unused_ticket.reset();
    }

    {
        const assets::ResidencyBudget constrained{
            .source_bytes = 4,
            .prepared_cpu_bytes = 4,
            .gpu_bytes = 4,
            .audio_bytes = 4,
            .temporary_bytes = 4,
        };
        auto residency = std::make_shared<assets::AssetResidencyManager>(constrained, &recorder,
                                                                         executor.mode());
        assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency,
                                                                      &recorder);
        const auto pressure_key = telemetry_key("telemetry:pressure", 1);
        auto pressured = orchestrator.request_on_owner(
            pressure_key, assets::AssetRequestReason::Demand,
            std::make_unique<TelemetryPreparationTask>(
                6, assets::ResidencyCost{.prepared_cpu_bytes = 16, .temporary_bytes = 16}));
        REQUIRE(pressured);
        auto pressure_handle = std::move(pressured).value();
        drive_until_resident(executor, orchestrator, pressure_key);
        auto pressure_lease = std::move(pressure_handle).take_ready();
        REQUIRE(pressure_lease);
        pressure_lease.reset();
        if (residency->resident_on_owner(pressure_key)) {
            CHECK(residency->evict_on_owner(pressure_key,
                                            assets::ResidencyEvictionReason::ExplicitRelease));
        }
        CHECK_FALSE(residency->resident_on_owner(pressure_key));
    }

    const auto profiler = core::capture_asset_profiler_snapshot_on_owner(executor, recorder);
    CHECK(profiler.schema_version == core::asset_profiler_snapshot_schema_version);
    CHECK(profiler.captured_at != std::chrono::steady_clock::time_point{});
    CHECK(profiler.jobs.critical.submitted_total >= 3);
    CHECK(profiler.jobs.prefetch.submitted_total >= 3);
    CHECK(profiler.jobs.critical.maximum_queue_latency > 0ns);
    CHECK(profiler.assets.memory.high_water.temporary_bytes >= 16);
    CHECK(profiler.assets.aggregates.compressed_bytes_read > 0);
    CHECK(profiler.assets.aggregates.uncompressed_bytes_read > 0);
    CHECK(profiler.assets.aggregates.source_read_duration > 0ns);
    CHECK(profiler.assets.aggregates.preparation_duration > 0ns);
    CHECK(profiler.assets.aggregates.owner_finalization_duration > 0ns);
    CHECK(profiler.assets.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::BudgetPressure)] >= 1);
    CHECK(profiler.assets.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::ReloadedAfterEviction)] >= 1);
    const auto pressure =
        std::find_if(profiler.assets.retained_events.begin(), profiler.assets.retained_events.end(),
                     [](const auto& event) {
                         return event.kind == core::AssetTelemetryEventKind::BudgetPressure &&
                                event.diagnostic_code == "assets.oversized_mandatory_preparation";
                     });
    REQUIRE(pressure != profiler.assets.retained_events.end());

    const auto* miss =
        find_event(profiler.assets, core::AssetTelemetryEventKind::PrefetchMiss, "telemetry:miss");
    REQUIRE(miss != nullptr);
    CHECK(miss->request_id.valid());
    CHECK(miss->job_id.valid());

    const auto* late =
        find_event(profiler.assets, core::AssetTelemetryEventKind::PrefetchLate, "telemetry:late");
    REQUIRE(late != nullptr);
    CHECK(late->request_id.valid());
    CHECK(late->job_id.valid());
    CHECK(late->prefetch_generation == assets::PrefetchGenerationId{101});

    const auto* used =
        find_event(profiler.assets, core::AssetTelemetryEventKind::PrefetchUsed, "telemetry:used");
    REQUIRE(used != nullptr);
    CHECK(used->request_id.valid());
    CHECK(used->job_id.valid());
    CHECK(used->prefetch_generation == assets::PrefetchGenerationId{102});

    const auto* unused = find_event(profiler.assets, core::AssetTelemetryEventKind::PrefetchUnused,
                                    "telemetry:unused");
    REQUIRE(unused != nullptr);
    CHECK(unused->job_id.valid());
    CHECK(unused->prefetch_generation == assets::PrefetchGenerationId{103});
    CHECK(unused->eviction_reason == assets::ResidencyEvictionReason::ExplicitRelease);

    const auto* source = find_event(
        profiler.assets, core::AssetTelemetryEventKind::SourceReadCompleted, "telemetry:used");
    REQUIRE(source != nullptr);
    CHECK(source->compressed_bytes == 11);
    CHECK(source->uncompressed_bytes == 22);
    CHECK(source->duration > 0ns);

    const auto* preparation = find_event(
        profiler.assets, core::AssetTelemetryEventKind::PreparationCompleted, "telemetry:used");
    REQUIRE(preparation != nullptr);
    CHECK(preparation->duration > 0ns);

    const auto* finalization =
        find_event(profiler.assets, core::AssetTelemetryEventKind::OwnerFinalizationCompleted,
                   "telemetry:used");
    REQUIRE(finalization != nullptr);
    CHECK(finalization->duration > 0ns);

    const auto* eviction =
        find_event(profiler.assets, core::AssetTelemetryEventKind::Evicted, "telemetry:unused");
    REQUIRE(eviction != nullptr);
    CHECK(eviction->eviction_reason == assets::ResidencyEvictionReason::ExplicitRelease);

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

TEST_CASE("Asset telemetry preserves stable failure and cancellation evidence",
          "[assets][phase-8][telemetry][diagnostics]")
{
    jobs::InlineJobExecutor executor;
    core::AssetTelemetryRecorder recorder(64);
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &recorder,
                                                                     executor.mode());
    assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency, &recorder);

    const auto failed_key = telemetry_key("telemetry:failed", 1);
    auto failed_result =
        orchestrator.request_on_owner(failed_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<FailingReadPreparationTask>());
    REQUIRE(failed_result);
    auto failed = std::move(failed_result).value();
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max()) == 1);
    CHECK(failed.state() == assets::AssetRequestState::Failed);
    REQUIRE_FALSE(failed.diagnostics().empty());
    CHECK(failed.diagnostics().front().code == "assets.telemetry_fixture_read_failed");

    const auto canceled_key = telemetry_key("telemetry:canceled", 1);
    auto canceled_result =
        orchestrator.request_on_owner(canceled_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<TelemetryPreparationTask>(9));
    REQUIRE(canceled_result);
    auto canceled = std::move(canceled_result).value();
    canceled.cancel();
    CHECK(canceled.state() == assets::AssetRequestState::Canceled);
    while (executor.advance_one_step()) {}
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());

    const auto snapshot = recorder.snapshot_on_owner();
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestFailed)] == 1);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestCanceled)] == 1);
    const auto* source_failure =
        find_event(snapshot, core::AssetTelemetryEventKind::SourceReadFailed, "telemetry:failed");
    REQUIRE(source_failure != nullptr);
    CHECK(source_failure->diagnostic_code == "assets.telemetry_fixture_read_failed");
    CHECK(source_failure->compressed_bytes == 3);
    CHECK(source_failure->uncompressed_bytes == 7);
    CHECK(source_failure->duration > 0ns);

    const auto* request_failure =
        find_event(snapshot, core::AssetTelemetryEventKind::RequestFailed, "telemetry:failed");
    REQUIRE(request_failure != nullptr);
    CHECK(request_failure->diagnostic_code == "assets.telemetry_fixture_read_failed");
    CHECK(request_failure->request_id.valid());
    CHECK(request_failure->job_id.valid());

    const auto* request_canceled =
        find_event(snapshot, core::AssetTelemetryEventKind::RequestCanceled, "telemetry:canceled");
    REQUIRE(request_canceled != nullptr);
    CHECK(request_canceled->request_id.valid());
    CHECK(request_canceled->job_id.valid());

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}
