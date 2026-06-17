#include "ui/rmlui/rmlui_file_interface.hpp"

#include <cstdio>

namespace noveltea::ui::rmlui {

std::string resolve_asset_path(const assets::AssetManager& assets, const std::string& path)
{
    const std::size_t encoded_scheme = path.find("|/");
    if (encoded_scheme != std::string::npos) {
        return path.substr(0, encoded_scheme) + ":/" + path.substr(encoded_scheme + 2);
    }
    if (path.find(":/") != std::string::npos) {
        return path;
    }
    const std::string rmlui_path = "project:/rmlui/" + path;
    if (assets.exists(rmlui_path)) {
        return rmlui_path;
    }
    return "project:/" + path;
}

#if defined(NOVELTEA_HAS_RMLUI)

AssetRmlFileInterface::AssetRmlFileInterface(const assets::AssetManager& assets)
    : m_assets(assets)
{
}

Rml::FileHandle AssetRmlFileInterface::Open(const Rml::String& path)
{
    const std::string logical = resolve_asset_path(m_assets, path.c_str());
    auto opened = m_assets.open(logical);
    if (!opened) {
        std::fprintf(stderr, "[rmlui] failed to open %s as %s: %s\n",
            path.c_str(), logical.c_str(), opened.error.c_str());
        return 0;
    }
    return reinterpret_cast<Rml::FileHandle>(opened.value->release());
}

void AssetRmlFileInterface::Close(Rml::FileHandle file)
{
    delete reinterpret_cast<assets::AssetReader*>(file);
}

size_t AssetRmlFileInterface::Read(void* buffer, size_t size, Rml::FileHandle file)
{
    return reinterpret_cast<assets::AssetReader*>(file)->read(buffer, size);
}

bool AssetRmlFileInterface::Seek(Rml::FileHandle file, long offset, int origin)
{
    return reinterpret_cast<assets::AssetReader*>(file)->seek(offset, origin);
}

size_t AssetRmlFileInterface::Tell(Rml::FileHandle file)
{
    return static_cast<size_t>(reinterpret_cast<assets::AssetReader*>(file)->tell().value_or(0));
}

#endif

} // namespace noveltea::ui::rmlui
