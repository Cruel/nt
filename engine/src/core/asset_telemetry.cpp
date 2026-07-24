#include "noveltea/core/asset_telemetry.hpp"

#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <algorithm>
#include <limits>
#include <mutex>
#include <utility>

namespace noveltea::core {
namespace {

void update_high_water(assets::ResidencyCost& high_water,
                       const assets::ResidencyCost& current) noexcept
{
    high_water.source_bytes = std::max(high_water.source_bytes, current.source_bytes);
    high_water.prepared_cpu_bytes =
        std::max(high_water.prepared_cpu_bytes, current.prepared_cpu_bytes);
    high_water.gpu_bytes = std::max(high_water.gpu_bytes, current.gpu_bytes);
    high_water.audio_bytes = std::max(high_water.audio_bytes, current.audio_bytes);
    high_water.temporary_bytes = std::max(high_water.temporary_bytes, current.temporary_bytes);
}

void add_duration(std::chrono::nanoseconds& total, std::chrono::nanoseconds value) noexcept
{
    if (value.count() <= 0)
        return;
    const auto available = std::chrono::nanoseconds::max() - total;
    total += std::min(value, available);
}

void add_bytes(std::uint64_t& total, std::uint64_t value) noexcept
{
    total += std::min(value, std::numeric_limits<std::uint64_t>::max() - total);
}

} // namespace

struct AssetTelemetryRecorder::Impl {
    explicit Impl(std::size_t configured_capacity)
        : event_capacity(configured_capacity), event_ring(configured_capacity)
    {
    }

    void update_aggregates(const AssetTelemetryEvent& event) noexcept
    {
        ++snapshot.event_counts[static_cast<std::size_t>(event.kind)];
        snapshot.memory.current = event.memory;
        update_high_water(snapshot.memory.high_water, event.memory);
        if (event.memory_policy)
            snapshot.memory_policy = event.memory_policy;

        switch (event.kind) {
        case AssetTelemetryEventKind::SourceReadCompleted:
        case AssetTelemetryEventKind::SourceReadFailed:
            add_bytes(snapshot.aggregates.compressed_bytes_read, event.compressed_bytes);
            add_bytes(snapshot.aggregates.uncompressed_bytes_read, event.uncompressed_bytes);
            add_duration(snapshot.aggregates.source_read_duration, event.duration);
            break;
        case AssetTelemetryEventKind::PreparationCompleted:
        case AssetTelemetryEventKind::PreparationFailed:
            add_duration(snapshot.aggregates.preparation_duration, event.duration);
            break;
        case AssetTelemetryEventKind::OwnerFinalizationCompleted:
        case AssetTelemetryEventKind::OwnerFinalizationFailed:
            add_duration(snapshot.aggregates.owner_finalization_duration, event.duration);
            break;
        default:
            break;
        }
    }

    jobs::OwnerThreadGuard owner_thread;
    const std::size_t event_capacity = 0;
    mutable std::mutex mutex;
    std::vector<AssetTelemetryEvent> event_ring;
    std::size_t event_start = 0;
    std::size_t retained_event_count = 0;
    AssetTelemetrySnapshot snapshot;
};

AssetTelemetryRecorder::AssetTelemetryRecorder(std::size_t event_capacity)
    : m_impl(std::make_unique<Impl>(event_capacity))
{
}

AssetTelemetryRecorder::~AssetTelemetryRecorder() = default;

void AssetTelemetryRecorder::record(AssetTelemetryEvent event) noexcept
{
    std::lock_guard lock(m_impl->mutex);
    event.timestamp = std::chrono::steady_clock::now();
    m_impl->update_aggregates(event);
    if (m_impl->event_capacity == 0)
        return;

    if (m_impl->retained_event_count < m_impl->event_capacity) {
        const auto index =
            (m_impl->event_start + m_impl->retained_event_count) % m_impl->event_capacity;
        m_impl->event_ring[index] = std::move(event);
        ++m_impl->retained_event_count;
        return;
    }

    m_impl->event_ring[m_impl->event_start] = std::move(event);
    m_impl->event_start = (m_impl->event_start + 1) % m_impl->event_capacity;
    ++m_impl->snapshot.lost_event_count;
}

AssetTelemetrySnapshot AssetTelemetryRecorder::snapshot_on_owner() const
{
    m_impl->owner_thread.assert_owner_thread();
    std::lock_guard lock(m_impl->mutex);
    auto result = m_impl->snapshot;
    result.retained_events.reserve(m_impl->retained_event_count);
    for (std::size_t offset = 0; offset < m_impl->retained_event_count; ++offset) {
        const auto index = (m_impl->event_start + offset) % m_impl->event_capacity;
        result.retained_events.push_back(m_impl->event_ring[index]);
    }
    return result;
}

void AssetTelemetryRecorder::reset_on_owner()
{
    m_impl->owner_thread.assert_owner_thread();
    std::lock_guard lock(m_impl->mutex);
    m_impl->event_start = 0;
    m_impl->retained_event_count = 0;
    m_impl->snapshot = {};
}

std::size_t AssetTelemetryRecorder::event_capacity() const noexcept
{
    return m_impl->event_capacity;
}

} // namespace noveltea::core
