#include <noveltea/text/text_asset_loader.hpp>

#include "text/text_engine.hpp"

#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_source.hpp>

#include <algorithm>

namespace noveltea::text {
namespace {

template<class T> assets::AssetLoadResult<T> fail(std::string error)
{
    return {std::nullopt, std::move(error)};
}

FontFamilyDesc to_font_family_desc(const assets::FontFamilyAssetDesc& desc)
{
    FontFamilyDesc family;
    family.alias = desc.alias;
    family.regular = desc.regular;
    family.bold = desc.bold;
    family.italic = desc.italic;
    family.bold_italic = desc.bold_italic;
    family.synthetic_styles = desc.synthetic_styles;
    return family;
}

} // namespace

TextFontAssetLoader::TextFontAssetLoader(const assets::AssetManager& assets,
                                         TextEngine& text_engine)
    : m_assets(assets), m_text_engine(text_engine)
{
}

void TextFontAssetLoader::set_default_alias(std::string alias)
{
    m_default_alias = alias.empty() ? std::string(kSystemFontAlias) : std::move(alias);
}

void TextFontAssetLoader::ensure_configured_families()
{
    const auto& config = m_assets.font_config();
    if (!config.default_alias.empty()) {
        m_default_alias = config.default_alias;
    }

    for (const auto& family_desc : config.families) {
        if (family_desc.alias.empty() || family_desc.regular.asset_path.empty()) {
            continue;
        }
        if (std::find(m_registered_family_aliases.begin(), m_registered_family_aliases.end(),
                      family_desc.alias) != m_registered_family_aliases.end()) {
            continue;
        }
        if (auto handle = m_text_engine.register_font_family(to_font_family_desc(family_desc))) {
            m_registered_family_aliases.push_back(family_desc.alias);
            if (family_desc.alias == m_default_alias) {
                m_text_engine.set_default_font_family(handle);
            }
        }
    }
}

FontFamilyHandle TextFontAssetLoader::ensure_system_family()
{
    if (m_system_family) {
        return m_system_family;
    }

    std::string font_asset;
    if (m_assets.exists(kSystemFontProjectAsset)) {
        font_asset = std::string(kSystemFontProjectAsset);
    } else if (m_assets.exists(kSystemFontAsset)) {
        font_asset = std::string(kSystemFontAsset);
    } else {
        return {};
    }

    FontFamilyDesc family;
    family.alias = std::string(kSystemFontAlias);
    family.regular = FontDesc{.asset_path = font_asset};
    family.synthetic_styles = true;
    m_system_family = m_text_engine.register_font_family(family);
    return m_system_family;
}

assets::AssetLoadResult<assets::FontAsset>
TextFontAssetLoader::load_font(const assets::FontAssetRequest& request)
{
    ensure_configured_families();
    const auto system_family = ensure_system_family();
    if (!system_family) {
        return fail<assets::FontAsset>(
            "failed to load system font family: no project/system font asset");
    }

    if (m_text_engine.default_font_family() != system_family &&
        m_default_alias == kSystemFontAlias) {
        m_text_engine.set_default_font_family(system_family);
    }

    std::string alias = request.alias.empty() ? m_default_alias : request.alias;
    if (alias == std::string(kSystemFontDisplayName) || alias == "runtime-ui") {
        alias = std::string(kSystemFontAlias);
    }

    auto resolved = m_text_engine.resolve_font(alias, request.style);
    if (!resolved.face && alias != kSystemFontAlias) {
        resolved = m_text_engine.resolve_font(std::string(kSystemFontAlias), request.style);
    }
    if (!resolved.face) {
        return fail<assets::FontAsset>("failed to resolve font alias '" + alias + "'");
    }

    const auto family =
        alias == kSystemFontAlias ? system_family : m_text_engine.default_font_family();
    return {assets::FontAsset{.face = resolved.face,
                              .family = family,
                              .resolved_alias = resolved.alias,
                              .requested_style = resolved.requested_style,
                              .synthetic_style = resolved.synthetic_style},
            {}};
}

} // namespace noveltea::text
