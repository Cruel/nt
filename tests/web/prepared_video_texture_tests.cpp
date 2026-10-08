#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/prepared_video_texture.hpp"

#include <cassert>
#include <cstdio>

int main()
{
    using namespace noveltea;
    const auto animation = *core::AnimationId::create("clip").value_if();
    const auto motion_id = *core::AnimationMotionId::create("loop").value_if();
    core::PreparedVideoMotion motion{
        animation,
        motion_id,
        {},
        {{"assets/.prepared-media/first.png", 33}, {"assets/.prepared-media/last.png", 1}}};
    const auto focused = assets::prepared_video_texture_request(motion, 1);
    assert(focused.path == "project:/assets/.prepared-media/last.png");
    assert(!focused.video_sample);

    motion.browser_video = core::PreparedBrowserVideo{"assets/.prepared-media/clip.webm", 96, 64};
    const auto browser = assets::prepared_video_texture_request(motion, 1);
    assert(browser.video_sample);
    assert(browser.video_sample->media_path == "project:/assets/.prepared-media/clip.webm");
    assert(browser.video_sample->width == 96 && browser.video_sample->height == 64);
    assert(browser.video_sample->time_ms == 33.5);
    assert(browser.sampler == MaterialTextureSampler::ClampLinear);
    assert(assets::make_texture_cache_key(browser, {}).stable_identity !=
           assets::make_texture_cache_key(focused, {}).stable_identity);
    std::puts("[web-video-request] focused raster transport and fractional directed sample passed");
}
