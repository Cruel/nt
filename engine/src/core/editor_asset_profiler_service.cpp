#include "core/editor_asset_profiler_service.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <mutex>
#include <utility>
#include <vector>

namespace noveltea::core {
namespace {

std::atomic<std::uint64_t> next_session_id{1};

AssetProfilerSessionId allocate_session_id() noexcept
{
    const auto value = next_session_id.fetch_add(1, std::memory_order_relaxed);
    if (value == 0)
        std::abort();
    return AssetProfilerSessionId{value};
}

bool retain_in_profiler_history(const AssetTelemetryEvent& event) noexcept
{
    switch (event.kind) {
    case AssetTelemetryEventKind::SourceReadCompleted:
    case AssetTelemetryEventKind::SourceReadFailed:
    case AssetTelemetryEventKind::PreparationCompleted:
    case AssetTelemetryEventKind::PreparationFailed:
    case AssetTelemetryEventKind::OwnerFinalizationCompleted:
    case AssetTelemetryEventKind::OwnerFinalizationFailed:
    case AssetTelemetryEventKind::RequestFailed:
    case AssetTelemetryEventKind::Evicted:
    case AssetTelemetryEventKind::ReloadedAfterEviction:
    case AssetTelemetryEventKind::PrefetchUsed:
    case AssetTelemetryEventKind::PrefetchLate:
    case AssetTelemetryEventKind::PrefetchMiss:
    case AssetTelemetryEventKind::PrefetchUnused:
        return true;
    case AssetTelemetryEventKind::BudgetPressure:
        return event.prefetch_generation.valid() &&
               (event.diagnostic_code == "assets.prefetch_allowance_exceeded" ||
                event.diagnostic_code == "assets.prefetch_preparation_rejected" ||
                event.diagnostic_code == "assets.prefetch_preparation_resize_rejected" ||
                event.diagnostic_code == "assets.prefetch_residency_rejected");
    default:
        return false;
    }
}

std::uint64_t elapsed_ns(std::chrono::steady_clock::time_point start,
                         std::chrono::steady_clock::time_point now) noexcept
{
    const auto elapsed = now - start;
    return static_cast<std::uint64_t>(std::max<std::int64_t>(
        0, std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count()));
}

std::uint64_t asset_ram_bytes(const assets::ResidencyCost& cost) noexcept
{
    return cost.source_bytes + cost.prepared_cpu_bytes + cost.audio_bytes;
}

void update_memory_peak(AssetProfilerMemoryPeaks& peak,
                        const AssetProfilerMemoryValues& current) noexcept
{
    peak.asset.source_bytes = std::max(peak.asset.source_bytes, current.asset.source_bytes);
    peak.asset.prepared_cpu_bytes =
        std::max(peak.asset.prepared_cpu_bytes, current.asset.prepared_cpu_bytes);
    peak.asset.gpu_bytes = std::max(peak.asset.gpu_bytes, current.asset.gpu_bytes);
    peak.asset.audio_bytes = std::max(peak.asset.audio_bytes, current.asset.audio_bytes);
    peak.asset.temporary_bytes =
        std::max(peak.asset.temporary_bytes, current.asset.temporary_bytes);
    peak.asset_ram_bytes = std::max(peak.asset_ram_bytes, current.asset_ram_bytes);
    if (current.renderer_estimate.ordinary_texture_bytes) {
        peak.renderer_estimate.ordinary_texture_bytes =
            std::max(peak.renderer_estimate.ordinary_texture_bytes.value_or(0),
                     *current.renderer_estimate.ordinary_texture_bytes);
    }
    if (current.renderer_estimate.render_target_bytes) {
        peak.renderer_estimate.render_target_bytes =
            std::max(peak.renderer_estimate.render_target_bytes.value_or(0),
                     *current.renderer_estimate.render_target_bytes);
    }
    if (current.total_gpu_resource_bytes) {
        peak.total_gpu_resource_bytes =
            std::max(peak.total_gpu_resource_bytes.value_or(0), *current.total_gpu_resource_bytes);
    }
}

AssetProfilerStateCounts state_counts(const std::vector<AssetProfilerEntry>& inventory) noexcept
{
    AssetProfilerStateCounts counts;
    for (const auto& entry : inventory) {
        switch (entry.state) {
        case AssetProfilerState::InUse:
            ++counts.in_use;
            break;
        case AssetProfilerState::Prefetched:
            ++counts.prefetched;
            break;
        case AssetProfilerState::Cached:
            ++counts.cached;
            break;
        case AssetProfilerState::Loading:
            ++counts.loading;
            break;
        case AssetProfilerState::Finishing:
            ++counts.finishing;
            break;
        case AssetProfilerState::Failed:
            ++counts.failed;
            break;
        }
    }
    return counts;
}

constexpr auto renderer_sample_interval = std::chrono::seconds(1);

} // namespace

struct EditorAssetProfilerService::Impl {
    explicit Impl(ClockNow clock)
        : recorder(production_asset_telemetry_event_capacity),
          clock_now(clock ? std::move(clock)
                          : ClockNow{[] { return std::chrono::steady_clock::now(); }})
    {
        reset_session_unlocked();
    }

    void reset_session_unlocked()
    {
        session_id = allocate_session_id();
        session_started = clock_now();
        next_sequence = 1;
        change_start = 0;
        retained_change_count = 0;
        lost_change_count = 0;
        inventory.clear();
        inventory_revision = 0;
        inventory_dirty = true;
        accounting_revision = 0;
        flushed_accounting_revision = 0;
        flushed_inventory_revision = 0;
        memory_current = {};
        memory_peak = {};
        current_state_counts = {};
        renderer_sampled_at.reset();
        renderer_sampled_at_ns.reset();
        renderer_history_dirty = false;
        last_memory_point.reset();
        changes.clear();
        changes.resize(editor_asset_profiler_change_capacity);
    }

    AssetProfilerSequence allocate_sequence_unlocked() noexcept
    {
        if (next_sequence == 0)
            std::abort();
        return AssetProfilerSequence{next_sequence++};
    }

    void append_change_unlocked(AssetProfilerChangePayload payload)
    {
        AssetProfilerChange change{.sequence = allocate_sequence_unlocked(),
                                   .timestamp_ns = elapsed_ns(session_started, clock_now()),
                                   .payload = std::move(payload)};
        if (retained_change_count < changes.size()) {
            const auto index = (change_start + retained_change_count) % changes.size();
            changes[index] = std::move(change);
            ++retained_change_count;
        } else {
            changes[change_start] = std::move(change);
            change_start = (change_start + 1) % changes.size();
            ++lost_change_count;
        }
    }

    jobs::OwnerThreadGuard owner_thread;
    AssetTelemetryRecorder recorder;
    ClockNow clock_now;
    mutable std::mutex mutex;
    AssetProfilerSessionId session_id;
    std::chrono::steady_clock::time_point session_started{};
    std::uint64_t next_sequence = 1;
    std::vector<AssetProfilerChange> changes;
    std::size_t change_start = 0;
    std::size_t retained_change_count = 0;
    std::uint64_t lost_change_count = 0;
    std::function<std::vector<AssetProfilerEntry>()> inventory_provider;
    std::function<std::pair<assets::ResidencyAccountingSnapshot, assets::ResidencyCost>()>
        memory_provider;
    std::function<AssetProfilerRendererEstimate()> renderer_provider;
    assets::ResolvedAssetMemoryPolicy policy;
    AssetProfilerMemoryValues memory_current;
    AssetProfilerMemoryPeaks memory_peak;
    AssetProfilerStateCounts current_state_counts;
    std::uint64_t accounting_revision = 0;
    std::uint64_t flushed_accounting_revision = 0;
    std::uint64_t flushed_inventory_revision = 0;
    std::optional<std::chrono::steady_clock::time_point> renderer_sampled_at;
    std::optional<std::uint64_t> renderer_sampled_at_ns;
    bool renderer_history_dirty = false;
    std::optional<AssetProfilerMemoryPoint> last_memory_point;
    std::vector<AssetProfilerEntry> inventory;
    std::uint64_t inventory_revision = 0;
    bool inventory_dirty = true;
};

EditorAssetProfilerService::EditorAssetProfilerService(ClockNow clock_now)
    : m_impl(std::make_unique<Impl>(std::move(clock_now)))
{
}

EditorAssetProfilerService::~EditorAssetProfilerService() = default;

void EditorAssetProfilerService::record(AssetTelemetryEvent event) noexcept
{
    std::lock_guard lock(m_impl->mutex);
    m_impl->recorder.record(event);
    if (event.cache_key.has_value())
        m_impl->inventory_dirty = true;
    if (!retain_in_profiler_history(event))
        return;

    event.timestamp = m_impl->clock_now();
    m_impl->append_change_unlocked(std::move(event));
}

void EditorAssetProfilerService::record_accounting_change(
    const assets::ResidencyAccountingSnapshot& current) noexcept
{
    std::lock_guard lock(m_impl->mutex);
    m_impl->memory_current.asset = current.current;
    m_impl->memory_current.asset_ram_bytes = asset_ram_bytes(current.current);
    update_memory_peak(m_impl->memory_peak, m_impl->memory_current);
    ++m_impl->accounting_revision;
    m_impl->inventory_dirty = true;
}

void EditorAssetProfilerService::record_inventory_maybe_changed() noexcept
{
    std::lock_guard lock(m_impl->mutex);
    m_impl->inventory_dirty = true;
}

AssetTelemetrySnapshot EditorAssetProfilerService::snapshot_on_owner() const
{
    std::lock_guard lock(m_impl->mutex);
    return m_impl->recorder.snapshot_on_owner();
}

AssetProfilerSnapshot EditorAssetProfilerService::capture_on_owner() const
{
    refresh_inventory_on_owner();
    refresh_memory_on_owner();
    (void)sample_renderer_on_owner(false);
    std::lock_guard lock(m_impl->mutex);
    AssetProfilerSnapshot snapshot;
    snapshot.session_id = m_impl->session_id;
    snapshot.latest_sequence = AssetProfilerSequence{m_impl->next_sequence - 1};
    snapshot.captured_at_ns = elapsed_ns(m_impl->session_started, m_impl->clock_now());
    snapshot.lost_change_count = m_impl->lost_change_count;
    snapshot.history_complete = m_impl->lost_change_count == 0;
    snapshot.assets = m_impl->inventory;
    snapshot.inventory_revision = m_impl->inventory_revision;
    snapshot.memory = {.current = m_impl->memory_current,
                       .peak = m_impl->memory_peak,
                       .policy = m_impl->policy,
                       .asset_counts = m_impl->current_state_counts,
                       .accounting_revision = m_impl->accounting_revision,
                       .renderer_sampled_at_ns = m_impl->renderer_sampled_at_ns};
    snapshot.retained_changes.reserve(m_impl->retained_change_count);
    for (std::size_t offset = 0; offset < m_impl->retained_change_count; ++offset) {
        const auto index = (m_impl->change_start + offset) % m_impl->changes.size();
        snapshot.retained_changes.push_back(m_impl->changes[index]);
    }
    if (!snapshot.retained_changes.empty())
        snapshot.earliest_retained_sequence = snapshot.retained_changes.front().sequence;
    return snapshot;
}

void EditorAssetProfilerService::refresh_inventory_on_owner() const
{
    m_impl->owner_thread.assert_owner_thread();
    std::function<std::vector<AssetProfilerEntry>()> provider;
    {
        std::lock_guard lock(m_impl->mutex);
        if (m_impl->inventory_dirty && m_impl->inventory_provider) {
            provider = m_impl->inventory_provider;
            m_impl->inventory_dirty = false;
        }
    }
    if (!provider)
        return;

    auto inventory = provider();
    std::lock_guard lock(m_impl->mutex);
    if (inventory != m_impl->inventory) {
        m_impl->inventory = std::move(inventory);
        m_impl->current_state_counts = state_counts(m_impl->inventory);
        ++m_impl->inventory_revision;
        m_impl->append_change_unlocked(AssetProfilerInventoryChanged{m_impl->inventory_revision});
    }
}

void EditorAssetProfilerService::refresh_memory_on_owner() const
{
    m_impl->owner_thread.assert_owner_thread();
    std::function<std::pair<assets::ResidencyAccountingSnapshot, assets::ResidencyCost>()> provider;
    {
        std::lock_guard lock(m_impl->mutex);
        provider = m_impl->memory_provider;
    }
    if (!provider)
        return;

    auto [accounting, warm] = provider();
    std::lock_guard lock(m_impl->mutex);
    m_impl->memory_current.asset = accounting.current;
    m_impl->memory_current.warm = warm;
    m_impl->memory_current.asset_ram_bytes = asset_ram_bytes(accounting.current);
    update_memory_peak(m_impl->memory_peak, m_impl->memory_current);
}

bool EditorAssetProfilerService::sample_renderer_on_owner(bool force) const
{
    m_impl->owner_thread.assert_owner_thread();
    std::function<AssetProfilerRendererEstimate()> provider;
    std::chrono::steady_clock::time_point sampled_at;
    {
        std::lock_guard lock(m_impl->mutex);
        provider = m_impl->renderer_provider;
        if (!provider)
            return false;
        sampled_at = m_impl->clock_now();
        if (!force && m_impl->renderer_sampled_at &&
            sampled_at - *m_impl->renderer_sampled_at < renderer_sample_interval) {
            return false;
        }
    }

    const auto estimate = provider();
    std::lock_guard lock(m_impl->mutex);
    const auto previous_estimate = m_impl->memory_current.renderer_estimate;
    const auto previous_total = m_impl->memory_current.total_gpu_resource_bytes;
    m_impl->memory_current.renderer_estimate = estimate;
    m_impl->memory_current.total_gpu_resource_bytes = estimate.total_bytes();
    m_impl->renderer_sampled_at = sampled_at;
    m_impl->renderer_sampled_at_ns = elapsed_ns(m_impl->session_started, sampled_at);
    update_memory_peak(m_impl->memory_peak, m_impl->memory_current);
    const bool changed = previous_estimate != estimate ||
                         previous_total != m_impl->memory_current.total_gpu_resource_bytes;
    m_impl->renderer_history_dirty = m_impl->renderer_history_dirty || changed;
    return changed;
}

void EditorAssetProfilerService::flush_frame_on_owner() const
{
    m_impl->owner_thread.assert_owner_thread();
    refresh_inventory_on_owner();
    refresh_memory_on_owner();
    (void)sample_renderer_on_owner(false);

    std::lock_guard lock(m_impl->mutex);
    const AssetProfilerMemoryPoint point{.values = m_impl->memory_current,
                                         .asset_counts = m_impl->current_state_counts};
    const bool state_changed = m_impl->accounting_revision != m_impl->flushed_accounting_revision ||
                               m_impl->inventory_revision != m_impl->flushed_inventory_revision ||
                               m_impl->renderer_history_dirty;
    if (state_changed && (!m_impl->last_memory_point || *m_impl->last_memory_point != point)) {
        m_impl->append_change_unlocked(point);
        m_impl->last_memory_point = point;
    }
    m_impl->flushed_accounting_revision = m_impl->accounting_revision;
    m_impl->flushed_inventory_revision = m_impl->inventory_revision;
    m_impl->renderer_history_dirty = false;
}

core::Result<AssetProfilerDelta, core::Diagnostic>
EditorAssetProfilerService::capture_delta_on_owner(AssetProfilerSessionId expected_session,
                                                   AssetProfilerSequence after_sequence) const
{
    refresh_inventory_on_owner();
    refresh_memory_on_owner();
    (void)sample_renderer_on_owner(false);
    std::lock_guard lock(m_impl->mutex);
    if (expected_session != m_impl->session_id) {
        return core::Result<AssetProfilerDelta, core::Diagnostic>::failure(
            {.code = "assets.editor_profiler_session_mismatch",
             .message = "Asset profiler session changed; request a full snapshot"});
    }
    const AssetProfilerSequence latest{m_impl->next_sequence - 1};
    if (after_sequence.value > latest.value) {
        return core::Result<AssetProfilerDelta, core::Diagnostic>::failure(
            {.code = "assets.editor_profiler_cursor_invalid",
             .message = "Asset profiler cursor is newer than the active session"});
    }

    AssetProfilerDelta delta;
    delta.session_id = m_impl->session_id;
    delta.after_sequence = after_sequence;
    delta.latest_sequence = latest;
    delta.captured_at_ns = elapsed_ns(m_impl->session_started, m_impl->clock_now());
    delta.lost_change_count = m_impl->lost_change_count;
    delta.inventory_revision = m_impl->inventory_revision;
    delta.memory = {.current = m_impl->memory_current,
                    .peak = m_impl->memory_peak,
                    .policy = m_impl->policy,
                    .asset_counts = m_impl->current_state_counts,
                    .accounting_revision = m_impl->accounting_revision,
                    .renderer_sampled_at_ns = m_impl->renderer_sampled_at_ns};
    if (m_impl->retained_change_count != 0) {
        const auto earliest = m_impl->changes[m_impl->change_start].sequence;
        delta.earliest_retained_sequence = earliest;
        delta.history_gap =
            m_impl->lost_change_count != 0 && after_sequence.value < earliest.value - 1;
        if (delta.history_gap)
            delta.replacement_inventory.emplace();
        for (std::size_t offset = 0; offset < m_impl->retained_change_count; ++offset) {
            const auto index = (m_impl->change_start + offset) % m_impl->changes.size();
            const auto& change = m_impl->changes[index];
            if (change.sequence.value > after_sequence.value &&
                std::holds_alternative<AssetProfilerInventoryChanged>(change.payload)) {
                delta.replacement_inventory = m_impl->inventory;
            }
            if (delta.history_gap || change.sequence.value > after_sequence.value)
                delta.changes.push_back(change);
        }
    }
    if (delta.history_gap)
        delta.replacement_inventory = m_impl->inventory;
    return core::Result<AssetProfilerDelta, core::Diagnostic>::success(std::move(delta));
}

void EditorAssetProfilerService::rotate_session_on_owner()
{
    m_impl->owner_thread.assert_owner_thread();
    {
        std::lock_guard lock(m_impl->mutex);
        m_impl->recorder.reset_on_owner();
        m_impl->reset_session_unlocked();
    }
    refresh_inventory_on_owner();
    refresh_memory_on_owner();
    (void)sample_renderer_on_owner(true);
}

AssetProfilerSessionId EditorAssetProfilerService::session_id_on_owner() const
{
    m_impl->owner_thread.assert_owner_thread();
    std::lock_guard lock(m_impl->mutex);
    return m_impl->session_id;
}

void EditorAssetProfilerService::set_inventory_provider(assets::AssetManager& assets)
{
    set_inventory_provider([&assets]() { return assets.asset_profiler_inventory_on_owner(); });
}

void EditorAssetProfilerService::set_inventory_provider(
    std::function<std::vector<AssetProfilerEntry>()> inventory_provider_on_owner)
{
    m_impl->owner_thread.assert_owner_thread();
    std::lock_guard lock(m_impl->mutex);
    m_impl->inventory_provider = std::move(inventory_provider_on_owner);
    m_impl->inventory_dirty = true;
}

void EditorAssetProfilerService::set_memory_provider(
    std::function<std::pair<assets::ResidencyAccountingSnapshot, assets::ResidencyCost>()>
        memory_provider_on_owner,
    assets::ResolvedAssetMemoryPolicy policy)
{
    m_impl->owner_thread.assert_owner_thread();
    {
        std::lock_guard lock(m_impl->mutex);
        m_impl->memory_provider = std::move(memory_provider_on_owner);
        m_impl->policy = std::move(policy);
    }
    refresh_memory_on_owner();
}

void EditorAssetProfilerService::set_memory_provider(assets::AssetManager& assets,
                                                     assets::ResolvedAssetMemoryPolicy policy)
{
    set_memory_provider([&assets]() { return assets.asset_profiler_memory_on_owner(); },
                        std::move(policy));
}

void EditorAssetProfilerService::set_renderer_statistics_provider(
    std::function<AssetProfilerRendererEstimate()> renderer_provider_on_owner)
{
    m_impl->owner_thread.assert_owner_thread();
    {
        std::lock_guard lock(m_impl->mutex);
        m_impl->renderer_provider = std::move(renderer_provider_on_owner);
        m_impl->renderer_sampled_at.reset();
        m_impl->renderer_sampled_at_ns.reset();
    }
    (void)sample_renderer_on_owner(true);
}

std::unique_ptr<EditorAssetProfilerService> make_editor_asset_profiler_service(bool preview_widget)
{
    if (!preview_widget)
        return nullptr;
    return std::make_unique<EditorAssetProfilerService>();
}

} // namespace noveltea::core
