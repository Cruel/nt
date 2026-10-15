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
    const char* const invalid_profile[] = {"benchmark", "--profile", "diagnostic"};
    const char* const config_only[] = {"benchmark", "--config", "run.json", "--output",
                                       "other.json"};
    const char* const mixed_config[] = {"benchmark", "--config", "run.json", "--smoke"};

    if (!expect_options(defaults, 1, true) || !expect_options(fixed, 7, true, 50) ||
        !expect_options(smoke, 2, true, 30) || !expect_options(invalid_frames, 3, false) ||
        !expect_options(invalid_float, 3, false) || !expect_options(invalid_width, 3, false) ||
        !expect_options(invalid_missing, 2, false) || !expect_options(invalid_unknown, 2, false) ||
        !expect_options(repeats, 5, true) || !expect_options(invalid_repeats, 3, false) ||
        !expect_options(invalid_large_frames, 3, false) ||
        !expect_options(invalid_profile, 3, false) || !expect_options(config_only, 5, true) ||
        !expect_options(mixed_config, 4, false))
        return 1;

    return 0;
}
