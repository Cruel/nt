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

template<class T> struct PreparedAsset {
    T asset;
    ResidencyCost cost;
    std::function<void(T&)> destroy_on_owner;
};

template<class T> class AssetPreparationTask {
public:
    virtual ~AssetPreparationTask() = default;

    [[nodiscard]] virtual ResidencyCost estimated_cost_on_owner() const noexcept = 0;
    [[nodiscard]] virtual AssetCacheState cache_state_for_next_step() const noexcept
    {
        return AssetCacheState::Preparing;
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
    jobs::JobPriority job_priority = jobs::JobPriority::Prefetch;
    AssetRequestReason admission_reason = AssetRequestReason::Prefetch;
    std::optional<PreparationReservation> preparation_reservation;
    std::unique_ptr<AssetPreparationTask<T>> deferred_task;
    ResidencyCost estimated_cost;
    std::shared_ptr<T> asset;
    std::function<void(T&)> destroy_on_owner;
    std::vector<std::weak_ptr<AsyncAssetConsumer<T>>> consumers;
    std::vector<std::weak_ptr<AsyncAssetTicket<T>>> tickets;
    bool invalidated = false;
    bool retire_when_unpinned = false;
    bool ever_evicted = false;
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
        publish_phase();
        auto outcome = m_task->step(context);
        if (outcome.status == jobs::JobStepStatus::Yielded) {
            publish_phase();
        } else if (outcome.status == jobs::JobStepStatus::Completed &&
                   !context.cancellation_requested()) {
            m_entry->active_job_state.store(AssetCacheState::WaitingForOwnerFinalization,
                                            std::memory_order_release);
        }
        return outcome;
    }

    void complete_on_owner(jobs::JobCompletion completion) noexcept override
    {
        m_state->complete_job(m_entry, std::move(m_task), std::move(completion));
    }

private:
    std::shared_ptr<AsyncAssetState<T>> m_state;
    std::shared_ptr<AsyncAssetEntry<T>> m_entry;
    std::unique_ptr<AssetPreparationTask<T>> m_task;
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

    void record(core::AssetTelemetryEventKind kind, const AsyncAssetEntry<T>* entry = nullptr,
                const AsyncAssetConsumer<T>* consumer = nullptr,
                std::optional<AssetRequestReason> reason = std::nullopt,
                std::optional<jobs::JobPriority> priority = std::nullopt,
                std::string diagnostic_code = {}) noexcept
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
            .compressed_bytes = 0,
            .uncompressed_bytes = 0,
            .duration = {},
            .diagnostic_code = std::move(diagnostic_code),
            .memory_policy = std::nullopt,
        };
        if (entry != nullptr) {
            event.cache_key = entry->key;
            event.job_id = entry->job_id;
        }
        if (consumer != nullptr)
            event.request_id = consumer->id;
        telemetry->record(std::move(event));
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

    void recompute_interest(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        if (!entry->job_id.valid())
            return;
        if (!has_live_interest(*entry)) {
            (void)executor.request_cancel(entry->job_id);
            return;
        }

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

    void complete_job(const std::shared_ptr<AsyncAssetEntry<T>>& entry,
                      std::unique_ptr<AssetPreparationTask<T>> task,
                      jobs::JobCompletion completion) noexcept
    {
        assert_owner();
        if (entry->job_id != completion.id)
            return;
        entry->job_id = {};

        if (completion.status == jobs::JobTerminalStatus::Canceled || entry->invalidated ||
            !has_live_interest(*entry)) {
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            entry->diagnostics.clear();
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
            record(core::AssetTelemetryEventKind::SourceReadFailed, entry.get(), nullptr,
                   std::nullopt, std::nullopt, code);
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = completion.diagnostics;
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        record(core::AssetTelemetryEventKind::SourceReadCompleted, entry.get());
        record(core::AssetTelemetryEventKind::PreparationCompleted, entry.get());
        entry->state = AssetCacheState::WaitingForOwnerFinalization;
        auto finalized = task->finalize_on_owner();
        if (!finalized) {
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = finalized.error();
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        auto* finalized_value = finalized.value_if();
        assert(finalized_value != nullptr);
        PreparedAsset<T> prepared = std::move(*finalized_value);
        if (entry->invalidated || !has_live_interest(*entry)) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            invalidate_tickets(*entry);
            return;
        }

        entry->admission_reason = effective_reason(*entry);
        auto resident_control = std::make_shared<AsyncResidentControl<T>>(
            this->weak_from_this(), std::weak_ptr<AsyncAssetEntry<T>>(entry));
        auto admission =
            residency->admit_on_owner({.cache_key = entry->key,
                                       .reason = entry->admission_reason,
                                       .estimated_cost = prepared.cost,
                                       .resident_control = std::move(resident_control)});
        if (admission.admission == ResidencyAdmission::RejectedPrefetch) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Canceled;
            entry->diagnostics = admission.diagnostics;
            fail_consumers(*entry, {}, AssetRequestState::Canceled);
            invalidate_tickets(*entry);
            return;
        }
        if (admission.admission == ResidencyAdmission::Deferred) {
            discard_prepared(prepared);
            entry->preparation_reservation.reset();
            entry->state = AssetCacheState::Failed;
            entry->diagnostics = admission.diagnostics;
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }

        entry->asset = std::make_shared<T>(std::move(prepared.asset));
        entry->destroy_on_owner = std::move(prepared.destroy_on_owner);
        entry->preparation_reservation.reset();
        entry->state = AssetCacheState::Resident;
        entry->diagnostics.insert(entry->diagnostics.end(), admission.diagnostics.begin(),
                                  admission.diagnostics.end());
        make_consumers_ready(*entry);
        record(core::AssetTelemetryEventKind::OwnerFinalizationCompleted, entry.get());
    }

    void submit_reserved(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        auto task = std::move(entry->deferred_task);
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
            fail_consumers(*entry, entry->diagnostics, AssetRequestState::Failed);
            invalidate_tickets(*entry);
            return;
        }
        const auto* submitted_id = submitted.value_if();
        assert(submitted_id != nullptr);
        entry->job_id = *submitted_id;
        entry->job_priority = priority;
        entry->state = AssetCacheState::Queued;
        entry->active_job_state.store(AssetCacheState::Queued, std::memory_order_release);
        record(core::AssetTelemetryEventKind::SourceReadStarted, entry.get(), nullptr,
               entry->admission_reason, priority);
    }

    void try_start_deferred(const std::shared_ptr<AsyncAssetEntry<T>>& entry) noexcept
    {
        assert_owner();
        if (entry->deferred_task == nullptr || entry->job_id.valid())
            return;
        if (!has_live_interest(*entry)) {
            entry->deferred_task.reset();
            entry->state = AssetCacheState::Canceled;
            return;
        }
        entry->admission_reason = effective_reason(*entry);
        const ResidencyCost temporary{.temporary_bytes = entry->estimated_cost.temporary_bytes};
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
        entry->estimated_cost = task->estimated_cost_on_owner();
        entry->deferred_task = std::move(task);
        if (entry->ever_evicted)
            record(core::AssetTelemetryEventKind::ReloadedAfterEviction, entry.get());
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
                          ResidencyEvictionReason) noexcept
    {
        assert_owner();
        invalidate_tickets(*entry);
        if (entry->asset != nullptr && entry->destroy_on_owner)
            entry->destroy_on_owner(*entry->asset);
        entry->asset.reset();
        entry->destroy_on_owner = {};
        entry->state = AssetCacheState::Missing;
        entry->ever_evicted = true;
        entry->retire_when_unpinned = false;
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

        if (entry->state == AssetCacheState::Resident && entry->asset != nullptr &&
            m_state->residency->resident_on_owner(key)) {
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
            m_state->record(core::AssetTelemetryEventKind::RequestCoalesced, entry.get(),
                            consumer.get(), reason);
            m_state->recompute_interest(entry);
            m_state->try_start_deferred(entry);
        } else {
            m_state->record(core::AssetTelemetryEventKind::CacheMiss, entry.get(), consumer.get(),
                            reason);
            m_state->begin_load(entry, reason, std::move(task));
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
                        AssetRequestReason::Prefetch, jobs::JobPriority::Prefetch);

        if (entry->state == AssetCacheState::Resident && entry->asset != nullptr) {
            m_state->record(core::AssetTelemetryEventKind::CacheHit, entry.get(), nullptr,
                            AssetRequestReason::Prefetch);
        } else if (entry->job_id.valid() || entry->deferred_task != nullptr) {
            m_state->record(core::AssetTelemetryEventKind::RequestCoalesced, entry.get(), nullptr,
                            AssetRequestReason::Prefetch);
            m_state->recompute_interest(entry);
            m_state->try_start_deferred(entry);
        } else {
            m_state->record(core::AssetTelemetryEventKind::CacheMiss, entry.get(), nullptr,
                            AssetRequestReason::Prefetch);
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
    std::shared_ptr<detail::AsyncAssetState<T>> m_state;
};

} // namespace noveltea::assets
