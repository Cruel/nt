#pragma once

#include <SDL3/SDL_filesystem.h>
#include <SDL3/SDL_iostream.h>
#include <bgfx/bgfx.h>

#include <cstdint>
#include <filesystem>

namespace noveltea::benchmark {

// Resolve assets next to the executable, independent of the launch directory
// or the source checkout. These are staged from NovelTea's common build assets.
[[nodiscard]] inline std::filesystem::path benchmark_asset_path(const char* relative)
{
#if defined(__ANDROID__)
    // SDL_IOFromFile resolves these relative paths through the APK asset manager.
    return relative;
#else
    const char* base = SDL_GetBasePath();
    return std::filesystem::path(base ? base : "") / "assets" / relative;
#endif
}

[[nodiscard]] inline bgfx::ShaderHandle load_benchmark_shader(const char* relative)
{
    const auto path = benchmark_asset_path(relative).string();
    size_t size = 0;
    void* data = SDL_LoadFile(path.c_str(), &size);
    if (!data || size == 0 || size > UINT32_MAX) {
        SDL_free(data);
        return BGFX_INVALID_HANDLE;
    }
    auto handle = bgfx::createShader(bgfx::copy(data, static_cast<uint32_t>(size)));
    SDL_free(data);
    return handle;
}

} // namespace noveltea::benchmark
