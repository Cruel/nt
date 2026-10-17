#include "benchmark_storage.hpp"

#include <SDL3/SDL.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#include <cstdlib>
#else
#include <filesystem>
#include <fstream>
#include <iterator>
#endif

namespace noveltea::benchmark {
namespace {
#if !defined(__EMSCRIPTEN__)
std::filesystem::path preferences_file(std::string& error)
{
    char* directory = SDL_GetPrefPath("NovelTea", "Benchmark");
    if (!directory) {
        error = std::string("SDL_GetPrefPath: ") + SDL_GetError();
        return {};
    }
    const std::filesystem::path path = std::filesystem::path(directory) / "dashboard-v1.json";
    SDL_free(directory);
    return path;
}
#endif
} // namespace

bool load_dashboard_preferences(DashboardPreferences& state, std::string& error)
{
    std::string text;
#if defined(__EMSCRIPTEN__)
    auto* raw = reinterpret_cast<char*>(EM_ASM_PTR({
        try {
            const value = localStorage.getItem('noveltea.benchmark.dashboard-state.v1');
            return value == null ? 0 : stringToNewUTF8(value);
        } catch (e) {
            return 0;
        }
    }));
    if (!raw)
        return true; // No saved preferences, or browser storage is inaccessible.
    text = raw;
    std::free(raw);
#else
    const auto path = preferences_file(error);
    if (!error.empty())
        return false;
    if (!std::filesystem::exists(path))
        return true;
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        error = "unable to read dashboard settings from " + path.string();
        return false;
    }
    text.assign(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
    if (!stream.eof() && stream.fail()) {
        error = "unable to finish reading dashboard settings";
        return false;
    }
#endif
    if (!decode_dashboard_preferences(text, state, error)) {
        error = "saved dashboard settings: " + error;
        return false;
    }
    return true;
}

bool save_dashboard_preferences(const DashboardPreferences& state, std::string& error)
{
    const std::string text = encode_dashboard_preferences(state);
#if defined(__EMSCRIPTEN__)
    const int saved = EM_ASM_INT(
        {
            try {
                localStorage.setItem('noveltea.benchmark.dashboard-state.v1', UTF8ToString($0));
                return 1;
            } catch (e) {
                return 0;
            }
        },
        text.c_str());
    if (!saved) {
        error = "browser localStorage is unavailable or full";
        return false;
    }
#else
    const auto path = preferences_file(error);
    if (!error.empty())
        return false;
    const auto temp = path.string() + ".tmp";
    {
        std::ofstream stream(temp, std::ios::trunc | std::ios::binary);
        stream << text << '\n';
        stream.close();
        if (!stream) {
            error = "unable to write dashboard settings to " + temp;
            return false;
        }
    }
    std::error_code code;
    std::filesystem::rename(temp, path, code);
    if (code) {
        error = "unable to replace dashboard settings: " + code.message();
        return false;
    }
#endif
    error.clear();
    return true;
}

} // namespace noveltea::benchmark
