#include "noveltea/assets/assets.hpp"

#include <SDL3/SDL_iostream.h>
#include <SDL3/SDL_log.h>

#include <cstdio>

namespace noveltea {

AssetPath::AssetPath(std::filesystem::path root) : m_root(std::move(root)) {}

void AssetPath::set_root(std::filesystem::path root) { m_root = std::move(root); }

std::filesystem::path AssetPath::resolve(const std::filesystem::path& relative) const
{
    if (relative.is_absolute() || m_root.empty()) {
        return relative;
    }
    return m_root / relative;
}

std::filesystem::path default_asset_root()
{
#if defined(NOVELTEA_PLATFORM_DESKTOP)
    return "apps/sandbox/assets";
#else
    return "assets";
#endif
}

std::filesystem::path resolve_asset_path(const std::filesystem::path& relative)
{
    return AssetPath(default_asset_root()).resolve(relative);
}

std::optional<std::vector<std::uint8_t>> read_binary_file(const std::filesystem::path& path)
{
    SDL_IOStream* in = SDL_IOFromFile(path.string().c_str(), "rb");
    if (!in) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] failed to open %s",
                     path.string().c_str());
        return std::nullopt;
    }

    const Sint64 size = SDL_SeekIO(in, 0, SDL_IO_SEEK_END);
    SDL_SeekIO(in, 0, SDL_IO_SEEK_SET);
    if (size < 0) {
        SDL_CloseIO(in);
        return std::vector<std::uint8_t>{};
    }

    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    if (!bytes.empty()) {
        const size_t read = SDL_ReadIO(in, bytes.data(), bytes.size());
        if (read != bytes.size()) {
            SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] incomplete read for %s",
                         path.string().c_str());
            SDL_CloseIO(in);
            return std::nullopt;
        }
    }
    SDL_CloseIO(in);
    return bytes;
}

std::optional<std::string> read_text_file(const std::filesystem::path& path)
{
    auto bytes = read_binary_file(path);
    if (!bytes) {
        return std::nullopt;
    }
    return std::string(bytes->begin(), bytes->end());
}

void log_info(const char* area, const char* message)
{
    SDL_LogInfo(SDL_LOG_CATEGORY_APPLICATION, "[%s] %s", area, message);
}

void log_error(const char* area, const char* message)
{
    SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[%s] %s", area, message);
}

} // namespace noveltea
