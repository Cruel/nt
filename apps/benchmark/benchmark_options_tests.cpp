#include "benchmark_options.hpp"

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
    const char* const repeats[] = {"benchmark", "--repeats", "3", "--ready-timeout-seconds", "1"};
    const char* const invalid_repeats[] = {"benchmark", "--repeats", "21"};
    const char* const invalid_large_frames[] = {"benchmark", "--frames", "300001"};
    const char* const diagnostic[] = {"benchmark", "--profile", "diagnostic"};
    const char* const invalid_profile[] = {"benchmark", "--profile", "unknown"};
    const char* const ui[] = {"benchmark", "--ui", "--frames", "30"};
    const char* const geometry[] = {"benchmark",    "--scenario", "raw-bgfx-geometry",
                                    "--rect-count", "12",         "--rect-scale",
                                    "0.75"};
    const char* const ui_reference[] = {"benchmark", "--scenario", "standalone-rmlui-simple"};
    const char* const invalid_geometry[] = {"benchmark", "--rect-count", "257"};
    const char* const invalid_scale[] = {"benchmark", "--rect-scale", "0.1"};
    const char* const lifecycle[] = {"benchmark", "--dashboard-smoke"};
    const char* const config_only[] = {"benchmark", "--config", "run.json", "--output",
                                       "other.json"};
    const char* const mixed_config[] = {"benchmark", "--config", "run.json", "--smoke"};

    if (!expect_options(defaults, 1, true) || !expect_options(fixed, 7, true, 50) ||
        !expect_options(smoke, 2, true, 30) || !expect_options(invalid_frames, 3, false) ||
        !expect_options(invalid_float, 3, false) || !expect_options(invalid_width, 3, false) ||
        !expect_options(invalid_missing, 2, false) || !expect_options(invalid_unknown, 2, false) ||
        !expect_options(repeats, 5, true) || !expect_options(invalid_repeats, 3, false) ||
        !expect_options(invalid_large_frames, 3, false) || !expect_options(diagnostic, 3, true) ||
        !expect_options(ui, 4, true, 30) || !expect_options(lifecycle, 2, true, 30) ||
        !expect_options(invalid_profile, 3, false) || !expect_options(geometry, 7, true) ||
        !expect_options(ui_reference, 3, true) || !expect_options(invalid_geometry, 3, false) ||
        !expect_options(invalid_scale, 3, false) || !expect_options(config_only, 5, true) ||
        !expect_options(mixed_config, 4, false))
        return 1;

    noveltea::benchmark::Options options;
    std::string error;
    if (!noveltea::benchmark::parse_options(1, defaults, options, error) || options.no_ui ||
        !noveltea::benchmark::parse_options(2, smoke, options, error) || !options.no_ui ||
        !noveltea::benchmark::parse_options(3, diagnostic, options, error) ||
        options.profile != "diagnostic" ||
        !noveltea::benchmark::parse_options(2, lifecycle, options, error) ||
        !options.dashboard_smoke || options.no_ui)
        return 1;
    if (!noveltea::benchmark::parse_options(7, geometry, options, error) ||
        options.scenario != "raw-bgfx-geometry" || options.rect_count != 12 ||
        options.rect_scale != 0.75 ||
        !noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "raw-bgfx-empty";
    if (noveltea::benchmark::validate_reference_options(options, error) || error.empty())
        return 1;
    options.scenario = "standalone-rmlui-simple";
    options.rect_count = 3;
    options.rect_scale = 1.0;
    if (!noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.rect_count = 4;
    if (noveltea::benchmark::validate_reference_options(options, error))
        return 1;
    options.scenario = "synthetic";
    if (noveltea::benchmark::validate_reference_options(options, error) || error.empty())
        return 1;
    return 0;
}
