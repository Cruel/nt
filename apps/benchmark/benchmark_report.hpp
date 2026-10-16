#pragma once

#include "benchmark_runner.hpp"
#include "noveltea/ui_render_configuration.hpp"
#include "reference_workloads.hpp"

#include <optional>
#include <string>
#include <string_view>

namespace noveltea::benchmark {

struct UiBackendSettings {
    std::uint8_t reference_msaa_samples = 0;
    bool base_direct_compatibility_requested = false;
    bool preserve_backbuffer = false;
    bool optimized_render_path = false;
    bool output_framebuffer_bound = false;
    bool geometry_raster_snapping = false;
    bool text_raster_snapping = false;
    int viewport_width = 0;
    int viewport_height = 0;
};

struct Environment {
    std::string platform;
    std::string video_driver;
    std::string renderer;
    std::string frame_path;
    int gpu_vendor_id = -1;
    int gpu_device_id = -1;
    int width_pixels = 0;
    int height_pixels = 0;
    int ui_reference_width = 0;
    int ui_reference_height = 0;
    int ui_raster_width = 0;
    int ui_raster_height = 0;
    int world_raster_width = 0;
    int world_raster_height = 0;
    std::optional<bool> engine_postprocess_active;
    std::optional<UiBackendSettings> ui_backend;
    std::optional<UiEffectActivity> ui_effect_activity;
    std::optional<RawWorkloadReference> raw_workload;

    void clear_scenario_metadata()
    {
        ui_backend.reset();
        ui_effect_activity.reset();
        raw_workload.reset();
    }
};

[[nodiscard]] std::string encode_configuration(const Options& options);
[[nodiscard]] bool decode_configuration(std::string_view source, Options& options,
                                        std::string& reason);
[[nodiscard]] std::string encode_result(const Options& options, const Environment& environment,
                                        const SuiteResult& result,
                                        const std::vector<Environment>& scenario_environments = {});

} // namespace noveltea::benchmark
