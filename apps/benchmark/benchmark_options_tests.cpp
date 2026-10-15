#include "benchmark_options.hpp"

#include <cmath>
#include <cstdio>
#include <string>

namespace {

bool expect_options(const char* const args[], int count, bool success, uint64_t expected_frames = 0)
{
    noveltea::benchmark::Options options;
    std::string error;
    const bool parsed = noveltea::benchmark::parse_options(count, args, options, error);
    if (parsed != success || (success && options.measurement_frames != expected_frames)) {
        std::fprintf(stderr, "unexpected parse outcome: %s\n", error.c_str());
        return false;
    }
    return true;
}

} // namespace

int main()
{
    const char* const defaults[] = {"benchmark"};
    const char* const fixed[] = {"benchmark", "--frames", "50",         "--seconds",
                                 "2",         "--output", "report.json"};
    const char* const smoke[] = {"benchmark", "--smoke"};
    const char* const invalid_frames[] = {"benchmark", "--frames", "0"};
    const char* const invalid_float[] = {"benchmark", "--seconds", "nan"};
    const char* const invalid_width[] = {"benchmark", "--width", "9000"};
    const char* const invalid_missing[] = {"benchmark", "--output"};
    const char* const invalid_unknown[] = {"benchmark", "--bogus"};

    if (!expect_options(defaults, 1, true) || !expect_options(fixed, 7, true, 50) ||
        !expect_options(smoke, 2, true, 30) || !expect_options(invalid_frames, 3, false) ||
        !expect_options(invalid_float, 3, false) || !expect_options(invalid_width, 3, false) ||
        !expect_options(invalid_missing, 2, false) || !expect_options(invalid_unknown, 2, false))
        return 1;

    noveltea::benchmark::FrameSummary summary;
    if (summary.frames != 0 || summary.mean_bgfx_call_ms() != 0.0)
        return 1;
    summary.record(0.001);
    summary.record(0.003);
    if (summary.frames != 2 || std::abs(summary.mean_bgfx_call_ms() - 2.0) > 1e-8 ||
        summary.min_bgfx_call_seconds != 0.001 || summary.max_bgfx_call_seconds != 0.003)
        return 1;
    return 0;
}
