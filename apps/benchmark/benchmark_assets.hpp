#pragma once

#include <SDL3/SDL_filesystem.h>

#include <filesystem>

namespace noveltea::benchmark {

// Resolve assets next to the executable, independent of the launch directory
// or the source checkout. These are staged from NovelTea's common build assets.
[[nodiscard]] inline std::filesystem::path benchmark_asset_path(const char* relative)
{
    const char* base = SDL_GetBasePath();
    return std::filesystem::path(base ? base : "") / relative;
}

} // namespace noveltea::benchmark
