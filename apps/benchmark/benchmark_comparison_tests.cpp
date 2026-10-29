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
    if (options.profile == "diagnostic") {
        trial.diagnostic.observations = trial.measured_frames;
        trial.diagnostic.cpu_update_ms = scenario.cpu_operation;
        trial.diagnostic.rmlui_update_ms = scenario.cpu_operation;
        trial.diagnostic.engine_layout_ms = scenario.cpu_operation;
    }
    scenario.trials.push_back(std::move(trial));
    if (!options.alternate && options.repeats > 1) {
        for (uint32_t index = 1; index < options.repeats; ++index)
            scenario.trials.push_back(scenario.trials.front());
        scenario.measured_frames *= options.repeats;
        scenario.measured_wall_seconds *= options.repeats;
        scenario.wall_frame.count = scenario.measured_frames;
        scenario.cpu_operation.count = scenario.measured_frames;
        scenario.repeated = summarize_repeated(scenario.trials);
    }
    if (options.alternate) {
        scenario.trials.push_back(scenario.trials.front());
        scenario.trials.back().arm = "B";
        scenario.trials.push_back(scenario.trials.front());
        scenario.measured_frames = 300;
        scenario.measured_wall_seconds = 3.0;
        scenario.wall_frame.count = 300;
        scenario.cpu_operation.count = 300;
        scenario.alternating = summarize_alternating(scenario.trials);
    }
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
    Options cpu;
    cpu.scenario = "cpu-runtime-session";
    cpu.cpu_work_units = 4;
    Environment headless;
    headless.platform = "Linux";
    headless.frame_path = "cpu-work-batch-no-presentation";
    const std::string cpu_json = example_report(cpu, headless, 0.3);
    ImportedReport cpu_baseline, cpu_candidate;
    std::string cpu_error;
    const bool cpu_a = decode_imported_report(cpu_json, "cpu baseline", cpu_baseline, cpu_error);
    if (!cpu_a)
        std::fprintf(stderr, "CPU baseline decode failed: %s\n", cpu_error.c_str());
    const bool cpu_b = decode_imported_report(example_report(cpu, headless, 0.2), "cpu candidate",
                                              cpu_candidate, cpu_error);
    if (!cpu_b)
        std::fprintf(stderr, "CPU candidate decode failed: %s\n", cpu_error.c_str());
    const auto cpu_comparison =
        cpu_a && cpu_b ? compare_reports(cpu_baseline, cpu_candidate) : ReportComparison{};
    if (cpu_a && cpu_b && !cpu_comparison.controlled)
        for (const auto& warning : cpu_comparison.warnings)
            std::fprintf(stderr, "CPU comparison warning: %s\n", warning.c_str());
    if (!check(cpu_a && cpu_b && cpu_comparison.controlled,
               "headless CPU reports import and compare with stable input and batch identity"))
        return 1;
    Options cpu_different_window = cpu;
    cpu_different_window.width = 640;
    cpu_different_window.height = 480;
    if (!check(parse(example_report(cpu_different_window, headless, 0.2), cpu_candidate) &&
                   compare_reports(cpu_baseline, cpu_candidate).controlled,
               "CPU-only workloads ignore irrelevant window dimensions during comparison"))
        return 1;
    auto cpu_fps = Json::parse(cpu_json);
    cpu_fps["scenarios"][0]["aggregate"]["frame_loop_cadence_hz"] = 100;
    ImportedReport rejected_cpu;
    if (!check(!parse(cpu_fps.dump(), rejected_cpu),
               "reject CPU reports that claim a presented-frame cadence"))
        return 1;
    cpu_fps = Json::parse(cpu_json);
    cpu_fps["scenarios"][0]["graphics"]["renderer"] = "OpenGL";
    if (!check(!parse(cpu_fps.dump(), rejected_cpu),
               "reject CPU reports that invent a renderer identity"))
        return 1;
    cpu_fps = Json::parse(cpu_json);
    cpu_fps["scenarios"][0]["trials"][0]["cpu_work_batches_per_second"] = "unknown";
    if (!check(!parse(cpu_fps.dump(), rejected_cpu),
               "reject CPU reports with invalid batch throughput metadata"))
        return 1;

    // Current report evidence is mandatory even when a backend is unavailable.
    Json missing_backend = Json::parse(json);
    for (const char* key : {"asset_workload", "video_decode_backend", "video_decode_fallback",
                            "video_upload_pipeline", "video_hardware_decode_confirmed"}) {
        Json missing = missing_backend;
        missing["scenarios"][0]["graphics"].erase(key);
        if (!check(!parse(missing.dump(), candidate),
                   "reject reports missing canonical backend evidence"))
            return 1;
    }

    Options asset_options;
    asset_options.scenario = "asset-project-prepare";
    asset_options.asset_cache = "cold";
    Environment asset_host;
    asset_host.platform = "Linux";
    asset_host.frame_path = "asset-source-and-compiled-project-cpu-only";
    const Json asset_json = Json::parse(example_report(asset_options, asset_host, 0.5));
    ImportedReport asset_base, asset_other;
    if (!check(parse(asset_json.dump(), asset_base) &&
                   parse(example_report(asset_options, asset_host, 0.4), asset_other) &&
                   compare_reports(asset_base, asset_other).controlled,
               "identical headless asset reports have controlled comparison"))
        return 1;
    Json invalid_asset = asset_json;
    invalid_asset["scenarios"][0]["graphics"]["asset_workload"]["manager_cache"] = "warm";
    if (!check(!parse(invalid_asset.dump(), candidate),
               "reject asset workload cache evidence conflicting with configuration"))
        return 1;
    invalid_asset = asset_json;
    invalid_asset["scenarios"][0]["graphics"]["asset_workload"]["source_backend"] = "Web MEMFS";
    if (!check(!parse(invalid_asset.dump(), candidate),
               "reject impossible asset source backend for the reported platform"))
        return 1;
    invalid_asset = asset_json;
    invalid_asset["scenarios"][0]["graphics"]["asset_workload"] = nullptr;
    if (!check(!parse(invalid_asset.dump(), candidate),
               "reject missing headless asset workload metadata"))
        return 1;

    Options decode_options;
    decode_options.scenario = "video-decode";
    Environment decoder_host;
    decoder_host.platform = "Linux";
    decoder_host.frame_path = "native-vp9-decoder-no-presentation";
    decoder_host.video_codec_backend = "libvpx-vp9";
    const Json decode_json = Json::parse(example_report(decode_options, decoder_host, 0.3));
    ImportedReport decode_base, decode_other;
    std::string decoder_error;
    const bool decoder_import_a =
        decode_imported_report(decode_json.dump(), "decoder A", decode_base, decoder_error);
    if (!decoder_import_a)
        std::fprintf(stderr, "decoder A import: %s\n", decoder_error.c_str());
    const bool decoder_import_b =
        decode_imported_report(example_report(decode_options, decoder_host, 0.2), "decoder B",
                               decode_other, decoder_error);
    if (!decoder_import_b)
        std::fprintf(stderr, "decoder B import: %s\n", decoder_error.c_str());
    if (decoder_import_a && decoder_import_b) {
        for (const auto& warning : compare_reports(decode_base, decode_other).warnings)
            std::fprintf(stderr, "headless decoder comparison: %s\n", warning.c_str());
    }
    if (!check(decoder_import_a && decoder_import_b &&
                   compare_reports(decode_base, decode_other).controlled,
               "identical headless decoder reports compare without GPU metadata"))
        return 1;
    Json switched_backend = decode_json;
    switched_backend["scenarios"][0]["graphics"]["video_decode_backend"] = "nvdec-vp9";
    switched_backend["scenarios"][0]["graphics"]["video_hardware_decode_confirmed"] = true;
    if (!check(parse(switched_backend.dump(), decode_other) &&
                   !compare_reports(decode_base, decode_other).controlled,
               "hardware decoder changes invalidate a controlled comparison"))
        return 1;
    Json incomplete_decode = decode_json;
    incomplete_decode["scenarios"][0]["graphics"] = nullptr;
    if (!check(!parse(incomplete_decode.dump(), candidate),
               "completed video report cannot omit all scenario backend evidence"))
        return 1;
    incomplete_decode = decode_json;
    incomplete_decode["scenarios"][0]["graphics"]["video_decode_backend"] = nullptr;
    if (!check(!parse(incomplete_decode.dump(), candidate),
               "completed video decode requires backend identity"))
        return 1;

    Options browser_video;
    browser_video.scenario = "video-upload";
    Environment browser_video_host = machine;
    browser_video_host.platform = "Emscripten";
    browser_video_host.browser = "Chromium";
    browser_video_host.video_codec_backend = "browser-media-gpu";
    browser_video_host.video_upload_pipeline = "typed-asset browser-media HTMLVideoElement";
    ImportedReport opaque_a, opaque_b;
    std::string opaque_error;
    const bool imported_opaque_a =
        decode_imported_report(example_report(browser_video, browser_video_host, 1.0), "browser A",
                               opaque_a, opaque_error);
    if (!imported_opaque_a)
        std::fprintf(stderr, "browser A import: %s\n", opaque_error.c_str());
    const bool imported_opaque_b =
        decode_imported_report(example_report(browser_video, browser_video_host, 0.9), "browser B",
                               opaque_b, opaque_error);
    if (!imported_opaque_b)
        std::fprintf(stderr, "browser B import: %s\n", opaque_error.c_str());
    if (!check(imported_opaque_a && imported_opaque_b &&
                   !compare_reports(opaque_a, opaque_b).controlled,
               "opaque browser hardware-decoding capability cannot be certified as controlled"))
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

    Options paired_options = options;
    paired_options.scenario = "raw-bgfx-geometry";
    paired_options.alternate = std::make_shared<Options>(paired_options);
    paired_options.alternate->rect_count = 5;
    const auto paired_report = example_report(paired_options, machine, 10);
    if (!check(
            parse(paired_report, candidate) &&
                candidate.document["scenarios"][0]["trials"].size() == 3 &&
                candidate.document["scenarios"][0]["trials"][1]["arm"] == "B" &&
                candidate.document["scenarios"][0]["alternating"]["baseline"]["completed_trials"] ==
                    2 &&
                candidate.document["scenarios"][0]["alternating"]["candidate"]
                                  ["completed_trials"] == 1,
            "A/B/A reports retain per-arm trials, summaries and embedded workload B"))
        return 1;
    ImportedReport paired_a, paired_b;
    if (!check(parse(paired_report, paired_a) && parse(paired_report, paired_b),
               "A/B/A imports are comparable"))
        return 1;
    const auto arm_comparison = compare_reports(paired_a, paired_b);
    if (!check(!arm_comparison.metrics.empty() &&
                   std::all_of(arm_comparison.metrics.begin(), arm_comparison.metrics.end(),
                               [](const ComparisonMetric& metric) {
                                   return metric.name.starts_with("baseline.") ||
                                          metric.name.starts_with("candidate.");
                               }),
               "A/B/A comparisons only use matching arms, never pooled aggregate"))
        return 1;
    Json drifted_pair = Json::parse(paired_report);
    drifted_pair["scenarios"][0]["alternating"]["warnings"].push_back("High A-arm drift");
    drifted_pair["scenarios"][0]["alternating"]["wall_drift_percent"] = 25.0;
    if (!check(parse(drifted_pair.dump(), paired_b), "import drifted A/B/A report"))
        return 1;
    const auto drift_comparison = compare_reports(paired_a, paired_b);
    if (!check(!drift_comparison.controlled &&
                   std::any_of(drift_comparison.warnings.begin(), drift_comparison.warnings.end(),
                               [](const std::string& warning) {
                                   return warning.find("drift") != std::string::npos;
                               }),
               "imported A/B/A reliability flags never disappear from comparison"))
        return 1;

    Json broken_pair = Json::parse(paired_report);
    broken_pair["scenarios"][0]["trials"][1]["arm"] = "A";
    if (!check(!parse(broken_pair.dump(), candidate),
               "report reader rejects incorrect A/B/A order"))
        return 1;
    broken_pair = Json::parse(paired_report);
    broken_pair["scenarios"][0]["alternating"]["baseline"]["trial_wall_medians_ms"]["mean_ms"] =
        999.0;
    if (!check(!parse(broken_pair.dump(), candidate),
               "reject A/B/A summary whose statistics contradict the completed A trials"))
        return 1;
    broken_pair = Json::parse(paired_report);
    broken_pair["scenarios"][0].erase("alternating");
    if (!check(!parse(broken_pair.dump(), candidate), "report reader requires A/B/A summary"))
        return 1;
    Options detailed = options;
    detailed.profile = "diagnostic";
    const Json detailed_report = Json::parse(example_report(detailed, machine, 11));
    if (!check(parse(detailed_report.dump(), candidate),
               "accept current owner-scoped diagnostic distributions"))
        return 1;
    auto broken_diagnostic = detailed_report;
    broken_diagnostic["scenarios"][0]["trials"][0]["diagnostic"]["engine_layout_ms"]["p95_ms"] = -1;
    if (!check(!parse(broken_diagnostic.dump(), candidate),
               "reject negative owner-stage sample quantile"))
        return 1;
    broken_diagnostic = detailed_report;
    broken_diagnostic["scenarios"][0]["trials"][0]["diagnostic"].erase("engine_scope");
    if (!check(!parse(broken_diagnostic.dump(), candidate),
               "reject obsolete diagnostic schema without owner scope"))
        return 1;
    broken_diagnostic = detailed_report;
    broken_diagnostic["scenarios"][0]["trials"][0]["diagnostic"]["draw_calls"] = "bad";
    if (!check(!parse(broken_diagnostic.dump(), candidate),
               "reject malformed async bgfx counter summary"))
        return 1;

    Options repeated_options = options;
    repeated_options.repeats = 3;
    const Json repeated_report = Json::parse(example_report(repeated_options, machine, 10));
    if (!check(parse(repeated_report.dump(), candidate) &&
                   repeated_report["scenarios"][0]["repeated"]["trials"]["completed_trials"] == 3,
               "ordinary repeated reports contain a per-trial reliability summary"))
        return 1;
    Json broken_repeat = repeated_report;
    broken_repeat["scenarios"][0]["repeated"]["trials"]["completed_trials"] = 1;
    if (!check(!parse(broken_repeat.dump(), candidate),
               "reject repeated-trial completed count inconsistent with trials"))
        return 1;
    broken_repeat = repeated_report;
    broken_repeat["scenarios"][0]["repeated"]["trials"]["trial_cpu_p95_ms"]["mean_ms"] = 99;
    if (!check(!parse(broken_repeat.dump(), candidate),
               "reject fabricated repeated-trial tail statistics"))
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
    malformed["scenarios"][0]["trials"] = Json::array();
    if (!check(!parse(malformed.dump(), candidate), "reject complete result with no trials"))
        return 1;
    // Required completed-trial distributions may not be null, even though
    // unavailable optional diagnostic distributions legitimately may be.
    for (const auto* metric : {"frame_wall_ms", "cpu_operation_ms"}) {
        malformed = Json::parse(json);
        malformed["scenarios"][0]["trials"][0][metric] = nullptr;
        if (!check(!decode_imported_report(malformed.dump(), "missing trial distribution",
                                           untouched, reason) &&
                       !reason.empty() && untouched.document == baseline.document,
                   "reject null required trial distribution without aborting or replacing import"))
            return 1;
        malformed = Json::parse(json);
        malformed["scenarios"][0]["aggregate"][metric] = nullptr;
        if (!check(
                !decode_imported_report(malformed.dump(), "missing aggregate distribution",
                                        untouched, reason) &&
                    !reason.empty() && untouched.document == baseline.document,
                "reject null required aggregate distribution without aborting or replacing import"))
            return 1;
    }
    malformed = Json::parse(paired_report);
    malformed["scenarios"][0]["alternating"]["baseline"]["trial_wall_medians_ms"] = nullptr;
    if (!check(!decode_imported_report(malformed.dump(), "missing A/B/A distribution", untouched,
                                       reason) &&
                   !reason.empty() && untouched.document == baseline.document,
               "reject null required A/B/A trial-group distribution without aborting"))
        return 1;
    malformed = repeated_report;
    malformed["scenarios"][0]["repeated"]["trials"]["trial_cpu_p95_ms"] = nullptr;
    if (!check(!decode_imported_report(malformed.dump(), "missing repeated distribution", untouched,
                                       reason) &&
                   !reason.empty() && untouched.document == baseline.document,
               "reject null repeated-trial distribution without aborting"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0].erase("measured_wall_seconds");
    if (!check(
            !decode_imported_report(malformed.dump(), "missing elapsed time", untouched, reason) &&
                !reason.empty() && untouched.document == baseline.document,
            "reject missing completed-trial elapsed time without aborting"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["measured_wall_seconds"] = nullptr;
    if (!check(!decode_imported_report(malformed.dump(), "null elapsed time", untouched, reason) &&
                   !reason.empty() && untouched.document == baseline.document,
               "reject null completed-trial elapsed time without aborting"))
        return 1;

    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["frame_wall_ms"]["samples"] = 99;
    if (!check(!parse(malformed.dump(), candidate),
               "reject trial distribution count inconsistent with frames"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["aggregate"]["cpu_operation_ms"]["samples"] = 99;
    if (!check(!parse(malformed.dump(), candidate),
               "reject aggregate distribution count inconsistent with complete trials"))
        return 1;
    malformed = Json::parse(json);
    malformed["scenarios"][0]["trials"][0]["outcome"] = "failed";
    if (!check(!parse(malformed.dump(), candidate),
               "reject successful suite with failed trial and retained aggregate"))
        return 1;
    malformed = Json::parse(paired_report);
    malformed["scenarios"][0]["alternating"]["baseline"]["completed_trials"] = 1;
    if (!check(!parse(malformed.dump(), candidate), "reject incorrect A/B/A arm count"))
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
    if (!check(!parse(malformed.dump(), candidate), "recovery attempt metadata required"))
        return 1;
    malformed["scenarios"][0]["trials"][0]["interrupted_attempts"] =
        Json::array({{{"reason", "surface lost"}, {"warmup_frames", 4}, {"measured_frames", 2}}});
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
