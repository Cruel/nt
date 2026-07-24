#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_request_orchestrator.hpp"
#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <ranges>
#include <string>
#include <thread>
#include <vector>

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

class ExpandingTelemetryPreparationTask final
    : public assets::AssetPreparationTask<TelemetryAsset> {
public:
    ExpandingTelemetryPreparationTask(std::uint64_t initial_temporary,
                                      std::uint64_t expanded_temporary)
        : m_temporary(initial_temporary), m_expanded_temporary(expanded_temporary)
    {
    }

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 1, .temporary_bytes = m_temporary};
    }

    [[nodiscard]] bool reservation_update_required_on_owner() const noexcept override
    {
        return m_reservation_update_required;
    }

    void reservation_update_granted_on_owner() noexcept override
    {
        m_reservation_update_required = false;
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        if (!m_expanded) {
            m_expanded = true;
            m_temporary = m_expanded_temporary;
            m_reservation_update_required = true;
        }
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>::success(
            {.asset = TelemetryAsset{.value = 1}, .cost = {.prepared_cpu_bytes = 1}});
    }

private:
    std::uint64_t m_temporary = 0;
    std::uint64_t m_expanded_temporary = 0;
    bool m_expanded = false;
    bool m_reservation_update_required = false;
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

class FailingPreparationTask final : public assets::AssetPreparationTask<TelemetryAsset> {
public:
    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 4, .temporary_bytes = 4};
    }

    [[nodiscard]] assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return assets::AssetCacheState::Preparing;
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.telemetry_fixture_preparation_failed",
                                 .message = "fixture preparation failed"}}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>::failure(
            {{.code = "assets.telemetry_fixture_unreachable_finalize",
              .message = "failed fixture must not finalize"}});
    }
};

class FailingFinalizationTask final : public assets::AssetPreparationTask<TelemetryAsset> {
public:
    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return {.prepared_cpu_bytes = 4, .temporary_bytes = 4};
    }

    [[nodiscard]] assets::AssetCacheState cache_state_for_next_step() const noexcept override
    {
        return assets::AssetCacheState::Preparing;
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext&) noexcept override
    {
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        return core::Result<assets::PreparedAsset<TelemetryAsset>, core::Diagnostics>::failure(
            {{.code = "assets.telemetry_fixture_finalization_failed",
              .message = "fixture owner finalization failed"}});
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
          "[assets][telemetry-matrix][telemetry]")
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
    CHECK(core::editor_asset_profiler_change_capacity == 8192);

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
    CHECK(std::ranges::is_sorted(concurrent_snapshot.retained_events, {},
                                 &core::AssetTelemetryEvent::timestamp));
    CHECK(std::ranges::none_of(concurrent_snapshot.retained_events, [](const auto& event) {
        return event.timestamp == std::chrono::steady_clock::time_point{};
    }));
}

TEST_CASE("Asset telemetry reports deferred mandatory preparation pressure",
          "[assets][telemetry-matrix][telemetry][residency]")
{
    core::AssetTelemetryRecorder recorder(32);
    const assets::ResidencyBudget budget{
        .source_bytes = 64,
        .prepared_cpu_bytes = 64,
        .gpu_bytes = 64,
        .audio_bytes = 64,
        .temporary_bytes = 8,
    };
    assets::AssetResidencyManager residency(budget, &recorder, jobs::JobExecutionMode::InlineTest);

    auto first = residency.reserve_preparation_on_owner({.temporary_bytes = 8},
                                                        assets::AssetRequestReason::Demand);
    REQUIRE(first.admission == assets::ResidencyAdmission::Admitted);
    REQUIRE(first.reservation.has_value());

    const auto deferred = residency.reserve_preparation_on_owner(
        {.temporary_bytes = 1}, assets::AssetRequestReason::Demand);
    CHECK(deferred.admission == assets::ResidencyAdmission::Deferred);
    REQUIRE_FALSE(deferred.diagnostics.empty());
    CHECK(deferred.diagnostics.front().code == "assets.preparation_deferred");

    const auto snapshot = recorder.snapshot_on_owner();
    const auto pressure = std::find_if(
        snapshot.retained_events.begin(), snapshot.retained_events.end(), [](const auto& event) {
            return event.kind == core::AssetTelemetryEventKind::BudgetPressure &&
                   event.diagnostic_code == "assets.preparation_deferred";
        });
    REQUIRE(pressure != snapshot.retained_events.end());
    CHECK(pressure->execution_mode == jobs::JobExecutionMode::InlineTest);
    CHECK(pressure->memory.temporary_bytes == 8);
}

TEST_CASE("Asset telemetry reports exact prefetch outcomes and profiler evidence",
          "[assets][telemetry-matrix][telemetry][prefetch]")
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
        CHECK(residency->evict_on_owner(miss_key, assets::ResidencyEvictionReason::BudgetPressure));

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

    const auto jobs = executor.snapshot_on_owner();
    const auto profiler = recorder.snapshot_on_owner();
    CHECK(jobs.critical.submitted_total >= 3);
    CHECK(jobs.prefetch.submitted_total >= 3);
    CHECK(jobs.critical.maximum_queue_latency > 0ns);
    CHECK(profiler.memory.high_water.temporary_bytes >= 16);
    CHECK(profiler.aggregates.compressed_bytes_read > 0);
    CHECK(profiler.aggregates.uncompressed_bytes_read > 0);
    CHECK(profiler.aggregates.source_read_duration > 0ns);
    CHECK(profiler.aggregates.preparation_duration > 0ns);
    CHECK(profiler.aggregates.owner_finalization_duration > 0ns);
    CHECK(profiler.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::BudgetPressure)] >= 1);
    CHECK(profiler.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::ReloadedAfterEviction)] >= 1);
    const auto pressure = std::find_if(
        profiler.retained_events.begin(), profiler.retained_events.end(), [](const auto& event) {
            return event.kind == core::AssetTelemetryEventKind::BudgetPressure &&
                   event.diagnostic_code == "assets.oversized_mandatory_preparation";
        });
    REQUIRE(pressure != profiler.retained_events.end());

    const auto* miss =
        find_event(profiler, core::AssetTelemetryEventKind::PrefetchMiss, "telemetry:miss");
    REQUIRE(miss != nullptr);
    CHECK(miss->request_id.valid());
    CHECK(miss->job_id.valid());

    const auto* late =
        find_event(profiler, core::AssetTelemetryEventKind::PrefetchLate, "telemetry:late");
    REQUIRE(late != nullptr);
    CHECK(late->request_id.valid());
    CHECK(late->job_id.valid());
    CHECK(late->prefetch_generation == assets::PrefetchGenerationId{101});

    const auto* used =
        find_event(profiler, core::AssetTelemetryEventKind::PrefetchUsed, "telemetry:used");
    REQUIRE(used != nullptr);
    CHECK(used->request_id.valid());
    CHECK(used->job_id.valid());
    CHECK(used->prefetch_generation == assets::PrefetchGenerationId{102});

    const auto* unused =
        find_event(profiler, core::AssetTelemetryEventKind::PrefetchUnused, "telemetry:unused");
    REQUIRE(unused != nullptr);
    CHECK(unused->job_id.valid());
    CHECK(unused->prefetch_generation == assets::PrefetchGenerationId{103});
    CHECK(unused->eviction_reason == assets::ResidencyEvictionReason::ExplicitRelease);

    const auto* source =
        find_event(profiler, core::AssetTelemetryEventKind::SourceReadCompleted, "telemetry:used");
    REQUIRE(source != nullptr);
    CHECK(source->compressed_bytes == 11);
    CHECK(source->uncompressed_bytes == 22);
    CHECK(source->duration > 0ns);

    const auto* preparation =
        find_event(profiler, core::AssetTelemetryEventKind::PreparationCompleted, "telemetry:used");
    REQUIRE(preparation != nullptr);
    CHECK(preparation->duration > 0ns);

    const auto* finalization = find_event(
        profiler, core::AssetTelemetryEventKind::OwnerFinalizationCompleted, "telemetry:used");
    REQUIRE(finalization != nullptr);
    CHECK(finalization->duration > 0ns);

    const auto* eviction =
        find_event(profiler, core::AssetTelemetryEventKind::Evicted, "telemetry:unused");
    REQUIRE(eviction != nullptr);
    CHECK(eviction->eviction_reason == assets::ResidencyEvictionReason::ExplicitRelease);

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

TEST_CASE("Prefetch outcome telemetry classifies one demand per residency lifecycle",
          "[assets][telemetry-matrix][telemetry][prefetch]")
{
    jobs::InlineJobExecutor executor;
    core::AssetTelemetryRecorder recorder(128);
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &recorder,
                                                                     executor.mode());
    assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency, &recorder);

    const auto canceled_key = telemetry_key("telemetry:used-canceled", 1);
    auto canceled_prefetch =
        orchestrator.prefetch_on_owner(canceled_key, assets::PrefetchGenerationId{201},
                                       std::make_unique<TelemetryPreparationTask>(1));
    REQUIRE(canceled_prefetch);
    auto canceled_ticket = std::move(canceled_prefetch).value();
    drive_until_resident(executor, orchestrator, canceled_key);

    auto canceled_demand =
        orchestrator.request_on_owner(canceled_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<TelemetryPreparationTask>(1));
    REQUIRE(canceled_demand);
    auto canceled_handle = std::move(canceled_demand).value();
    CHECK(canceled_handle.state() == assets::AssetRequestState::Ready);
    CHECK(recorder.snapshot_on_owner().event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PrefetchUsed)] == 0);
    canceled_handle.cancel();
    CHECK(
        residency->evict_on_owner(canceled_key, assets::ResidencyEvictionReason::ExplicitRelease));
    canceled_ticket.reset();

    const auto claimed_key = telemetry_key("telemetry:used-once", 1);
    auto claimed_prefetch =
        orchestrator.prefetch_on_owner(claimed_key, assets::PrefetchGenerationId{202},
                                       std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(claimed_prefetch);
    auto claimed_ticket = std::move(claimed_prefetch).value();
    drive_until_resident(executor, orchestrator, claimed_key);
    claimed_ticket.reset();

    auto first_demand =
        orchestrator.request_on_owner(claimed_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<TelemetryPreparationTask>(2));
    auto second_demand =
        orchestrator.request_on_owner(claimed_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(first_demand);
    REQUIRE(second_demand);
    auto first_handle = std::move(first_demand).value();
    auto second_handle = std::move(second_demand).value();

    auto first_lease = std::move(first_handle).take_ready();
    REQUIRE(first_lease);
    auto after_first = recorder.snapshot_on_owner();
    CHECK(after_first.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PrefetchUsed)] == 1);
    const auto* used =
        find_event(after_first, core::AssetTelemetryEventKind::PrefetchUsed, "telemetry:used-once");
    REQUIRE(used != nullptr);
    CHECK(used->prefetch_generation == assets::PrefetchGenerationId{202});
    CHECK(used->request_id.valid());
    CHECK(used->job_id.valid());

    auto newer_prefetch =
        orchestrator.prefetch_on_owner(claimed_key, assets::PrefetchGenerationId{203},
                                       std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(newer_prefetch);
    auto newer_ticket = std::move(newer_prefetch).value();
    newer_ticket.reset();

    auto second_lease = std::move(second_handle).take_ready();
    REQUIRE(second_lease);
    CHECK(recorder.snapshot_on_owner().event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PrefetchUsed)] == 1);

    auto newer_demand =
        orchestrator.request_on_owner(claimed_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(newer_demand);
    auto newer_handle = std::move(newer_demand).value();
    auto newer_lease = std::move(newer_handle).take_ready();
    REQUIRE(newer_lease);
    const auto after_newer = recorder.snapshot_on_owner();
    CHECK(after_newer.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PrefetchUsed)] == 1);
    const auto newer_used =
        std::find_if(after_newer.retained_events.begin(), after_newer.retained_events.end(),
                     [](const auto& event) {
                         return event.kind == core::AssetTelemetryEventKind::PrefetchUsed &&
                                event.prefetch_generation == assets::PrefetchGenerationId{203};
                     });
    CHECK(newer_used == after_newer.retained_events.end());
    first_lease->reset();
    second_lease->reset();
    newer_lease->reset();
    CHECK(residency->evict_on_owner(claimed_key, assets::ResidencyEvictionReason::ExplicitRelease));

    const auto snapshot = recorder.snapshot_on_owner();
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PrefetchUnused)] == 1);
    const auto* unused = find_event(snapshot, core::AssetTelemetryEventKind::PrefetchUnused,
                                    "telemetry:used-canceled");
    REQUIRE(unused != nullptr);
    CHECK(unused->prefetch_generation == assets::PrefetchGenerationId{201});
    CHECK(find_event(snapshot, core::AssetTelemetryEventKind::PrefetchUnused,
                     "telemetry:used-once") == nullptr);

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

TEST_CASE("Startup and coalesced consumers do not duplicate prefetch classifications",
          "[assets][telemetry-matrix][telemetry][prefetch]")
{
    jobs::InlineJobExecutor executor;
    core::AssetTelemetryRecorder recorder(256);
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &recorder,
                                                                     executor.mode());
    assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency, &recorder);

    const auto miss_key = telemetry_key("telemetry:coalesced-miss", 1);
    auto first_miss = orchestrator.request_on_owner(miss_key, assets::AssetRequestReason::Demand,
                                                    std::make_unique<TelemetryPreparationTask>(1));
    auto second_miss = orchestrator.request_on_owner(miss_key, assets::AssetRequestReason::Demand,
                                                     std::make_unique<TelemetryPreparationTask>(1));
    REQUIRE(first_miss);
    REQUIRE(second_miss);
    drive_until_resident(executor, orchestrator, miss_key);
    auto first_miss_lease = std::move(first_miss).value().take_ready();
    auto second_miss_lease = std::move(second_miss).value().take_ready();
    REQUIRE(first_miss_lease);
    REQUIRE(second_miss_lease);

    const auto late_key = telemetry_key("telemetry:coalesced-late", 1);
    auto late_prefetch = orchestrator.prefetch_on_owner(
        late_key, assets::PrefetchGenerationId{301}, std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(late_prefetch);
    auto late_ticket = std::move(late_prefetch).value();
    auto first_late = orchestrator.request_on_owner(late_key, assets::AssetRequestReason::Demand,
                                                    std::make_unique<TelemetryPreparationTask>(2));
    auto second_late = orchestrator.request_on_owner(late_key, assets::AssetRequestReason::Demand,
                                                     std::make_unique<TelemetryPreparationTask>(2));
    REQUIRE(first_late);
    REQUIRE(second_late);
    drive_until_resident(executor, orchestrator, late_key);
    auto first_late_lease = std::move(first_late).value().take_ready();
    auto second_late_lease = std::move(second_late).value().take_ready();
    REQUIRE(first_late_lease);
    REQUIRE(second_late_lease);

    const auto startup_key = telemetry_key("telemetry:startup", 1);
    auto startup = orchestrator.request_on_owner(startup_key, assets::AssetRequestReason::Startup,
                                                 std::make_unique<TelemetryPreparationTask>(3));
    REQUIRE(startup);
    drive_until_resident(executor, orchestrator, startup_key);
    auto startup_lease = std::move(startup).value().take_ready();
    REQUIRE(startup_lease);

    const auto startup_prefetch_key = telemetry_key("telemetry:startup-prefetch", 1);
    auto startup_prefetch =
        orchestrator.prefetch_on_owner(startup_prefetch_key, assets::PrefetchGenerationId{302},
                                       std::make_unique<TelemetryPreparationTask>(4));
    REQUIRE(startup_prefetch);
    auto startup_ticket = std::move(startup_prefetch).value();
    auto startup_join =
        orchestrator.request_on_owner(startup_prefetch_key, assets::AssetRequestReason::Startup,
                                      std::make_unique<TelemetryPreparationTask>(4));
    REQUIRE(startup_join);
    drive_until_resident(executor, orchestrator, startup_prefetch_key);
    auto startup_join_lease = std::move(startup_join).value().take_ready();
    REQUIRE(startup_join_lease);

    const auto snapshot = recorder.snapshot_on_owner();
    const auto count_for = [&](core::AssetTelemetryEventKind kind, std::string_view identity) {
        return std::ranges::count_if(snapshot.retained_events, [&](const auto& event) {
            return event.kind == kind && event.cache_key &&
                   event.cache_key->stable_identity == identity;
        });
    };
    CHECK(count_for(core::AssetTelemetryEventKind::PrefetchMiss, "telemetry:coalesced-miss") == 1);
    CHECK(count_for(core::AssetTelemetryEventKind::PrefetchLate, "telemetry:coalesced-late") == 1);
    CHECK(count_for(core::AssetTelemetryEventKind::PrefetchMiss, "telemetry:startup") == 0);
    CHECK(count_for(core::AssetTelemetryEventKind::PrefetchLate, "telemetry:startup-prefetch") ==
          0);
    CHECK(count_for(core::AssetTelemetryEventKind::PrefetchUsed, "telemetry:startup-prefetch") ==
          0);

    first_miss_lease->reset();
    second_miss_lease->reset();
    first_late_lease->reset();
    second_late_lease->reset();
    startup_lease->reset();
    startup_join_lease->reset();
    late_ticket.reset();
    startup_ticket.reset();
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}

TEST_CASE("Prefetch memory rejection telemetry preserves typed generation correlation",
          "[assets][telemetry-matrix][telemetry][prefetch][residency]")
{
    const auto correlated_pressure = [](const core::AssetTelemetrySnapshot& snapshot,
                                        std::string_view code,
                                        assets::PrefetchGenerationId generation) {
        return std::ranges::find_if(snapshot.retained_events, [&](const auto& event) {
            return event.kind == core::AssetTelemetryEventKind::BudgetPressure &&
                   event.diagnostic_code == code && event.prefetch_generation == generation &&
                   event.request_reason == assets::AssetRequestReason::Prefetch;
        });
    };

    {
        jobs::InlineJobExecutor executor;
        core::AssetTelemetryRecorder recorder(64);
        const assets::ResidencyBudget budget{.source_bytes = 64,
                                             .prepared_cpu_bytes = 64,
                                             .gpu_bytes = 64,
                                             .audio_bytes = 64,
                                             .temporary_bytes = 0};
        auto residency =
            std::make_shared<assets::AssetResidencyManager>(budget, &recorder, executor.mode());
        assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency,
                                                                      &recorder);
        const assets::PrefetchGenerationId generation{401};
        auto rejected = orchestrator.prefetch_on_owner(
            telemetry_key("telemetry:prefetch-preparation-rejected", 1), generation,
            std::make_unique<TelemetryPreparationTask>(1));
        REQUIRE(rejected);
        auto ticket = std::move(rejected).value();
        const auto snapshot = recorder.snapshot_on_owner();
        CHECK(correlated_pressure(snapshot, "assets.prefetch_preparation_rejected", generation) !=
              snapshot.retained_events.end());
        ticket.reset();
        executor.begin_shutdown();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        CHECK(executor.shutdown_complete());
    }

    {
        jobs::InlineJobExecutor executor;
        core::AssetTelemetryRecorder recorder(64);
        const assets::ResidencyBudget budget{.source_bytes = 64,
                                             .prepared_cpu_bytes = 64,
                                             .gpu_bytes = 64,
                                             .audio_bytes = 64,
                                             .temporary_bytes = 4};
        auto residency =
            std::make_shared<assets::AssetResidencyManager>(budget, &recorder, executor.mode());
        assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency,
                                                                      &recorder);
        const assets::PrefetchGenerationId generation{402};
        auto rejected = orchestrator.prefetch_on_owner(
            telemetry_key("telemetry:prefetch-resize-rejected", 1), generation,
            std::make_unique<ExpandingTelemetryPreparationTask>(1, 8));
        REQUIRE(rejected);
        auto ticket = std::move(rejected).value();
        REQUIRE(executor.advance_one_step());
        REQUIRE(executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max()) == 1);
        const auto snapshot = recorder.snapshot_on_owner();
        CHECK(correlated_pressure(snapshot, "assets.prefetch_preparation_resize_rejected",
                                  generation) != snapshot.retained_events.end());
        ticket.reset();
        executor.begin_shutdown();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        CHECK(executor.shutdown_complete());
    }

    {
        jobs::InlineJobExecutor executor;
        core::AssetTelemetryRecorder recorder(64);
        const assets::ResidencyBudget budget{.source_bytes = 64,
                                             .prepared_cpu_bytes = 0,
                                             .gpu_bytes = 64,
                                             .audio_bytes = 64,
                                             .temporary_bytes = 8};
        auto residency =
            std::make_shared<assets::AssetResidencyManager>(budget, &recorder, executor.mode());
        assets::AssetRequestOrchestrator<TelemetryAsset> orchestrator(executor, residency,
                                                                      &recorder);
        const assets::PrefetchGenerationId generation{403};
        auto rejected = orchestrator.prefetch_on_owner(
            telemetry_key("telemetry:prefetch-residency-rejected", 1), generation,
            std::make_unique<TelemetryPreparationTask>(1));
        REQUIRE(rejected);
        auto ticket = std::move(rejected).value();
        while (executor.advance_one_step())
            (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        const auto snapshot = recorder.snapshot_on_owner();
        CHECK(correlated_pressure(snapshot, "assets.prefetch_residency_rejected", generation) !=
              snapshot.retained_events.end());
        ticket.reset();
        executor.begin_shutdown();
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        CHECK(executor.shutdown_complete());
    }
}

TEST_CASE("Asset telemetry preserves stable failure and cancellation evidence",
          "[assets][telemetry-matrix][telemetry][diagnostics]")
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

    const auto preparation_key = telemetry_key("telemetry:preparation-failed", 1);
    auto preparation_result =
        orchestrator.request_on_owner(preparation_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<FailingPreparationTask>());
    REQUIRE(preparation_result);
    auto preparation_failed = std::move(preparation_result).value();
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max()) == 1);
    CHECK(preparation_failed.state() == assets::AssetRequestState::Failed);
    REQUIRE_FALSE(preparation_failed.diagnostics().empty());
    CHECK(preparation_failed.diagnostics().front().code ==
          "assets.telemetry_fixture_preparation_failed");

    const auto finalization_key = telemetry_key("telemetry:finalization-failed", 1);
    auto finalization_result =
        orchestrator.request_on_owner(finalization_key, assets::AssetRequestReason::Demand,
                                      std::make_unique<FailingFinalizationTask>());
    REQUIRE(finalization_result);
    auto finalization_failed = std::move(finalization_result).value();
    REQUIRE(executor.advance_one_step());
    REQUIRE(executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max()) == 1);
    CHECK(finalization_failed.state() == assets::AssetRequestState::Failed);
    REQUIRE_FALSE(finalization_failed.diagnostics().empty());
    CHECK(finalization_failed.diagnostics().front().code ==
          "assets.telemetry_fixture_finalization_failed");

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
              core::AssetTelemetryEventKind::RequestFailed)] == 3);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PreparationFailed)] == 1);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::OwnerFinalizationFailed)] == 1);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestCanceled)] == 1);
    CHECK(snapshot.aggregates.source_read_duration > 0ns);
    CHECK(snapshot.aggregates.preparation_duration > 0ns);
    CHECK(snapshot.aggregates.owner_finalization_duration > 0ns);
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

    const auto* preparation_failure = find_event(
        snapshot, core::AssetTelemetryEventKind::PreparationFailed, "telemetry:preparation-failed");
    REQUIRE(preparation_failure != nullptr);
    CHECK(preparation_failure->diagnostic_code == "assets.telemetry_fixture_preparation_failed");
    CHECK(preparation_failure->duration > 0ns);

    const auto* finalization_failure =
        find_event(snapshot, core::AssetTelemetryEventKind::OwnerFinalizationFailed,
                   "telemetry:finalization-failed");
    REQUIRE(finalization_failure != nullptr);
    CHECK(finalization_failure->diagnostic_code == "assets.telemetry_fixture_finalization_failed");
    CHECK(finalization_failure->duration > 0ns);

    const auto* request_canceled =
        find_event(snapshot, core::AssetTelemetryEventKind::RequestCanceled, "telemetry:canceled");
    REQUIRE(request_canceled != nullptr);
    CHECK(request_canceled->request_id.valid());
    CHECK(request_canceled->job_id.valid());

    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    CHECK(executor.shutdown_complete());
}
