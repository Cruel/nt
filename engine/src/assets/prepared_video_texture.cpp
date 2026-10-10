#include "noveltea/assets/prepared_video_texture.hpp"

namespace noveltea::assets {

TextureAssetRequest prepared_video_texture_request(const core::PreparedVideoMotion& motion,
                                                   std::size_t index)
{
    TextureAssetRequest request{.path = "project:/" + motion.frames[index].path,
                                .sampler = MaterialTextureSampler::ClampLinear};
    // The private WebM representation is shared by native and browser decoding.
    if (motion.browser_video) {
        // Rounded semantic boundaries can precede codec PTS; sample inside the interval.
        double time = static_cast<double>(motion.frames[index].duration_ms) / 2.0;
        for (std::size_t previous = 0; previous < index; ++previous)
            time += motion.frames[previous].duration_ms;
        const auto& video = *motion.browser_video;
        request.video_sample = PreparedVideoTextureSample{.media_path = "project:/" + video.path,
                                                          .time_ms = time,
                                                          .width = video.width,
                                                          .height = video.height};
    }
#ifndef __EMSCRIPTEN__
    else {
        request.video_sample = PreparedVideoTextureSample{};
    }
#endif
    return request;
}

} // namespace noveltea::assets
