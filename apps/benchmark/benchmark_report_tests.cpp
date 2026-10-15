#include "benchmark_report.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>

namespace {
using noveltea::benchmark::decode_configuration;
using noveltea::benchmark::encode_configuration;
using noveltea::benchmark::encode_result;
using noveltea::benchmark::Options;

bool check(bool success, const char* explanation)
{
    if (!success)
        std::fprintf(stderr, "report contract: %s\n", explanation);
    return success;
}

bool rejected(nlohmann::json value)
{
    Options options;
    std::string error;
    return !decode_configuration(value.dump(), options, error) && !error.empty();
}
} // namespace

int main()
{
    Options original;
    original.warmup_seconds = 0.5;
    original.measurement_frames = 41;
    original.repeats = 3;
    original.raw_samples = true;
    original.output_path = "run.json";
    std::string error;
    Options roundtrip;
    const auto configured = nlohmann::json::parse(encode_configuration(original));
    if (!check(decode_configuration(configured.dump(), roundtrip, error) &&
                   roundtrip.measurement_frames == 41 && roundtrip.repeats == 3 &&
                   roundtrip.warmup_seconds == 0.5 && roundtrip.raw_samples &&
                   roundtrip.output_path == "run.json",
               "current config roundtrip"))
        return 1;

    auto old_version = configured;
    old_version["version"] = 0;
    auto wrong_scenario_version = configured;
    wrong_scenario_version["scenario_version"] = 2;
    auto bad_parameters = configured;
    bad_parameters["parameters"]["draw_calls"] = 10;
    auto bad_clock = configured;
    bad_clock["clock_policy"] = "fixed_step";
    auto missing = configured;
    missing["settings"].erase("no_ui");
    auto extra = configured;
    extra["settings"]["unknown"] = true;
    auto no_ui_false = configured;
    no_ui_false["settings"]["no_ui"] = false;
    auto negative_frames = configured;
    negative_frames["settings"]["measurement_frames"] = -1;
    auto wrong_profile = configured;
    wrong_profile["settings"]["profile"] = "diagnostic";
    auto extra_root = configured;
    extra_root["unused"] = nullptr;
    if (!check(rejected(old_version) && rejected(wrong_scenario_version) &&
                   rejected(bad_parameters) && rejected(bad_clock) && rejected(missing) &&
                   rejected(extra) && rejected(no_ui_false) && rejected(negative_frames) &&
                   rejected(wrong_profile) && rejected(extra_root),
               "reject unknown versions, settings, and invalid values"))
        return 1;

    noveltea::benchmark::TrialResult trial;
    trial.outcome = "complete";
    trial.phases = {
        noveltea::benchmark::Phase::Preparation, noveltea::benchmark::Phase::Ready,
        noveltea::benchmark::Phase::Warmup,      noveltea::benchmark::Phase::Measurement,
        noveltea::benchmark::Phase::Completion,  noveltea::benchmark::Phase::Results,
        noveltea::benchmark::Phase::Cleanup};
    trial.measured_frames = 2;
    trial.measured_wall_seconds = 0.02;
    trial.cpu_operation.count = 2;
    trial.cpu_operation.mean_ms = 8.0;
    trial.raw_samples = {{0.01, 0.008}, {0.01, 0.008}};

    noveltea::benchmark::ScenarioResult scenario;
    scenario.scenario = "raw-bgfx-empty";
    scenario.description = "known reference";
    scenario.outcome = "complete";
    scenario.measured_frames = 2;
    scenario.measured_wall_seconds = 0.02;
    scenario.trials.push_back(trial);
    scenario.cpu_operation = trial.cpu_operation;
    noveltea::benchmark::SuiteResult suite;
    suite.outcome = "complete";
    suite.scenarios.push_back(scenario);
    const auto result = nlohmann::json::parse(encode_result(original,
                                                            {.platform = "Linux",
                                                             .video_driver = "x11",
                                                             .renderer = "OpenGL",
                                                             .gpu_vendor_id = 12,
                                                             .gpu_device_id = 34,
                                                             .width_pixels = 1280,
                                                             .height_pixels = 720},
                                                            suite));
    if (!check(result["format"] == "noveltea.benchmark.result" && result["version"] == 1 &&
                   result["configuration"] == configured &&
                   result["build"]["revision"].is_string() &&
                   (result["build"]["tracked_source_dirty"].is_boolean() ||
                    result["build"]["tracked_source_dirty"].is_null()) &&
                   result["build"]["source_fingerprint_sha256"].is_string() &&
                   result["configuration"]["clock_policy"] == "realtime" &&
                   result["configuration"]["parameters"].empty() &&
                   result["graphics"]["gpu_device_id"] == 34 &&
                   result["graphics"]["gpu_driver_version"].is_null() &&
                   result["timing"]["gpu_execution_ms"].is_null() &&
                   result["timing"]["presented_frame_count"].is_null() &&
                   result["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"] == 100 &&
                   result["scenarios"][0]["trials"][0]["raw_samples"].size() == 2 &&
                   result["scenarios"][0]["trials"][0]["phases"].size() == 7,
               "result identity, timing, metadata and raw samples"))
        return 1;

    original.raw_samples = false;
    suite.scenarios[0].trials[0].outcome = "failed";
    suite.scenarios[0].trials[0].reason =
        "presentation interrupted; cleanup failed: host shutdown failed";
    suite.scenarios[0].trials[0].measured_frames = 1;
    suite.scenarios[0].trials[0].measured_wall_seconds = 0.01;
    const auto failed = nlohmann::json::parse(encode_result(original, {}, suite));
    if (!check(failed["scenarios"][0]["trials"][0]["reason"] ==
                       "presentation interrupted; cleanup failed: host shutdown failed" &&
                   failed["scenarios"][0]["trials"][0]["raw_samples"].is_null() &&
                   failed["scenarios"][0]["trials"][0]["measured_frames"] == 1 &&
                   failed["scenarios"][0]["trials"][0]["frame_wall_ms"].is_null() &&
                   failed["graphics"]["gpu_device_id"].is_null(),
               "failed trial and missing graphics are not fabricated"))
        return 1;
    return 0;
}
