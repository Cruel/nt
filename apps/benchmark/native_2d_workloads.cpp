#include "native_2d_workloads.hpp"

#include "benchmark_android_lifecycle.hpp"
#include "benchmark_assets.hpp"
#include "benchmark_bgfx_diagnostics.hpp"
#include "benchmark_inspection.hpp"
#include "benchmark_window_size.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/world_presentation.hpp"

#include <SDL3/SDL.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <string>
#include <utility>
#include <vector>

namespace noveltea::benchmark {

Native2DReference make_native_2d_reference(uint32_t quad_count, uint32_t glyph_count, int width,
                                           int height)
{
    Native2DReference scene;
    const auto columns = std::max(1u, static_cast<uint32_t>(std::ceil(std::sqrt(quad_count))));
    const auto rows = std::max(1u, (quad_count + columns - 1u) / columns);
    const float cell_w = static_cast<float>(std::max(width, 1)) / columns;
    const float cell_h = static_cast<float>(std::max(height, 1)) / rows;
    for (uint32_t index = 0; index < quad_count; ++index) {
        const float x = static_cast<float>(index % columns) * cell_w;
        const float y = static_cast<float>(index / columns) * cell_h;
        const float intensity = 0.15f + 0.75f * static_cast<float>(index % 13u) / 12.0f;
        scene.quads.draw_colored_quad(
            {x + 0.5f, y + 0.5f, std::max(cell_w - 1.0f, 0.5f), std::max(cell_h - 1.0f, 0.5f)},
            {intensity, 0.6f, 0.85f, 1.0f});
    }
    // Exactly glyph_count visible letters; extra word separators allow wrapping.
    scene.text.reserve(glyph_count + glyph_count / 17u + 1u);
    scene.alternate_text.reserve(glyph_count + glyph_count / 17u + 1u);
    for (uint32_t index = 0; index < glyph_count; ++index) {
        if (index > 0 && index % 17u == 0) {
            scene.text.push_back(' ');
            scene.alternate_text.push_back(' ');
        }
        scene.text.push_back(static_cast<char>('A' + index % 26u));
        scene.alternate_text.push_back(static_cast<char>('Z' - index % 26u));
    }
    return scene;
}

Native2DScenario::~Native2DScenario()
{
    std::string ignored;
    (void)cleanup(ignored);
}

const char* Native2DScenario::description() const
{
    if (id_ == "native-2d-geometry")
        return "production Renderer::draw_2d geometry submission; optional real GPU texture";
    if (id_ == "native-2d-text-static")
        return "production native text renderer with pre-shaped static glyph layout";
    return "production native HarfBuzz shaping/layout plus text draw with changing strings";
}

bool Native2DScenario::prepare(const Options& options, std::string& reason)
{
    if (!cleanup(reason))
        return false;
#if defined(__EMSCRIPTEN__)
    reason = "native 2D renderer owns bgfx; the Web dashboard currently owns that context";
    return false;
#endif
    interruption_ = Interruption::None;
    environment_ = {};
    dynamic_ = id_ == "native-2d-text-dynamic";
    frame_number_ = 0;

    PlatformConfig platform_config{.title = "NovelTea Native 2D Benchmark",
                                   .width = options.width,
                                   .height = options.height,
                                   .resizable = false,
                                   .vsync = options.vsync};
    if (!requested_benchmark_window_size(options, nullptr, platform_config.width,
                                         platform_config.height, reason))
        return false;
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        reason = "Android Activity is not in the foreground";
        return false;
    }
#endif
    if (!platform_.initialize(platform_config)) {
        reason = "native 2D Platform initialization failed";
        return false;
    }
#if defined(__ANDROID__)
    assets_.mount("system", std::make_shared<assets::SdlPackagedAssetSource>("system"));
#else
    assets_.mount_directory("system", benchmark_asset_path("system"));
#endif
    const auto surface = platform_.surface();
    const auto presentation =
        make_presentation_metrics(surface, {.reference = {.size = surface.framebuffer_size},
                                            .world_raster_policy = WorldRasterPolicy::Native});
    if (!presentation) {
        reason = "cannot construct native 2D presentation metrics";
        return false;
    }
    const auto handles = platform_.native_window_handles();
    if (!renderer_.initialize({.native_display = handles.display,
                               .native_window = handles.window,
                               .native_window_type = handles.type,
                               .presentation = presentation.value(),
                               .vsync = options.vsync,
                               .assets = &assets_})) {
        reason = "production native 2D Renderer initialization failed";
        return false;
    }
    const auto width = renderer_.reference_width();
    const auto height = renderer_.reference_height();
    const bool geometry = id_ == "native-2d-geometry";
    reference_ = make_native_2d_reference(geometry ? options.native_quads : 0u,
                                          geometry ? 0u : options.native_glyphs, width, height);
    if (geometry && options.native_texture_size > 0) {
        const auto size = static_cast<uint16_t>(options.native_texture_size);
        std::vector<uint8_t> pixels(static_cast<size_t>(size) * size * 4u);
        for (uint32_t y = 0; y < size; ++y)
            for (uint32_t x = 0; x < size; ++x) {
                const auto offset = (static_cast<size_t>(y) * size + x) * 4u;
                const uint8_t shade = ((x / 8u + y / 8u) % 2u) ? 220 : 40;
                pixels[offset] = shade;
                pixels[offset + 1u] = static_cast<uint8_t>(255u - shade);
                pixels[offset + 2u] = 190;
                pixels[offset + 3u] = 255;
            }
        texture_ = bgfx::createTexture2D(
            size, size, false, 1, bgfx::TextureFormat::RGBA8, BGFX_SAMPLER_NONE,
            bgfx::copy(pixels.data(), static_cast<uint32_t>(pixels.size())));
        if (!bgfx::isValid(texture_)) {
            reason = "native 2D benchmark texture allocation failed";
            return false;
        }
        // Same placement and geometry count as untextured mode; only sampler/texture work differs.
        QuadBatch textured;
        for (const auto& command : reference_.quads.commands()) {
            textured.draw_textured_quad(command.rect, Texture{texture_.idx}, {0, 0, 1, 1},
                                        command.color);
        }
        reference_.quads = std::move(textured);
    }
    if (!geometry) {
        font_ = renderer_.load_font({std::string(kSystemFontAsset)});
        if (!font_) {
            reason = "native text font load failed: system:/fonts/LiberationSans.ttf";
            return false;
        }
        label_.font = font_;
        label_.bounds = {18, 12, std::max(1.0f, static_cast<float>(width) - 36.0f),
                         std::max(1.0f, static_cast<float>(height) - 24.0f)};
        label_.value = reference_.text;
        // A fixed glyph size keeps glyph-count comparisons independent of font scale.
        label_.style = {12.0f, {0.93f, 0.97f, 1.0f, 1.0f}, 1.0f};
        label_.language = "en";
        static_layout_ = renderer_.layout_text(label_);
        const auto visible_glyph_count = [](const TextLayout& layout) {
            size_t count = 0;
            for (const auto& line : layout.lines)
                for (const auto& run : line.visual_runs)
                    count += run.glyphs.size();
            return count;
        };
        if (static_layout_.lines.empty() || static_layout_.overflowed ||
            static_layout_.metrics.height > label_.bounds.height ||
            visible_glyph_count(static_layout_) < options.native_glyphs) {
            reason = "native text fixture cannot fit glyph count: shaped=" +
                     std::to_string(visible_glyph_count(static_layout_)) +
                     " expected=" + std::to_string(options.native_glyphs) +
                     " height=" + std::to_string(static_layout_.metrics.height) +
                     " available=" + std::to_string(label_.bounds.height) +
                     " overflow=" + std::to_string(static_layout_.overflowed);
            return false;
        }
        label_.value = reference_.alternate_text;
        dynamic_layout_ = renderer_.layout_text(label_);
        if (dynamic_layout_.lines.empty() || dynamic_layout_.overflowed ||
            dynamic_layout_.metrics.height > label_.bounds.height ||
            visible_glyph_count(dynamic_layout_) < options.native_glyphs) {
            reason = "alternate native text fixture cannot fit the requested glyph count";
            return false;
        }
        label_.value = reference_.text;
    }
    environment_.platform = SDL_GetPlatform();
    if (const auto* driver = SDL_GetCurrentVideoDriver())
        environment_.video_driver = driver;
    environment_.frame_path = "native-renderer-frame";
    if (const auto* caps = bgfx::getCaps()) {
        environment_.renderer = bgfx::getRendererName(caps->rendererType);
        environment_.gpu_vendor_id = caps->vendorId;
        environment_.gpu_device_id = caps->deviceId;
    }
    environment_.width_pixels = surface.framebuffer_size.width;
    environment_.height_pixels = surface.framebuffer_size.height;
    environment_.ui_reference_width = width;
    environment_.ui_reference_height = height;
    environment_.ui_raster_width = presentation.value().ui_raster.size.width;
    environment_.ui_raster_height = presentation.value().ui_raster.size.height;
    environment_.world_raster_width = presentation.value().world_raster.size.width;
    environment_.world_raster_height = presentation.value().world_raster.size.height;
    environment_.engine_postprocess_active = false;

    // Warm raster/glyph atlas and submit real frames before Ready, even for --smoke.
    for (int step = 0; step < 4; ++step)
        if (!frame(reason))
            return false;
    frame_number_ = 0;
    return true;
}

Readiness Native2DScenario::readiness(std::string& reason)
{
    if (!renderer_.is_initialized()) {
        reason = "production native 2D renderer is not initialized";
        return Readiness::Failed;
    }
    return Readiness::Ready;
}

bool Native2DScenario::frame(std::string& reason)
{
#if defined(__ANDROID__)
    if (!android_benchmark_foreground()) {
        interruption_ = Interruption::Recoverable;
        reason = "Android Activity suspended during native 2D benchmark";
        return false;
    }
#endif
    platform_.poll_events();
    if (platform_.should_quit()) {
        interruption_ = Interruption::Cancelled;
        reason = "native 2D window was closed";
        return false;
    }
    if (!renderer_.is_initialized()) {
        reason = "native 2D renderer not initialized";
        return false;
    }
    renderer_.begin_frame();
    if (id_ == "native-2d-geometry") {
        renderer_.draw_2d(reference_.quads);
        renderer_.composite_ordinary_world_surface();
    } else if (dynamic_) {
        // Both text variants are laid out/rasterized before Ready; reshaping remains timed.
        label_.value = (frame_number_ & 1u) ? reference_.text : reference_.alternate_text;
        renderer_.draw_text(renderer_.layout_text(label_));
    } else {
        renderer_.draw_text(static_layout_);
    }
    renderer_.finalize_screenshot_capture();
    renderer_.end_frame();
    ++frame_number_;
    return true;
}

void Native2DScenario::diagnostic_frame(DiagnosticObservation& observation)
{
    capture_bgfx_diagnostics(observation);
}

bool Native2DScenario::inspect(const Options& options, std::string& reason)
{
    if (!renderer_.is_initialized()) {
        reason = "native 2D visual inspection requires a prepared Renderer";
        return false;
    }
    const auto width = static_cast<uint32_t>(renderer_.reference_width());
    const auto height = static_cast<uint32_t>(renderer_.reference_height());
    if (!renderer_.request_screenshot_capture({1, width, height})) {
        reason = "native 2D screenshot request was rejected";
        return false;
    }
    std::optional<RendererScreenshotCapture> screenshot;
    for (int attempt = 0; attempt < 32 && !screenshot; ++attempt) {
        if (!frame(reason))
            return false;
        screenshot = renderer_.take_screenshot_capture();
    }
    if (!screenshot) {
        reason = "native 2D screenshot was not ready after 32 frames";
        return false;
    }
    if (screenshot->pixels.size() < 4u || screenshot->pitch < screenshot->width * 4u) {
        reason = "native 2D screenshot has malformed pixels";
        return false;
    }
    const auto first = screenshot->pixels.begin();
    bool varied = false;
    for (size_t offset = 4; offset + 3 < screenshot->pixels.size(); offset += 4)
        if (first[0] != screenshot->pixels[offset] || first[1] != screenshot->pixels[offset + 1u] ||
            first[2] != screenshot->pixels[offset + 2u]) {
            varied = true;
            break;
        }
    if (!varied) {
        reason = "native 2D visual inspection is uniform (no visible workload)";
        return false;
    }
    InspectionPixels pixels;
    pixels.width = screenshot->width;
    pixels.height = screenshot->height;
    pixels.pitch = screenshot->pitch;
    pixels.format = screenshot->format == RendererScreenshotPixelFormat::Rgba8
                        ? bgfx::TextureFormat::RGBA8
                        : bgfx::TextureFormat::BGRA8;
    pixels.yflip = screenshot->yflip;
    pixels.bytes = std::move(screenshot->pixels);
    std::vector<uint8_t> encoded;
    if (!encode_inspection_png(pixels, options, encoded, reason))
        return false;
    const auto path = make_inspection_path(options, reason);
    if (path.empty())
        return false;
    std::ofstream output(path, std::ios::binary);
    output.write(reinterpret_cast<const char*>(encoded.data()),
                 static_cast<std::streamsize>(encoded.size()));
    if (!output) {
        reason = "unable to save native 2D inspection PNG: " + path.string();
        return false;
    }
    std::printf("[benchmark] native 2D inspection smoke complete: %s\n", path.string().c_str());
    return true;
}

bool Native2DScenario::complete(std::string&) { return true; }

bool Native2DScenario::cleanup(std::string& reason)
{
    reason.clear();
    if (bgfx::isValid(texture_)) {
        bgfx::destroy(texture_);
        texture_ = BGFX_INVALID_HANDLE;
    }
    renderer_.shutdown();
    platform_.shutdown();
    reference_ = {};
    font_ = {};
    label_ = {};
    static_layout_ = {};
    dynamic_layout_ = {};
    return true;
}

} // namespace noveltea::benchmark
