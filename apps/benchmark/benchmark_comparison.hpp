#pragma once

#include "benchmark_options.hpp"

#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::benchmark {

// An imported report owns its parsed JSON. A failed import never replaces the
// prior, successfully validated report.
struct ImportedReport {
    nlohmann::json document;
    std::string source;
};

struct ComparisonMetric {
    std::string scenario;
    std::string name;
    double baseline = 0.0;
    double candidate = 0.0;
    double delta = 0.0;
    std::optional<double> percent;
    double baseline_stddev = 0.0;
    double candidate_stddev = 0.0;
    uint64_t baseline_samples = 0;
    uint64_t candidate_samples = 0;
};

struct ReportComparison {
    bool controlled = true;
    std::vector<std::string> warnings;
    std::vector<ComparisonMetric> metrics;
};

[[nodiscard]] bool decode_imported_report(std::string_view source, std::string name,
                                          ImportedReport& report, std::string& error);
[[nodiscard]] ReportComparison compare_reports(const ImportedReport& baseline,
                                               const ImportedReport& candidate);

struct NamedBenchmarkPreset {
    std::string name;
    Options configuration;
};

struct DashboardPreferences {
    Options last_configuration;
    std::vector<NamedBenchmarkPreset> presets;
};

[[nodiscard]] std::string encode_dashboard_preferences(const DashboardPreferences& state);
[[nodiscard]] bool decode_dashboard_preferences(std::string_view json,
                                                DashboardPreferences& preferences,
                                                std::string& error);

} // namespace noveltea::benchmark
