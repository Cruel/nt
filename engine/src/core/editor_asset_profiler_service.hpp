#pragma once

#include "noveltea/core/asset_telemetry.hpp"

#include <chrono>
#include <functional>
#include <memory>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::core {

class EditorAssetProfilerService final : public AssetTelemetrySink {
public:
    using ClockNow = std::function<std::chrono::steady_clock::time_point()>;

    explicit EditorAssetProfilerService(ClockNow clock_now = {});
    ~EditorAssetProfilerService() override;

    void record(AssetTelemetryEvent event) noexcept override;
    void
    record_accounting_change(const assets::ResidencyAccountingSnapshot& current) noexcept override;
    void record_inventory_maybe_changed() noexcept override;
    void record_prefetch_generation(
        const AssetProfilerPrefetchGenerationRecord& record) noexcept override;
    void
    record_prefetch_generation_released(assets::PrefetchGenerationId generation) noexcept override;
    void record_asset_wait_started(const AssetWaitStart& wait) noexcept override;
    void record_asset_wait_finished(const AssetWaitFinish& wait) noexcept override;
    [[nodiscard]] AssetTelemetrySnapshot snapshot_on_owner() const override;
    [[nodiscard]] AssetProfilerSnapshot capture_on_owner() const;
    [[nodiscard]] core::Result<AssetProfilerDelta, core::Diagnostic>
    capture_delta_on_owner(AssetProfilerSessionId expected_session,
                           AssetProfilerSequence after_sequence) const;
    void flush_frame_on_owner() const;
    void rotate_session_on_owner();
    [[nodiscard]] AssetProfilerSessionId session_id_on_owner() const;
    void set_inventory_provider(assets::AssetManager& assets);
    void set_inventory_provider(
        std::function<std::vector<AssetProfilerEntry>()> inventory_provider_on_owner);
    void set_memory_provider(
        std::function<std::pair<assets::ResidencyAccountingSnapshot, assets::ResidencyCost>()>
            memory_provider_on_owner,
        assets::ResolvedAssetMemoryPolicy policy);
    void set_memory_provider(assets::AssetManager& assets,
                             assets::ResolvedAssetMemoryPolicy policy);
    void set_renderer_statistics_provider(
        std::function<AssetProfilerRendererEstimate()> renderer_provider_on_owner);

private:
    void refresh_inventory_on_owner() const;
    void refresh_memory_on_owner() const;
    [[nodiscard]] bool sample_renderer_on_owner(bool force) const;

    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

[[nodiscard]] std::unique_ptr<EditorAssetProfilerService>
make_editor_asset_profiler_service(bool preview_widget);

} // namespace noveltea::core
