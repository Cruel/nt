#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>

namespace {

using namespace noveltea;

struct FakeAsset {
    int value = 0;
};

struct LeaseCounters {
    int pins = 1;
    int marks = 0;
};

class FakeLeaseControl final : public assets::AssetLeaseControl<FakeAsset> {
public:
    FakeLeaseControl(FakeAsset asset, assets::AssetCacheKey key,
                     std::shared_ptr<LeaseCounters> counters)
        : m_asset(asset), m_key(std::move(key)), m_counters(std::move(counters))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner_thread.assert_owner_thread(); }

    void retain_pin_on_owner() noexcept override
    {
        assert_owner_thread();
        ++m_counters->pins;
    }

    void release_pin_on_owner() noexcept override
    {
        assert_owner_thread();
        REQUIRE(m_counters->pins > 0);
        --m_counters->pins;
    }

    void mark_used_on_owner() noexcept override
    {
        assert_owner_thread();
        ++m_counters->marks;
    }

    [[nodiscard]] const FakeAsset& asset_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_asset;
    }

    [[nodiscard]] const assets::AssetCacheKey& cache_key_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_key;
    }

private:
    jobs::OwnerThreadGuard m_owner_thread;
    FakeAsset m_asset;
    assets::AssetCacheKey m_key;
    std::shared_ptr<LeaseCounters> m_counters;
};

struct RequestCounters {
    int cancellations = 0;
    int ready_transfers = 0;
};

class FakeRequestControl final : public assets::AssetRequestControl<FakeAsset> {
public:
    FakeRequestControl(assets::AssetRequestId id, assets::AssetRequestState state,
                       std::shared_ptr<FakeLeaseControl> lease,
                       std::shared_ptr<RequestCounters> request_counters,
                       std::shared_ptr<LeaseCounters> lease_counters)
        : m_id(id), m_state(state), m_lease(std::move(lease)),
          m_request_counters(std::move(request_counters)),
          m_lease_counters(std::move(lease_counters))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner_thread.assert_owner_thread(); }

    [[nodiscard]] assets::AssetRequestId id_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_id;
    }

    [[nodiscard]] assets::AssetRequestState state_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_state;
    }

    [[nodiscard]] core::Diagnostics diagnostics_on_owner() const override
    {
        assert_owner_thread();
        return m_diagnostics;
    }

    void cancel_on_owner() noexcept override
    {
        assert_owner_thread();
        if (m_state == assets::AssetRequestState::Canceled)
            return;
        ++m_request_counters->cancellations;
        if (m_ready_reservation_active) {
            REQUIRE(m_lease_counters->pins > 0);
            --m_lease_counters->pins;
            m_ready_reservation_active = false;
        }
        m_state = assets::AssetRequestState::Canceled;
    }

    [[nodiscard]] std::shared_ptr<assets::AssetLeaseControl<FakeAsset>>
    take_ready_lease_on_owner() noexcept override
    {
        assert_owner_thread();
        if (m_state != assets::AssetRequestState::Ready || !m_ready_reservation_active)
            return {};
        m_ready_reservation_active = false;
        ++m_request_counters->ready_transfers;
        return m_lease;
    }

private:
    jobs::OwnerThreadGuard m_owner_thread;
    assets::AssetRequestId m_id;
    assets::AssetRequestState m_state;
    std::shared_ptr<FakeLeaseControl> m_lease;
    std::shared_ptr<RequestCounters> m_request_counters;
    std::shared_ptr<LeaseCounters> m_lease_counters;
    core::Diagnostics m_diagnostics;
    bool m_ready_reservation_active = true;
};

struct PinCounters {
    int releases = 0;
};

struct TicketCounters {
    int cancellations = 0;
};

class FakePrefetchTicketControl final : public assets::PrefetchTicketControl {
public:
    FakePrefetchTicketControl(assets::AssetRequestId request_id,
                              assets::PrefetchGenerationId generation,
                              std::shared_ptr<TicketCounters> counters)
        : m_request_id(request_id), m_generation(generation), m_counters(std::move(counters))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner_thread.assert_owner_thread(); }

    [[nodiscard]] assets::AssetRequestId request_id_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_request_id;
    }

    [[nodiscard]] assets::PrefetchGenerationId generation_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_generation;
    }

    void cancel_on_owner() noexcept override
    {
        assert_owner_thread();
        if (!m_canceled) {
            ++m_counters->cancellations;
            m_canceled = true;
        }
    }

private:
    jobs::OwnerThreadGuard m_owner_thread;
    assets::AssetRequestId m_request_id;
    assets::PrefetchGenerationId m_generation;
    std::shared_ptr<TicketCounters> m_counters;
    bool m_canceled = false;
};

struct PreparationCounters {
    int releases = 0;
};

class FakePreparationReservationControl final : public assets::PreparationReservationControl {
public:
    FakePreparationReservationControl(assets::PreparationReservationId id,
                                      assets::ResidencyCost cost,
                                      std::shared_ptr<PreparationCounters> counters)
        : m_id(id), m_cost(cost), m_counters(std::move(counters))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner_thread.assert_owner_thread(); }

    [[nodiscard]] assets::PreparationReservationId id_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_id;
    }

    [[nodiscard]] assets::ResidencyCost cost_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_cost;
    }

    void release_on_owner() noexcept override
    {
        assert_owner_thread();
        if (!m_released) {
            ++m_counters->releases;
            m_released = true;
        }
    }

private:
    jobs::OwnerThreadGuard m_owner_thread;
    assets::PreparationReservationId m_id;
    assets::ResidencyCost m_cost;
    std::shared_ptr<PreparationCounters> m_counters;
    bool m_released = false;
};

class FakeReservationPinControl final : public assets::ReservationPinControl {
public:
    FakeReservationPinControl(assets::AssetCacheKey key, std::shared_ptr<PinCounters> counters)
        : m_key(std::move(key)), m_counters(std::move(counters))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner_thread.assert_owner_thread(); }

    [[nodiscard]] const assets::AssetCacheKey& cache_key_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_key;
    }

    void release_on_owner() noexcept override
    {
        assert_owner_thread();
        if (!m_released) {
            ++m_counters->releases;
            m_released = true;
        }
    }

private:
    jobs::OwnerThreadGuard m_owner_thread;
    assets::AssetCacheKey m_key;
    std::shared_ptr<PinCounters> m_counters;
    bool m_released = false;
};

class BoundedFakeTelemetryRecorder final : public core::AssetTelemetrySink {
public:
    explicit BoundedFakeTelemetryRecorder(std::size_t capacity) : m_capacity(capacity) {}

    void record(core::AssetTelemetryEvent event) noexcept override
    {
        std::lock_guard lock(m_mutex);
        ++m_snapshot.event_counts[static_cast<std::size_t>(event.kind)];
        update_high_water(event.memory);
        if (m_capacity == 0)
            return;
        if (m_events.size() == m_capacity) {
            m_events.pop_front();
            ++m_snapshot.lost_event_count;
        }
        m_events.push_back(std::move(event));
    }

    [[nodiscard]] core::AssetTelemetrySnapshot snapshot_on_owner() const override
    {
        m_owner_thread.assert_owner_thread();
        std::lock_guard lock(m_mutex);
        auto copy = m_snapshot;
        copy.retained_events.assign(m_events.begin(), m_events.end());
        return copy;
    }

private:
    void update_high_water(const assets::ResidencyCost& current) noexcept
    {
        m_snapshot.memory.current = current;
        auto& high = m_snapshot.memory.high_water;
        high.source_bytes = std::max(high.source_bytes, current.source_bytes);
        high.prepared_cpu_bytes = std::max(high.prepared_cpu_bytes, current.prepared_cpu_bytes);
        high.gpu_bytes = std::max(high.gpu_bytes, current.gpu_bytes);
        high.audio_bytes = std::max(high.audio_bytes, current.audio_bytes);
        high.temporary_bytes = std::max(high.temporary_bytes, current.temporary_bytes);
    }

    jobs::OwnerThreadGuard m_owner_thread;
    std::size_t m_capacity = 0;
    mutable std::mutex m_mutex;
    std::deque<core::AssetTelemetryEvent> m_events;
    core::AssetTelemetrySnapshot m_snapshot;
};

} // namespace

TEST_CASE("Asset request IDs, generations, and cache states are distinct contracts")
{
    using namespace noveltea;

    STATIC_REQUIRE(!std::is_copy_constructible_v<assets::AssetRequestHandle<FakeAsset>>);
    STATIC_REQUIRE(std::is_move_constructible_v<assets::AssetRequestHandle<FakeAsset>>);
    STATIC_REQUIRE(std::is_copy_constructible_v<assets::AssetLease<FakeAsset>>);
    STATIC_REQUIRE(!std::is_copy_constructible_v<assets::ReservationPin>);

    CHECK_FALSE(assets::AssetRequestId{}.valid());
    CHECK_FALSE(assets::AssetSourceGeneration{}.valid());
    CHECK_FALSE(assets::PrefetchGenerationId{}.valid());
    CHECK(assets::AssetRequestId{7}.valid());
    CHECK(assets::AssetCacheKey{.stable_identity = "texture:hero",
                                .source_generation = assets::AssetSourceGeneration{3}}
              .valid());
    CHECK(assets::AssetCacheState::WaitingForOwnerFinalization !=
          assets::AssetCacheState::Resident);
}

TEST_CASE("Ready request reservations transfer into copyable leases without an eviction gap")
{
    using namespace noveltea;

    const assets::AssetCacheKey key{.stable_identity = "texture:hero",
                                    .source_generation = assets::AssetSourceGeneration{2}};
    auto lease_counters = std::make_shared<LeaseCounters>();
    auto request_counters = std::make_shared<RequestCounters>();
    auto lease_control =
        std::make_shared<FakeLeaseControl>(FakeAsset{.value = 42}, key, lease_counters);
    auto handle = assets::AssetRequestHandle<FakeAsset>::from_control_on_owner(
        std::make_unique<FakeRequestControl>(assets::AssetRequestId{9},
                                             assets::AssetRequestState::Ready, lease_control,
                                             request_counters, lease_counters));

    CHECK(handle.id() == assets::AssetRequestId{9});
    CHECK(handle.state() == assets::AssetRequestState::Ready);
    CHECK(lease_counters->pins == 1);

    auto lease = std::move(handle).take_ready();
    REQUIRE(lease);
    CHECK_FALSE(handle);
    CHECK(request_counters->ready_transfers == 1);
    CHECK(request_counters->cancellations == 0);
    CHECK(lease_counters->pins == 1);
    CHECK((*lease)->value == 42);
    CHECK(lease->cache_key() == key);

    {
        auto copy = *lease;
        CHECK(lease_counters->pins == 2);
        copy.mark_used_on_owner();
        CHECK(lease_counters->marks == 1);
    }
    CHECK(lease_counters->pins == 1);

    lease.reset();
    CHECK(lease_counters->pins == 0);
}

TEST_CASE("Destroying a request detaches its consumer and releases a ready reservation")
{
    using namespace noveltea;

    const assets::AssetCacheKey key{.stable_identity = "audio:voice",
                                    .source_generation = assets::AssetSourceGeneration{5}};
    auto lease_counters = std::make_shared<LeaseCounters>();
    auto request_counters = std::make_shared<RequestCounters>();
    auto lease_control =
        std::make_shared<FakeLeaseControl>(FakeAsset{.value = 8}, key, lease_counters);
    {
        auto handle = assets::AssetRequestHandle<FakeAsset>::from_control_on_owner(
            std::make_unique<FakeRequestControl>(assets::AssetRequestId{11},
                                                 assets::AssetRequestState::Ready, lease_control,
                                                 request_counters, lease_counters));
        CHECK(lease_counters->pins == 1);
    }

    CHECK(request_counters->cancellations == 1);
    CHECK(lease_counters->pins == 0);
}

TEST_CASE("Reservation pins are move-only owner-thread RAII contracts")
{
    using namespace noveltea;

    const assets::AssetCacheKey key{.stable_identity = "material:dialogue",
                                    .source_generation = assets::AssetSourceGeneration{1}};
    auto counters = std::make_shared<PinCounters>();
    {
        auto pin = assets::ReservationPin::from_control_on_owner(
            std::make_unique<FakeReservationPinControl>(key, counters));
        CHECK(pin.cache_key() == key);
        auto moved = std::move(pin);
        CHECK_FALSE(pin);
        CHECK(moved);
        CHECK(counters->releases == 0);
    }
    CHECK(counters->releases == 1);
}

TEST_CASE("Prefetch tickets detach one generation without creating a ready reservation")
{
    using namespace noveltea;

    auto counters = std::make_shared<TicketCounters>();
    {
        auto ticket = assets::PrefetchTicket::from_control_on_owner(
            std::make_unique<FakePrefetchTicketControl>(
                assets::AssetRequestId{13}, assets::PrefetchGenerationId{21}, counters));
        CHECK(ticket.request_id() == assets::AssetRequestId{13});
        CHECK(ticket.generation() == assets::PrefetchGenerationId{21});
        auto moved = std::move(ticket);
        CHECK_FALSE(ticket);
        CHECK(moved);
        CHECK(counters->cancellations == 0);
    }
    CHECK(counters->cancellations == 1);
}

TEST_CASE("Preparation reservations release temporary accounting through move-only RAII")
{
    using namespace noveltea;

    auto counters = std::make_shared<PreparationCounters>();
    const assets::ResidencyCost cost{.temporary_bytes = 4096};
    {
        auto reservation = assets::PreparationReservation::from_control_on_owner(
            std::make_unique<FakePreparationReservationControl>(assets::PreparationReservationId{4},
                                                                cost, counters));
        CHECK(reservation.id() == assets::PreparationReservationId{4});
        CHECK(reservation.cost() == cost);
        auto moved = std::move(reservation);
        CHECK_FALSE(reservation);
        CHECK(moved);
        CHECK(counters->releases == 0);
    }
    CHECK(counters->releases == 1);
}

TEST_CASE("Residency cost and admission contracts separate resident and temporary memory")
{
    using namespace noveltea;

    const assets::ResidencyCost cost{
        .source_bytes = 10,
        .prepared_cpu_bytes = 20,
        .gpu_bytes = 30,
        .audio_bytes = 40,
        .temporary_bytes = 50,
    };
    CHECK(cost.resident_bytes() == 100);
    CHECK(cost.total_bytes() == 150);
    CHECK(assets::ResidencyClass::Pinned != assets::ResidencyClass::Warm);
    CHECK(assets::ResidencyAdmission::AdmittedOverBudget !=
          assets::ResidencyAdmission::RejectedPrefetch);
}

TEST_CASE("Bounded telemetry fakes retain aggregates with zero or finite event capacity")
{
    using namespace noveltea;

    BoundedFakeTelemetryRecorder aggregate_only(0);
    aggregate_only.record(core::AssetTelemetryEvent{
        .kind = core::AssetTelemetryEventKind::CacheHit,
        .memory = {.prepared_cpu_bytes = 12},
    });
    const auto aggregate_snapshot = aggregate_only.snapshot_on_owner();
    CHECK(aggregate_snapshot.retained_events.empty());
    CHECK(aggregate_snapshot.lost_event_count == 0);
    CHECK(aggregate_snapshot
              .event_counts[static_cast<std::size_t>(core::AssetTelemetryEventKind::CacheHit)] ==
          1);
    CHECK(aggregate_snapshot.memory.high_water.prepared_cpu_bytes == 12);

    BoundedFakeTelemetryRecorder ring(2);
    ring.record(core::AssetTelemetryEvent{.kind = core::AssetTelemetryEventKind::CacheMiss});
    ring.record(core::AssetTelemetryEvent{.kind = core::AssetTelemetryEventKind::PrefetchLate});
    ring.record(core::AssetTelemetryEvent{.kind = core::AssetTelemetryEventKind::PrefetchUsed});

    const auto ring_snapshot = ring.snapshot_on_owner();
    REQUIRE(ring_snapshot.retained_events.size() == 2);
    CHECK(ring_snapshot.retained_events[0].kind == core::AssetTelemetryEventKind::PrefetchLate);
    CHECK(ring_snapshot.retained_events[1].kind == core::AssetTelemetryEventKind::PrefetchUsed);
    CHECK(ring_snapshot.lost_event_count == 1);
    CHECK(ring_snapshot
              .event_counts[static_cast<std::size_t>(core::AssetTelemetryEventKind::CacheMiss)] ==
          1);
}
