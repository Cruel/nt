#pragma once

#include "noveltea/core/asset_telemetry.hpp"
#include <functional>
#include <memory>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::core {

class EditorAssetProfilerService final : public AssetTelemetrySink {
public:
    EditorAssetProfilerService();
    ~EditorAssetProfilerService() override;

    void record(AssetTelemetryEvent event) noexcept override;
    void record_inventory_maybe_changed() noexcept override;
    [[nodiscard]] AssetTelemetrySnapshot snapshot_on_owner() const override;
    [[nodiscard]] AssetProfilerSnapshot capture_on_owner() const;
    [[nodiscard]] core::Result<AssetProfilerDelta, core::Diagnostic>
    capture_delta_on_owner(AssetProfilerSessionId expected_session,
                           AssetProfilerSequence after_sequence) const;
    void flush_inventory_on_owner() const;
    void rotate_session_on_owner();
    [[nodiscard]] AssetProfilerSessionId session_id_on_owner() const;
    void set_inventory_provider(assets::AssetManager& assets);
    void set_inventory_provider(
        std::function<std::vector<AssetProfilerEntry>()> inventory_provider_on_owner);

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

[[nodiscard]] std::unique_ptr<EditorAssetProfilerService>
make_editor_asset_profiler_service(bool preview_widget);

} // namespace noveltea::core
