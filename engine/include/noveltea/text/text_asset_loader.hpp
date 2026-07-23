#pragma once

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/text/font.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::assets {
class AssetManager;
}

namespace noveltea::text {

class TextEngine;
struct FontSourceResidencyState;

struct PreparedFontSource {
    FontFamilyDesc family;
    assets::AssetBytes regular;
    std::optional<assets::AssetBytes> bold;
    std::optional<assets::AssetBytes> italic;
    std::optional<assets::AssetBytes> bold_italic;

    [[nodiscard]] std::uint64_t total_source_bytes() const noexcept;
};

class FontSourcePreparationOwner {
public:
    virtual ~FontSourcePreparationOwner() = default;
    [[nodiscard]] virtual core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
    finalize_font_source_on_owner(assets::FontAssetRequest request,
                                  PreparedFontSource prepared) noexcept = 0;
};

class FontSourcePreparationTask final : public assets::AssetPreparationTask<assets::FontAsset> {
public:
    FontSourcePreparationTask(const assets::AssetManager& assets, FontSourcePreparationOwner& owner,
                              assets::FontAssetRequest request, FontFamilyDesc family);
    ~FontSourcePreparationTask() override;

    [[nodiscard]] assets::ResidencyCost estimated_cost_on_owner() const noexcept override;
    [[nodiscard]] jobs::JobStepOutcome step(jobs::JobContext& context) noexcept override;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
    finalize_on_owner() noexcept override;

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

class TextFontAssetLoader final : public assets::FontAssetLoader,
                                  private FontSourcePreparationOwner {
public:
    TextFontAssetLoader(const assets::AssetManager& assets, TextEngine& text_engine);
    ~TextFontAssetLoader() override;

    void set_default_alias(std::string alias);
    [[nodiscard]] assets::AssetLoadResult<assets::FontAsset>
    load_font(const assets::FontAssetRequest& request) override;
    [[nodiscard]] std::unique_ptr<assets::AssetPreparationTask<assets::FontAsset>>
    create_font_preparation_task(const assets::FontAssetRequest& request) override;

private:
    void ensure_configured_families();
    [[nodiscard]] FontFamilyHandle ensure_system_family();
    [[nodiscard]] std::optional<FontFamilyDesc>
    preparation_family_for_request(const assets::FontAssetRequest& request) const;
    [[nodiscard]] core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
    finalize_font_source_on_owner(assets::FontAssetRequest request,
                                  PreparedFontSource prepared) noexcept override;

    const assets::AssetManager& m_assets;
    TextEngine& m_text_engine;
    FontFamilyHandle m_system_family{};
    std::vector<std::string> m_registered_family_aliases;
    std::string m_default_alias = std::string(kSystemFontAlias);
    std::shared_ptr<FontSourceResidencyState> m_residency_state;
};

} // namespace noveltea::text
