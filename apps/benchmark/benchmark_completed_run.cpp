#include "benchmark_completed_run.hpp"

#include <iomanip>
#include <sstream>

namespace noveltea::benchmark {

std::string completed_run_identity(const CompletedRun& run)
{
    const auto& settings = run.configuration;
    std::ostringstream label;
    if (settings.profile == "clean")
        label << "Clean (authoritative)";
    else if (settings.profile == "diagnostic")
        label << "Diagnostic (non-authoritative)";
    else
        label << "Unknown profile (" << settings.profile << ")";
    if (settings.quick_suite || run.result.scenarios.size() > 1)
        label << " | Quick Suite (" << run.result.scenarios.size() << " scenarios)";
    else
        label << " | " << settings.scenario;
    if (settings.scenario == "raw-bgfx-geometry") {
        label << " | rectangles " << settings.rect_count << " at scale " << std::fixed
              << std::setprecision(2) << settings.rect_scale;
    }
    label << " | requested " << settings.width << "x" << settings.height;
    label << " | VSync " << (settings.vsync ? "on" : "off");
    return label.str();
}

} // namespace noveltea::benchmark
