#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/core/result.hpp"

#include <cassert>
#include <compare>
#include <cstdint>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

namespace noveltea::assets {

enum class ResidencyClass : std::uint8_t {
    Pinned,
    Warm,
    Cold,
};

enum class ResidencyAdmission : std::uint8_t {
    Admitted,
    AdmittedOverBudget,
    Deferred,
    RejectedPrefetch,
};

enum class ResidencyEvictionReason : std::uint8_t {
    BudgetPressure,
    ExplicitRelease,
    GenerationInvalidated,
    PrefetchRejected,
};

struct ResidencyCost {
    std::uint64_t source_bytes = 0;
    std::uint64_t prepared_cpu_bytes = 0;
    std::uint64_t gpu_bytes = 0;
    std::uint64_t audio_bytes = 0;
    std::uint64_t temporary_bytes = 0;

    [[nodiscard]] std::uint64_t resident_bytes() const noexcept
    {
        return source_bytes + prepared_cpu_bytes + gpu_bytes + audio_bytes;
    }

    [[nodiscard]] std::uint64_t total_bytes() const noexcept
    {
        return resident_bytes() + temporary_bytes;
    }

    auto operator<=>(const ResidencyCost&) const = default;
};

struct ResidencyBudget {
    std::uint64_t source_bytes = 0;
    std::uint64_t prepared_cpu_bytes = 0;
    std::uint64_t gpu_bytes = 0;
    std::uint64_t audio_bytes = 0;
    std::uint64_t temporary_bytes = 0;
};

struct ResidencyAccountingSnapshot {
    ResidencyCost current;
    ResidencyCost high_water;
};

struct PreparationReservationId {
    std::uint64_t value = 0;

    [[nodiscard]] bool valid() const noexcept { return value != 0; }
    auto operator<=>(const PreparationReservationId&) const = default;
};

class PreparationReservationControl {
public:
    virtual ~PreparationReservationControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    [[nodiscard]] virtual PreparationReservationId id_on_owner() const noexcept = 0;
    [[nodiscard]] virtual ResidencyCost cost_on_owner() const noexcept = 0;
    virtual void release_on_owner() noexcept = 0;
};

class PreparationReservation {
public:
    PreparationReservation() = default;
    ~PreparationReservation() { reset(); }

    PreparationReservation(const PreparationReservation&) = delete;
    PreparationReservation& operator=(const PreparationReservation&) = delete;
    PreparationReservation(PreparationReservation&& other) noexcept = default;

    PreparationReservation& operator=(PreparationReservation&& other) noexcept
    {
        if (this == &other)
            return *this;
        reset();
        m_control = std::move(other.m_control);
        return *this;
    }

    [[nodiscard]] static PreparationReservation
    from_control_on_owner(std::unique_ptr<PreparationReservationControl> control) noexcept
    {
        assert(control != nullptr);
        control->assert_owner_thread();
        assert(control->id_on_owner().valid());
        return PreparationReservation(std::move(control));
    }

    [[nodiscard]] explicit operator bool() const noexcept { return m_control != nullptr; }

    [[nodiscard]] PreparationReservationId id() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->id_on_owner();
    }

    [[nodiscard]] ResidencyCost cost() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->cost_on_owner();
    }

    void reset() noexcept
    {
        if (m_control == nullptr)
            return;
        m_control->assert_owner_thread();
        m_control->release_on_owner();
        m_control.reset();
    }

private:
    explicit PreparationReservation(std::unique_ptr<PreparationReservationControl> control) noexcept
        : m_control(std::move(control))
    {
    }

    std::unique_ptr<PreparationReservationControl> m_control;
};

class ReservationPinControl {
public:
    virtual ~ReservationPinControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    [[nodiscard]] virtual const AssetCacheKey& cache_key_on_owner() const noexcept = 0;
    virtual void release_on_owner() noexcept = 0;
};

class ReservationPin {
public:
    ReservationPin() = default;
    ~ReservationPin() { reset(); }

    ReservationPin(const ReservationPin&) = delete;
    ReservationPin& operator=(const ReservationPin&) = delete;
    ReservationPin(ReservationPin&& other) noexcept = default;

    ReservationPin& operator=(ReservationPin&& other) noexcept
    {
        if (this == &other)
            return *this;
        reset();
        m_control = std::move(other.m_control);
        return *this;
    }

    [[nodiscard]] static ReservationPin
    from_control_on_owner(std::unique_ptr<ReservationPinControl> control) noexcept
    {
        assert(control != nullptr);
        control->assert_owner_thread();
        assert(control->cache_key_on_owner().valid());
        return ReservationPin(std::move(control));
    }

    [[nodiscard]] explicit operator bool() const noexcept { return m_control != nullptr; }

    [[nodiscard]] const AssetCacheKey& cache_key() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->cache_key_on_owner();
    }

    void reset() noexcept
    {
        if (m_control == nullptr)
            return;
        m_control->assert_owner_thread();
        m_control->release_on_owner();
        m_control.reset();
    }

private:
    explicit ReservationPin(std::unique_ptr<ReservationPinControl> control) noexcept
        : m_control(std::move(control))
    {
    }

    std::unique_ptr<ReservationPinControl> m_control;
};

struct ResidencyAdmissionRequest {
    AssetCacheKey cache_key;
    AssetRequestReason reason = AssetRequestReason::Demand;
    ResidencyCost estimated_cost;
};

struct ResidencyAdmissionResult {
    ResidencyAdmission admission = ResidencyAdmission::Deferred;
    ResidencyCost committed_cost;
    core::Diagnostics diagnostics;
};

struct ResidencyEvictionResult {
    std::vector<AssetCacheKey> evicted;
    ResidencyAccountingSnapshot accounting;
};

class ResidencyManager {
public:
    virtual ~ResidencyManager() = default;

    [[nodiscard]] virtual core::Result<PreparationReservation, core::Diagnostic>
    reserve_preparation_on_owner(ResidencyCost cost, AssetRequestReason reason) noexcept = 0;
    [[nodiscard]] virtual ResidencyAdmissionResult
    admit_on_owner(ResidencyAdmissionRequest request) noexcept = 0;
    [[nodiscard]] virtual core::Result<ReservationPin, core::Diagnostic>
    pin_resident_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    [[nodiscard]] virtual std::optional<ResidencyClass>
    classification_on_owner(const AssetCacheKey& cache_key) const noexcept = 0;
    virtual void mark_used_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    virtual void attach_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                                   PrefetchGenerationId generation) noexcept = 0;
    virtual void release_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                                    PrefetchGenerationId generation) noexcept = 0;
    [[nodiscard]] virtual ResidencyEvictionResult enforce_budgets_on_owner() noexcept = 0;
    [[nodiscard]] virtual bool evict_on_owner(const AssetCacheKey& cache_key,
                                              ResidencyEvictionReason reason) noexcept = 0;
    [[nodiscard]] virtual ResidencyAccountingSnapshot accounting_on_owner() const noexcept = 0;
};

} // namespace noveltea::assets
