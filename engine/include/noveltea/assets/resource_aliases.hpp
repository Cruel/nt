#pragma once

#include "noveltea/assets/typed_assets.hpp"

#include <optional>
#include <string>
#include <unordered_map>

namespace noveltea::assets {

struct ResourceAliasRegistry {
    std::unordered_map<std::string, AudioAssetRequest> audio;
    std::unordered_map<std::string, TextureAssetRequest> textures;
    std::unordered_map<std::string, MaterialAssetRequest> materials;

    void clear();
    [[nodiscard]] bool empty() const noexcept;

    void register_audio(std::string alias, AudioAssetRequest request);
    void register_texture(std::string alias, TextureAssetRequest request);
    void register_material(std::string alias, MaterialAssetRequest request);

    [[nodiscard]] std::optional<AudioAssetRequest> audio_request(std::string_view alias) const;
    [[nodiscard]] std::optional<TextureAssetRequest> texture_request(std::string_view alias) const;
    [[nodiscard]] std::optional<MaterialAssetRequest>
    material_request(std::string_view alias) const;
};

[[nodiscard]] AssetResult<ResourceAliasRegistry>
parse_resource_alias_registry(std::string_view json_text);

} // namespace noveltea::assets
