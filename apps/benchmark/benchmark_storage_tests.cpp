#include "benchmark_storage.hpp"

#include <SDL3/SDL.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

int main()
{
    namespace fs = std::filesystem;
    using namespace noveltea::benchmark;
    const auto root = fs::temp_directory_path() /
                      ("noveltea-benchmark-preferences-" +
                       std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directories(root);
    if (setenv("XDG_DATA_HOME", root.string().c_str(), 1) != 0) {
        std::fprintf(stderr, "storage: unable to isolate XDG_DATA_HOME\n");
        return 1;
    }
    DashboardPreferences original;
    original.last_configuration.scenario = "raw-bgfx-geometry";
    original.last_configuration.rect_count = 29;
    original.last_configuration.no_ui = false;
    original.presets.push_back({"baseline", original.last_configuration});
    std::string error;
    DashboardPreferences missing = original;
    if (!load_dashboard_preferences(missing, error) || !error.empty() ||
        missing.last_configuration.rect_count != 29) {
        std::fprintf(stderr, "storage: absent settings should preserve defaults: %s\n",
                     error.c_str());
        return 1;
    }
    if (!save_dashboard_preferences(original, error)) {
        std::fprintf(stderr, "storage: save failed: %s\n", error.c_str());
        return 1;
    }
    DashboardPreferences loaded;
    if (!load_dashboard_preferences(loaded, error) || loaded.last_configuration.rect_count != 29 ||
        loaded.presets.size() != 1 || loaded.presets[0].name != "baseline") {
        std::fprintf(stderr, "storage: app-local roundtrip failed: %s\n", error.c_str());
        return 1;
    }
    char* pref_dir = SDL_GetPrefPath("NovelTea", "Benchmark");
    if (!pref_dir)
        return 1;
    const fs::path file = fs::path(pref_dir) / "dashboard-v1.json";
    SDL_free(pref_dir);
    if (file.string().find(root.string()) != 0) {
        std::fprintf(stderr, "storage: preferences escaped app-local test directory\n");
        return 1;
    }
    {
        std::ofstream corrupted(file, std::ios::trunc);
        corrupted << R"({"format":"noveltea.benchmark.dashboard-state","version":99})";
    }
    error.clear();
    if (load_dashboard_preferences(loaded, error) || error.empty() ||
        loaded.last_configuration.rect_count != 29 || loaded.presets.size() != 1) {
        std::fprintf(stderr, "storage: invalid settings should preserve previously loaded state\n");
        return 1;
    }
    // A stale invalid-state or invalid-preset error must not latch persistence off.
    original.last_configuration.rect_count = 37;
    if (!save_dashboard_preferences(original, error) || !error.empty() ||
        !load_dashboard_preferences(loaded, error) || loaded.last_configuration.rect_count != 37) {
        std::fprintf(stderr, "storage: failed to recover save after invalid preferences: %s\n",
                     error.c_str());
        return 1;
    }
    error = "empty named preset";
    original.last_configuration.rect_count = 41;
    if (!save_dashboard_preferences(original, error) || !error.empty() ||
        !load_dashboard_preferences(loaded, error) || loaded.last_configuration.rect_count != 41) {
        std::fprintf(stderr, "storage: stale dashboard error disabled subsequent saves\n");
        return 1;
    }
    fs::remove(file);
    fs::create_symlink(file.filename(), file);
    error.clear();
    if (load_dashboard_preferences(loaded, error) || error.empty() ||
        loaded.last_configuration.rect_count != 41 || loaded.presets.size() != 1) {
        std::fprintf(stderr, "storage: filesystem inspection failure must preserve loaded state\n");
        return 1;
    }
    fs::remove(file);
    if (!save_dashboard_preferences(original, error) || !error.empty() ||
        !load_dashboard_preferences(loaded, error) || loaded.last_configuration.rect_count != 41) {
        std::fprintf(stderr, "storage: failed to recover from filesystem error: %s\n",
                     error.c_str());
        return 1;
    }
    fs::remove_all(root);
    std::puts("benchmark native app-local storage passed");
    return 0;
}
