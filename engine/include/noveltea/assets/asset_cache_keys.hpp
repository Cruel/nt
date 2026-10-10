#pragma once

#include "noveltea/assets/asset_request.hpp"
#include "noveltea/assets/typed_assets.hpp"

#include <cstdint>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>

namespace noveltea::assets {

[[nodiscard]] inline AssetCacheKey make_font_cache_key(const FontAssetRequest& request,
                                                       AssetSourceGeneration generation)
{
    return {.stable_identity = "font-source|" + request.alias + "|" +
                               request.source_path.value_or(std::string{}) + "|" +
                               std::to_string(request.style),
            .source_generation = generation};
}

[[nodiscard]] inline AssetCacheKey make_texture_cache_key(const TextureAssetRequest& request,
                                                          AssetSourceGeneration generation)
{
    std::string identity = "texture|" + request.path + "|" +
                           std::to_string(static_cast<std::uint32_t>(request.sampler));
    if (request.video_sample) {
        const auto& video = *request.video_sample;
        identity += "|video|" + std::to_string(video.media_path.size()) + ":" + video.media_path +
                    "|" + std::to_string(video.time_ms) + "|" + std::to_string(video.width) + "x" +
                    std::to_string(video.height);
    }
    if (request.video_session)
        identity += "|occurrence|" + std::to_string(request.video_session->identity()) +
                    "|revision|" + std::to_string(request.video_sample->revision);
    return {.stable_identity = std::move(identity), .source_generation = generation};
}

[[nodiscard]] inline AssetCacheKey
make_hotspot_mask_cache_key(const HotspotMaskAssetRequest& request,
                            AssetSourceGeneration generation)
{
    const auto identity = std::visit(
        [](const auto& owner) {
            using Owner = std::decay_t<decltype(owner)>;
            if constexpr (std::is_same_v<Owner, core::compiled::RoomHotspotOwnerRef>)
                return std::string{"room|"} + owner.room.text();
            else
                return std::string{"interactable|"} + owner.interactable.text();
        },
        request.owner);
    return {.stable_identity = "hotspot-mask|" + identity, .source_generation = generation};
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

[[nodiscard]] inline AssetCacheKey make_audio_cache_key(const AudioAssetRequest& request,
                                                        AssetSourceGeneration generation)
{
    return {.stable_identity = "audio|" + request.path + "|" +
                               std::to_string(static_cast<std::uint32_t>(request.mode)) + "|" +
                               std::to_string(static_cast<std::uint32_t>(request.kind)),
            .source_generation = generation};
}

} // namespace noveltea::assets
