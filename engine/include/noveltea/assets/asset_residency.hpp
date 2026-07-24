#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/jobs/job_types.hpp"

#include <cassert>
#include <compare>
#include <cstdint>
#include <memory>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::core {
class AssetTelemetrySink;
}

namespace noveltea::assets {

class AssetManager;

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
    std::uint32_t prefetch_allowance_percent = 100;

    auto operator<=>(const ResidencyBudget&) const = default;
};

enum class AssetMemoryTarget : std::uint8_t {
    Desktop,
    Android,
    Web,
};

enum class AssetMemoryPreset : std::uint8_t {
    Low,
    Balanced,
    High,
    Custom,
};

struct CustomAssetMemoryPolicy {
    std::optional<std::uint64_t> prepared_cpu_bytes;
    std::optional<std::uint64_t> gpu_bytes;
    std::optional<std::uint64_t> audio_bytes;
    std::optional<std::uint64_t> temporary_bytes;
    std::optional<std::uint32_t> prefetch_allowance_percent;
};

struct ResolvedAssetMemoryPolicy {
    AssetMemoryTarget target = AssetMemoryTarget::Desktop;
    AssetMemoryPreset preset = AssetMemoryPreset::Balanced;
    ResidencyBudget budget;

    auto operator<=>(const ResolvedAssetMemoryPolicy&) const = default;
};

inline constexpr std::uint64_t minimum_temporary_asset_budget_bytes = 1024u * 1024u;

[[nodiscard]] core::Result<ResolvedAssetMemoryPolicy, core::Diagnostics>
resolve_asset_memory_policy(AssetMemoryTarget target, AssetMemoryPreset preset,
                            const CustomAssetMemoryPolicy& custom = {});
[[nodiscard]] const char* asset_memory_target_name(AssetMemoryTarget target) noexcept;
[[nodiscard]] const char* asset_memory_preset_name(AssetMemoryPreset preset) noexcept;

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
    virtual void set_cost_on_owner(ResidencyCost cost) noexcept = 0;
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

    void set_cost_on_owner(ResidencyCost cost) noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        m_control->set_cost_on_owner(cost);
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

class ResidentAssetControl {
public:
    virtual ~ResidentAssetControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    virtual void destroy_on_owner(ResidencyEvictionReason reason) noexcept = 0;
};

struct PreparationReservationResult {
    ResidencyAdmission admission = ResidencyAdmission::Deferred;
    std::optional<PreparationReservation> reservation;
    core::Diagnostics diagnostics;
};

struct PreparationReservationResizeResult {
    ResidencyAdmission admission = ResidencyAdmission::Deferred;
    core::Diagnostics diagnostics;
};

struct ResidencyAdmissionRequest {
    AssetCacheKey cache_key;
    AssetRequestReason reason = AssetRequestReason::Demand;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    AssetRequestReason profiler_request_origin = AssetRequestReason::Demand;
    std::uint64_t profiler_reload_count = 0;
#endif
    ResidencyCost estimated_cost;
    std::shared_ptr<ResidentAssetControl> resident_control;
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

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
struct ResidencyProfilerRecord {
    AssetCacheKey cache_key;
    ResidencyCost committed_cost;
    AssetRequestReason request_origin = AssetRequestReason::Demand;
    std::uint64_t reload_count = 0;
    std::uint64_t pin_count = 0;
    ResidencyClass classification = ResidencyClass::Cold;
    std::uint64_t last_use_order = 0;
};
#endif

class ResidencyManager {
public:
    virtual ~ResidencyManager() = default;

    [[nodiscard]] virtual PreparationReservationResult
    reserve_preparation_on_owner(ResidencyCost cost, AssetRequestReason reason) noexcept = 0;
    [[nodiscard]] virtual PreparationReservationResizeResult
    resize_preparation_on_owner(PreparationReservation& reservation, ResidencyCost cost,
                                AssetRequestReason reason) noexcept
    {
        (void)reservation;
        (void)cost;
        (void)reason;
        return {.admission = ResidencyAdmission::Deferred,
                .diagnostics = {
                    {.code = "assets.preparation_resize_unsupported",
                     .message = "residency manager cannot resize preparation reservations"}}};
    }
    [[nodiscard]] virtual ResidencyAdmissionResult
    admit_on_owner(ResidencyAdmissionRequest request) noexcept = 0;
    [[nodiscard]] virtual core::Result<ReservationPin, core::Diagnostic>
    pin_resident_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    [[nodiscard]] virtual bool retain_pin_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    virtual void release_pin_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    [[nodiscard]] virtual bool resident_on_owner(const AssetCacheKey& cache_key) const noexcept = 0;
    [[nodiscard]] virtual std::optional<ResidencyClass>
    classification_on_owner(const AssetCacheKey& cache_key) const noexcept = 0;
    virtual void mark_used_on_owner(const AssetCacheKey& cache_key) noexcept = 0;
    [[nodiscard]] virtual bool
    attach_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                      PrefetchGenerationId generation) noexcept = 0;
    virtual void release_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                                    PrefetchGenerationId generation) noexcept = 0;
    [[nodiscard]] virtual ResidencyEvictionResult enforce_budgets_on_owner() noexcept = 0;
    [[nodiscard]] virtual bool evict_on_owner(const AssetCacheKey& cache_key,
                                              ResidencyEvictionReason reason) noexcept = 0;
    [[nodiscard]] virtual ResidencyAccountingSnapshot accounting_on_owner() const noexcept = 0;
    [[nodiscard]] virtual ResolvedAssetMemoryPolicy policy_on_owner() const noexcept = 0;

private:
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    friend class AssetManager;

    [[nodiscard]] virtual std::vector<ResidencyProfilerRecord> profiler_records_on_owner() const
    {
        return {};
    }
#endif
};

class AssetResidencyManager final : public ResidencyManager {
public:
    struct Impl;

    explicit AssetResidencyManager(
        ResidencyBudget budget, core::AssetTelemetrySink* telemetry = nullptr,
        jobs::JobExecutionMode execution_mode = jobs::JobExecutionMode::Cooperative);
    explicit AssetResidencyManager(
        ResolvedAssetMemoryPolicy policy, core::AssetTelemetrySink* telemetry = nullptr,
        jobs::JobExecutionMode execution_mode = jobs::JobExecutionMode::Cooperative);
    ~AssetResidencyManager() override;

    AssetResidencyManager(const AssetResidencyManager&) = delete;
    AssetResidencyManager& operator=(const AssetResidencyManager&) = delete;
    AssetResidencyManager(AssetResidencyManager&&) noexcept;
    AssetResidencyManager& operator=(AssetResidencyManager&&) noexcept;

    [[nodiscard]] PreparationReservationResult
    reserve_preparation_on_owner(ResidencyCost cost, AssetRequestReason reason) noexcept override;
    [[nodiscard]] PreparationReservationResizeResult
    resize_preparation_on_owner(PreparationReservation& reservation, ResidencyCost cost,
                                AssetRequestReason reason) noexcept override;
    [[nodiscard]] ResidencyAdmissionResult
    admit_on_owner(ResidencyAdmissionRequest request) noexcept override;
    [[nodiscard]] core::Result<ReservationPin, core::Diagnostic>
    pin_resident_on_owner(const AssetCacheKey& cache_key) noexcept override;
    [[nodiscard]] bool retain_pin_on_owner(const AssetCacheKey& cache_key) noexcept override;
    void release_pin_on_owner(const AssetCacheKey& cache_key) noexcept override;
    [[nodiscard]] bool resident_on_owner(const AssetCacheKey& cache_key) const noexcept override;
    [[nodiscard]] std::optional<ResidencyClass>
    classification_on_owner(const AssetCacheKey& cache_key) const noexcept override;
    void mark_used_on_owner(const AssetCacheKey& cache_key) noexcept override;
    [[nodiscard]] bool
    attach_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                      PrefetchGenerationId generation) noexcept override;
    void release_prefetch_interest_on_owner(const AssetCacheKey& cache_key,
                                            PrefetchGenerationId generation) noexcept override;
    [[nodiscard]] ResidencyEvictionResult enforce_budgets_on_owner() noexcept override;
    [[nodiscard]] bool evict_on_owner(const AssetCacheKey& cache_key,
                                      ResidencyEvictionReason reason) noexcept override;
    [[nodiscard]] ResidencyAccountingSnapshot accounting_on_owner() const noexcept override;
    [[nodiscard]] ResolvedAssetMemoryPolicy policy_on_owner() const noexcept override;

private:
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    [[nodiscard]] std::vector<ResidencyProfilerRecord> profiler_records_on_owner() const override;
#endif

    std::shared_ptr<Impl> m_impl;
};

} // namespace noveltea::assets
