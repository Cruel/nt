#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/typed_assets.hpp"

#include <cstdint>
#include <string>

namespace noveltea::assets {

[[nodiscard]] inline AssetCacheKey make_font_cache_key(const FontAssetRequest& request,
                                                       AssetSourceGeneration generation)
{
    return {.stable_identity = "font-source|" + request.alias + "|" + std::to_string(request.style),
            .source_generation = generation};
}

[[nodiscard]] inline AssetCacheKey make_texture_cache_key(const TextureAssetRequest& request,
                                                          AssetSourceGeneration generation)
{
    return {.stable_identity = "texture|" + request.path + "|" +
                               std::to_string(static_cast<std::uint32_t>(request.sampler)),
            .source_generation = generation};
}

[[nodiscard]] inline AssetCacheKey
make_shader_program_cache_key(const ShaderProgramAssetRequest& request,
                              AssetSourceGeneration generation)
{
    return {.stable_identity =
                "shader-material|program|" + shader_program_cache_key(request.resolution.key),
            .source_generation = generation};
}

[[nodiscard]] inline AssetCacheKey make_material_cache_key(const MaterialAssetRequest& request,
                                                           AssetSourceGeneration generation)
{
    return {.stable_identity = "shader-material|material|" + request.id,
            .source_generation = generation};
}

} // namespace noveltea::assets
