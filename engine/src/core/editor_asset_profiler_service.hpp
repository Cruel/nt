#pragma once

#include "noveltea/core/asset_telemetry.hpp"
#include "noveltea/jobs/job_executor.hpp"

#include <memory>

namespace noveltea::core {

class EditorAssetProfilerService final : public AssetTelemetrySink {
public:
    EditorAssetProfilerService();

    void record(AssetTelemetryEvent event) noexcept override;
    [[nodiscard]] AssetTelemetrySnapshot snapshot_on_owner() const override;
    [[nodiscard]] AssetProfilerSnapshot capture_on_owner(const jobs::JobExecutor& jobs) const;

private:
    AssetTelemetryRecorder m_recorder;
};

[[nodiscard]] std::unique_ptr<EditorAssetProfilerService>
make_editor_asset_profiler_service(bool preview_widget);

} // namespace noveltea::core
