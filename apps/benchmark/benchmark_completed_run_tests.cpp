#include "benchmark_completed_run.hpp"

#include <cstdio>
#include <string>

namespace {
bool check(bool condition, const char* message)
{
    if (!condition)
        std::fprintf(stderr, "completed run identity: %s\n", message);
    return condition;
}
} // namespace

int main()
{
    using namespace noveltea::benchmark;
    Options editable;
    editable.scenario = "raw-bgfx-geometry";
    editable.profile = "diagnostic";
    editable.rect_count = 64;
    editable.rect_scale = 0.5;
    editable.width = 900;
    editable.height = 700;
    editable.vsync = true;
    SuiteResult result;
    result.outcome = "complete";
    result.scenarios.push_back(ScenarioResult{});
    result.scenarios.front().scenario = editable.scenario;
    CompletedRun completed{editable, result, "diagnostic.json"};

    // This is the actual label consumed by ImGui Results, not a string
    // reconstructed from the dashboard's current editable run settings.
    const auto before = completed_run_identity(completed);
    if (!check(before.find("Diagnostic (non-authoritative)") != std::string::npos &&
                   before.find("raw-bgfx-geometry") != std::string::npos &&
                   before.find("rectangles 64 at scale 0.50") != std::string::npos &&
                   before.find("requested 900x700") != std::string::npos &&
                   before.find("VSync on") != std::string::npos,
               "identity shows completed diagnostic profile, geometry and settings"))
        return 1;

    editable.profile = "clean";
    editable.scenario = "raw-bgfx-empty";
    editable.rect_count = 3;
    editable.rect_scale = 1.0;
    editable.width = 1280;
    editable.vsync = false;
    if (!check(completed_run_identity(completed) == before &&
                   completed.configuration.profile == "diagnostic" &&
                   completed.report_path == "diagnostic.json" &&
                   completed.result.scenarios.front().scenario == "raw-bgfx-geometry",
               "changing editable options cannot relabel or replace the previous results"))
        return 1;

    completed = CompletedRun{editable, result, "clean.json"};
    const auto clean = completed_run_identity(completed);
    if (!check(clean.find("Clean (authoritative)") != std::string::npos &&
                   clean.find("raw-bgfx-empty") != std::string::npos &&
                   clean.find("rectangles") == std::string::npos &&
                   clean.find("VSync off") != std::string::npos &&
                   clean.find("Diagnostic") == std::string::npos,
               "next run replaces profile and workload identity"))
        return 1;
    editable.quick_suite = true;
    result.scenarios.push_back(ScenarioResult{});
    result.scenarios.back().scenario = "engine-empty";
    completed = CompletedRun{editable, result, "quick-suite.json"};
    const auto quick = completed_run_identity(completed);
    if (!check(quick.find("Quick Suite (2 scenarios)") != std::string::npos &&
                   quick.find("raw-bgfx-empty") == std::string::npos,
               "the Results header identifies the completed suite, not the input selection"))
        return 1;
    return 0;
}
