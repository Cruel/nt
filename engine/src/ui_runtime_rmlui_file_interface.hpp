#pragma once

#include "noveltea/assets/asset_manager.hpp"

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core/FileInterface.h>
#endif

#include <cstdio>
#include <string>

namespace noveltea {

#if defined(NOVELTEA_HAS_RMLUI)

class AssetRmlFileInterface : public Rml::FileInterface
{
public:
    explicit AssetRmlFileInterface(const assets::AssetManager& assets)
        : m_assets(assets)
    {
    }

    Rml::FileHandle Open(const Rml::String& path) override
    {
        const std::string logical = normalize(path);
        auto opened = m_assets.open(logical);
        if (!opened) {
            std::fprintf(stderr, "[rmlui] failed to open %s as %s: %s\n",
                path.c_str(), logical.c_str(), opened.error.c_str());
            return 0;
        }
        return reinterpret_cast<Rml::FileHandle>(opened.value->release());
    }

    void Close(Rml::FileHandle file) override
    {
        if (file) {
            delete reinterpret_cast<assets::AssetReader*>(file);
        }
    }

    size_t Read(void* buffer, size_t size, Rml::FileHandle file) override
    {
        return reinterpret_cast<assets::AssetReader*>(file)->read(buffer, size);
    }

    bool Seek(Rml::FileHandle file, long offset, int origin) override
    {
        return reinterpret_cast<assets::AssetReader*>(file)->seek(offset, origin);
    }

    size_t Tell(Rml::FileHandle file) override
    {
        return static_cast<size_t>(reinterpret_cast<assets::AssetReader*>(file)->tell().value_or(0));
    }

private:
    std::string normalize(const Rml::String& path) const
    {
        const std::string value(path.c_str());
        if (value.find(":/") != std::string::npos) {
            return value;
        }
        if (m_assets.exists("project:/rmlui/" + value)) {
            return "project:/rmlui/" + value;
        }
        return "project:/" + value;
    }

    const assets::AssetManager& m_assets;
};

#endif

} // namespace noveltea
