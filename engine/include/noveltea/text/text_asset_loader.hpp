#pragma once

#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/text/font.hpp"

#include <string>
#include <vector>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::text {

class TextEngine;

class TextFontAssetLoader final : public assets::FontAssetLoader {
public:
    TextFontAssetLoader(const assets::AssetManager& assets, TextEngine& text_engine);

    void set_default_alias(std::string alias);
    [[nodiscard]] assets::AssetLoadResult<assets::FontAsset>
    load_font(const assets::FontAssetRequest& request) override;

private:
    void ensure_configured_families();
    [[nodiscard]] FontFamilyHandle ensure_system_family();

    const assets::AssetManager& m_assets;
    TextEngine& m_text_engine;
    FontFamilyHandle m_system_family{};
    std::vector<std::string> m_registered_family_aliases;
    std::string m_default_alias = std::string(kSystemFontAlias);
};

} // namespace noveltea::text
