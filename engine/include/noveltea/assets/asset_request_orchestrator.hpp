#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/asset_residency.hpp"
#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace noveltea::assets {

class AssetManager;

template<class T> struct PreparedAsset {
    T asset;
    ResidencyCost cost;
    std::function<void(T&)> destroy_on_owner;
};

struct AssetPreparationTelemetry {
    std::uint64_t compressed_bytes = 0;
    std::uint64_t uncompressed_bytes = 0;
    std::chrono::nanoseconds source_read_duration{};
    std::chrono::nanoseconds preparation_duration{};
};

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
struct AssetOrchestratorProfilerEntry {
    AssetCacheKey cache_key;
    AssetCacheState cache_state = AssetCacheState::Missing;
    jobs::JobId job_id;
    jobs::JobPriority priority = jobs::JobPriority::Prefetch;
    AssetRequestReason request_origin = AssetRequestReason::Demand;
    ResidencyCost estimated_cost;
    std::uint64_t loading_memory_bytes = 0;
    std::optional<PrefetchGenerationId> prefetch_generation;
    bool completed_prefetch_claimed = false;
    bool has_live_consumer = false;
    bool has_live_prefetch_ticket = false;
    bool invalidated = false;
    std::uint64_t reload_count = 0;
    core::Diagnostics diagnostics;
};
#endif

template<class T> class AssetPreparationTask {
public:
    virtual ~AssetPreparationTask() = default;

    [[nodiscard]] virtual ResidencyCost estimated_cost_on_owner() const noexcept = 0;
    [[nodiscard]] virtual bool reservation_update_required_on_owner() const noexcept
    {
        return false;
    }
    virtual void reservation_update_granted_on_owner() noexcept {}
    [[nodiscard]] virtual AssetCacheState cache_state_for_next_step() const noexcept
    {
        return AssetCacheState::Preparing;
    }
    [[nodiscard]] virtual AssetPreparationTelemetry telemetry_on_owner() const noexcept
    {
        return {};
    }
    [[nodiscard]] virtual jobs::JobStepOutcome step(jobs::JobContext& context) noexcept = 0;
    [[nodiscard]] virtual core::Result<PreparedAsset<T>, core::Diagnostics>
    finalize_on_owner() noexcept = 0;
};

namespace detail {

inline std::atomic<std::uint64_t> g_next_asset_request_id{1};
inline std::atomic<std::uint64_t> g_next_asset_source_generation{1};
inline std::atomic<std::uint64_t> g_next_prefetch_generation_id{1};

template<class Id> std::optional<Id> allocate_process_id(std::atomic<std::uint64_t>& next) noexcept
{
    std::uint64_t candidate = next.load(std::memory_order_relaxed);
    while (candidate != 0 && candidate != std::numeric_limits<std::uint64_t>::max()) {
        if (next.compare_exchange_weak(candidate, candidate + 1, std::memory_order_relaxed,
                                       std::memory_order_relaxed)) {
            return Id{candidate};
        }
    }
    return std::nullopt;
}

template<class T> struct AsyncAssetState;

template<class T> struct AsyncAssetConsumer {
    AssetRequestId id;
    AssetRequestReason reason = AssetRequestReason::Demand;
    AssetRequestState state = AssetRequestState::Pending;
    core::Diagnostics diagnostics;
    std::optional<PrefetchGenerationId> ready_prefetch_generation;
    bool active = true;
    bool reservation_pin = false;
};

template<class T> struct AsyncAssetTicket {
    AssetRequestId request_id;
    PrefetchGenerationId generation;
    bool active = true;
};

template<class T> struct AsyncAssetEntry {
    AssetCacheKey key;
    AssetCacheState state = AssetCacheState::Missing;
    std::atomic<AssetCacheState> active_job_state{AssetCacheState::Missing};
    core::Diagnostics diagnostics;
    jobs::JobId job_id;
    jobs::JobId last_job_id;
    jobs::JobPriority job_priority = jobs::JobPriority::Prefetch;
    AssetRequestReason admission_reason = AssetRequestReason::Prefetch;
    AssetRequestReason request_origin = AssetRequestReason::Prefetch;
    std::optional<PreparationReservation> preparation_reservation;
    std::unique_ptr<AssetPreparationTask<T>> deferred_task;
    ResidencyCost estimated_cost;
    AssetPreparationTelemetry accumulated_preparation;
    std::shared_ptr<T> asset;
    std::function<void(T&)> destroy_on_owner;
    std::vector<std::weak_ptr<AsyncAssetConsumer<T>>> consumers;
    std::vector<std::weak_ptr<AsyncAssetTicket<T>>> tickets;
    bool invalidated = false;
    bool retire_when_unpinned = false;
    bool policy_evicted = false;
    std::uint64_t reload_count = 0;
    bool source_read_completed_recorded = false;
    bool demand_prefetch_classified = false;
    bool prefetch_claimed_by_demand = false;
    std::optional<PrefetchGenerationId> completed_prefetch_generation;
};

template<class T> class AsyncAssetLeaseControl final : public AssetLeaseControl<T> {
public:
    AsyncAssetLeaseControl(std::shared_ptr<AsyncAssetState<T>> state,
                           std::shared_ptr<AsyncAssetEntry<T>> entry)
        : m_state(std::move(state)), m_entry(std::move(entry))
    {
    }

    void assert_owner_thread() const noexcept override { m_state->assert_owner(); }
    void retain_pin_on_owner() noexcept override { m_state->retain_lease_pin(m_entry); }
    void release_pin_on_owner() noexcept override { m_state->release_lease_pin(m_entry); }
    void mark_used_on_owner() noexcept override { m_state->mark_used(m_entry); }
    [[nodiscard]] const T& asset_on_owner() const noexcept override
    {
        assert_owner_thread();
        assert(m_entry->asset != nullptr);
        return *m_entry->asset;
    }
    [[nodiscard]] const AssetCacheKey& cache_key_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_entry->key;
    }

private:
    std::shared_ptr<AsyncAssetState<T>> m_state;
    std::shared_ptr<AsyncAssetEntry<T>> m_entry;
};

template<class T> class AsyncAssetRequestControl final : public AssetRequestControl<T> {
public:
    AsyncAssetRequestControl(std::shared_ptr<AsyncAssetState<T>> state,
                             std::shared_ptr<AsyncAssetEntry<T>> entry,
                             std::shared_ptr<AsyncAssetConsumer<T>> consumer)
        : m_state(std::move(state)), m_entry(std::move(entry)), m_consumer(std::move(consumer))
    {
    }

    void assert_owner_thread() const noexcept override { m_state->assert_owner(); }
    [[nodiscard]] AssetRequestId id_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_consumer->id;
    }
    [[nodiscard]] AssetRequestState state_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_consumer->state;
    }
    [[nodiscard]] core::Diagnostics diagnostics_on_owner() const override
    {
        assert_owner_thread();
        return m_consumer->diagnostics;
    }
    void cancel_on_owner() noexcept override
    {
        assert_owner_thread();
        m_state->cancel_consumer(m_entry, m_consumer);
    }
    [[nodiscard]] std::shared_ptr<AssetLeaseControl<T>>
    take_ready_lease_on_owner() noexcept override
    {
        assert_owner_thread();
        if (!m_consumer->active || m_consumer->state != AssetRequestState::Ready ||
            !m_consumer->reservation_pin || m_entry->asset == nullptr) {
            return {};
        }
        m_state->claim_ready_prefetch(m_entry, m_consumer);
        m_consumer->reservation_pin = false;
        m_consumer->active = false;
        m_state->recompute_interest(m_entry);
        return std::make_shared<AsyncAssetLeaseControl<T>>(m_state, m_entry);
    }

private:
    std::shared_ptr<AsyncAssetState<T>> m_state;
    std::shared_ptr<AsyncAssetEntry<T>> m_entry;
    std::shared_ptr<AsyncAssetConsumer<T>> m_consumer;
};

template<class T> class AsyncAssetPrefetchControl final : public PrefetchTicketControl {
public:
    AsyncAssetPrefetchControl(std::shared_ptr<AsyncAssetState<T>> state,
                              std::shared_ptr<AsyncAssetEntry<T>> entry,
                              std::shared_ptr<AsyncAssetTicket<T>> ticket)
        : m_state(std::move(state)), m_entry(std::move(entry)), m_ticket(std::move(ticket))
    {
    }

    void assert_owner_thread() const noexcept override { m_state->assert_owner(); }
    [[nodiscard]] AssetRequestId request_id_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_ticket->request_id;
    }
    [[nodiscard]] PrefetchGenerationId generation_on_owner() const noexcept override
    {
        assert_owner_thread();
        return m_ticket->generation;
    }
    void cancel_on_owner() noexcept override
    {
        assert_owner_thread();
        m_state->cancel_ticket(m_entry, m_ticket);
    }

private:
    std::shared_ptr<AsyncAssetState<T>> m_state;
    std::shared_ptr<AsyncAssetEntry<T>> m_entry;
    std::shared_ptr<AsyncAssetTicket<T>> m_ticket;
};

template<class T> class AsyncResidentControl final : public ResidentAssetControl {
public:
    AsyncResidentControl(std::weak_ptr<AsyncAssetState<T>> state,
                         std::weak_ptr<AsyncAssetEntry<T>> entry)
        : m_state(std::move(state)), m_entry(std::move(entry))
    {
    }

    void assert_owner_thread() const noexcept override
    {
        if (const auto state = m_state.lock())
            state->assert_owner();
    }

    void destroy_on_owner(ResidencyEvictionReason reason) noexcept override
    {
        const auto state = m_state.lock();
        const auto entry = m_entry.lock();
        if (state == nullptr || entry == nullptr)
            return;
        state->destroy_resident(entry, reason);
    }

private:
    std::weak_ptr<AsyncAssetState<T>> m_state;
    std::weak_ptr<AsyncAssetEntry<T>> m_entry;
};

template<class T> class AsyncAssetLoadJob final : public jobs::JobTask {
public:
    AsyncAssetLoadJob(std::shared_ptr<AsyncAssetState<T>> state,
                      std::shared_ptr<AsyncAssetEntry<T>> entry,
                      std::unique_ptr<AssetPreparationTask<T>> task)
        : m_state(std::move(state)), m_entry(std::move(entry)), m_task(std::move(task))
    {
    }

    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override
    {
        const auto publish_phase = [this]() noexcept {
            const auto phase = m_task->cache_state_for_next_step();
            m_entry->active_job_state.store(phase == AssetCacheState::Reading
                                                ? AssetCacheState::Reading
                                                : AssetCacheState::Preparing,
                                            std::memory_order_release);
        };
        const auto measured_phase = m_task->cache_state_for_next_step();
        publish_phase();
        const auto started_at = std::chrono::steady_clock::now();
        auto outcome = m_task->step(context);
        auto elapsed = std::chrono::steady_clock::now() - started_at;
        if (elapsed <= std::chrono::steady_clock::duration::zero())
            elapsed = std::chrono::nanoseconds{1};
        if (measured_phase == AssetCacheState::Reading)
            m_telemetry.source_read_duration += elapsed;
        else
            m_telemetry.preparation_duration += elapsed;
        if (outcome.status == jobs::JobStepStatus::Yielded) {
            publish_phase();
        } else if (outcome.status == jobs::JobStepStatus::Completed &&
                   !context.cancellation_requested()) {
            m_entry->active_job_state.store(AssetCacheState::WaitingForOwnerFinalization,
                                            std::memory_order_release);
            m_state->record_inventory_maybe_changed();
        }
        return outcome;
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        const auto reported = m_task->telemetry_on_owner();
        m_telemetry.compressed_bytes = reported.compressed_bytes;
        m_telemetry.uncompressed_bytes = reported.uncompressed_bytes;
        m_telemetry.source_read_duration += reported.source_read_duration;
        m_telemetry.preparation_duration += reported.preparation_duration;
        m_state->complete_job(m_entry, std::move(m_task), std::move(completion), m_telemetry);
    }

private:
    std::shared_ptr<AsyncAssetState<T>> m_state;
    std::shared_ptr<AsyncAssetEntry<T>> m_entry;
    std::unique_ptr<AssetPreparationTask<T>> m_task;
    AssetPreparationTelemetry m_telemetry;
};

template<class T> struct AsyncAssetState : std::enable_shared_from_this<AsyncAssetState<T>> {
    AsyncAssetState(jobs::JobExecutor& configured_executor,
                    std::shared_ptr<ResidencyManager> configured_residency,
                    core::AssetTelemetrySink* configured_telemetry)
        : executor(configured_executor), residency(std::move(configured_residency)),
          telemetry(configured_telemetry)
    {
        assert(residency != nullptr);
    }

    void assert_owner() const noexcept { owner_thread.assert_owner_thread(); }

    void record_inventory_maybe_changed() noexcept
    {
        if (telemetry != nullptr)
            telemetry->record_inventory_maybe_changed();
    }

    void record(core::AssetTelemetryEventKind kind, const AsyncAssetEntry<T>* entry = nullptr,
                const AsyncAssetConsumer<T>* consumer = nullptr,
                std::optional<AssetRequestReason> reason = std::nullopt,
                std::optional<jobs::JobPriority> priority = std::nullopt,
                std::string diagnostic_code = {}, const AsyncAssetTicket<T>* ticket = nullptr,
                AssetPreparationTelemetry preparation = {}, std::chrono::nanoseconds duration = {},
                std::optional<ResidencyEvictionReason> eviction_reason = std::nullopt,
                PrefetchGenerationId explicit_generation = {}) noexcept
    {
        if (telemetry == nullptr)
            return;
        core::AssetTelemetryEvent event{
            .timestamp = std::chrono::steady_clock::now(),
            .kind = kind,
            .execution_mode = executor.mode(),
            .cache_key = std::nullopt,
            .job_id = {},
            .request_id = {},
            .prefetch_generation = {},
            .request_reason = reason,
            .job_priority = priority,
            .memory = residency->accounting_on_owner().current,
            .compressed_bytes = preparation.compressed_bytes,
            .uncompressed_bytes = preparation.uncompressed_bytes,
            .duration = duration,
            .diagnostic_code = std::move(diagnostic_code),
            .eviction_reason = eviction_reason,
            .memory_policy = std::nullopt,
        };
        if (entry != nullptr) {
            event.cache_key = entry->key;
            event.job_id = entry->job_id.valid() ? entry->job_id : entry->last_job_id;
        }
        if (consumer != nullptr)
            event.request_id = consumer->id;
        else if (ticket != nullptr)
            event.request_id = ticket->request_id;
        if (ticket != nullptr)
            event.prefetch_generation = ticket->generation;
        else if (explicit_generation.valid())
            event.prefetch_generation = explicit_generation;
        telemetry->record(std::move(event));
    }

    [[nodiscard]] std::shared_ptr<AsyncAssetTicket<T>>
    active_prefetch_ticket(AsyncAssetEntry<T>& entry) const noexcept
    {
        compact_tickets(entry);
        for (auto it = entry.tickets.rbegin(); it != entry.tickets.rend(); ++it) {
            const auto ticket = it->lock();
            if (ticket != nullptr && ticket->active)
                return ticket;
        }
        return {};
    }

    void claim_ready_prefetch(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                              const std::shared_ptr<AsyncAssetConsumer<T>>& consumer) noexcept
    {
        assert_owner();
        if (consumer->reason != AssetRequestReason::Demand || entry->demand_prefetch_classified ||
            !consumer->ready_prefetch_generation) {
            return;
        }
        const auto generation = *consumer->ready_prefetch_generation;
        consumer->ready_prefetch_generation.reset();
        if (entry->prefetch_claimed_by_demand || !entry->completed_prefetch_generation ||
            *entry->completed_prefetch_generation != generation) {
            return;
        }
        entry->demand_prefetch_classified = true;
        entry->prefetch_claimed_by_demand = true;
        record(core::AssetTelemetryEventKind::PrefetchUsed, entry.get(), consumer.get(),
               consumer->reason, std::nullopt, {}, nullptr, {}, {}, std::nullopt, generation);
    }

    [[nodiscard]] std::shared_ptr<AsyncAssetEntry<T>> entry_for(const AssetCacheKey& key)
    {
        const auto found = entries.find(key);
        if (found != entries.end())
            return found->second;
        auto entry = std::make_shared<AsyncAssetEntry<T>>();
        entry->key = key;
        entries.emplace(key, entry);
        return entry;
    }

    static void compact_consumers(AsyncAssetEntry<T>& entry)
    {
        std::erase_if(entry.consumers, [](const auto& weak) { return weak.expired(); });
    }

    static void compact_tickets(AsyncAssetEntry<T>& entry)
    {
        std::erase_if(entry.tickets, [](const auto& weak) { return weak.expired(); });
    }

    void record_terminal_for_consumers(core::AssetTelemetryEventKind kind,
                                       AsyncAssetEntry<T>& entry, std::string diagnostic_code,
                                       const AsyncAssetTicket<T>* ticket = nullptr,
                                       AssetPreparationTelemetry preparation = {},
                                       std::chrono::nanoseconds duration = {}) noexcept
    {
        compact_consumers(entry);
        bool recorded_consumer = false;
        for (const auto& weak : entry.consumers) {
            const auto consumer = weak.lock();
            if (consumer == nullptr || !consumer->active ||
                consumer->state != AssetRequestState::Pending) {
                continue;
            }
            record(kind, &entry, consumer.get(), consumer->reason, std::nullopt, diagnostic_code,
                   ticket, preparation, duration);
            recorded_consumer = true;
        }
        if (!recorded_consumer && ticket != nullptr) {
            record(kind, &entry, nullptr, std::nullopt, std::nullopt, std::move(diagnostic_code),
                   ticket, preparation, duration);
        }
    }

    [[nodiscard]] AssetRequestReason effective_reason(AsyncAssetEntry<T>& entry) const noexcept
    {
        bool demand = false;
        compact_consumers(entry);
        for (const auto& weak : entry.consumers) {
            const auto consumer = weak.lock();
            if (consumer == nullptr || !consumer->active ||
                consumer->state != AssetRequestState::Pending) {
                continue;
            }
            if (consumer->reason == AssetRequestReason::Startup)
                return AssetRequestReason::Startup;
            demand = true;
        }
        return demand ? AssetRequestReason::Demand : AssetRequestReason::Prefetch;
    }

    [[nodiscard]] bool has_live_interest(AsyncAssetEntry<T>& entry) const noexcept
    {
        compact_consumers(entry);
        for (const auto& weak : entry.consumers) {
            const auto consumer = weak.lock();
            if (consumer != nullptr && consumer->active &&
                consumer->state == AssetRequestState::Pending) {
                return true;
            }
        }
        compact_tickets(entry);
        for (const auto& weak : entry.tickets) {
            const auto ticket = weak.lock();
            if (ticket != nullptr && ticket->active)
                return true;
        }
        return false;
    }

    [[nodiscard]] bool has_live_prefetch(AsyncAssetEntry<T>& entry) const noexcept
    {
        compact_tickets(entry);
        for (const auto& weak : entry.tickets) {
            const auto ticket = weak.lock();
            if (ticket != nullptr && ticket->active)
                return true;
        }
        return false;
    }

    void
    discard_deferred_without_interest(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        // The task owns any source/decode buffers covered by the preparation reservation. Destroy
        // those buffers before releasing the charge so accounting never understates live memory.
        entry->deferred_task.reset();
        entry->preparation_reservation.reset();
        entry->state = AssetCacheState::Canceled;
        entry->diagnostics.clear();
        entry->estimated_cost = {};
        entry->accumulated_preparation = {};
        entry->source_read_completed_recorded = false;
    }

    void recompute_interest(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        if (!has_live_interest(*entry)) {
            if (entry->job_id.valid()) {
                (void)executor.request_cancel(entry->job_id);
            } else if (entry->deferred_task != nullptr || entry->preparation_reservation) {
                discard_deferred_without_interest(entry);
            }
            return;
        }
        if (!entry->job_id.valid())
            return;

        const auto reason = effective_reason(*entry);
        const auto desired = reason == AssetRequestReason::Prefetch ? jobs::JobPriority::Prefetch
                                                                    : jobs::JobPriority::Critical;
        entry->admission_reason = reason;
        if (desired == entry->job_priority)
            return;
        const auto previous = entry->job_priority;
        if (!executor.set_priority(entry->job_id, desired))
            return;
        entry->job_priority = desired;
        const bool promoted =
            static_cast<std::uint8_t>(desired) < static_cast<std::uint8_t>(previous);
        record(promoted ? core::AssetTelemetryEventKind::PriorityPromoted
                        : core::AssetTelemetryEventKind::PriorityDemoted,
               entry.get(), nullptr, reason, desired);
    }

    void fail_consumers(AsyncAssetEntry<T>& entry, const core::Diagnostics& diagnostics,
                        AssetRequestState state) noexcept
    {
        compact_consumers(entry);
        for (const auto& weak : entry.consumers) {
            const auto consumer = weak.lock();
            if (consumer == nullptr || !consumer->active ||
                consumer->state != AssetRequestState::Pending) {
                continue;
            }
            consumer->state = state;
            consumer->diagnostics = diagnostics;
            consumer->active = false;
        }
    }

    void invalidate_tickets(AsyncAssetEntry<T>& entry) noexcept
    {
        compact_tickets(entry);
        for (const auto& weak : entry.tickets) {
            const auto ticket = weak.lock();
            if (ticket == nullptr || !ticket->active)
                continue;
            residency->release_prefetch_interest_on_owner(entry.key, ticket->generation);
            ticket->active = false;
        }
    }

    void make_consumers_ready(AsyncAssetEntry<T>& entry) noexcept
    {
        compact_consumers(entry);
        for (const auto& weak : entry.consumers) {
            const auto consumer = weak.lock();
            if (consumer == nullptr || !consumer->active ||
                consumer->state != AssetRequestState::Pending) {
                continue;
            }
            if (!residency->retain_pin_on_owner(entry.key)) {
                consumer->state = AssetRequestState::Failed;
                consumer->active = false;
                consumer->diagnostics = {
                    {.code = "assets.ready_reservation_failed",
                     .message = "resident asset could not be reservation-pinned"}};
                record(core::AssetTelemetryEventKind::RequestFailed, &entry, consumer.get(),
                       consumer->reason, std::nullopt, consumer->diagnostics.front().code);
                continue;
            }
            consumer->reservation_pin = true;
            consumer->state = AssetRequestState::Ready;
            consumer->diagnostics = entry.diagnostics;
        }
    }

    void discard_prepared(PreparedAsset<T>& prepared) noexcept
    {
        assert_owner();
        if (prepared.destroy_on_owner)
            prepared.destroy_on_owner(prepared.asset);
    }

    static void merge_preparation_telemetry(AssetPreparationTelemetry& destination,
                                            const AssetPreparationTelemetry& source) noexcept
    {
        destination.compressed_bytes =
            std::max(destination.compressed_bytes, source.compressed_bytes);
        destination.uncompressed_bytes =
            std::max(destination.uncompressed_bytes, source.uncompressed_bytes);
        destination.source_read_duration += source.source_read_duration;
        destination.preparation_duration += source.preparation_duration;
    }

    void complete_job(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                      std::unique_ptr<AssetPreparationTask<T>> task, jobs::JobCompletion completion,
                      AssetPreparationTelemetry preparation) noexcept
    {
        assert_owner();
        if (entry->job_id != completion.id)
            return;
        entry->job_id = {};
        const auto active_prefetch = active_prefetch_ticket(*entry);
        merge_preparation_telemetry(entry->accumulated_preparation, preparation);
        preparation = entry->accumulated_preparation;

        if (completion.status == jobs::JobTerminalStatus::Canceled || entry->invalidated ||
            !has_live_interest(*entry)) {
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            entry->diagnostics.clear();
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestCanceled, *entry,
                                          {}, active_prefetch.get());
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            if (entry->invalidated || !has_live_prefetch(*entry))
                invalidate_tickets(*entry);
            return;
        }
        if (completion.status == jobs::JobTerminalStatus::Failed) {
            entry->preparation_reservation.reset();
            const std::string code = completion.diagnostics.empty()
                                         ? std::string{}
                                         : completion.diagnostics.front().code;
            const auto failed_phase = entry->active_job_state.load(std::memory_order_acquire);
            if (failed_phase == AssetCacheState::Reading) {
                record(core::AssetTelemetryEventKind::SourceReadFailed, entry.get(), nullptr,
                       std::nullopt, std::nullopt, code, active_prefetch.get(), preparation,
                       preparation.source_read_duration);
            } else if (failed_phase == AssetCacheState::Preparing) {
                record(core::AssetTelemetryEventKind::PreparationFailed, entry.get(), nullptr,
                       std::nullopt, std::nullopt, code, active_prefetch.get(), preparation,
                       preparation.preparation_duration);
            }
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestFailed, *entry,
                                          code, active_prefetch.get(), preparation);
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = completion.diagnostics;
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        if (task->reservation_update_required_on_owner()) {
            if (!entry->source_read_completed_recorded &&
                (preparation.source_read_duration.count() > 0 ||
                 preparation.compressed_bytes != 0 || preparation.uncompressed_bytes != 0)) {
                record(core::AssetTelemetryEventKind::SourceReadCompleted, entry.get(), nullptr,
                       std::nullopt, std::nullopt, {}, active_prefetch.get(), preparation,
                       preparation.source_read_duration);
                entry->source_read_completed_recorded = true;
            }
            entry->estimated_cost = task->estimated_cost_on_owner();
            entry->deferred_task = std::move(task);
            entry->state = AssetCacheState::Queued;
            try_start_deferred(entry);
            return;
        }

        if (!entry->source_read_completed_recorded &&
            (preparation.source_read_duration.count() > 0 || preparation.compressed_bytes != 0 ||
             preparation.uncompressed_bytes != 0)) {
            record(core::AssetTelemetryEventKind::SourceReadCompleted, entry.get(), nullptr,
                   std::nullopt, std::nullopt, {}, active_prefetch.get(), preparation,
                   preparation.source_read_duration);
            entry->source_read_completed_recorded = true;
        }
        record(core::AssetTelemetryEventKind::PreparationCompleted, entry.get(), nullptr,
               std::nullopt, std::nullopt, {}, active_prefetch.get(), preparation,
               preparation.preparation_duration);
        entry->state = AssetCacheState::WaitingForOwnerFinalization;
        const auto finalization_started_at = std::chrono::steady_clock::now();
        auto finalized = task->finalize_on_owner();
        auto finalization_duration = std::chrono::steady_clock::now() - finalization_started_at;
        if (finalization_duration <= std::chrono::steady_clock::duration::zero())
            finalization_duration = std::chrono::nanoseconds{1};
        if (!finalized) {
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = finalized.error();
            const std::string code =
                entry->diagnostics.empty() ? std::string{} : entry->diagnostics.front().code;
            record(core::AssetTelemetryEventKind::OwnerFinalizationFailed, entry.get(), nullptr,
                   std::nullopt, std::nullopt, code, active_prefetch.get(), preparation,
                   finalization_duration);
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestFailed, *entry,
                                          code, active_prefetch.get(), preparation);
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        record(core::AssetTelemetryEventKind::OwnerFinalizationCompleted, entry.get(), nullptr,
               std::nullopt, std::nullopt, {}, active_prefetch.get(), preparation,
               finalization_duration);

        auto* finalized_value = finalized.value_if();
        assert(finalized_value != nullptr);
        PreparedAsset<T> prepared = std::move(*finalized_value);
        if (entry->invalidated || !has_live_interest(*entry)) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestCanceled, *entry,
                                          {}, active_prefetch.get());
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            invalidate_tickets(*entry);
            return;
        }

        entry->admission_reason = effective_reason(*entry);
        auto resident_control = std::make_shared<AsyncResidentControl<T>>(
            this->weak_from_this(), std::weak_ptr<AsyncAssetEntry<T>>(entry));
        ResidencyAdmissionRequest admission_request{
            .cache_key = entry->key,
            .reason = entry->admission_reason,
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
            .profiler_request_origin = entry->request_origin,
            .profiler_reload_count = entry->reload_count + (entry->policy_evicted ? 1u : 0u),
#endif
            .estimated_cost = prepared.cost,
            .resident_control = std::move(resident_control)};
        auto admission = residency->admit_on_owner(std::move(admission_request));
        if (admission.admission == ResidencyAdmission::RejectedPrefetch) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            entry->diagnostics = admission.diagnostics;
            const std::string code =
                entry->diagnostics.empty() ? std::string{} : entry->diagnostics.front().code;
            record(core::AssetTelemetryEventKind::BudgetPressure, entry.get(), nullptr,
                   AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch, code,
                   active_prefetch.get());
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestCanceled, *entry,
                                          code, active_prefetch.get());
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            invalidate_tickets(*entry);
            return;
        }
        if (admission.admission == ResidencyAdmission::Deferred) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = admission.diagnostics;
            const std::string code =
                entry->diagnostics.empty() ? std::string{} : entry->diagnostics.front().code;
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestFailed, *entry,
                                          code, active_prefetch.get());
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        entry->asset = std::make_shared<T>(std::move(prepared.asset));
        entry->destroy_on_owner = std::move(prepared.destroy_on_owner);
        entry->preparation_reservation.reset();
        entry->state = AssetCacheState::Resident;
        if (entry->policy_evicted) {
            ++entry->reload_count;
            entry->policy_evicted = false;
            record(core::AssetTelemetryEventKind::ReloadedAfterEviction, entry.get());
        }
        entry->diagnostics.insert(entry->diagnostics.end(), admission.diagnostics.begin(),
                                  admission.diagnostics.end());
        make_consumers_ready(*entry);
        if (active_prefetch != nullptr &&
            (!entry->demand_prefetch_classified || entry->prefetch_claimed_by_demand)) {
            entry->completed_prefetch_generation = active_prefetch->generation;
        }
    }

    void submit_reserved(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        auto task = std::move(entry->deferred_task);
        const bool source_read_expected =
            task->cache_state_for_next_step() == AssetCacheState::Reading;
        auto job = std::make_unique<AsyncAssetLoadJob<T>>(this->shared_from_this(), entry,
                                                          std::move(task));
        const auto priority = entry->admission_reason == AssetRequestReason::Prefetch
                                  ? jobs::JobPriority::Prefetch
                                  : jobs::JobPriority::Critical;
        auto submitted = executor.submit(priority, std::move(job));
        if (!submitted) {
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = {submitted.error()};
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestFailed, *entry,
                                          entry->diagnostics.front().code);
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }
        const auto* submitted_id = submitted.value_if();
        assert(submitted_id != nullptr);
        entry->job_id = *submitted_id;
        entry->last_job_id = *submitted_id;
        entry->job_priority = priority;
        entry->state = AssetCacheState::Queued;
        entry->active_job_state.store(AssetCacheState::Queued, std::memory_order_release);
        const auto active_prefetch = active_prefetch_ticket(*entry);
        if (source_read_expected) {
            record(core::AssetTelemetryEventKind::SourceReadStarted, entry.get(), nullptr,
                   entry->admission_reason, priority, {}, active_prefetch.get());
        }
    }

    void try_start_deferred(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        if (entry->deferred_task == nullptr || entry->job_id.valid())
            return;
        record_inventory_maybe_changed();
        if (!has_live_interest(*entry)) {
            discard_deferred_without_interest(entry);
            return;
        }
        entry->admission_reason = effective_reason(*entry);
        const ResidencyCost temporary{.temporary_bytes = entry->estimated_cost.temporary_bytes};
        if (entry->preparation_reservation) {
            auto resized = residency->resize_preparation_on_owner(
                *entry->preparation_reservation, temporary, entry->admission_reason);
            if (resized.admission == ResidencyAdmission::Deferred) {
                entry->state = AssetCacheState::Queued;
                entry->diagnostics = resized.diagnostics;
                return;
            }
            if (resized.admission == ResidencyAdmission::RejectedPrefetch) {
                entry->deferred_task.reset();
                entry->preparation_reservation.reset();
                entry->state = AssetCacheState::Canceled;
                entry->diagnostics = resized.diagnostics;
                const std::string code =
                    entry->diagnostics.empty() ? std::string{} : entry->diagnostics.front().code;
                const auto active_prefetch = active_prefetch_ticket(*entry);
                record(core::AssetTelemetryEventKind::BudgetPressure, entry.get(), nullptr,
                       AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch, code,
                       active_prefetch.get());
                record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestCanceled,
                                              *entry, code, active_prefetch.get());
                invalidate_tickets(*entry);
                fail_consumers(*entry, {}, AssetRequestState::Canceled);
                return;
            }
            entry->diagnostics = resized.diagnostics;
            entry->deferred_task->reservation_update_granted_on_owner();
            submit_reserved(entry);
            return;
        }
        auto reserved = residency->reserve_preparation_on_owner(temporary, entry->admission_reason);
        if (reserved.admission == ResidencyAdmission::Deferred) {
            entry->state = AssetCacheState::Queued;
            entry->diagnostics = reserved.diagnostics;
            return;
        }
        if (reserved.admission == ResidencyAdmission::RejectedPrefetch) {
            entry->deferred_task.reset();
            entry->state = AssetCacheState::Canceled;
            entry->diagnostics = reserved.diagnostics;
            const std::string code =
                entry->diagnostics.empty() ? std::string{} : entry->diagnostics.front().code;
            const auto active_prefetch = active_prefetch_ticket(*entry);
            record(core::AssetTelemetryEventKind::BudgetPressure, entry.get(), nullptr,
                   AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch, code,
                   active_prefetch.get());
            record_terminal_for_consumers(core::AssetTelemetryEventKind::RequestCanceled, *entry,
                                          code, active_prefetch.get());
            invalidate_tickets(*entry);
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            return;
        }
        assert(reserved.reservation.has_value());
        entry->diagnostics = reserved.diagnostics;
        entry->preparation_reservation = std::move(*reserved.reservation);
        submit_reserved(entry);
    }

    void begin_load(const std::shared_ptr<AsyncAssetEntry<T>>& entry, AssetRequestReason reason,
                    std::unique_ptr<AssetPreparationTask<T>> task) noexcept
    {
        assert_owner();
        entry->state = AssetCacheState::Queued;
        entry->active_job_state.store(AssetCacheState::Queued, std::memory_order_release);
        entry->diagnostics.clear();
        entry->admission_reason = reason;
        entry->request_origin = reason;
        entry->estimated_cost = task->estimated_cost_on_owner();
        entry->accumulated_preparation = {};
        entry->source_read_completed_recorded = false;
        entry->demand_prefetch_classified = false;
        entry->prefetch_claimed_by_demand = false;
        entry->completed_prefetch_generation.reset();
        entry->deferred_task = std::move(task);
        try_start_deferred(entry);
    }

    void cancel_consumer(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                         const std::shared_ptr<AsyncAssetConsumer<T>>& consumer) noexcept
    {
        assert_owner();
        if (consumer->state == AssetRequestState::Canceled ||
            consumer->state == AssetRequestState::Failed) {
            return;
        }
        if (consumer->reservation_pin) {
            residency->release_pin_on_owner(entry->key);
            consumer->reservation_pin = false;
        }
        consumer->active = false;
        consumer->state = AssetRequestState::Canceled;
        consumer->ready_prefetch_generation.reset();
        record(core::AssetTelemetryEventKind::RequestCanceled, entry.get(), consumer.get(),
               consumer->reason);
        recompute_interest(entry);
        retire_if_possible(entry);
    }

    void cancel_ticket(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                       const std::shared_ptr<AsyncAssetTicket<T>>& ticket) noexcept
    {
        assert_owner();
        if (!ticket->active)
            return;
        ticket->active = false;
        residency->release_prefetch_interest_on_owner(entry->key, ticket->generation);
        recompute_interest(entry);
    }

    void retain_lease_pin(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        const bool retained = residency->retain_pin_on_owner(entry->key);
        assert(retained);
        (void)retained;
    }

    void release_lease_pin(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        residency->release_pin_on_owner(entry->key);
        retire_if_possible(entry);
    }

    void mark_used(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        residency->mark_used_on_owner(entry->key);
    }

    void retire_if_possible(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        if (!entry->retire_when_unpinned || entry->state != AssetCacheState::Resident)
            return;
        const auto classification = residency->classification_on_owner(entry->key);
        if (classification && *classification != ResidencyClass::Pinned)
            (void)residency->evict_on_owner(entry->key,
                                            ResidencyEvictionReason::GenerationInvalidated);
    }

    void destroy_resident(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                          ResidencyEvictionReason reason) noexcept
    {
        assert_owner();
        if (entry->completed_prefetch_generation && !entry->prefetch_claimed_by_demand) {
            record(core::AssetTelemetryEventKind::PrefetchUnused, entry.get(), nullptr,
                   AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch, {}, nullptr, {}, {},
                   reason, *entry->completed_prefetch_generation);
        }
        invalidate_tickets(*entry);
        if (entry->asset != nullptr && entry->destroy_on_owner)
            entry->destroy_on_owner(*entry->asset);
        entry->asset.reset();
        entry->destroy_on_owner = {};
        entry->state = AssetCacheState::Missing;
        entry->policy_evicted = reason == ResidencyEvictionReason::BudgetPressure ||
                                reason == ResidencyEvictionReason::PrefetchRejected;
        entry->retire_when_unpinned = false;
        entry->completed_prefetch_generation.reset();
        entry->demand_prefetch_classified = false;
        entry->prefetch_claimed_by_demand = false;
    }

    void invalidate_generation(AssetSourceGeneration generation) noexcept
    {
        assert_owner();
        for (auto& [key, entry] : entries) {
            if (key.source_generation != generation)
                continue;
            entry->invalidated = true;
            compact_consumers(*entry);
            for (const auto& weak : entry->consumers) {
                if (const auto consumer = weak.lock())
                    cancel_consumer(entry, consumer);
            }
            invalidate_tickets(*entry);
            if (entry->job_id.valid())
                (void)executor.request_cancel(entry->job_id);
            if (entry->state == AssetCacheState::Resident) {
                if (!residency->evict_on_owner(entry->key,
                                               ResidencyEvictionReason::GenerationInvalidated)) {
                    entry->retire_when_unpinned = true;
                }
            }
        }
    }

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    [[nodiscard]] std::vector<AssetOrchestratorProfilerEntry> profiler_entries_on_owner() const
    {
        assert_owner();
        std::vector<AssetOrchestratorProfilerEntry> result;
        result.reserve(entries.size());
        for (const auto& [_, entry] : entries) {
            bool live_consumer = false;
            for (const auto& weak : entry->consumers) {
                if (const auto consumer = weak.lock(); consumer != nullptr && consumer->active) {
                    live_consumer = true;
                    break;
                }
            }
            bool live_ticket = false;
            std::optional<PrefetchGenerationId> generation = entry->completed_prefetch_generation;
            for (const auto& weak : entry->tickets) {
                if (const auto ticket = weak.lock(); ticket != nullptr && ticket->active) {
                    live_ticket = true;
                    generation = ticket->generation;
                    break;
                }
            }
            const auto active_state = entry->active_job_state.load(std::memory_order_acquire);
            const auto normalized_state = entry->job_id.valid() ? active_state : entry->state;
            const bool has_reservation = entry->preparation_reservation.has_value();
            const bool in_flight =
                entry->job_id.valid() || entry->deferred_task != nullptr || has_reservation;
            if (entry->invalidated && normalized_state != AssetCacheState::Resident && !in_flight)
                continue;
            const bool show = normalized_state == AssetCacheState::Resident ||
                              normalized_state == AssetCacheState::Failed || live_consumer ||
                              live_ticket || in_flight || !entry->diagnostics.empty();
            if (!show)
                continue;
            result.push_back(
                {.cache_key = entry->key,
                 .cache_state = normalized_state,
                 .job_id = entry->job_id.valid() ? entry->job_id : entry->last_job_id,
                 .priority = entry->job_priority,
                 .request_origin = entry->request_origin,
                 .estimated_cost = entry->estimated_cost,
                 .loading_memory_bytes =
                     has_reservation ? entry->preparation_reservation->cost().temporary_bytes : 0,
                 .prefetch_generation = generation,
                 .completed_prefetch_claimed = entry->prefetch_claimed_by_demand,
                 .has_live_consumer = live_consumer,
                 .has_live_prefetch_ticket = live_ticket,
                 .invalidated = entry->invalidated,
                 .reload_count = entry->reload_count,
                 .diagnostics = entry->diagnostics});
        }
        return result;
    }
#endif

    void shutdown_on_owner() noexcept
    {
        assert_owner();
        if (!accepting)
            return;
        accepting = false;
        for (auto& [_, entry] : entries) {
            compact_consumers(*entry);
            for (const auto& weak : entry->consumers) {
                if (const auto consumer = weak.lock())
                    cancel_consumer(entry, consumer);
            }
            invalidate_tickets(*entry);
            entry->deferred_task.reset();
            entry->preparation_reservation.reset();
            if (entry->job_id.valid())
                (void)executor.request_cancel(entry->job_id);
            if (entry->state == AssetCacheState::Resident) {
                if (!residency->evict_on_owner(entry->key,
                                               ResidencyEvictionReason::ExplicitRelease)) {
                    entry->retire_when_unpinned = true;
                }
            }
        }
    }

    jobs::OwnerThreadGuard owner_thread;
    jobs::JobExecutor& executor;
    std::shared_ptr<ResidencyManager> residency;
    core::AssetTelemetrySink* telemetry = nullptr;
    std::map<AssetCacheKey, std::shared_ptr<AsyncAssetEntry<T>>> entries;
    bool accepting = true;
};

} // namespace detail

[[nodiscard]] inline std::optional<AssetSourceGeneration>
allocate_asset_source_generation() noexcept
{
    return detail::allocate_process_id<AssetSourceGeneration>(
        detail::g_next_asset_source_generation);
}

[[nodiscard]] inline std::optional<PrefetchGenerationId> allocate_prefetch_generation() noexcept
{
    return detail::allocate_process_id<PrefetchGenerationId>(detail::g_next_prefetch_generation_id);
}

template<class T> class AssetRequestOrchestrator {
public:
    AssetRequestOrchestrator(jobs::JobExecutor& executor,
                             std::shared_ptr<ResidencyManager> residency,
                             core::AssetTelemetrySink* telemetry = nullptr)
        : m_state(std::make_shared<detail::AsyncAssetState<T>>(executor, std::move(residency),
                                                               telemetry))
    {
    }

    ~AssetRequestOrchestrator() { m_state->shutdown_on_owner(); }

    AssetRequestOrchestrator(const AssetRequestOrchestrator&) = delete;
    AssetRequestOrchestrator& operator=(const AssetRequestOrchestrator&) = delete;
    AssetRequestOrchestrator(AssetRequestOrchestrator&&) = delete;
    AssetRequestOrchestrator& operator=(AssetRequestOrchestrator&&) = delete;

    [[nodiscard]] core::Result<AssetRequestHandle<T>, core::Diagnostic>
    request_on_owner(AssetCacheKey key, AssetRequestReason reason,
                     std::unique_ptr<AssetPreparationTask<T>> task) noexcept
    {
        m_state->assert_owner();
        if (!m_state->accepting) {
            return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                {.code = "assets.request_orchestrator_shutdown",
                 .message = "typed asset request orchestrator is shutting down"});
        }
        if (reason == AssetRequestReason::Prefetch) {
            return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                {.code = "assets.prefetch_requires_ticket",
                 .message = "prefetch requests must use a prefetch ticket"});
        }
        if (!key.valid() || task == nullptr) {
            return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                {.code = "assets.invalid_async_request",
                 .message = "typed asset request requires a valid cache key and preparation task"});
        }
        const auto id =
            detail::allocate_process_id<AssetRequestId>(detail::g_next_asset_request_id);
        if (!id) {
            return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                {.code = "assets.request_id_exhausted",
                 .message = "process asset request ID space is exhausted"});
        }

        auto entry = m_state->entry_for(key);
        if (entry->invalidated) {
            return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                {.code = "assets.invalidated_source_generation",
                 .message = "asset request targets an invalidated source generation"});
        }
        auto consumer = std::make_shared<detail::AsyncAssetConsumer<T>>();
        consumer->id = *id;
        consumer->reason = reason;
        entry->consumers.push_back(consumer);
        m_state->record(core::AssetTelemetryEventKind::AssetRequested, entry.get(), consumer.get(),
                        reason);
        const auto active_prefetch = m_state->active_prefetch_ticket(*entry);

        if (entry->state == AssetCacheState::Resident && entry->asset != nullptr &&
            m_state->residency->resident_on_owner(key)) {
            if (reason == AssetRequestReason::Demand && !entry->demand_prefetch_classified &&
                !entry->prefetch_claimed_by_demand && entry->completed_prefetch_generation) {
                consumer->ready_prefetch_generation = entry->completed_prefetch_generation;
            }
            if (!m_state->residency->retain_pin_on_owner(key)) {
                return core::Result<AssetRequestHandle<T>, core::Diagnostic>::failure(
                    {.code = "assets.cache_hit_pin_failed",
                     .message = "resident cache hit could not be reservation-pinned"});
            }
            consumer->reservation_pin = true;
            consumer->state = AssetRequestState::Ready;
            m_state->record(core::AssetTelemetryEventKind::CacheHit, entry.get(), consumer.get(),
                            reason);
        } else if (entry->job_id.valid() || entry->deferred_task != nullptr) {
            if (reason == AssetRequestReason::Demand && !entry->demand_prefetch_classified &&
                active_prefetch != nullptr) {
                entry->demand_prefetch_classified = true;
                entry->prefetch_claimed_by_demand = true;
                m_state->record(core::AssetTelemetryEventKind::PrefetchLate, entry.get(),
                                consumer.get(), reason, jobs::JobPriority::Critical, {},
                                active_prefetch.get());
            } else if (reason == AssetRequestReason::Demand && !entry->demand_prefetch_classified) {
                entry->demand_prefetch_classified = true;
                m_state->record(core::AssetTelemetryEventKind::PrefetchMiss, entry.get(),
                                consumer.get(), reason);
            }
            m_state->record(core::AssetTelemetryEventKind::RequestCoalesced, entry.get(),
                            consumer.get(), reason);
            m_state->recompute_interest(entry);
            m_state->try_start_deferred(entry);
        } else {
            m_state->record(core::AssetTelemetryEventKind::CacheMiss, entry.get(), consumer.get(),
                            reason);
            m_state->begin_load(entry, reason, std::move(task));
            if (reason == AssetRequestReason::Demand) {
                entry->demand_prefetch_classified = true;
                m_state->record(core::AssetTelemetryEventKind::PrefetchMiss, entry.get(),
                                consumer.get(), reason);
            }
        }

        auto control =
            std::make_unique<detail::AsyncAssetRequestControl<T>>(m_state, entry, consumer);
        return core::Result<AssetRequestHandle<T>, core::Diagnostic>::success(
            AssetRequestHandle<T>::from_control_on_owner(std::move(control)));
    }

    [[nodiscard]] core::Result<PrefetchTicket, core::Diagnostic>
    prefetch_on_owner(AssetCacheKey key, PrefetchGenerationId generation,
                      std::unique_ptr<AssetPreparationTask<T>> task) noexcept
    {
        m_state->assert_owner();
        if (!m_state->accepting) {
            return core::Result<PrefetchTicket, core::Diagnostic>::failure(
                {.code = "assets.request_orchestrator_shutdown",
                 .message = "typed asset request orchestrator is shutting down"});
        }
        if (!key.valid() || !generation.valid() || task == nullptr) {
            return core::Result<PrefetchTicket, core::Diagnostic>::failure(
                {.code = "assets.invalid_prefetch_request",
                 .message = "prefetch requires a valid key, generation, and preparation task"});
        }
        const auto id =
            detail::allocate_process_id<AssetRequestId>(detail::g_next_asset_request_id);
        if (!id) {
            return core::Result<PrefetchTicket, core::Diagnostic>::failure(
                {.code = "assets.request_id_exhausted",
                 .message = "process asset request ID space is exhausted"});
        }

        auto entry = m_state->entry_for(key);
        if (entry->invalidated) {
            return core::Result<PrefetchTicket, core::Diagnostic>::failure(
                {.code = "assets.invalidated_source_generation",
                 .message = "prefetch targets an invalidated source generation"});
        }
        if (!m_state->residency->attach_prefetch_interest_on_owner(key, generation)) {
            return core::Result<PrefetchTicket, core::Diagnostic>::failure(
                {.code = "assets.prefetch_allowance_exceeded",
                 .message = "prefetch would exceed the configured Warm residency allowance"});
        }
        auto ticket = std::make_shared<detail::AsyncAssetTicket<T>>();
        ticket->request_id = *id;
        ticket->generation = generation;
        entry->tickets.push_back(ticket);
        m_state->record(core::AssetTelemetryEventKind::AssetRequested, entry.get(), nullptr,
                        AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch, {},
                        ticket.get());

        if (entry->state == AssetCacheState::Resident && entry->asset != nullptr) {
            m_state->record(core::AssetTelemetryEventKind::CacheHit, entry.get(), nullptr,
                            AssetRequestReason::Prefetch, std::nullopt, {}, ticket.get());
        } else if (entry->job_id.valid() || entry->deferred_task != nullptr) {
            m_state->record(core::AssetTelemetryEventKind::RequestCoalesced, entry.get(), nullptr,
                            AssetRequestReason::Prefetch, std::nullopt, {}, ticket.get());
            m_state->recompute_interest(entry);
            m_state->try_start_deferred(entry);
        } else {
            m_state->record(core::AssetTelemetryEventKind::CacheMiss, entry.get(), nullptr,
                            AssetRequestReason::Prefetch, std::nullopt, {}, ticket.get());
            m_state->begin_load(entry, AssetRequestReason::Prefetch, std::move(task));
        }

        auto control =
            std::make_unique<detail::AsyncAssetPrefetchControl<T>>(m_state, entry, ticket);
        return core::Result<PrefetchTicket, core::Diagnostic>::success(
            PrefetchTicket::from_control_on_owner(std::move(control)));
    }

    std::size_t retry_deferred_on_owner() noexcept
    {
        m_state->assert_owner();
        std::size_t started = 0;
        for (auto& [_, entry] : m_state->entries) {
            if (entry->deferred_task == nullptr || entry->job_id.valid())
                continue;
            const bool before = entry->job_id.valid();
            m_state->try_start_deferred(entry);
            if (!before && entry->job_id.valid())
                ++started;
        }
        return started;
    }

    void invalidate_generation_on_owner(AssetSourceGeneration generation) noexcept
    {
        m_state->invalidate_generation(generation);
    }

    [[nodiscard]] std::optional<AssetCacheState>
    cache_state_on_owner(const AssetCacheKey& key) const noexcept
    {
        m_state->assert_owner();
        const auto found = m_state->entries.find(key);
        if (found == m_state->entries.end())
            return std::nullopt;
        const auto& entry = *found->second;
        if (entry.state == AssetCacheState::Queued && entry.job_id.valid())
            return entry.active_job_state.load(std::memory_order_acquire);
        return entry.state;
    }

    [[nodiscard]] jobs::JobId job_id_on_owner(const AssetCacheKey& key) const noexcept
    {
        m_state->assert_owner();
        const auto found = m_state->entries.find(key);
        return found == m_state->entries.end() ? jobs::JobId{} : found->second->job_id;
    }

private:
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    friend class AssetManager;

    [[nodiscard]] std::vector<AssetOrchestratorProfilerEntry> profiler_entries_on_owner() const
    {
        return m_state->profiler_entries_on_owner();
    }
#endif

    std::shared_ptr<detail::AsyncAssetState<T>> m_state;
};

} // namespace noveltea::assets
