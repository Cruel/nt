#include "noveltea/assets/assets.hpp"

#include <SDL3/SDL_log.h>

#include <fstream>

namespace noveltea {

AssetPath::AssetPath(std::filesystem::path root)
    : m_root(std::move(root))
{
}

void AssetPath::set_root(std::filesystem::path root)
{
    m_root = std::move(root);
}

std::filesystem::path AssetPath::resolve(const std::filesystem::path& relative) const
{
    if (relative.is_absolute() || m_root.empty()) {
        return relative;
    }
    return m_root / relative;
}

std::optional<std::vector<std::uint8_t>> read_binary_file(const std::filesystem::path& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in) {
        SDL_LogError(SDL_LOG_CATEGORY_APPLICATION, "[assets] failed to open %s", path.string().c_str());
        return std::nullopt;
    }

    in.seekg(0, std::ios::end);
    const auto size = in.tellg();
    in.seekg(0, std::ios::beg);
    if (size < 0) {
        return std::vector<std::uint8_t>{};
    }

    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
    if (!bytes.empty()) {
        in.read(reinterpret_cast<char*>(bytes.data()), size);
    }
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
