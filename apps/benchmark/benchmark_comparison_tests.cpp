#include "benchmark_comparison.hpp"
#include "benchmark_report.hpp"

#include <nlohmann/json.hpp>

#include <cstdio>
#include <string>

namespace {
using namespace noveltea::benchmark;
using Json = nlohmann::json;

bool check(bool value, const char* message)
{
    if (!value)
        std::fprintf(stderr, "comparison: %s\n", message);
    return value;
}

std::string example_report(const Options& options, const Environment& environment,
                           double milliseconds)
{
    SuiteResult suite;
    suite.outcome = "complete";
    ScenarioResult scenario;
    scenario.scenario = options.scenario;
    scenario.outcome = "complete";
    scenario.description = "test workload";
    scenario.measured_frames = 100;
    scenario.measured_wall_seconds = 1.0;
    scenario.wall_frame = {100,          milliseconds, milliseconds, milliseconds,
                           milliseconds, milliseconds, milliseconds, 0.0};
    scenario.cpu_operation = {100,
                              milliseconds / 2,
                              milliseconds / 2,
                              milliseconds / 2,
                              milliseconds / 2,
                              milliseconds / 2,
                              milliseconds / 2,
                              0.0};
    TrialResult trial;
    trial.outcome = "complete";
    trial.measured_frames = 100;
    trial.measured_wall_seconds = 1;
    trial.wall_frame = scenario.wall_frame;
    trial.cpu_operation = scenario.cpu_operation;
    scenario.trials.push_back(std::move(trial));
    suite.scenarios.push_back(std::move(scenario));
    return encode_result(options, environment, suite);
}

bool parse(const std::string& text, ImportedReport& report)
{
    std::string error;
    return decode_imported_report(text, "fixture", report, error);
}

} // namespace

int main()
{
    Options options;
    Environment machine;
    machine.platform = "Linux";
    machine.renderer = "OpenGL";
    machine.width_pixels = 1280;
    machine.height_pixels = 720;
    machine.gpu_vendor_id = 4318;
    machine.gpu_device_id = 123;
    const std::string json = example_report(options, machine, 10);
    ImportedReport baseline, candidate;
    if (!check(parse(json, baseline) && parse(example_report(options, machine, 9), candidate),
               "accept exported current result reports"))
        return 1;
    const auto comparison = compare_reports(baseline, candidate);
    if (!check(comparison.controlled && !comparison.metrics.empty() &&
                   comparison.metrics[0].delta == -1.0 && comparison.metrics[0].percent == -10.0 &&
                   comparison.metrics[0].baseline_samples == 100,
               "identical configurations produce per-metric signed raw, percentage and samples"))
        return 1;
    Environment other = machine;
    other.browser = "Firefox";
    other.gpu_device_id = 456;
    if (!check(parse(example_report(options, other, 12), candidate), "import other device"))
        return 1;
    const auto cross = compare_reports(baseline, candidate);
    if (!check(!cross.controlled && !cross.metrics.empty() && cross.metrics[0].delta == 2.0 &&
                   cross.warnings.size() >= 2,
               "unlike devices are exploratory, not rejected or given a pass/fail score"))
        return 1;
    // Quick Suites normalize each selected scenario independently of the
    // initial dashboard selection. Different initial selections must not
    // manufacture a workload mismatch for the same actual suite scenario.
    Options suite_a = options;
    Options suite_b = options;
    suite_a.quick_suite = true;
    suite_b.quick_suite = true;
    suite_b.scenario = "raw-bgfx-clear";
    Json suite_b_report = Json::parse(example_report(suite_b, machine, 11));
    suite_b_report["scenarios"][0]["id"] = options.scenario;
    if (!check(
            parse(example_report(suite_a, machine, 10), baseline) &&
                parse(suite_b_report.dump(), candidate) &&
                compare_reports(baseline, candidate).controlled,
            "Quick Suites compare normalized per-scenario references, not the initial selection"))
        return 1;
    if (!check(parse(json, baseline), "restore baseline"))
        return 1;
    Options changed = options;
    changed.vsync = true;
    if (!check(parse(example_report(changed, machine, 11), candidate) &&
                   !compare_reports(baseline, candidate).controlled,
               "graphics settings difference is conspicuous"))
        return 1;

    Json malformed = Json::parse(json);
    ImportedReport untouched = baseline;
    std::string reason;
    malformed["version"] = 2;
    if (!check(!decode_imported_report(malformed.dump(), "bad", untouched, reason) &&
                   untouched.document == baseline.document,
               "reject obsolete/unknown report version without replacing existing import"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["aggregate"]["frame_wall_ms"]["p95_ms"] = -1;
    if (!check(!parse(malformed.dump(), untouched), "reject malformed timing distributions"))
        return 1;
    malformed = Json::parse(json);
    malformed["configuration"]["settings"]["warmup_seconds"] = "invalid";
    if (!check(!parse(malformed.dump(), untouched), "reject malformed nested configuration"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["graphics"]["browser"] = 15;
    if (!check(!parse(malformed.dump(), untouched), "reject malformed browser metadata"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["id"] = "raw-bgfx-composition";
    if (!check(!parse(malformed.dump(), untouched),
               "reject scenario that contradicts the recorded run configuration"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["interruption_retries"] = -1;
    if (!check(!parse(malformed.dump(), untouched), "reject invalid interruption count"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["raw_samples"] = Json::array({"bad"});
    if (!check(!parse(malformed.dump(), untouched), "reject malformed raw samples"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["interruption_retries"] = 1;
    if (!check(parse(malformed.dump(), candidate), "accept recovered trial") ||
        !check(!compare_reports(baseline, candidate).warnings.empty(),
               "comparison surfaces recovery/interruption warnings"))
        return 1;
    if (!check(!parse("{", untouched), "reject truncated JSON"))
        return 1;

    DashboardPreferences settings;
    settings.last_configuration = options;
    settings.last_configuration.duration_seconds = 23;
    settings.presets.push_back({"small", options});
    changed.duration_seconds = 3.0;
    settings.presets.push_back({"diagnostic", changed});
    DashboardPreferences restored;
    if (!check(decode_dashboard_preferences(encode_dashboard_preferences(settings), restored,
                                            reason) &&
                   restored.last_configuration.duration_seconds == 23 &&
                   restored.presets.size() == 2 &&
                   restored.presets[1].configuration.duration_seconds == 3.0,
               "last-used run settings and named canonical presets roundtrip"))
        return 1;
    Json state = Json::parse(encode_dashboard_preferences(settings));
    state["version"] = 2;
    if (!check(!decode_dashboard_preferences(state.dump(), restored, reason) &&
                   restored.presets.size() == 2,
               "unsupported settings versions are rejected without replacing previous state"))
        return 1;
    state = Json::parse(encode_dashboard_preferences(settings));
    state["presets"][1]["name"] = "small";
    if (!check(!decode_dashboard_preferences(state.dump(), restored, reason),
               "duplicate preset identities rejected"))
        return 1;
    state = Json::parse(encode_dashboard_preferences(settings));
    state["presets"][0]["configuration"]["scenario_version"] = 2;
    if (!check(!decode_dashboard_preferences(state.dump(), restored, reason),
               "named presets use current-only canonical run config"))
        return 1;
    std::puts("benchmark comparison and preset contract passed");
    return 0;
}
