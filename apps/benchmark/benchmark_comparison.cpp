#include "benchmark_comparison.hpp"
#include "benchmark_report.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
#include <utility>

namespace noveltea::benchmark {
namespace {
using Json = nlohmann::json;

bool fields(const Json& object, std::initializer_list<const char*> keys)
{
    if (!object.is_object())
        return false;
    for (const auto* key : keys)
        if (!object.contains(key))
            return false;
    return true;
}

bool finite_nonnegative(const Json& number)
{
    return number.is_number() && std::isfinite(number.get<double>()) && number.get<double>() >= 0.0;
}

bool unsigned_count(const Json& number)
{
    return number.is_number_integer() &&
           (number.is_number_unsigned() || number.get<int64_t>() >= 0);
}

bool valid_raw_samples(const Json& samples)
{
    if (samples.is_null())
        return true;
    if (!samples.is_array())
        return false;
    for (const auto& sample : samples) {
        if (!fields(sample, {"wall_ms", "cpu_operation_ms"}) || sample.size() != 2 ||
            !finite_nonnegative(sample["wall_ms"]) ||
            !finite_nonnegative(sample["cpu_operation_ms"]))
            return false;
    }
    return true;
}

bool valid_distribution(const Json& value)
{
    if (value.is_null())
        return true;
    if (!fields(value, {"samples", "mean_ms", "min_ms", "max_ms", "p50_ms", "p95_ms", "p99_ms",
                        "standard_deviation_ms"}) ||
        !unsigned_count(value["samples"]) || value["samples"] == 0)
        return false;
    for (const auto* field :
         {"mean_ms", "min_ms", "max_ms", "p50_ms", "p95_ms", "p99_ms", "standard_deviation_ms"})
        if (!finite_nonnegative(value[field]))
            return false;
    return value["min_ms"] <= value["p50_ms"] && value["p50_ms"] <= value["p95_ms"] &&
           value["p95_ms"] <= value["p99_ms"] && value["p99_ms"] <= value["max_ms"] &&
           value["min_ms"] <= value["mean_ms"] && value["mean_ms"] <= value["max_ms"];
}

bool count_matches(const Json& distribution, uint64_t count)
{
    return count == 0 ? distribution.is_null()
                      : distribution.is_object() && valid_distribution(distribution) &&
                            distribution["samples"].get<uint64_t>() == count;
}

bool valid_trial_group(const Json& group, uint64_t completed, const Json& trials,
                       std::string_view arm)
{
    if (!fields(group, {"completed_trials", "trial_wall_medians_ms", "trial_cpu_medians_ms",
                        "trial_wall_p95_ms", "trial_cpu_p95_ms", "trial_wall_p99_ms",
                        "trial_cpu_p99_ms"}) ||
        !unsigned_count(group["completed_trials"]) ||
        group["completed_trials"].get<uint64_t>() != completed)
        return false;
    for (const auto* metric : {"trial_wall_medians_ms", "trial_cpu_medians_ms", "trial_wall_p95_ms",
                               "trial_cpu_p95_ms", "trial_wall_p99_ms", "trial_cpu_p99_ms"}) {
        if (!count_matches(group[metric], completed))
            return false;
        const bool wall = std::string_view(metric).find("wall") != std::string_view::npos;
        const char* percentile =
            std::string_view(metric).find("medians") != std::string_view::npos ? "p50_ms"
            : std::string_view(metric).find("p95") != std::string_view::npos   ? "p95_ms"
                                                                               : "p99_ms";
        std::vector<FrameSample> observations;
        for (const auto& trial : trials)
            if (trial["outcome"] == "complete" && trial["arm"] == arm) {
                const double ms =
                    trial[wall ? "frame_wall_ms" : "cpu_operation_ms"][percentile].get<double>();
                observations.push_back({ms / 1000.0, 0.0});
            }
        const auto expected = summarize(observations, true);
        if (!completed)
            continue;
        const auto& recorded = group[metric];
        const auto equal = [&](const char* key, double value) {
            const double actual = recorded[key].get<double>();
            return std::abs(actual - value) <=
                   1e-7 * std::max({1.0, std::abs(value), std::abs(actual)});
        };
        if (!equal("mean_ms", expected.mean_ms) || !equal("min_ms", expected.min_ms) ||
            !equal("max_ms", expected.max_ms) || !equal("p50_ms", expected.p50_ms) ||
            !equal("p95_ms", expected.p95_ms) || !equal("p99_ms", expected.p99_ms) ||
            !equal("standard_deviation_ms", expected.standard_deviation_ms))
            return false;
    }
    return true;
}

bool valid_percentage(const Json& value)
{
    return value.is_null() || (value.is_number() && std::isfinite(value.get<double>()));
}

bool valid_warnings(const Json& warnings)
{
    return warnings.is_array() && std::all_of(warnings.begin(), warnings.end(),
                                              [](const Json& item) { return item.is_string(); });
}

bool near_seconds(double a, double b)
{
    return std::abs(a - b) <= 1e-8 * std::max({1.0, std::abs(a), std::abs(b)});
}

bool valid_counter(const Json& value)
{
    if (value.is_null())
        return true;
    if (!fields(value, {"snapshots", "mean", "min", "max"}) ||
        !unsigned_count(value["snapshots"]) || value["snapshots"] == 0 ||
        !finite_nonnegative(value["mean"]) || !unsigned_count(value["min"]) ||
        !unsigned_count(value["max"]))
        return false;
    return value["min"] <= value["mean"] && value["mean"] <= value["max"];
}

bool valid_diagnostic(const Json& value)
{
    if (value.is_null())
        return true;
    if (!fields(value, {"observations",
                        "bgfx_stats_snapshots",
                        "stats_scope",
                        "cpu_update_ms",
                        "cpu_submission_ms",
                        "rmlui_update_ms",
                        "rmlui_render_ms",
                        "ui_fixture_mutation_ms",
                        "engine_events_ms",
                        "engine_jobs_ms",
                        "engine_assets_ms",
                        "engine_update_ms",
                        "engine_runtime_ms",
                        "engine_layout_ms",
                        "engine_render_ms",
                        "engine_scope",
                        "rmlui_scope",
                        "ui_fixture_scope",
                        "stage_additivity",
                        "bgfx_frame_cpu_ms",
                        "bgfx_render_thread_ms",
                        "bgfx_wait_render_ms",
                        "bgfx_wait_submit_ms",
                        "gpu_execution_ms",
                        "gpu_scope",
                        "draw_calls",
                        "compute_calls",
                        "blit_calls",
                        "view_count",
                        "view_scope",
                        "resource_textures",
                        "resource_framebuffers",
                        "resource_programs"}) ||
        !unsigned_count(value["observations"]) || !unsigned_count(value["bgfx_stats_snapshots"]) ||
        value["observations"] == 0)
        return false;
    for (const auto* field : {"stats_scope", "gpu_scope", "view_scope", "engine_scope",
                              "rmlui_scope", "ui_fixture_scope", "stage_additivity"})
        if (!value[field].is_string() || value[field].get<std::string>().empty())
            return false;
    for (const auto* field :
         {"cpu_update_ms", "cpu_submission_ms", "rmlui_update_ms", "rmlui_render_ms",
          "ui_fixture_mutation_ms", "engine_events_ms", "engine_jobs_ms", "engine_assets_ms",
          "engine_update_ms", "engine_runtime_ms", "engine_layout_ms", "engine_render_ms",
          "bgfx_frame_cpu_ms", "bgfx_render_thread_ms", "bgfx_wait_render_ms",
          "bgfx_wait_submit_ms", "gpu_execution_ms"})
        if (!valid_distribution(value[field]))
            return false;
    for (const auto* field : {"draw_calls", "compute_calls", "blit_calls", "view_count",
                              "resource_textures", "resource_framebuffers", "resource_programs"})
        if (!valid_counter(value[field]))
            return false;
    return true;
}

bool valid_graphics(const Json& value)
{
    if (value.is_null())
        return true; // A failed or mixed-host suite may not have a graphics owner.
    if (!fields(value, {"platform", "video_driver", "renderer", "frame_path", "gpu_vendor_id",
                        "gpu_device_id", "width_pixels", "height_pixels", "browser"}))
        return false;
    if (!value["platform"].is_string() || !value["browser"].is_string())
        return false;
    for (const auto* key : {"video_driver", "renderer", "frame_path"})
        if (!value[key].is_null() && !value[key].is_string())
            return false;
    for (const auto* key : {"gpu_vendor_id", "gpu_device_id", "width_pixels", "height_pixels"})
        if (!value[key].is_null() && !value[key].is_number_integer())
            return false;
    return true;
}

std::string text_field(const Json& object, const char* key)
{
    if (!object.is_object() || !object.contains(key))
        return "<unavailable>";
    const auto& value = object[key];
    return value.is_null() ? "<unavailable>" : value.dump();
}

void mismatch(ReportComparison& result, const char* what, const Json& left, const Json& right,
              const char* field)
{
    if (text_field(left, field) == text_field(right, field))
        return;
    result.controlled = false;
    result.warnings.emplace_back(std::string(what) + " differs: " + text_field(left, field) +
                                 " vs " + text_field(right, field));
}

const Json* by_id(const Json& scenarios, const std::string& id)
{
    for (const auto& scenario : scenarios)
        if (scenario["id"] == id)
            return &scenario;
    return nullptr;
}

void add_metric(ReportComparison& result, const std::string& scenario, const char* name,
                const Json& left, const Json& right, const char* field)
{
    if (left.is_null() || right.is_null())
        return;
    const double a = left[field].get<double>();
    const double b = right[field].get<double>();
    ComparisonMetric metric;
    metric.scenario = scenario;
    metric.name = name;
    metric.baseline = a;
    metric.candidate = b;
    metric.delta = b - a;
    if (a != 0.0)
        metric.percent = 100.0 * (b - a) / a;
    metric.baseline_stddev = left["standard_deviation_ms"].get<double>();
    metric.candidate_stddev = right["standard_deviation_ms"].get<double>();
    metric.baseline_samples = left["samples"].get<uint64_t>();
    metric.candidate_samples = right["samples"].get<uint64_t>();
    result.metrics.push_back(std::move(metric));
}

bool valid_name(const std::string& name)
{
    return !name.empty() && name.size() <= 64 &&
           std::none_of(name.begin(), name.end(),
                        [](unsigned char ch) { return ch < 0x20 || ch == 0x7f; });
}
} // namespace

bool decode_imported_report(std::string_view source, std::string name, ImportedReport& report,
                            std::string& error)
{
    if (source.size() > 16 * 1024 * 1024) {
        error = "report exceeds 16 MiB import limit";
        return false;
    }
    const Json root = Json::parse(source.begin(), source.end(), nullptr, false);
    if (!fields(root, {"format", "version", "configuration", "build", "graphics", "timing",
                       "outcome", "scenarios", "capacity_search"}) ||
        root.size() != 9 || root["format"] != "noveltea.benchmark.result" || root["version"] != 1 ||
        !root["build"].is_object() || !root["timing"].is_object() || !root["outcome"].is_string() ||
        !root["scenarios"].is_array() ||
        (!root["capacity_search"].is_null() && !root["capacity_search"].is_object())) {
        error = "invalid or unsupported benchmark result V1";
        return false;
    }
    const auto outcome_allowed = [](const Json& value) {
        return value == "complete" || value == "partial" || value == "failed" ||
               value == "cancelled";
    };
    if (!outcome_allowed(root["outcome"])) {
        error = "unsupported benchmark suite outcome";
        return false;
    }
    Options config;
    if (!decode_configuration(root["configuration"].dump(), config, error)) {
        error = "report configuration: " + error;
        return false;
    }
    if (!fields(root["build"], {"revision", "type", "source_fingerprint_sha256"}) ||
        !root["build"]["type"].is_string() || !root["timing"].contains("clock") ||
        !root["timing"]["clock"].is_string() || !valid_graphics(root["graphics"])) {
        error = "invalid benchmark build, clock or graphics metadata";
        return false;
    }
    std::set<std::string> ids;
    for (const auto& scenario : root["scenarios"]) {
        if (!fields(scenario, {"id", "outcome", "trials", "aggregate", "graphics", "alternating",
                               "repeated"}) ||
            !scenario["id"].is_string() || !scenario["outcome"].is_string() ||
            !scenario["trials"].is_array() || !scenario["aggregate"].is_object() ||
            !valid_graphics(scenario["graphics"]) || !outcome_allowed(scenario["outcome"])) {
            error = "invalid scenario or graphics metadata";
            return false;
        }
        const auto id = scenario["id"].get<std::string>();
        const auto& suite_scenarios = quick_suite_scenarios();
        if (id.empty() || !ids.insert(id).second ||
            (!config.quick_suite && id != config.scenario) ||
            (config.quick_suite && std::find(suite_scenarios.begin(), suite_scenarios.end(), id) ==
                                       suite_scenarios.end())) {
            error = "invalid or duplicate scenario identity for reported configuration";
            return false;
        }
        const auto& aggregate = scenario["aggregate"];
        if (!fields(aggregate, {"measured_frames", "measured_wall_seconds", "frame_loop_cadence_hz",
                                "frame_wall_ms", "cpu_operation_ms"}) ||
            !unsigned_count(aggregate["measured_frames"]) ||
            !finite_nonnegative(aggregate["measured_wall_seconds"]) ||
            (!aggregate["frame_loop_cadence_hz"].is_null() &&
             !finite_nonnegative(aggregate["frame_loop_cadence_hz"])) ||
            !valid_distribution(aggregate["frame_wall_ms"]) ||
            !valid_distribution(aggregate["cpu_operation_ms"])) {
            error = "invalid aggregate distribution";
            return false;
        }
        const bool alternating = !root["configuration"]["alternate"].is_null();
        const bool repeated = !alternating && scenario["trials"].size() > 1;
        if (repeated != !scenario["repeated"].is_null()) {
            error = "inconsistent repeated-trial summary";
            return false;
        }
        if (alternating != !scenario["alternating"].is_null()) {
            error = "inconsistent A/B/A summary";
            return false;
        }
        if (alternating) {
            const auto& detail = scenario["alternating"];
            if (!fields(detail, {"order", "baseline", "candidate", "wall_delta_percent",
                                 "cpu_delta_percent", "wall_drift_percent", "cpu_drift_percent",
                                 "warnings"}) ||
                detail["order"] != "A/B/A" || !detail["warnings"].is_array() ||
                !std::all_of(detail["warnings"].begin(), detail["warnings"].end(),
                             [](const Json& v) { return v.is_string(); })) {
                error = "invalid A/B/A reliability summary";
                return false;
            }
            for (const auto* metric : {"wall_delta_percent", "cpu_delta_percent",
                                       "wall_drift_percent", "cpu_drift_percent"})
                if (!detail[metric].is_null() &&
                    (!detail[metric].is_number() || !std::isfinite(detail[metric].get<double>()))) {
                    error = "invalid A/B/A percentage";
                    return false;
                }
            for (const auto* arm : {"baseline", "candidate"}) {
                const auto& group = detail[arm];
                if (!fields(group, {"completed_trials", "trial_wall_medians_ms",
                                    "trial_cpu_medians_ms", "trial_wall_p95_ms", "trial_cpu_p95_ms",
                                    "trial_wall_p99_ms", "trial_cpu_p99_ms"}) ||
                    !unsigned_count(group["completed_trials"])) {
                    error = "invalid A/B/A trial group";
                    return false;
                }
                for (const auto* key :
                     {"trial_wall_medians_ms", "trial_cpu_medians_ms", "trial_wall_p95_ms",
                      "trial_cpu_p95_ms", "trial_wall_p99_ms", "trial_cpu_p99_ms"})
                    if (!valid_distribution(group[key])) {
                        error = "invalid A/B/A trial distribution";
                        return false;
                    }
            }
        }
        size_t ordinal = 0;
        uint64_t completed_a = 0, completed_b = 0, frames = 0;
        double wall_seconds = 0.0;
        for (const auto& trial : scenario["trials"]) {
            if (!fields(trial, {"outcome", "arm", "interrupted_attempts", "measured_frames",
                                "measured_wall_seconds", "interruption_retries", "frame_wall_ms",
                                "cpu_operation_ms", "diagnostic", "raw_samples"}) ||
                !trial["outcome"].is_string() ||
                (trial["outcome"] != "complete" && trial["outcome"] != "failed" &&
                 trial["outcome"] != "cancelled") ||
                !trial["arm"].is_string() ||
                trial["arm"] != (alternating && ordinal % 3 == 1 ? "B" : "A") ||
                !trial["interrupted_attempts"].is_array() ||
                trial["interrupted_attempts"].size() > kMaxInterruptionRetries ||
                !unsigned_count(trial["measured_frames"]) ||
                !unsigned_count(trial["interruption_retries"]) ||
                !valid_distribution(trial["frame_wall_ms"]) ||
                !valid_distribution(trial["cpu_operation_ms"]) ||
                !valid_raw_samples(trial["raw_samples"]) ||
                !valid_diagnostic(trial["diagnostic"]) ||
                ((config.profile == "diagnostic" && trial["outcome"] == "complete") !=
                 !trial["diagnostic"].is_null())) {
                error = "invalid trial measurement";
                return false;
            }
            for (const auto& attempt : trial["interrupted_attempts"])
                if (!fields(attempt, {"reason", "warmup_frames", "measured_frames"}) ||
                    !attempt["reason"].is_string() || !unsigned_count(attempt["warmup_frames"]) ||
                    !unsigned_count(attempt["measured_frames"])) {
                    error = "invalid interrupted attempt";
                    return false;
                }
            if (trial["interrupted_attempts"].size() !=
                trial["interruption_retries"].get<uint64_t>()) {
                error = "inconsistent retry metadata";
                return false;
            }
            const bool complete = trial["outcome"] == "complete";
            const uint64_t count = complete ? trial["measured_frames"].get<uint64_t>() : 0;
            if ((complete && count == 0) || !count_matches(trial["frame_wall_ms"], count) ||
                !count_matches(trial["cpu_operation_ms"], count) ||
                (!trial["raw_samples"].is_null() &&
                 (trial["raw_samples"].size() != count || !complete))) {
                error = "trial outcome, measured frames and sample counts disagree";
                return false;
            }
            if (complete) {
                ++(trial["arm"] == "B" ? completed_b : completed_a);
                frames += count;
                if (!finite_nonnegative(trial["measured_wall_seconds"]) ||
                    trial["measured_wall_seconds"].get<double>() <= 0.0) {
                    error = "completed trial lacks elapsed wall time";
                    return false;
                }
                wall_seconds += trial["measured_wall_seconds"].get<double>();
            }
            ++ordinal;
        }
        const uint64_t completed = completed_a + completed_b;
        const uint64_t expected = static_cast<uint64_t>(config.repeats) * (alternating ? 3u : 1u);
        if (frames != aggregate["measured_frames"].get<uint64_t>() ||
            !near_seconds(wall_seconds, aggregate["measured_wall_seconds"].get<double>()) ||
            !count_matches(aggregate["frame_wall_ms"], frames) ||
            !count_matches(aggregate["cpu_operation_ms"], frames) ||
            scenario["trials"].size() > expected ||
            (scenario["outcome"] == "complete" &&
             (completed != expected || scenario["trials"].size() != expected)) ||
            (scenario["outcome"] == "failed" && completed != 0) ||
            (scenario["outcome"] == "partial" && completed == 0) ||
            (scenario["outcome"] == "complete" && completed == 0)) {
            error = "scenario outcome, trials and aggregate measurements disagree";
            return false;
        }
        if (alternating && (!valid_trial_group(scenario["alternating"]["baseline"], completed_a,
                                               scenario["trials"], "A") ||
                            !valid_trial_group(scenario["alternating"]["candidate"], completed_b,
                                               scenario["trials"], "B"))) {
            error = "A/B/A completed-arm summaries disagree with trials";
            return false;
        }
        if (repeated) {
            const auto& summary = scenario["repeated"];
            if (!fields(summary,
                        {"trials", "wall_drift_percent", "cpu_drift_percent", "warnings"}) ||
                !valid_trial_group(summary["trials"], completed_a, scenario["trials"], "A") ||
                !valid_percentage(summary["wall_drift_percent"]) ||
                !valid_percentage(summary["cpu_drift_percent"]) ||
                !valid_warnings(summary["warnings"])) {
                error = "repeated-trial reliability summary disagrees with trials";
                return false;
            }
        }
    }
    if (root["outcome"] == "complete" && root["capacity_search"].is_null() &&
        (root["scenarios"].empty() ||
         !std::all_of(root["scenarios"].begin(), root["scenarios"].end(),
                      [](const Json& value) { return value["outcome"] == "complete"; }))) {
        error = "complete suite lacks complete scenario evidence";
        return false;
    }
    report = {std::move(root), std::move(name)};
    error.clear();
    return true;
}

ReportComparison compare_reports(const ImportedReport& baseline, const ImportedReport& candidate)
{
    ReportComparison result;
    const auto& a = baseline.document;
    const auto& b = candidate.document;
    const auto& ac = a["configuration"];
    const auto& bc = b["configuration"];
    Options a_options;
    Options b_options;
    std::string decode_error;
    // Imported reports were already checked against the current configuration
    // contract before reaching this point.
    (void)decode_configuration(ac.dump(), a_options, decode_error);
    (void)decode_configuration(bc.dump(), b_options, decode_error);
    mismatch(result, "Build type", a["build"], b["build"], "type");
    if (text_field(a["build"], "source_fingerprint_sha256") !=
        text_field(b["build"], "source_fingerprint_sha256"))
        result.warnings.emplace_back(
            "Build source differs (expected for before/after code changes)");
    mismatch(result, "Clock", a["timing"], b["timing"], "clock");
    mismatch(result, "Timing profile", a["timing"], b["timing"], "profile");
    mismatch(result, "Clock policy", ac, bc, "clock_policy");
    mismatch(result, "A/B/A candidate configuration", ac, bc, "alternate");
    mismatch(result, "Workload version", ac, bc, "scenario_version");
    // Ignore run duration, repeats, raw-sample export and output name when
    // checking workload identity. A Quick Suite's selection is per scenario.
    for (const auto* key : {"vsync", "native_resolution", "width", "height", "capacity_dimension",
                            "capacity_target", "capacity_threshold", "capacity_mode"})
        mismatch(result, key, ac["settings"], bc["settings"], key);
    for (const auto& scenario : a["scenarios"]) {
        const auto id = scenario["id"].get<std::string>();
        const auto* other = by_id(b["scenarios"], id);
        if (!other) {
            result.controlled = false;
            result.warnings.push_back("Scenario absent from candidate: " + id);
            continue;
        }
        const auto parameters_for = [&](const Json& config,
                                        const Options& options) -> std::optional<Json> {
            if (config["settings"]["quick_suite"] == true) {
                const Options reference = reference_scenario_options(options, id);
                return Json::parse(encode_configuration(reference))["parameters"];
            }
            if (options.scenario == id)
                return std::optional<Json>{std::in_place, config["parameters"]};
            return std::nullopt;
        };
        const auto a_parameters = parameters_for(ac, a_options);
        const auto b_parameters = parameters_for(bc, b_options);
        if (!a_parameters || !b_parameters) {
            result.controlled = false;
            result.warnings.push_back(id + ": workload parameters cannot be verified");
        } else if (*a_parameters != *b_parameters) {
            result.controlled = false;
            result.warnings.push_back(id + ": workload parameters differ");
        }
        const Json& ag = scenario["graphics"].is_null() ? a["graphics"] : scenario["graphics"];
        const Json& bg = (*other)["graphics"].is_null() ? b["graphics"] : (*other)["graphics"];
        if (ag.is_null() || bg.is_null()) {
            result.controlled = false;
            result.warnings.push_back(id + ": graphics identity unavailable");
        } else {
            for (const auto* key :
                 {"platform", "browser", "video_driver", "renderer", "frame_path", "gpu_vendor_id",
                  "gpu_device_id", "width_pixels", "height_pixels", "ui_raster_width_pixels",
                  "ui_raster_height_pixels", "world_raster_width_pixels",
                  "world_raster_height_pixels", "raw_workload", "ui_render_path",
                  "ui_reference_msaa_samples"})
                mismatch(result, (id + ": " + key).c_str(), ag, bg, key);
            for (const auto* key : {"platform", "renderer", "gpu_vendor_id", "gpu_device_id",
                                    "width_pixels", "height_pixels"}) {
                if (text_field(ag, key) == "<unavailable>" || text_field(ag, key) == "null" ||
                    text_field(bg, key) == "<unavailable>" || text_field(bg, key) == "null") {
                    result.controlled = false;
                    result.warnings.push_back(id + ": " + key +
                                              " unavailable; cannot verify parity");
                }
            }
        }
        if (scenario["outcome"] != "complete" || (*other)["outcome"] != "complete") {
            result.controlled = false;
            result.warnings.push_back(id + ": incomplete scenario; metrics may be unavailable");
        }
        for (const auto* label : {"baseline", "candidate"}) {
            const auto& measured = std::string_view(label) == "baseline" ? scenario : *other;
            for (const auto& trial : measured["trials"]) {
                if (trial["interruption_retries"].get<uint64_t>() > 0) {
                    result.warnings.push_back(id + ": " + label +
                                              " required interruption recovery / fresh warmup");
                    break;
                }
            }
        }
        // A/B/A aggregate mixes two different workloads and must never be compared.
        if (!scenario["alternating"].is_null() || !(*other)["alternating"].is_null()) {
            const auto warn_arm = [&](const Json& source, const char* label) {
                if (source["alternating"].is_null())
                    return;
                const auto& detail = source["alternating"];
                for (const auto& warning : detail["warnings"]) {
                    result.warnings.push_back(id + ": " + label +
                                              " A/B/A: " + warning.get<std::string>());
                    result.controlled = false;
                }
                for (const auto* drift : {"wall_drift_percent", "cpu_drift_percent"}) {
                    if (!detail[drift].is_null() && std::abs(detail[drift].get<double>()) > 10.0) {
                        result.controlled = false;
                        result.warnings.push_back(id + ": " + label + " " + drift + " exceeds 10%");
                    }
                }
            };
            warn_arm(scenario, "baseline");
            warn_arm(*other, "candidate");
            if (scenario["alternating"].is_null() || (*other)["alternating"].is_null()) {
                result.controlled = false;
                result.warnings.push_back(id + ": A/B/A and ordinary runs cannot be compared");
                continue;
            }
            for (const auto* arm : {"baseline", "candidate"}) {
                for (const auto* metric :
                     {"trial_wall_medians_ms", "trial_cpu_medians_ms", "trial_wall_p95_ms",
                      "trial_cpu_p95_ms", "trial_wall_p99_ms", "trial_cpu_p99_ms"}) {
                    const auto& left = scenario["alternating"][arm][metric];
                    const auto& right = (*other)["alternating"][arm][metric];
                    for (const auto* field : {"mean_ms", "p50_ms", "p95_ms", "p99_ms"})
                        add_metric(result, id,
                                   (std::string(arm) + "." + metric + "." + field).c_str(), left,
                                   right, field);
                }
            }
            continue;
        }
        const auto warn_repeated = [&](const Json& source, const char* label) {
            if (source["repeated"].is_null())
                return;
            const auto& detail = source["repeated"];
            for (const auto& warning : detail["warnings"]) {
                result.warnings.push_back(id + ": " + label +
                                          " repeated trials: " + warning.get<std::string>());
                result.controlled = false;
            }
        };
        warn_repeated(scenario, "baseline");
        warn_repeated(*other, "candidate");
        for (const auto* key : {"frame_wall_ms", "cpu_operation_ms"}) {
            const auto& left = scenario["aggregate"][key];
            const auto& right = (*other)["aggregate"][key];
            for (const auto* field : {"mean_ms", "p50_ms", "p95_ms", "p99_ms"})
                add_metric(result, id, std::string(key).append(".").append(field).c_str(), left,
                           right, field);
            if (!left.is_null() && !right.is_null()) {
                const auto noisy = [](const Json& v) {
                    return v["mean_ms"].get<double>() > 0.0 &&
                           v["standard_deviation_ms"].get<double>() / v["mean_ms"].get<double>() >
                               0.15;
                };
                if (noisy(left) || noisy(right))
                    result.warnings.push_back(id + ": high variability in " + key +
                                              " (stddev exceeds 15% of mean)");
            }
        }
    }
    for (const auto& scenario : b["scenarios"])
        if (!by_id(a["scenarios"], scenario["id"].get<std::string>())) {
            result.controlled = false;
            result.warnings.push_back("Scenario absent from baseline: " +
                                      scenario["id"].get<std::string>());
        }
    if (result.metrics.empty()) {
        result.controlled = false;
        result.warnings.emplace_back("No matching completed metric distributions");
    }
    return result;
}

std::string encode_dashboard_preferences(const DashboardPreferences& state)
{
    Json presets = Json::array();
    for (const auto& preset : state.presets)
        presets.push_back(
            {{"name", preset.name},
             {"configuration", Json::parse(encode_configuration(preset.configuration))}});
    return Json{{"format", "noveltea.benchmark.dashboard-state"},
                {"version", 1},
                {"last_configuration", Json::parse(encode_configuration(state.last_configuration))},
                {"presets", std::move(presets)}}
        .dump(2);
}

bool decode_dashboard_preferences(std::string_view source, DashboardPreferences& preferences,
                                  std::string& error)
{
    if (source.size() > 2 * 1024 * 1024) {
        error = "saved dashboard settings exceed 2 MiB";
        return false;
    }
    const Json root = Json::parse(source.begin(), source.end(), nullptr, false);
    if (!fields(root, {"format", "version", "last_configuration", "presets"}) || root.size() != 4 ||
        root["format"] != "noveltea.benchmark.dashboard-state" || root["version"] != 1 ||
        !root["presets"].is_array() || root["presets"].size() > 32) {
        error = "invalid or unsupported dashboard state V1";
        return false;
    }
    DashboardPreferences next;
    if (!decode_configuration(root["last_configuration"].dump(), next.last_configuration, error))
        return false;
    std::set<std::string> names;
    for (const auto& value : root["presets"]) {
        if (!fields(value, {"name", "configuration"}) || value.size() != 2 ||
            !value["name"].is_string()) {
            error = "invalid named preset";
            return false;
        }
        const auto name = value["name"].get<std::string>();
        if (!valid_name(name) || !names.insert(name).second) {
            error = "invalid or duplicate preset name";
            return false;
        }
        Options config;
        if (!decode_configuration(value["configuration"].dump(), config, error)) {
            error = "preset " + name + ": " + error;
            return false;
        }
        next.presets.push_back({name, std::move(config)});
    }
    preferences = std::move(next);
    error.clear();
    return true;
}

} // namespace noveltea::benchmark
