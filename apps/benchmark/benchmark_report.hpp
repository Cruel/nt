#pragma once

#include "benchmark_runner.hpp"

#include <string>
#include <string_view>

namespace noveltea::benchmark {

struct Environment {
    std::string platform;
    std::string video_driver;
    std::string renderer;
    int gpu_vendor_id = -1;
    int gpu_device_id = -1;
    int width_pixels = 0;
    int height_pixels = 0;
};

[[nodiscard]] std::string encode_configuration(const Options& options);
[[nodiscard]] bool decode_configuration(std::string_view source, Options& options,
                                        std::string& reason);
[[nodiscard]] std::string encode_result(const Options& options, const Environment& environment,
                                        const SuiteResult& result);

} // namespace noveltea::benchmark
