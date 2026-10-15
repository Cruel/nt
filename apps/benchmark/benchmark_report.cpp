#include "benchmark_report.hpp"
#include "benchmark_source_identity.hpp"

#include <nlohmann/json.hpp>

#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>

namespace noveltea::benchmark {
namespace {
using Json = nlohmann::json;
constexpr std::string_view kConfigFormat = "noveltea.benchmark.configuration";
constexpr std::string_view kResultFormat = "noveltea.benchmark.result";

Json configuration(const Options& options)
{
    return {{"format", kConfigFormat},
            {"version", 1},
            {"scenario", options.scenario},
            {"scenario_version", 1},
            {"parameters", Json::object()},
            {"clock_policy", "realtime"},
            {"settings",
             {{"width", options.width},
              {"height", options.height},
              {"warmup_seconds", options.warmup_seconds},
              {"measurement_seconds", options.duration_seconds},
              {"measurement_frames", options.measurement_frames},
              {"repeats", options.repeats},
              {"ready_timeout_seconds", options.ready_timeout_seconds},
              {"profile", "clean"},
              {"no_ui", options.no_ui},
              {"raw_samples", options.raw_samples},
              {"vsync", options.vsync},
              {"output", options.output_path}}}};
}

Json distribution(const Distribution& value)
{
    if (value.count == 0)
        return nullptr;
    return {{"samples", value.count}, {"mean_ms", value.mean_ms},
            {"min_ms", value.min_ms}, {"max_ms", value.max_ms},
            {"p50_ms", value.p50_ms}, {"p95_ms", value.p95_ms},
            {"p99_ms", value.p99_ms}, {"standard_deviation_ms", value.standard_deviation_ms}};
}

const char* phase_name(Phase value)
{
    switch (value) {
    case Phase::Preparation:
        return "preparation";
    case Phase::Ready:
        return "ready";
    case Phase::Warmup:
        return "warmup";
    case Phase::Measurement:
        return "measurement";
    case Phase::Completion:
        return "completion";
    case Phase::Results:
        return "results";
    case Phase::Cleanup:
        return "cleanup";
    }
    return "unknown";
}

bool has_fields(const Json& value, std::initializer_list<const char*> keys)
{
    if (!value.is_object() || value.size() != keys.size())
        return false;
    for (const char* key : keys) {
        if (!value.contains(key))
            return false;
    }
    return true;
}

bool numeric(const Json& value, const char* key)
{
    return value[key].is_number() && std::isfinite(value[key].get<double>());
}

bool unsigned_integer(const Json& value, const char* key)
{
    return value[key].is_number_integer() &&
           (value[key].is_number_unsigned() || value[key].get<int64_t>() >= 0);
}
} // namespace

std::string encode_configuration(const Options& options) { return configuration(options).dump(2); }

bool decode_configuration(std::string_view source, Options& options, std::string& reason)
{
    const Json root = Json::parse(source.begin(), source.end(), nullptr, false);
    if (root.is_discarded() ||
        !has_fields(root, {"format", "version", "scenario", "scenario_version", "parameters",
                           "clock_policy", "settings"}) ||
        !root["format"].is_string() || root["format"] != kConfigFormat ||
        !root["version"].is_number_integer() || root["version"] != 1 ||
        !root["scenario"].is_string() || root["scenario"].get<std::string>().empty() ||
        !root["scenario_version"].is_number_integer() || root["scenario_version"] != 1 ||
        !root["parameters"].is_object() || !root["parameters"].empty() ||
        !root["clock_policy"].is_string() || root["clock_policy"] != "realtime") {
        reason = "invalid or unsupported benchmark configuration schema";
        return false;
    }
    const auto& settings = root["settings"];
    if (!has_fields(settings, {"width", "height", "warmup_seconds", "measurement_seconds",
                               "measurement_frames", "repeats", "ready_timeout_seconds", "profile",
                               "no_ui", "raw_samples", "vsync", "output"}) ||
        !unsigned_integer(settings, "width") || !unsigned_integer(settings, "height") ||
        !numeric(settings, "warmup_seconds") || !numeric(settings, "measurement_seconds") ||
        !unsigned_integer(settings, "measurement_frames") ||
        !unsigned_integer(settings, "repeats") || !numeric(settings, "ready_timeout_seconds") ||
        !settings["profile"].is_string() || settings["profile"] != "clean" ||
        !settings["no_ui"].is_boolean() || !settings["raw_samples"].is_boolean() ||
        !settings["vsync"].is_boolean() || !settings["output"].is_string()) {
        reason = "invalid benchmark configuration settings";
        return false;
    }
    const uint64_t width = settings["width"].get<uint64_t>();
    const uint64_t height = settings["height"].get<uint64_t>();
    const uint64_t repeats = settings["repeats"].get<uint64_t>();
    if (width > 8192 || height > 8192 || repeats > 20) {
        reason = "benchmark configuration exceeds supported limits";
        return false;
    }
    Options next;
    next.scenario = root["scenario"].get<std::string>();
    next.width = static_cast<int>(width);
    next.height = static_cast<int>(height);
    next.warmup_seconds = settings["warmup_seconds"].get<double>();
    next.duration_seconds = settings["measurement_seconds"].get<double>();
    next.measurement_frames = settings["measurement_frames"].get<uint64_t>();
    next.repeats = static_cast<uint32_t>(repeats);
    next.ready_timeout_seconds = settings["ready_timeout_seconds"].get<double>();
    next.raw_samples = settings["raw_samples"].get<bool>();
    next.no_ui = settings["no_ui"].get<bool>();
    next.vsync = settings["vsync"].get<bool>();
    next.output_path = settings["output"].get<std::string>();
    if (!validate_run_options(next, reason))
        return false;
    options = std::move(next);
    reason.clear();
    return true;
}

std::string encode_result(const Options& options, const Environment& environment,
                          const SuiteResult& result)
{
    Json scenarios = Json::array();
    for (const auto& scenario : result.scenarios) {
        Json trials = Json::array();
        for (const auto& trial : scenario.trials) {
            Json phases = Json::array();
            for (const auto phase : trial.phases)
                phases.push_back(phase_name(phase));
            Json raw = nullptr;
            if (options.raw_samples && trial.outcome == "complete") {
                raw = Json::array();
                for (const auto& sample : trial.raw_samples)
                    raw.push_back({{"wall_ms", sample.wall_seconds * 1000.0},
                                   {"cpu_operation_ms", sample.operation_seconds * 1000.0}});
            }
            trials.push_back(
                {{"outcome", trial.outcome},
                 {"reason", trial.reason.empty() ? Json(nullptr) : Json(trial.reason)},
                 {"phases", std::move(phases)},
                 {"warmup_frames", trial.warmup_frames},
                 {"measured_frames", trial.measured_frames},
                 {"measured_wall_seconds",
                  trial.measured_frames > 0 ? Json(trial.measured_wall_seconds) : Json(nullptr)},
                 {"frame_loop_cadence_hz",
                  trial.outcome == "complete" && trial.measured_wall_seconds > 0.0
                      ? Json(static_cast<double>(trial.measured_frames) /
                             trial.measured_wall_seconds)
                      : Json(nullptr)},
                 {"frame_wall_ms", distribution(trial.wall_frame)},
                 {"cpu_operation_ms", distribution(trial.cpu_operation)},
                 {"raw_samples", std::move(raw)}});
        }
        scenarios.push_back(
            {{"id", scenario.scenario},
             {"description", scenario.description},
             {"outcome", scenario.outcome},
             {"trials", std::move(trials)},
             {"aggregate",
              {{"measured_frames", scenario.measured_frames},
               {"measured_wall_seconds", scenario.measured_wall_seconds},
               {"frame_loop_cadence_hz", scenario.measured_wall_seconds > 0.0
                                             ? Json(static_cast<double>(scenario.measured_frames) /
                                                    scenario.measured_wall_seconds)
                                             : Json(nullptr)},
               {"frame_wall_ms", distribution(scenario.wall_frame)},
               {"cpu_operation_ms", distribution(scenario.cpu_operation)}}}});
    }
    const Json graphics = {
        {"platform", environment.platform},
        {"video_driver",
         environment.video_driver.empty() ? Json(nullptr) : Json(environment.video_driver)},
        {"renderer", environment.renderer.empty() ? Json(nullptr) : Json(environment.renderer)},
        {"gpu_vendor_id",
         environment.gpu_vendor_id < 0 ? Json(nullptr) : Json(environment.gpu_vendor_id)},
        {"gpu_device_id",
         environment.gpu_device_id < 0 ? Json(nullptr) : Json(environment.gpu_device_id)},
        {"gpu_driver_version", nullptr},
        {"width_pixels",
         environment.width_pixels > 0 ? Json(environment.width_pixels) : Json(nullptr)},
        {"height_pixels",
         environment.height_pixels > 0 ? Json(environment.height_pixels) : Json(nullptr)}};
    const Json report = {
        {"format", kResultFormat},
        {"version", 1},
        {"configuration", configuration(options)},
        {"build",
         {{"revision", NOVELTEA_BENCHMARK_REVISION},
          {"type", NOVELTEA_BENCHMARK_BUILD_TYPE},
          {"compiler", NOVELTEA_BENCHMARK_COMPILER},
          {"tracked_source_dirty", NOVELTEA_BENCHMARK_SOURCE_DIRTY},
          {"source_fingerprint_sha256", NOVELTEA_BENCHMARK_SOURCE_FINGERPRINT},
          {"devtools", false}}},
        {"graphics", graphics},
        {"timing",
         {{"clock", "steady_clock"},
          {"profile", "clean"},
          {"frame_wall", "end-to-end CPU frame-loop interval; not confirmed presentation"},
          {"cpu_operation", "CPU wall duration of scenario frame operation"},
          {"gpu_execution_ms", nullptr},
          {"gpu_timing_status", "unavailable"},
          {"presented_frame_count", nullptr},
          {"bgfx_wait_submit_ms", nullptr},
          {"bgfx_wait_render_ms", nullptr}}},
        {"outcome", result.outcome},
        {"scenarios", std::move(scenarios)}};
    return report.dump(2);
}

} // namespace noveltea::benchmark
