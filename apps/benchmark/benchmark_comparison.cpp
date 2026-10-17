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
        if (!fields(scenario, {"id", "outcome", "trials", "aggregate", "graphics"}) ||
            !scenario["id"].is_string() || !scenario["outcome"].is_string() ||
            !scenario["trials"].is_array() || !scenario["aggregate"].is_object() ||
            !valid_graphics(scenario["graphics"])) {
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
        for (const auto& trial : scenario["trials"]) {
            if (!fields(trial,
                        {"outcome", "measured_frames", "interruption_retries", "frame_wall_ms",
                         "cpu_operation_ms", "diagnostic", "raw_samples"}) ||
                !trial["outcome"].is_string() || !unsigned_count(trial["measured_frames"]) ||
                !unsigned_count(trial["interruption_retries"]) ||
                !valid_distribution(trial["frame_wall_ms"]) ||
                !valid_distribution(trial["cpu_operation_ms"]) ||
                !valid_raw_samples(trial["raw_samples"]) ||
                (!trial["diagnostic"].is_null() && !trial["diagnostic"].is_object())) {
                error = "invalid trial measurement";
                return false;
            }
        }
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
