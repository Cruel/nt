#pragma once

#include "benchmark_comparison.hpp"

#include <string>

namespace noveltea::benchmark {

// Settings are separate from results. Native platforms use SDL's app-local
// preference directory; Web uses origin-scoped browser localStorage.
[[nodiscard]] bool load_dashboard_preferences(DashboardPreferences& state, std::string& error);
[[nodiscard]] bool save_dashboard_preferences(const DashboardPreferences& state,
                                              std::string& error);

} // namespace noveltea::benchmark
