#pragma once

#include "noveltea/assets/asset_source.hpp"
#include "noveltea/audio/audio_types.hpp"
#include "noveltea/render/material.hpp"
#include "noveltea/render/shader_manifest.hpp"
#include "noveltea/text/font.hpp"

#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <vector>

namespace noveltea::assets {

inline constexpr uint16_t invalid_typed_asset_handle = std::numeric_limits<uint16_t>::max();

struct FontAssetRequest {
    std::string alias;
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
};

struct TextureAsset {
    uint16_t handle = invalid_typed_asset_handle;
    std::string path;
    uint16_t width = 0;
    uint16_t height = 0;
};

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
    [[nodiscard]] virtual AssetResult<FontAsset> load_font(const FontAssetRequest& request) = 0;
};

class TextureAssetLoader {
public:
    virtual ~TextureAssetLoader() = default;
    [[nodiscard]] virtual AssetResult<TextureAsset>
    load_texture(const TextureAssetRequest& request) = 0;
};

class ShaderProgramAssetLoader {
public:
    virtual ~ShaderProgramAssetLoader() = default;
    [[nodiscard]] virtual AssetResult<ShaderProgramAsset>
    load_shader_program(const ShaderProgramAssetRequest& request) = 0;
};

class MaterialAssetLoader {
public:
    virtual ~MaterialAssetLoader() = default;
    [[nodiscard]] virtual AssetResult<MaterialAsset>
    load_material(const MaterialAssetRequest& request) = 0;
};

class AudioAssetLoader {
public:
    virtual ~AudioAssetLoader() = default;
    [[nodiscard]] virtual AssetResult<AudioAsset> load_audio(const AudioAssetRequest& request) = 0;
};

} // namespace noveltea::assets
