#pragma once

#include "noveltea/assets/typed_assets.hpp"
#include "noveltea/core/compiled_package.hpp"

#include <cstddef>

namespace noveltea::assets {

[[nodiscard]] TextureAssetRequest
prepared_video_texture_request(const core::PreparedVideoMotion& motion, std::size_t index);

} // namespace noveltea::assets
