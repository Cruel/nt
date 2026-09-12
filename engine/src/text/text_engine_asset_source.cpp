#include "text/text_engine.hpp"

#include <noveltea/assets/asset_manager.hpp>

#include <utility>

namespace noveltea::text {
namespace {

FontAssetReadResult read_asset_manager_font(const void* context, std::string_view logical_path)
{
    const auto* assets = static_cast<const assets::AssetManager*>(context);
    if (!assets)
        return {.bytes = {}, .error = "font asset reader has no AssetManager"};
    auto result = assets->read_binary(logical_path);
    if (!result)
        return {.bytes = {}, .error = result.error.message};
    return {.bytes = std::move(result.value->bytes), .error = {}};
}

} // namespace

TextEngine::TextEngine(const assets::AssetManager& assets)
    : TextEngine(&read_asset_manager_font, &assets)
{
}

} // namespace noveltea::text
