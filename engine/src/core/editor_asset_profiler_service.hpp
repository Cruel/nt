#pragma once

#include "noveltea/core/asset_telemetry.hpp"
#include <memory>

namespace noveltea::core {

class EditorAssetProfilerService final : public AssetTelemetrySink {
public:
    EditorAssetProfilerService();
    ~EditorAssetProfilerService() override;

    void record(AssetTelemetryEvent event) noexcept override;
    [[nodiscard]] AssetTelemetrySnapshot snapshot_on_owner() const override;
    [[nodiscard]] AssetProfilerSnapshot capture_on_owner() const;
    [[nodiscard]] core::Result<AssetProfilerDelta, core::Diagnostic>
    capture_delta_on_owner(AssetProfilerSessionId expected_session,
                           AssetProfilerSequence after_sequence) const;
    void rotate_session_on_owner();
    [[nodiscard]] AssetProfilerSessionId session_id_on_owner() const;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

[[nodiscard]] std::unique_ptr<EditorAssetProfilerService>
make_editor_asset_profiler_service(bool preview_widget);

} // namespace noveltea::core
