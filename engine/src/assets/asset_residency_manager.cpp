#include "noveltea/assets/asset_residency.hpp"

#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <limits>
#include <map>
#include <tuple>
#include <utility>

namespace noveltea::assets {
namespace {

using PrefetchCounts = std::map<std::uint64_t, std::uint64_t>;

constexpr std::uint64_t mib(std::uint64_t value) noexcept { return value * 1024u * 1024u; }

ResidencyBudget measured_budget(AssetMemoryTarget target, AssetMemoryPreset preset) noexcept
{
    switch (target) {
    case AssetMemoryTarget::Desktop:
        switch (preset) {
        case AssetMemoryPreset::Low:
            return {.source_bytes = mib(64),
                    .prepared_cpu_bytes = mib(64),
                    .gpu_bytes = mib(128),
                    .audio_bytes = mib(32),
                    .temporary_bytes = mib(32),
                    .prefetch_allowance_percent = 20};
        case AssetMemoryPreset::Balanced:
        case AssetMemoryPreset::Custom:
            return {.source_bytes = mib(128),
                    .prepared_cpu_bytes = mib(128),
                    .gpu_bytes = mib(256),
                    .audio_bytes = mib(64),
                    .temporary_bytes = mib(64),
                    .prefetch_allowance_percent = 30};
        case AssetMemoryPreset::High:
            return {.source_bytes = mib(256),
                    .prepared_cpu_bytes = mib(256),
                    .gpu_bytes = mib(512),
                    .audio_bytes = mib(128),
                    .temporary_bytes = mib(128),
                    .prefetch_allowance_percent = 40};
        }
        break;
    case AssetMemoryTarget::Android:
        switch (preset) {
        case AssetMemoryPreset::Low:
            return {.source_bytes = mib(48),
                    .prepared_cpu_bytes = mib(48),
                    .gpu_bytes = mib(96),
                    .audio_bytes = mib(24),
                    .temporary_bytes = mib(24),
                    .prefetch_allowance_percent = 15};
        case AssetMemoryPreset::Balanced:
        case AssetMemoryPreset::Custom:
            return {.source_bytes = mib(96),
                    .prepared_cpu_bytes = mib(96),
                    .gpu_bytes = mib(192),
                    .audio_bytes = mib(48),
                    .temporary_bytes = mib(48),
                    .prefetch_allowance_percent = 25};
        case AssetMemoryPreset::High:
            return {.source_bytes = mib(192),
                    .prepared_cpu_bytes = mib(192),
                    .gpu_bytes = mib(384),
                    .audio_bytes = mib(96),
                    .temporary_bytes = mib(96),
                    .prefetch_allowance_percent = 35};
        }
        break;
    case AssetMemoryTarget::Web:
        switch (preset) {
        case AssetMemoryPreset::Low:
            return {.source_bytes = mib(32),
                    .prepared_cpu_bytes = mib(32),
                    .gpu_bytes = mib(64),
                    .audio_bytes = mib(16),
                    .temporary_bytes = mib(16),
                    .prefetch_allowance_percent = 10};
        case AssetMemoryPreset::Balanced:
        case AssetMemoryPreset::Custom:
            return {.source_bytes = mib(64),
                    .prepared_cpu_bytes = mib(64),
                    .gpu_bytes = mib(128),
                    .audio_bytes = mib(32),
                    .temporary_bytes = mib(32),
                    .prefetch_allowance_percent = 20};
        case AssetMemoryPreset::High:
            return {.source_bytes = mib(128),
                    .prepared_cpu_bytes = mib(128),
                    .gpu_bytes = mib(256),
                    .audio_bytes = mib(64),
                    .temporary_bytes = mib(64),
                    .prefetch_allowance_percent = 30};
        }
        break;
    }
    return {};
}

core::Diagnostic invalid_policy_field(std::string path, std::string message)
{
    return {.code = "assets.invalid_memory_policy",
            .message = std::move(message),
            .source_path = std::move(path)};
}

void add_cost(ResidencyCost& destination, const ResidencyCost& value) noexcept
{
    destination.source_bytes += value.source_bytes;
    destination.prepared_cpu_bytes += value.prepared_cpu_bytes;
    destination.gpu_bytes += value.gpu_bytes;
    destination.audio_bytes += value.audio_bytes;
    destination.temporary_bytes += value.temporary_bytes;
}

void subtract_cost(ResidencyCost& destination, const ResidencyCost& value) noexcept
{
    assert(destination.source_bytes >= value.source_bytes);
    assert(destination.prepared_cpu_bytes >= value.prepared_cpu_bytes);
    assert(destination.gpu_bytes >= value.gpu_bytes);
    assert(destination.audio_bytes >= value.audio_bytes);
    assert(destination.temporary_bytes >= value.temporary_bytes);
    destination.source_bytes -= value.source_bytes;
    destination.prepared_cpu_bytes -= value.prepared_cpu_bytes;
    destination.gpu_bytes -= value.gpu_bytes;
    destination.audio_bytes -= value.audio_bytes;
    destination.temporary_bytes -= value.temporary_bytes;
}

void update_high_water(ResidencyCost& high_water, const ResidencyCost& current) noexcept
{
    high_water.source_bytes = std::max(high_water.source_bytes, current.source_bytes);
    high_water.prepared_cpu_bytes =
        std::max(high_water.prepared_cpu_bytes, current.prepared_cpu_bytes);
    high_water.gpu_bytes = std::max(high_water.gpu_bytes, current.gpu_bytes);
    high_water.audio_bytes = std::max(high_water.audio_bytes, current.audio_bytes);
    high_water.temporary_bytes = std::max(high_water.temporary_bytes, current.temporary_bytes);
}

bool addition_exceeds(std::uint64_t current, std::uint64_t added, std::uint64_t budget) noexcept
{
    return current > budget || added > budget - current;
}

bool resident_addition_exceeds(const ResidencyCost& current, const ResidencyCost& added,
                               const ResidencyBudget& budget) noexcept
{
    return addition_exceeds(current.source_bytes, added.source_bytes, budget.source_bytes) ||
           addition_exceeds(current.prepared_cpu_bytes, added.prepared_cpu_bytes,
                            budget.prepared_cpu_bytes) ||
           addition_exceeds(current.gpu_bytes, added.gpu_bytes, budget.gpu_bytes) ||
           addition_exceeds(current.audio_bytes, added.audio_bytes, budget.audio_bytes);
}

bool resident_over_budget(const ResidencyCost& current, const ResidencyBudget& budget) noexcept
{
    return current.source_bytes > budget.source_bytes ||
           current.prepared_cpu_bytes > budget.prepared_cpu_bytes ||
           current.gpu_bytes > budget.gpu_bytes || current.audio_bytes > budget.audio_bytes;
}

std::uint64_t allowance_bytes(std::uint64_t budget, std::uint32_t percent) noexcept
{
    return budget / 100u * percent + budget % 100u * percent / 100u;
}

bool warm_addition_exceeds(const ResidencyCost& current, const ResidencyCost& added,
                           const ResidencyBudget& budget) noexcept
{
    const auto percent = budget.prefetch_allowance_percent;
    return addition_exceeds(current.prepared_cpu_bytes, added.prepared_cpu_bytes,
                            allowance_bytes(budget.prepared_cpu_bytes, percent)) ||
           addition_exceeds(current.gpu_bytes, added.gpu_bytes,
                            allowance_bytes(budget.gpu_bytes, percent)) ||
           addition_exceeds(current.audio_bytes, added.audio_bytes,
                            allowance_bytes(budget.audio_bytes, percent));
}

bool warm_over_budget(const ResidencyCost& current, const ResidencyBudget& budget) noexcept
{
    return current.prepared_cpu_bytes >
               allowance_bytes(budget.prepared_cpu_bytes, budget.prefetch_allowance_percent) ||
           current.gpu_bytes >
               allowance_bytes(budget.gpu_bytes, budget.prefetch_allowance_percent) ||
           current.audio_bytes >
               allowance_bytes(budget.audio_bytes, budget.prefetch_allowance_percent);
}

core::Diagnostic pressure_diagnostic(std::string code, std::string message)
{
    return {.code = std::move(code),
            .message = std::move(message),
            .severity = core::ErrorSeverity::Warning};
}

} // namespace

core::Result<ResolvedAssetMemoryPolicy, core::Diagnostics>
resolve_asset_memory_policy(AssetMemoryTarget target, AssetMemoryPreset preset,
                            const CustomAssetMemoryPolicy& custom)
{
    auto budget = measured_budget(target, preset);
    if (preset == AssetMemoryPreset::Custom) {
        budget.prepared_cpu_bytes = custom.prepared_cpu_bytes.value_or(budget.prepared_cpu_bytes);
        budget.source_bytes = budget.prepared_cpu_bytes;
        budget.gpu_bytes = custom.gpu_bytes.value_or(budget.gpu_bytes);
        budget.audio_bytes = custom.audio_bytes.value_or(budget.audio_bytes);
        budget.temporary_bytes = custom.temporary_bytes.value_or(budget.temporary_bytes);
        budget.prefetch_allowance_percent =
            custom.prefetch_allowance_percent.value_or(budget.prefetch_allowance_percent);
    }

    core::Diagnostics diagnostics;
    if (budget.prepared_cpu_bytes == 0)
        diagnostics.push_back(invalid_policy_field("/assetMemory/custom/preparedCpuBytes",
                                                   "prepared CPU budget must be positive"));
    if (budget.gpu_bytes == 0)
        diagnostics.push_back(
            invalid_policy_field("/assetMemory/custom/gpuBytes", "GPU budget must be positive"));
    if (budget.audio_bytes == 0)
        diagnostics.push_back(invalid_policy_field("/assetMemory/custom/audioBytes",
                                                   "audio budget must be positive"));
    if (budget.temporary_bytes < minimum_temporary_asset_budget_bytes) {
        diagnostics.push_back(
            invalid_policy_field("/assetMemory/custom/temporaryBytes",
                                 "temporary preparation budget must be at least 1 MiB"));
    }
    if (budget.prefetch_allowance_percent > 100) {
        diagnostics.push_back(
            invalid_policy_field("/assetMemory/custom/prefetchAllowancePercent",
                                 "prefetch allowance percent must be between 0 and 100"));
    }
    if (!diagnostics.empty())
        return core::Result<ResolvedAssetMemoryPolicy, core::Diagnostics>::failure(
            std::move(diagnostics));
    return core::Result<ResolvedAssetMemoryPolicy, core::Diagnostics>::success(
        {.target = target, .preset = preset, .budget = budget});
}

const char* asset_memory_target_name(AssetMemoryTarget target) noexcept
{
    switch (target) {
    case AssetMemoryTarget::Desktop:
        return "desktop";
    case AssetMemoryTarget::Android:
        return "android";
    case AssetMemoryTarget::Web:
        return "web";
    }
    return "desktop";
}

const char* asset_memory_preset_name(AssetMemoryPreset preset) noexcept
{
    switch (preset) {
    case AssetMemoryPreset::Low:
        return "low";
    case AssetMemoryPreset::Balanced:
        return "balanced";
    case AssetMemoryPreset::High:
        return "high";
    case AssetMemoryPreset::Custom:
        return "custom";
    }
    return "balanced";
}

struct AssetResidencyManager::Impl : std::enable_shared_from_this<Impl> {
    struct ResidentRecord {
        AssetCacheKey key;
        ResidencyCost cost;
        std::shared_ptr<ResidentAssetControl> control;
        std::uint64_t pin_count = 0;
        std::uint64_t last_use = 0;
    };

    struct ReservationRecord {
        PreparationReservationId id;
        ResidencyCost cost;
        AssetRequestReason reason = AssetRequestReason::Demand;
    };

    explicit Impl(ResolvedAssetMemoryPolicy configured_policy,
                  core::AssetTelemetrySink* telemetry_sink)
        : policy(configured_policy), budget(configured_policy.budget), telemetry(telemetry_sink)
    {
        if (telemetry != nullptr) {
            telemetry->record({.timestamp = std::chrono::steady_clock::now(),
                               .kind = core::AssetTelemetryEventKind::MemoryPolicyResolved,
                               .execution_mode = jobs::JobExecutionMode::Cooperative,
                               .cache_key = std::nullopt,
                               .job_id = {},
                               .request_id = {},
                               .prefetch_generation = {},
                               .request_reason = std::nullopt,
                               .job_priority = std::nullopt,
                               .memory = {},
                               .compressed_bytes = 0,
                               .uncompressed_bytes = 0,
                               .duration = {},
                               .diagnostic_code = {},
                               .memory_policy = policy});
        }
    }

    ~Impl()
    {
        owner_thread.assert_owner_thread();
        while (!residents.empty())
            evict_record(residents.begin(), ResidencyEvictionReason::ExplicitRelease);
        reservations.clear();
    }

    void assert_owner() const noexcept { owner_thread.assert_owner_thread(); }

    [[nodiscard]] ResidencyClass classification(const ResidentRecord& record) const noexcept
    {
        if (record.pin_count > 0)
            return ResidencyClass::Pinned;
        const auto interests = prefetch_interests.find(record.key);
        if (interests != prefetch_interests.end() && !interests->second.empty())
            return ResidencyClass::Warm;
        return ResidencyClass::Cold;
    }

    void record_telemetry(core::AssetTelemetryEventKind kind, const AssetCacheKey* key = nullptr,
                          std::string diagnostic_code = {}) noexcept
    {
        if (telemetry == nullptr)
            return;
        core::AssetTelemetryEvent event{
            .timestamp = std::chrono::steady_clock::now(),
            .kind = kind,
            .execution_mode = jobs::JobExecutionMode::Cooperative,
            .cache_key = std::nullopt,
            .job_id = {},
            .request_id = {},
            .prefetch_generation = {},
            .request_reason = std::nullopt,
            .job_priority = std::nullopt,
            .memory = accounting.current,
            .compressed_bytes = 0,
            .uncompressed_bytes = 0,
            .duration = {},
            .diagnostic_code = std::move(diagnostic_code),
            .memory_policy = std::nullopt,
        };
        if (key != nullptr)
            event.cache_key = *key;
        telemetry->record(std::move(event));
    }

    void add_accounting(const ResidencyCost& cost) noexcept
    {
        add_cost(accounting.current, cost);
        update_high_water(accounting.high_water, accounting.current);
    }

    void subtract_accounting(const ResidencyCost& cost) noexcept
    {
        subtract_cost(accounting.current, cost);
    }

    void release_reservation(PreparationReservationId id) noexcept
    {
        assert_owner();
        const auto found = reservations.find(id.value);
        if (found == reservations.end())
            return;
        subtract_accounting(found->second.cost);
        reservations.erase(found);
    }

    using ResidentIterator = std::map<AssetCacheKey, ResidentRecord>::iterator;

    [[nodiscard]] ResidencyCost warm_cost() const noexcept
    {
        ResidencyCost result;
        for (const auto& [_, record] : residents) {
            if (classification(record) == ResidencyClass::Warm)
                add_cost(result, record.cost);
        }
        return result;
    }

    [[nodiscard]] ResidentIterator eviction_candidate(bool warm_only = false)
    {
        ResidentIterator best = residents.end();
        auto rank = [this](const ResidentRecord& record) {
            switch (classification(record)) {
            case ResidencyClass::Cold:
                return 0;
            case ResidencyClass::Warm:
                return 1;
            case ResidencyClass::Pinned:
                return 2;
            }
            return 2;
        };
        for (auto it = residents.begin(); it != residents.end(); ++it) {
            if (it->second.pin_count > 0)
                continue;
            if (warm_only && classification(it->second) != ResidencyClass::Warm)
                continue;
            if (best == residents.end()) {
                best = it;
                continue;
            }
            const auto left = std::tuple{rank(it->second), it->second.last_use,
                                         std::numeric_limits<std::uint64_t>::max() -
                                             it->second.cost.resident_bytes(),
                                         it->second.key};
            const auto right = std::tuple{rank(best->second), best->second.last_use,
                                          std::numeric_limits<std::uint64_t>::max() -
                                              best->second.cost.resident_bytes(),
                                          best->second.key};
            if (left < right)
                best = it;
        }
        return best;
    }

    AssetCacheKey evict_record(ResidentIterator found, ResidencyEvictionReason reason) noexcept
    {
        assert_owner();
        AssetCacheKey key = found->second.key;
        ResidencyCost cost = found->second.cost;
        auto control = std::move(found->second.control);
        prefetch_interests.erase(key);
        residents.erase(found);
        subtract_accounting(cost);
        if (control != nullptr) {
            control->assert_owner_thread();
            control->destroy_on_owner(reason);
        }
        record_telemetry(core::AssetTelemetryEventKind::Evicted, &key);
        return key;
    }

    [[nodiscard]] ResidencyEvictionResult enforce_budgets() noexcept
    {
        assert_owner();
        ResidencyEvictionResult result;
        while (resident_over_budget(accounting.current, budget)) {
            auto candidate = eviction_candidate();
            if (candidate == residents.end())
                break;
            result.evicted.push_back(
                evict_record(candidate, ResidencyEvictionReason::BudgetPressure));
        }
        while (warm_over_budget(warm_cost(), budget)) {
            auto candidate = eviction_candidate(true);
            if (candidate == residents.end())
                break;
            result.evicted.push_back(
                evict_record(candidate, ResidencyEvictionReason::BudgetPressure));
        }
        result.accounting = accounting;
        return result;
    }

    jobs::OwnerThreadGuard owner_thread;
    ResolvedAssetMemoryPolicy policy;
    ResidencyBudget budget;
    core::AssetTelemetrySink* telemetry = nullptr;
    ResidencyAccountingSnapshot accounting;
    std::map<AssetCacheKey, ResidentRecord> residents;
    std::map<AssetCacheKey, PrefetchCounts> prefetch_interests;
    std::map<std::uint64_t, ReservationRecord> reservations;
    std::uint64_t next_reservation_id = 1;
    std::uint64_t use_clock = 0;
};

namespace {

class PreparationReservationControlImpl final : public PreparationReservationControl {
public:
    PreparationReservationControlImpl(std::shared_ptr<AssetResidencyManager::Impl> owner,
                                      PreparationReservationId id, ResidencyCost cost)
        : m_owner(std::move(owner)), m_id(id), m_cost(cost)
    {
    }

    void assert_owner_thread() const noexcept override { m_owner->assert_owner(); }
    [[nodiscard]] PreparationReservationId id_on_owner() const noexcept override { return m_id; }
    [[nodiscard]] ResidencyCost cost_on_owner() const noexcept override { return m_cost; }
    void release_on_owner() noexcept override
    {
        if (m_released)
            return;
        m_owner->release_reservation(m_id);
        m_released = true;
    }

private:
    std::shared_ptr<AssetResidencyManager::Impl> m_owner;
    PreparationReservationId m_id;
    ResidencyCost m_cost;
    bool m_released = false;
};

class ReservationPinControlImpl final : public ReservationPinControl {
public:
    ReservationPinControlImpl(std::shared_ptr<AssetResidencyManager::Impl> owner, AssetCacheKey key)
        : m_owner(std::move(owner)), m_key(std::move(key))
    {
    }

    void assert_owner_thread() const noexcept override { m_owner->assert_owner(); }
    [[nodiscard]] const AssetCacheKey& cache_key_on_owner() const noexcept override
    {
        return m_key;
    }
    void release_on_owner() noexcept override
    {
        if (m_released)
            return;
        const auto found = m_owner->residents.find(m_key);
        if (found != m_owner->residents.end()) {
            assert(found->second.pin_count > 0);
            --found->second.pin_count;
            m_owner->record_telemetry(core::AssetTelemetryEventKind::PinReleased, &m_key);
            (void)m_owner->enforce_budgets();
        }
        m_released = true;
    }

private:
    std::shared_ptr<AssetResidencyManager::Impl> m_owner;
    AssetCacheKey m_key;
    bool m_released = false;
};

} // namespace

AssetResidencyManager::AssetResidencyManager(ResidencyBudget budget,
                                             core::AssetTelemetrySink* telemetry)
    : AssetResidencyManager(ResolvedAssetMemoryPolicy{.target = AssetMemoryTarget::Desktop,
                                                      .preset = AssetMemoryPreset::Custom,
                                                      .budget = budget},
                            telemetry)
{
}

AssetResidencyManager::AssetResidencyManager(ResolvedAssetMemoryPolicy policy,
                                             core::AssetTelemetrySink* telemetry)
    : m_impl(std::make_shared<Impl>(policy, telemetry))
{
}

AssetResidencyManager::~AssetResidencyManager() = default;
AssetResidencyManager::AssetResidencyManager(AssetResidencyManager&&) noexcept = default;
AssetResidencyManager& AssetResidencyManager::operator=(AssetResidencyManager&&) noexcept = default;

PreparationReservationResult
AssetResidencyManager::reserve_preparation_on_owner(ResidencyCost cost,
                                                    AssetRequestReason reason) noexcept
{
    m_impl->assert_owner();
    const bool exceeds = addition_exceeds(m_impl->accounting.current.temporary_bytes,
                                          cost.temporary_bytes, m_impl->budget.temporary_bytes);
    if (exceeds && reason == AssetRequestReason::Prefetch) {
        m_impl->record_telemetry(core::AssetTelemetryEventKind::BudgetPressure, nullptr,
                                 "assets.prefetch_preparation_rejected");
        return {.admission = ResidencyAdmission::RejectedPrefetch,
                .reservation = std::nullopt,
                .diagnostics = {pressure_diagnostic(
                    "assets.prefetch_preparation_rejected",
                    "prefetch preparation would exceed the temporary asset budget")}};
    }
    if (exceeds && m_impl->accounting.current.temporary_bytes != 0) {
        return {.admission = ResidencyAdmission::Deferred,
                .reservation = std::nullopt,
                .diagnostics = {pressure_diagnostic(
                    "assets.preparation_deferred",
                    "mandatory asset preparation is deferred until temporary memory is released")}};
    }

    if (m_impl->next_reservation_id == 0) {
        return {
            .admission = ResidencyAdmission::Deferred,
            .reservation = std::nullopt,
            .diagnostics = {{.code = "assets.preparation_reservation_id_exhausted",
                             .message = "asset preparation reservation ID space is exhausted"}}};
    }
    const PreparationReservationId id{m_impl->next_reservation_id++};
    m_impl->reservations.emplace(id.value,
                                 Impl::ReservationRecord{.id = id, .cost = cost, .reason = reason});
    m_impl->add_accounting(cost);

    const ResidencyAdmission admission =
        exceeds ? ResidencyAdmission::AdmittedOverBudget : ResidencyAdmission::Admitted;
    core::Diagnostics diagnostics;
    if (exceeds) {
        diagnostics.push_back(pressure_diagnostic(
            "assets.oversized_mandatory_preparation",
            "mandatory asset preparation exceeds the temporary budget and is admitted serially"));
        m_impl->record_telemetry(core::AssetTelemetryEventKind::BudgetPressure, nullptr,
                                 diagnostics.front().code);
    }
    auto control = std::make_unique<PreparationReservationControlImpl>(m_impl, id, cost);
    return {.admission = admission,
            .reservation = PreparationReservation::from_control_on_owner(std::move(control)),
            .diagnostics = std::move(diagnostics)};
}

ResidencyAdmissionResult
AssetResidencyManager::admit_on_owner(ResidencyAdmissionRequest request) noexcept
{
    m_impl->assert_owner();
    ResidencyCost committed = request.estimated_cost;
    committed.temporary_bytes = 0;
    if (!request.cache_key.valid() || request.resident_control == nullptr) {
        return {
            .admission = ResidencyAdmission::Deferred,
            .committed_cost = {},
            .diagnostics = {{.code = "assets.invalid_residency_admission",
                             .message = "residency admission requires a valid key and control"}}};
    }
    const auto existing = m_impl->residents.find(request.cache_key);
    if (existing != m_impl->residents.end()) {
        return {.admission = ResidencyAdmission::Admitted,
                .committed_cost = existing->second.cost,
                .diagnostics = {}};
    }

    if (request.reason == AssetRequestReason::Prefetch &&
        (resident_addition_exceeds(m_impl->accounting.current, committed, m_impl->budget) ||
         warm_addition_exceeds(m_impl->warm_cost(), committed, m_impl->budget))) {
        m_impl->record_telemetry(core::AssetTelemetryEventKind::BudgetPressure, &request.cache_key,
                                 "assets.prefetch_residency_rejected");
        return {.admission = ResidencyAdmission::RejectedPrefetch,
                .committed_cost = {},
                .diagnostics = {
                    pressure_diagnostic("assets.prefetch_residency_rejected",
                                        "prefetch residency would exceed an asset memory budget or "
                                        "the Warm residency allowance")}};
    }

    while (resident_addition_exceeds(m_impl->accounting.current, committed, m_impl->budget)) {
        auto candidate = m_impl->eviction_candidate();
        if (candidate == m_impl->residents.end())
            break;
        (void)m_impl->evict_record(candidate, ResidencyEvictionReason::BudgetPressure);
    }

    const bool over_budget =
        resident_addition_exceeds(m_impl->accounting.current, committed, m_impl->budget);
    Impl::ResidentRecord record{
        .key = request.cache_key,
        .cost = committed,
        .control = std::move(request.resident_control),
        .pin_count = 0,
        .last_use = ++m_impl->use_clock,
    };
    m_impl->residents.emplace(record.key, std::move(record));
    m_impl->add_accounting(committed);

    core::Diagnostics diagnostics;
    if (over_budget) {
        diagnostics.push_back(pressure_diagnostic(
            "assets.mandatory_residency_over_budget",
            "mandatory resident asset exceeds configured memory budgets after eligible eviction"));
        m_impl->record_telemetry(core::AssetTelemetryEventKind::BudgetPressure, &request.cache_key,
                                 diagnostics.front().code);
    }
    return {.admission =
                over_budget ? ResidencyAdmission::AdmittedOverBudget : ResidencyAdmission::Admitted,
            .committed_cost = committed,
            .diagnostics = std::move(diagnostics)};
}

core::Result<ReservationPin, core::Diagnostic>
AssetResidencyManager::pin_resident_on_owner(const AssetCacheKey& cache_key) noexcept
{
    m_impl->assert_owner();
    if (!retain_pin_on_owner(cache_key)) {
        return core::Result<ReservationPin, core::Diagnostic>::failure(
            {.code = "assets.pin_missing_resident",
             .message = "cannot pin an asset that is not resident"});
    }
    return core::Result<ReservationPin, core::Diagnostic>::success(
        ReservationPin::from_control_on_owner(
            std::make_unique<ReservationPinControlImpl>(m_impl, cache_key)));
}

bool AssetResidencyManager::retain_pin_on_owner(const AssetCacheKey& cache_key) noexcept
{
    m_impl->assert_owner();
    const auto found = m_impl->residents.find(cache_key);
    if (found == m_impl->residents.end())
        return false;
    ++found->second.pin_count;
    found->second.last_use = ++m_impl->use_clock;
    m_impl->record_telemetry(core::AssetTelemetryEventKind::PinAdded, &cache_key);
    return true;
}

void AssetResidencyManager::release_pin_on_owner(const AssetCacheKey& cache_key) noexcept
{
    m_impl->assert_owner();
    const auto found = m_impl->residents.find(cache_key);
    if (found == m_impl->residents.end())
        return;
    assert(found->second.pin_count > 0);
    --found->second.pin_count;
    m_impl->record_telemetry(core::AssetTelemetryEventKind::PinReleased, &cache_key);
    (void)m_impl->enforce_budgets();
}

bool AssetResidencyManager::resident_on_owner(const AssetCacheKey& cache_key) const noexcept
{
    m_impl->assert_owner();
    return m_impl->residents.contains(cache_key);
}

std::optional<ResidencyClass>
AssetResidencyManager::classification_on_owner(const AssetCacheKey& cache_key) const noexcept
{
    m_impl->assert_owner();
    const auto found = m_impl->residents.find(cache_key);
    if (found == m_impl->residents.end())
        return std::nullopt;
    return m_impl->classification(found->second);
}

void AssetResidencyManager::mark_used_on_owner(const AssetCacheKey& cache_key) noexcept
{
    m_impl->assert_owner();
    const auto found = m_impl->residents.find(cache_key);
    if (found != m_impl->residents.end())
        found->second.last_use = ++m_impl->use_clock;
}

bool AssetResidencyManager::attach_prefetch_interest_on_owner(
    const AssetCacheKey& cache_key, PrefetchGenerationId generation) noexcept
{
    m_impl->assert_owner();
    if (!cache_key.valid() || !generation.valid())
        return false;
    const auto resident = m_impl->residents.find(cache_key);
    if (resident != m_impl->residents.end() &&
        m_impl->classification(resident->second) == ResidencyClass::Cold &&
        warm_addition_exceeds(m_impl->warm_cost(), resident->second.cost, m_impl->budget)) {
        m_impl->record_telemetry(core::AssetTelemetryEventKind::BudgetPressure, &cache_key,
                                 "assets.prefetch_allowance_exceeded");
        return false;
    }
    ++m_impl->prefetch_interests[cache_key][generation.value];
    return true;
}

void AssetResidencyManager::release_prefetch_interest_on_owner(
    const AssetCacheKey& cache_key, PrefetchGenerationId generation) noexcept
{
    m_impl->assert_owner();
    const auto key_found = m_impl->prefetch_interests.find(cache_key);
    if (key_found == m_impl->prefetch_interests.end())
        return;
    const auto generation_found = key_found->second.find(generation.value);
    if (generation_found == key_found->second.end())
        return;
    if (--generation_found->second == 0)
        key_found->second.erase(generation_found);
    if (key_found->second.empty())
        m_impl->prefetch_interests.erase(key_found);
}

ResidencyEvictionResult AssetResidencyManager::enforce_budgets_on_owner() noexcept
{
    return m_impl->enforce_budgets();
}

bool AssetResidencyManager::evict_on_owner(const AssetCacheKey& cache_key,
                                           ResidencyEvictionReason reason) noexcept
{
    m_impl->assert_owner();
    const auto found = m_impl->residents.find(cache_key);
    if (found == m_impl->residents.end() || found->second.pin_count > 0)
        return false;
    (void)m_impl->evict_record(found, reason);
    return true;
}

ResidencyAccountingSnapshot AssetResidencyManager::accounting_on_owner() const noexcept
{
    m_impl->assert_owner();
    return m_impl->accounting;
}

ResolvedAssetMemoryPolicy AssetResidencyManager::policy_on_owner() const noexcept
{
    m_impl->assert_owner();
    return m_impl->policy;
}

} // namespace noveltea::assets
