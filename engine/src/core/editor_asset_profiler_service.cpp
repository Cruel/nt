#include "core/editor_asset_profiler_service.hpp"

#include <utility>

namespace noveltea::core {

EditorAssetProfilerService::EditorAssetProfilerService()
    : m_recorder(editor_asset_telemetry_event_capacity)
{
}

void EditorAssetProfilerService::record(AssetTelemetryEvent event) noexcept
{
    m_recorder.record(std::move(event));
}

AssetTelemetrySnapshot EditorAssetProfilerService::snapshot_on_owner() const
{
    return m_recorder.snapshot_on_owner();
}

AssetProfilerSnapshot
EditorAssetProfilerService::capture_on_owner(const jobs::JobExecutor& jobs) const
{
    return capture_asset_profiler_snapshot_on_owner(jobs, m_recorder);
}

} // namespace noveltea::core
