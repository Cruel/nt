#pragma once

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/audio/audio_types.hpp"
#include "noveltea/core/compiled_project.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "noveltea/text/font.hpp"

#include <cstdint>
#include <cmath>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::assets {

template<class T> class AssetPreparationTask;

inline constexpr uint16_t invalid_typed_asset_handle = std::numeric_limits<uint16_t>::max();

struct FontAssetRequest {
    std::string alias;
    std::optional<std::string> source_path;
    uint32_t style = TextFontRegular;
    std::string language = "und";
    float size = 0.0f;
};

struct FontAsset {
    FontHandle face{};
    FontFamilyHandle family{};
    std::string resolved_alias;
    uint32_t requested_style = TextFontRegular;
    uint32_t synthetic_style = TextFontRegular;
};

struct FontFamilyAssetDesc {
    std::string alias;
    FontDesc regular;
    std::optional<FontDesc> bold;
    std::optional<FontDesc> italic;
    std::optional<FontDesc> bold_italic;
    bool synthetic_styles = true;
};

struct FontAssetConfig {
    std::string default_alias = "sys";
    std::vector<FontFamilyAssetDesc> families;
};

struct TextureAssetRequest {
    std::string path;
    MaterialTextureSampler sampler = MaterialTextureSampler::ClampLinear;
    bool retain_alpha_coverage = false;
};

struct TextureAlphaCoverage {
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::uint32_t row_stride_bytes = 0;
    std::vector<std::uint8_t> occupancy_bits;
};

struct TextureAsset {
    uint16_t handle = invalid_typed_asset_handle;
    std::string path;
    uint16_t width = 0;
    uint16_t height = 0;
    MaterialTextureSampler sampler = MaterialTextureSampler::ClampLinear;
    uint8_t mip_count = 1;
    std::optional<TextureAlphaCoverage> alpha_coverage;
};

struct HotspotMaskRegionInput {
    core::HotspotId hotspot;
    core::compiled::NormalizedRect bounds;
    bool operator==(const HotspotMaskRegionInput&) const = default;
};

struct HotspotMaskAssetRequest {
    core::compiled::HotspotOwnerRef owner;
    std::uint16_t width = 0;
    std::uint16_t height = 0;
    std::vector<HotspotMaskRegionInput> regions;
    bool operator==(const HotspotMaskAssetRequest&) const = default;
};

struct HotspotMaskAsset {
    core::compiled::HotspotOwnerRef owner;
    std::uint16_t handle = invalid_typed_asset_handle;
    std::uint16_t width = 0;
    std::uint16_t height = 0;
};

[[nodiscard]] inline bool texture_alpha_coverage_contains(const TextureAlphaCoverage& coverage,
                                                          float u, float v) noexcept
{
    if (!std::isfinite(u) || !std::isfinite(v) || coverage.width == 0 || coverage.height == 0 ||
        coverage.row_stride_bytes != (static_cast<std::uint32_t>(coverage.width) + 7u) / 8u ||
        coverage.occupancy_bits.size() !=
            static_cast<std::size_t>(coverage.row_stride_bytes) * coverage.height) {
        return false;
    }
    const float clamped_u = std::min(1.0f, std::max(0.0f, u));
    const float clamped_v = std::min(1.0f, std::max(0.0f, v));
    const auto x = std::min<std::uint32_t>(
        coverage.width - 1u, static_cast<std::uint32_t>(std::floor(clamped_u * coverage.width)));
    const auto y = std::min<std::uint32_t>(
        coverage.height - 1u, static_cast<std::uint32_t>(std::floor(clamped_v * coverage.height)));
    const auto byte =
        coverage.occupancy_bits[static_cast<std::size_t>(y) * coverage.row_stride_bytes + x / 8u];
    return (byte & static_cast<std::uint8_t>(1u << (x & 7u))) != 0;
}

struct ShaderProgramAssetRequest {
    ShaderProgramResolution resolution;
};

struct ShaderProgramAsset {
    uint16_t handle = invalid_typed_asset_handle;
    ShaderProgramKey key;
};

struct MaterialAssetRequest {
    std::string id;
};

struct MaterialAsset {
    const MaterialDefinition* definition = nullptr;
    std::string id;
};

struct AudioAssetRequest {
    std::string path;
    AudioLoadMode mode = AudioLoadMode::Auto;
    AudioClipKind kind = AudioClipKind::Auto;
};

struct AudioAsset {
    AudioClipHandle clip;
    std::string path;
    AudioLoadMode mode = AudioLoadMode::Auto;
    AudioClipKind kind = AudioClipKind::Auto;
};

class FontAssetLoader {
public:
    virtual ~FontAssetLoader() = default;
    [[nodiscard]] virtual AssetLoadResult<FontAsset> load_font(const FontAssetRequest& request) = 0;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<FontAsset>>
    create_font_preparation_task(const FontAssetRequest& request) = 0;
};

class TextureAssetLoader {
public:
    virtual ~TextureAssetLoader() = default;
    [[nodiscard]] virtual AssetLoadResult<TextureAsset>
    load_texture(const TextureAssetRequest& request) = 0;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<TextureAsset>>
    create_texture_preparation_task(const TextureAssetRequest& request) = 0;
};

class HotspotMaskAssetLoader {
public:
    virtual ~HotspotMaskAssetLoader() = default;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<HotspotMaskAsset>>
    create_hotspot_mask_preparation_task(const HotspotMaskAssetRequest& request) = 0;
};

class ShaderProgramAssetLoader {
public:
    virtual ~ShaderProgramAssetLoader() = default;
    [[nodiscard]] virtual AssetLoadResult<ShaderProgramAsset>
    load_shader_program(const ShaderProgramAssetRequest& request) = 0;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<ShaderProgramAsset>>
    create_shader_program_preparation_task(const ShaderProgramAssetRequest& request) = 0;
};

class MaterialAssetLoader {
public:
    virtual ~MaterialAssetLoader() = default;
    [[nodiscard]] virtual AssetLoadResult<MaterialAsset>
    load_material(const MaterialAssetRequest& request) = 0;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<MaterialAsset>>
    create_material_preparation_task(const MaterialAssetRequest& request) = 0;
};

class AudioAssetLoader {
public:
    virtual ~AudioAssetLoader() = default;
    [[nodiscard]] virtual AssetLoadResult<AudioAsset>
    load_audio(const AudioAssetRequest& request) = 0;
    [[nodiscard]] virtual std::unique_ptr<AssetPreparationTask<AudioAsset>>
    create_audio_preparation_task(const AudioAssetRequest& request);
};

} // namespace noveltea::assets
