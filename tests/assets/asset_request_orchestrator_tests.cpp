#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_request_orchestrator.hpp"
#include "noveltea/jobs/cooperative_job_executor.hpp"
#include "noveltea/jobs/inline_job_executor.hpp"
#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace std::chrono_literals;

struct TestAsset {
    int value = 0;
};

struct TaskProbe {
    std::atomic<std::uint64_t> steps = 0;
    std::atomic<std::uint64_t> finalizations = 0;
    std::atomic<std::uint64_t> destructions = 0;
    std::atomic<bool> entered = false;
    std::atomic<bool> wrong_owner_thread = false;
    std::thread::id owner_thread{};
};

class ProbePreparationTask final : public assets::AssetPreparationTask<TestAsset> {
public:
    ProbePreparationTask(std::shared_ptr<TaskProbe> probe, int value, assets::ResidencyCost cost,
                         std::shared_ptr<std::atomic<bool>> release = {},
                         std::uint64_t yielded_steps = 0)
        : m_probe(std::move(probe)), m_value(value), m_cost(cost), m_release(std::move(release)),
          m_yielded_steps(yielded_steps)
    {
    }

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override
    {
        return m_cost;
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        m_probe->entered.store(true, std::memory_order_release);
        m_probe->steps.fetch_add(1, std::memory_order_relaxed);
        if (m_release != nullptr) {
            while (!m_release->load(std::memory_order_acquire)) {
                if (context.cancellation_requested())
                    return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
                std::this_thread::yield();
            }
        }
        if (m_yielded_steps > 0) {
            --m_yielded_steps;
            return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    [[nodiscard]] core::Result<assets::PreparedAsset<TestAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override
    {
        if (std::this_thread::get_id() != m_probe->owner_thread)
            m_probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
        m_probe->finalizations.fetch_add(1, std::memory_order_relaxed);
        auto probe = m_probe;
        return core::Result<assets::PreparedAsset<TestAsset>, core::Diagnostics>::success(
            assets::PreparedAsset<TestAsset>{
                .asset = TestAsset{.value = m_value},
                .cost = m_cost,
                .destroy_on_owner =
                    [probe = std::move(probe)](TestAsset&) {
                        if (std::this_thread::get_id() != probe->owner_thread)
                            probe->wrong_owner_thread.store(true, std::memory_order_relaxed);
                        probe->destructions.fetch_add(1, std::memory_order_relaxed);
                    },
            });
    }

private:
    std::shared_ptr<TaskProbe> m_probe;
    int m_value = 0;
    assets::ResidencyCost m_cost;
    std::shared_ptr<std::atomic<bool>> m_release;
    std::uint64_t m_yielded_steps = 0;
};

class TestTelemetrySink final : public core::AssetTelemetrySink {
public:
    void record(core::AssetTelemetryEvent event) noexcept override
    {
        std::lock_guard lock(m_mutex);
        ++m_snapshot.event_counts[static_cast<std::size_t>(event.kind)];
        if (event.memory_policy)
            m_snapshot.memory_policy = event.memory_policy;
        m_events.push_back(std::move(event));
    }

    [[nodiscard]] core::AssetTelemetrySnapshot snapshot_on_owner() const override
    {
        std::lock_guard lock(m_mutex);
        auto result = m_snapshot;
        result.retained_events = m_events;
        return result;
    }

private:
    mutable std::mutex m_mutex;
    std::vector<core::AssetTelemetryEvent> m_events;
    core::AssetTelemetrySnapshot m_snapshot;
};

assets::ResidencyBudget generous_budget()
{
    return {.source_bytes = 1024,
            .prepared_cpu_bytes = 1024,
            .gpu_bytes = 1024,
            .audio_bytes = 1024,
            .temporary_bytes = 1024};
}

assets::AssetCacheKey key(std::string identity, std::uint64_t generation)
{
    return {.stable_identity = std::move(identity),
            .source_generation = assets::AssetSourceGeneration{generation}};
}

template<class Predicate> bool drive_until(jobs::InlineJobExecutor& executor, Predicate&& predicate)
{
    for (std::size_t iteration = 0; iteration < 1024; ++iteration) {
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        if (!executor.advance_one_step())
            return predicate();
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::CooperativeJobExecutor& executor, Predicate&& predicate)
{
    for (std::size_t iteration = 0; iteration < 1024; ++iteration) {
        executor.pump(10ms);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
    }
    return false;
}

template<class Predicate>
bool drive_until(jobs::SdlThreadPoolJobExecutor& executor, Predicate&& predicate)
{
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    while (std::chrono::steady_clock::now() < deadline) {
        executor.pump(0ns);
        (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        if (predicate())
            return true;
        std::this_thread::sleep_for(1ms);
    }
    return false;
}

void shutdown_executor(jobs::InlineJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}

void shutdown_executor(jobs::CooperativeJobExecutor& executor)
{
    executor.begin_shutdown();
    (void)executor.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
    REQUIRE(executor.shutdown_complete());
}

void shutdown_executor(jobs::SdlThreadPoolJobExecutor& executor)
{
    executor.begin_shutdown();
    REQUIRE(drive_until(executor, [&] { return executor.shutdown_complete(); }));
}

template<class Executor> void run_request_contract(Executor& executor)
{
    TestTelemetrySink telemetry;
    auto residency = std::make_shared<assets::AssetResidencyManager>(generous_budget(), &telemetry);
    const auto owner_thread = std::this_thread::get_id();
    const auto first_key = key("texture:hero", 11);
    const auto replacement_key = key("texture:hero", 12);

    auto primary = std::make_shared<TaskProbe>();
    primary->owner_thread = owner_thread;
    auto discarded_one = std::make_shared<TaskProbe>();
    discarded_one->owner_thread = owner_thread;
    auto discarded_two = std::make_shared<TaskProbe>();
    discarded_two->owner_thread = owner_thread;
    auto release = std::make_shared<std::atomic<bool>>(false);

    {
        assets::AssetRequestOrchestrator<TestAsset> requests(executor, residency, &telemetry);
        auto prefetched = requests.prefetch_on_owner(
            first_key, assets::PrefetchGenerationId{31},
            std::make_unique<ProbePreparationTask>(primary, 41,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 64,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 16},
                                                   release));
        REQUIRE(prefetched);
        auto ticket = std::move(prefetched).value();

        auto first_demand_result = requests.request_on_owner(
            first_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(discarded_one, 99, assets::ResidencyCost{}));
        REQUIRE(first_demand_result);
        auto first_demand = std::move(first_demand_result).value();
        first_demand.cancel();
        CHECK(first_demand.state() == assets::AssetRequestState::Canceled);

        auto second_demand_result = requests.request_on_owner(
            first_key, assets::AssetRequestReason::Startup,
            std::make_unique<ProbePreparationTask>(discarded_two, 100, assets::ResidencyCost{}));
        REQUIRE(second_demand_result);
        auto second_demand = std::move(second_demand_result).value();
        ticket.cancel();
        release->store(true, std::memory_order_release);

        REQUIRE(drive_until(
            executor, [&] { return second_demand.state() == assets::AssetRequestState::Ready; }));
        CHECK(primary->finalizations.load(std::memory_order_relaxed) == 1);
        CHECK(discarded_one->steps.load(std::memory_order_relaxed) == 0);
        CHECK(discarded_two->steps.load(std::memory_order_relaxed) == 0);
        CHECK_FALSE(primary->wrong_owner_thread.load(std::memory_order_relaxed));

        auto first_lease = std::move(second_demand).take_ready();
        REQUIRE(first_lease);
        CHECK((*first_lease)->value == 41);
        CHECK(residency->classification_on_owner(first_key) == assets::ResidencyClass::Pinned);
        auto lease_copy = *first_lease;
        CHECK_FALSE(
            residency->evict_on_owner(first_key, assets::ResidencyEvictionReason::ExplicitRelease));
        first_lease->reset();
        CHECK_FALSE(
            residency->evict_on_owner(first_key, assets::ResidencyEvictionReason::ExplicitRelease));
        lease_copy.reset();
        CHECK(
            residency->evict_on_owner(first_key, assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(primary->destructions.load(std::memory_order_relaxed) == 1);

        auto reload_probe = std::make_shared<TaskProbe>();
        reload_probe->owner_thread = owner_thread;
        auto reload_result = requests.request_on_owner(
            first_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(reload_probe, 42,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 32,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 8},
                                                   nullptr, 1));
        REQUIRE(reload_result);
        auto reload = std::move(reload_result).value();
        REQUIRE(drive_until(executor,
                            [&] { return reload.state() == assets::AssetRequestState::Ready; }));
        auto reload_lease = std::move(reload).take_ready();
        REQUIRE(reload_lease);
        CHECK((*reload_lease)->value == 42);

        requests.invalidate_generation_on_owner(first_key.source_generation);
        CHECK((*reload_lease)->value == 42);
        CHECK(residency->classification_on_owner(first_key) == assets::ResidencyClass::Pinned);
        reload_lease->reset();
        CHECK_FALSE(residency->resident_on_owner(first_key));
        CHECK(reload_probe->destructions.load(std::memory_order_relaxed) == 1);

        auto stale = requests.request_on_owner(
            first_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(reload_probe, 43, assets::ResidencyCost{}));
        REQUIRE_FALSE(stale);
        CHECK(stale.error().code == "assets.invalidated_source_generation");

        auto replacement_probe = std::make_shared<TaskProbe>();
        replacement_probe->owner_thread = owner_thread;
        auto replacement_result = requests.request_on_owner(
            replacement_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(replacement_probe, 44,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 16,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 4}));
        REQUIRE(replacement_result);
        auto replacement = std::move(replacement_result).value();
        REQUIRE(drive_until(
            executor, [&] { return replacement.state() == assets::AssetRequestState::Ready; }));
        auto replacement_lease = std::move(replacement).take_ready();
        REQUIRE(replacement_lease);
        CHECK((*replacement_lease)->value == 44);
        replacement_lease->reset();
        CHECK(residency->evict_on_owner(replacement_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(replacement_probe->destructions.load(std::memory_order_relaxed) == 1);

        const auto canceled_key = key("texture:canceled", 12);
        auto canceled_probe = std::make_shared<TaskProbe>();
        canceled_probe->owner_thread = owner_thread;
        auto canceled_release = std::make_shared<std::atomic<bool>>(false);
        auto canceled_result = requests.request_on_owner(
            canceled_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(canceled_probe, 45, assets::ResidencyCost{},
                                                   canceled_release));
        REQUIRE(canceled_result);
        auto canceled = std::move(canceled_result).value();
        canceled.cancel();
        REQUIRE(drive_until(executor, [&] {
            return requests.cache_state_on_owner(canceled_key) == assets::AssetCacheState::Canceled;
        }));
        canceled_release->store(true, std::memory_order_release);
        CHECK(canceled_probe->finalizations.load(std::memory_order_relaxed) == 0);
    }

    const auto snapshot = telemetry.snapshot_on_owner();
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::RequestCoalesced)] >= 2);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PriorityPromoted)] >= 2);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::PriorityDemoted)] >= 1);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::ReloadedAfterEviction)] >= 1);
    CHECK(residency->accounting_on_owner().current.total_bytes() == 0);
}

class CountingResidentControl final : public assets::ResidentAssetControl {
public:
    CountingResidentControl(std::uint64_t& destructions, std::thread::id owner_thread)
        : m_destructions(destructions), m_owner_thread(owner_thread)
    {
    }

    void assert_owner_thread() const noexcept override
    {
        if (std::this_thread::get_id() != m_owner_thread)
            std::terminate();
    }

    void destroy_on_owner(assets::ResidencyEvictionReason) noexcept override
    {
        assert_owner_thread();
        ++m_destructions;
    }

private:
    std::uint64_t& m_destructions;
    std::thread::id m_owner_thread;
};

assets::ResidencyAdmissionResult admit_cpu(assets::AssetResidencyManager& residency,
                                           const assets::AssetCacheKey& cache_key,
                                           std::uint64_t bytes, assets::AssetRequestReason reason,
                                           std::uint64_t& destructions)
{
    return residency.admit_on_owner({.cache_key = cache_key,
                                     .reason = reason,
                                     .estimated_cost = {.source_bytes = 0,
                                                        .prepared_cpu_bytes = bytes,
                                                        .gpu_bytes = 0,
                                                        .audio_bytes = 0,
                                                        .temporary_bytes = 0},
                                     .resident_control = std::make_shared<CountingResidentControl>(
                                         destructions, std::this_thread::get_id())});
}

} // namespace

TEST_CASE("Typed request and residency contract is executor independent", "[assets][workstream-6d]")
{
    SECTION("inline")
    {
        jobs::InlineJobExecutor executor;
        run_request_contract(executor);
        shutdown_executor(executor);
    }

    SECTION("cooperative")
    {
        jobs::CooperativeJobExecutor executor;
        run_request_contract(executor);
        shutdown_executor(executor);
    }

    SECTION("SDL")
    {
        jobs::SdlThreadPoolJobExecutor executor(1);
        REQUIRE(executor.ready());
        run_request_contract(executor);
        shutdown_executor(executor);
    }
}

TEST_CASE("Preparation reservations defer demand and reject speculative work")
{
    jobs::InlineJobExecutor executor;
    auto residency = std::make_shared<assets::AssetResidencyManager>(
        assets::ResidencyBudget{.source_bytes = 100,
                                .prepared_cpu_bytes = 100,
                                .gpu_bytes = 100,
                                .audio_bytes = 100,
                                .temporary_bytes = 10});
    {
        assets::AssetRequestOrchestrator<TestAsset> requests(executor, residency);
        auto occupied =
            residency->reserve_preparation_on_owner(assets::ResidencyCost{.source_bytes = 0,
                                                                          .prepared_cpu_bytes = 0,
                                                                          .gpu_bytes = 0,
                                                                          .audio_bytes = 0,
                                                                          .temporary_bytes = 10},
                                                    assets::AssetRequestReason::Demand);
        REQUIRE(occupied.reservation);

        auto demand_probe = std::make_shared<TaskProbe>();
        demand_probe->owner_thread = std::this_thread::get_id();
        const auto deferred_key = key("deferred", 1);
        auto demand_result = requests.request_on_owner(
            deferred_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(demand_probe, 7,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 1,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 6}));
        REQUIRE(demand_result);
        auto demand = std::move(demand_result).value();
        CHECK(demand.state() == assets::AssetRequestState::Pending);
        CHECK_FALSE(requests.job_id_on_owner(deferred_key).valid());
        CHECK(requests.retry_deferred_on_owner() == 0);

        occupied.reservation->reset();
        CHECK(requests.retry_deferred_on_owner() == 1);
        REQUIRE(drive_until(executor,
                            [&] { return demand.state() == assets::AssetRequestState::Ready; }));
        auto demand_lease = std::move(demand).take_ready();
        REQUIRE(demand_lease);
        demand_lease->reset();
        CHECK(residency->evict_on_owner(deferred_key,
                                        assets::ResidencyEvictionReason::ExplicitRelease));

        auto occupied_again =
            residency->reserve_preparation_on_owner(assets::ResidencyCost{.source_bytes = 0,
                                                                          .prepared_cpu_bytes = 0,
                                                                          .gpu_bytes = 0,
                                                                          .audio_bytes = 0,
                                                                          .temporary_bytes = 10},
                                                    assets::AssetRequestReason::Demand);
        REQUIRE(occupied_again.reservation);
        auto rejected_probe = std::make_shared<TaskProbe>();
        rejected_probe->owner_thread = std::this_thread::get_id();
        const auto rejected_key = key("rejected-preparation", 1);
        auto rejected = requests.prefetch_on_owner(
            rejected_key, assets::PrefetchGenerationId{2},
            std::make_unique<ProbePreparationTask>(rejected_probe, 8,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 1,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 1}));
        REQUIRE(rejected);
        CHECK(requests.cache_state_on_owner(rejected_key) == assets::AssetCacheState::Canceled);
        CHECK(rejected_probe->steps.load(std::memory_order_relaxed) == 0);
        occupied_again.reservation->reset();
    }
    shutdown_executor(executor);
}

TEST_CASE("Residency admission rejects prefetch but admits over-budget demand and retry")
{
    jobs::InlineJobExecutor executor;
    TestTelemetrySink telemetry;
    auto residency = std::make_shared<assets::AssetResidencyManager>(
        assets::ResidencyBudget{.source_bytes = 5,
                                .prepared_cpu_bytes = 5,
                                .gpu_bytes = 5,
                                .audio_bytes = 5,
                                .temporary_bytes = 5},
        &telemetry);
    const auto cache_key = key("oversized", 3);
    auto prefetch_probe = std::make_shared<TaskProbe>();
    prefetch_probe->owner_thread = std::this_thread::get_id();
    auto demand_probe = std::make_shared<TaskProbe>();
    demand_probe->owner_thread = std::this_thread::get_id();

    {
        assets::AssetRequestOrchestrator<TestAsset> requests(executor, residency, &telemetry);
        auto prefetched = requests.prefetch_on_owner(
            cache_key, assets::PrefetchGenerationId{3},
            std::make_unique<ProbePreparationTask>(prefetch_probe, 1,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 20,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 0}));
        REQUIRE(prefetched);
        auto ticket = std::move(prefetched).value();
        REQUIRE(drive_until(executor, [&] {
            return requests.cache_state_on_owner(cache_key) == assets::AssetCacheState::Canceled;
        }));
        CHECK(prefetch_probe->finalizations.load(std::memory_order_relaxed) == 1);
        CHECK(prefetch_probe->destructions.load(std::memory_order_relaxed) == 1);

        auto demanded = requests.request_on_owner(
            cache_key, assets::AssetRequestReason::Demand,
            std::make_unique<ProbePreparationTask>(demand_probe, 2,
                                                   assets::ResidencyCost{.source_bytes = 0,
                                                                         .prepared_cpu_bytes = 20,
                                                                         .gpu_bytes = 0,
                                                                         .audio_bytes = 0,
                                                                         .temporary_bytes = 0}));
        REQUIRE(demanded);
        auto demand = std::move(demanded).value();
        REQUIRE(drive_until(executor,
                            [&] { return demand.state() == assets::AssetRequestState::Ready; }));
        REQUIRE(demand.diagnostics().size() == 1);
        CHECK(demand.diagnostics().front().code == "assets.mandatory_residency_over_budget");
        auto lease = std::move(demand).take_ready();
        REQUIRE(lease);
        CHECK((*lease)->value == 2);
        CHECK(residency->accounting_on_owner().current.prepared_cpu_bytes == 20);
        lease->reset();
        CHECK(
            residency->evict_on_owner(cache_key, assets::ResidencyEvictionReason::ExplicitRelease));
        CHECK(demand_probe->destructions.load(std::memory_order_relaxed) == 1);
    }
    shutdown_executor(executor);
}

TEST_CASE("Residency manager applies pin warm cold and deterministic LRU policy",
          "[assets][workstream-6d]")
{
    assets::AssetResidencyManager residency(assets::ResidencyBudget{.source_bytes = 100,
                                                                    .prepared_cpu_bytes = 100,
                                                                    .gpu_bytes = 100,
                                                                    .audio_bytes = 100,
                                                                    .temporary_bytes = 10});
    const auto a = key("a", 1);
    const auto b = key("b", 1);
    const auto c = key("c", 1);
    const auto d = key("d", 1);
    std::uint64_t destroyed_a = 0;
    std::uint64_t destroyed_b = 0;
    std::uint64_t destroyed_c = 0;
    std::uint64_t destroyed_d = 0;

    CHECK(admit_cpu(residency, a, 40, assets::AssetRequestReason::Demand, destroyed_a).admission ==
          assets::ResidencyAdmission::Admitted);
    CHECK(admit_cpu(residency, b, 40, assets::AssetRequestReason::Demand, destroyed_b).admission ==
          assets::ResidencyAdmission::Admitted);
    CHECK(residency.attach_prefetch_interest_on_owner(a, assets::PrefetchGenerationId{9}));
    CHECK(residency.classification_on_owner(a) == assets::ResidencyClass::Warm);

    CHECK(admit_cpu(residency, c, 40, assets::AssetRequestReason::Demand, destroyed_c).admission ==
          assets::ResidencyAdmission::Admitted);
    CHECK(destroyed_b == 1);
    CHECK(destroyed_a == 0);
    CHECK(residency.resident_on_owner(a));
    CHECK(residency.resident_on_owner(c));

    auto pin = residency.pin_resident_on_owner(a);
    REQUIRE(pin);
    CHECK(residency.classification_on_owner(a) == assets::ResidencyClass::Pinned);
    CHECK_FALSE(residency.evict_on_owner(a, assets::ResidencyEvictionReason::ExplicitRelease));
    pin.value().reset();
    CHECK(residency.classification_on_owner(a) == assets::ResidencyClass::Warm);
    residency.release_prefetch_interest_on_owner(a, assets::PrefetchGenerationId{9});
    CHECK(residency.classification_on_owner(a) == assets::ResidencyClass::Cold);

    CHECK(admit_cpu(residency, d, 70, assets::AssetRequestReason::Demand, destroyed_d).admission ==
          assets::ResidencyAdmission::Admitted);
    CHECK(destroyed_a == 1);
    CHECK(destroyed_c == 1);
    CHECK(residency.resident_on_owner(d));
    CHECK(residency.accounting_on_owner().current.prepared_cpu_bytes == 70);
    CHECK(residency.accounting_on_owner().high_water.prepared_cpu_bytes == 80);

    CHECK(residency.evict_on_owner(d, assets::ResidencyEvictionReason::ExplicitRelease));
    CHECK(destroyed_d == 1);
    CHECK(residency.accounting_on_owner().current.total_bytes() == 0);

    auto oversized =
        residency.reserve_preparation_on_owner(assets::ResidencyCost{.source_bytes = 0,
                                                                     .prepared_cpu_bytes = 0,
                                                                     .gpu_bytes = 0,
                                                                     .audio_bytes = 0,
                                                                     .temporary_bytes = 20},
                                               assets::AssetRequestReason::Demand);
    CHECK(oversized.admission == assets::ResidencyAdmission::AdmittedOverBudget);
    REQUIRE(oversized.reservation);
    auto deferred =
        residency.reserve_preparation_on_owner(assets::ResidencyCost{.source_bytes = 0,
                                                                     .prepared_cpu_bytes = 0,
                                                                     .gpu_bytes = 0,
                                                                     .audio_bytes = 0,
                                                                     .temporary_bytes = 1},
                                               assets::AssetRequestReason::Demand);
    CHECK(deferred.admission == assets::ResidencyAdmission::Deferred);
    oversized.reservation->reset();
    auto rejected =
        residency.reserve_preparation_on_owner(assets::ResidencyCost{.source_bytes = 0,
                                                                     .prepared_cpu_bytes = 0,
                                                                     .gpu_bytes = 0,
                                                                     .audio_bytes = 0,
                                                                     .temporary_bytes = 20},
                                               assets::AssetRequestReason::Prefetch);
    CHECK(rejected.admission == assets::ResidencyAdmission::RejectedPrefetch);
}

TEST_CASE("Measured asset memory profiles resolve and validate for every target",
          "[assets][workstream-6d]")
{
    struct ExpectedTargetProfiles {
        assets::AssetMemoryTarget target;
        assets::ResidencyBudget low;
        assets::ResidencyBudget balanced;
        assets::ResidencyBudget high;
    };
    constexpr std::uint64_t mib = 1024u * 1024u;
    constexpr ExpectedTargetProfiles expected[]{
        {.target = assets::AssetMemoryTarget::Desktop,
         .low = {64 * mib, 64 * mib, 128 * mib, 32 * mib, 32 * mib, 20},
         .balanced = {128 * mib, 128 * mib, 256 * mib, 64 * mib, 64 * mib, 30},
         .high = {256 * mib, 256 * mib, 512 * mib, 128 * mib, 128 * mib, 40}},
        {.target = assets::AssetMemoryTarget::Android,
         .low = {48 * mib, 48 * mib, 96 * mib, 24 * mib, 24 * mib, 15},
         .balanced = {96 * mib, 96 * mib, 192 * mib, 48 * mib, 48 * mib, 25},
         .high = {192 * mib, 192 * mib, 384 * mib, 96 * mib, 96 * mib, 35}},
        {.target = assets::AssetMemoryTarget::Web,
         .low = {32 * mib, 32 * mib, 64 * mib, 16 * mib, 16 * mib, 10},
         .balanced = {64 * mib, 64 * mib, 128 * mib, 32 * mib, 32 * mib, 20},
         .high = {128 * mib, 128 * mib, 256 * mib, 64 * mib, 64 * mib, 30}},
    };
    for (const auto& target : expected) {
        auto low =
            assets::resolve_asset_memory_policy(target.target, assets::AssetMemoryPreset::Low);
        auto balanced =
            assets::resolve_asset_memory_policy(target.target, assets::AssetMemoryPreset::Balanced);
        auto high =
            assets::resolve_asset_memory_policy(target.target, assets::AssetMemoryPreset::High);
        REQUIRE(low);
        REQUIRE(balanced);
        REQUIRE(high);
        const auto& low_budget = low.value().budget;
        const auto& balanced_budget = balanced.value().budget;
        const auto& high_budget = high.value().budget;
        CHECK(low_budget == target.low);
        CHECK(balanced_budget == target.balanced);
        CHECK(high_budget == target.high);
        CHECK(low_budget.source_bytes == low_budget.prepared_cpu_bytes);
        CHECK(balanced_budget.source_bytes == balanced_budget.prepared_cpu_bytes);
        CHECK(high_budget.source_bytes == high_budget.prepared_cpu_bytes);
        CHECK(low_budget.prepared_cpu_bytes < balanced_budget.prepared_cpu_bytes);
        CHECK(balanced_budget.prepared_cpu_bytes < high_budget.prepared_cpu_bytes);
        CHECK(low_budget.gpu_bytes < balanced_budget.gpu_bytes);
        CHECK(balanced_budget.gpu_bytes < high_budget.gpu_bytes);
        CHECK(low_budget.audio_bytes < balanced_budget.audio_bytes);
        CHECK(balanced_budget.audio_bytes < high_budget.audio_bytes);
        CHECK(low_budget.temporary_bytes >= assets::minimum_temporary_asset_budget_bytes);
        CHECK(low_budget.prefetch_allowance_percent <= 100);
        CHECK(low.value().target == target.target);
    }

    auto inherited = assets::resolve_asset_memory_policy(
        assets::AssetMemoryTarget::Web, assets::AssetMemoryPreset::Custom,
        assets::CustomAssetMemoryPolicy{.gpu_bytes = 96u * 1024u * 1024u,
                                        .prefetch_allowance_percent = 0});
    REQUIRE(inherited);
    CHECK(inherited.value().budget.prepared_cpu_bytes == 64u * 1024u * 1024u);
    CHECK(inherited.value().budget.gpu_bytes == 96u * 1024u * 1024u);
    CHECK(inherited.value().budget.prefetch_allowance_percent == 0);

    auto invalid = assets::resolve_asset_memory_policy(
        assets::AssetMemoryTarget::Desktop, assets::AssetMemoryPreset::Custom,
        assets::CustomAssetMemoryPolicy{.temporary_bytes = 1024,
                                        .prefetch_allowance_percent = 101});
    REQUIRE_FALSE(invalid);
    REQUIRE(invalid.error().size() == 2);
    CHECK(invalid.error()[0].source_path == "/assetMemory/custom/temporaryBytes");
    CHECK(invalid.error()[1].source_path == "/assetMemory/custom/prefetchAllowancePercent");
}

TEST_CASE("Warm allowance protects demand and records deterministic pressure high-water",
          "[assets][workstream-6d]")
{
    TestTelemetrySink telemetry;
    const assets::ResolvedAssetMemoryPolicy policy{
        .target = assets::AssetMemoryTarget::Desktop,
        .preset = assets::AssetMemoryPreset::Custom,
        .budget = {.source_bytes = 100,
                   .prepared_cpu_bytes = 100,
                   .gpu_bytes = 100,
                   .audio_bytes = 100,
                   .temporary_bytes = 10,
                   .prefetch_allowance_percent = 25},
    };
    assets::AssetResidencyManager residency(policy, &telemetry);
    auto snapshot = telemetry.snapshot_on_owner();
    REQUIRE(snapshot.memory_policy);
    CHECK(*snapshot.memory_policy == policy);
    CHECK(snapshot.event_counts[static_cast<std::size_t>(
              core::AssetTelemetryEventKind::MemoryPolicyResolved)] == 1);

    const auto first = key("warm-first", 1);
    const auto second = key("warm-second", 1);
    const auto demand = key("demand", 1);
    const auto oversized = key("oversized", 1);
    std::uint64_t destroyed_first = 0;
    std::uint64_t destroyed_second = 0;
    std::uint64_t destroyed_demand = 0;
    std::uint64_t destroyed_oversized = 0;

    CHECK(admit_cpu(residency, first, 20, assets::AssetRequestReason::Prefetch, destroyed_first)
              .admission == assets::ResidencyAdmission::Admitted);
    CHECK(residency.attach_prefetch_interest_on_owner(first, assets::PrefetchGenerationId{1}));
    CHECK(admit_cpu(residency, second, 10, assets::AssetRequestReason::Prefetch, destroyed_second)
              .admission == assets::ResidencyAdmission::RejectedPrefetch);
    CHECK(admit_cpu(residency, second, 10, assets::AssetRequestReason::Demand, destroyed_second)
              .admission == assets::ResidencyAdmission::Admitted);
    CHECK_FALSE(
        residency.attach_prefetch_interest_on_owner(second, assets::PrefetchGenerationId{1}));

    CHECK(admit_cpu(residency, demand, 90, assets::AssetRequestReason::Demand, destroyed_demand)
              .admission == assets::ResidencyAdmission::Admitted);
    CHECK(destroyed_first == 1);
    CHECK(residency.resident_on_owner(demand));
    CHECK(residency.accounting_on_owner().current.prepared_cpu_bytes == 90);
    CHECK(residency.accounting_on_owner().high_water.prepared_cpu_bytes == 90);

    CHECK(admit_cpu(residency, oversized, 120, assets::AssetRequestReason::Demand,
                    destroyed_oversized)
              .admission == assets::ResidencyAdmission::AdmittedOverBudget);
    CHECK(destroyed_demand == 1);
    CHECK(residency.resident_on_owner(oversized));
    CHECK(residency.accounting_on_owner().current.prepared_cpu_bytes == 120);
    CHECK(residency.accounting_on_owner().high_water.prepared_cpu_bytes == 120);
    CHECK(destroyed_second == 1);
}
