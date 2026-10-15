#include "benchmark_options.hpp"

#include <charconv>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <string_view>

namespace noveltea::benchmark {
namespace {

bool parse_integer(std::string_view text, uint64_t& value)
{
    if (text.empty())
        return false;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    return error == std::errc{} && end == text.data() + text.size();
}

bool parse_duration(const char* text, double& value)
{
    if (!text || *text == '\0')
        return false;
    char* end = nullptr;
    errno = 0;
    value = std::strtod(text, &end);
    return errno == 0 && end != text && *end == '\0' && std::isfinite(value) && value >= 0.0 &&
           value <= 3600.0;
}

} // namespace

bool parse_options(int argc, const char* const argv[], Options& options, std::string& error)
{
    options = {};
    error.clear();
    for (int i = 1; i < argc; ++i) {
        const std::string_view flag = argv[i];
        if (flag == "--help") {
            options.help = true;
            return true;
        }
        if (flag == "--smoke") {
            options.warmup_seconds = 0.0;
            options.measurement_frames = 30;
            continue;
        }
        if (flag == "--vsync") {
            options.vsync = true;
            continue;
        }
        if (flag != "--width" && flag != "--height" && flag != "--warmup-seconds" &&
            flag != "--seconds" && flag != "--frames" && flag != "--output") {
            error = "unknown argument: " + std::string(flag);
            return false;
        }
        if (i + 1 >= argc) {
            error = "missing value for " + std::string(flag);
            return false;
        }
        const char* value = argv[++i];
        if (flag == "--output") {
            if (*value == '\0') {
                error = "output path must not be empty";
                return false;
            }
            options.output_path = value;
            continue;
        }
        if (flag == "--seconds" || flag == "--warmup-seconds") {
            double seconds = 0.0;
            if (!parse_duration(value, seconds) || (flag == "--seconds" && seconds == 0.0)) {
                error = "invalid duration for " + std::string(flag);
                return false;
            }
            if (flag == "--seconds")
                options.duration_seconds = seconds;
            else
                options.warmup_seconds = seconds;
            continue;
        }
        uint64_t number = 0;
        if (!parse_integer(value, number) || number == 0) {
            error = "invalid positive integer for " + std::string(flag);
            return false;
        }
        if (flag == "--frames") {
            if (number > 1000000000) {
                error = "--frames exceeds maximum (1000000000)";
                return false;
            }
            options.measurement_frames = number;
        } else {
            if (number > 8192) {
                error = "width/height must be within 1..8192";
                return false;
            }
            if (flag == "--width")
                options.width = static_cast<int>(number);
            else
                options.height = static_cast<int>(number);
        }
    }
    return true;
}

void FrameSummary::record(double seconds)
{
    if (frames == 0 || seconds < min_bgfx_call_seconds)
        min_bgfx_call_seconds = seconds;
    if (frames == 0 || seconds > max_bgfx_call_seconds)
        max_bgfx_call_seconds = seconds;
    ++frames;
    total_bgfx_call_seconds += seconds;
}

double FrameSummary::mean_bgfx_call_ms() const
{
    return frames == 0 ? 0.0 : (total_bgfx_call_seconds * 1000.0 / static_cast<double>(frames));
}

} // namespace noveltea::benchmark
