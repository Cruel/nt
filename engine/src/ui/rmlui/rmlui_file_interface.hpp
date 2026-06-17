#pragma once

#include "noveltea/assets/asset_manager.hpp"

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core/FileInterface.h>
#endif

#include <string>

namespace noveltea::ui::rmlui {

std::string resolve_asset_path(const assets::AssetManager& assets, const std::string& path);

#if defined(NOVELTEA_HAS_RMLUI)

class AssetRmlFileInterface : public Rml::FileInterface {
public:
    explicit AssetRmlFileInterface(const assets::AssetManager& assets);

    Rml::FileHandle Open(const Rml::String& path) override;
    void Close(Rml::FileHandle file) override;
    size_t Read(void* buffer, size_t size, Rml::FileHandle file) override;
    bool Seek(Rml::FileHandle file, long offset, int origin) override;
    size_t Tell(Rml::FileHandle file) override;

private:
    const assets::AssetManager& m_assets;
};

#endif

} // namespace noveltea::ui::rmlui
