#include "reference_scene.hpp"
#include "reference_workloads.hpp"
#include "ui_effect_verification.hpp"

#include <cmath>
#include <cstdio>
#include <limits>

namespace {
bool check(bool success, const char* message)
{
    if (!success)
        std::fprintf(stderr, "reference scene: %s\n", message);
    return success;
}
} // namespace

int main()
{
    using namespace noveltea::benchmark;
    const auto fixed = geometry_reference_scene();
    if (!check(fixed.id == "geometry-reference" && fixed.width == 1280 && fixed.height == 720 &&
                   fixed.rects.size() == 3 && fixed.texts.empty() &&
                   fixed.texture.id == "solid-white" && fixed.texture.width == 1 &&
                   fixed.texture.height == 1 && !fixed.texture.linear_filter,
               "stable reference dimensions and white texture") ||
        !check(fixed.rects[0].id == "primary" && fixed.rects[0].x == 700 &&
                   fixed.rects[0].y == 130 && fixed.rects[0].width == 340 &&
                   fixed.rects[0].height == 210 && fixed.rects[0].color.r == 225 &&
                   fixed.rects[1].id == "secondary" && fixed.rects[2].id == "accent",
               "stable fixture order, geometry and colors"))
        return 1;

    const auto simple_ui = simple_ui_reference_scene();
    if (!check(simple_ui.id == "simple-ui-reference" && simple_ui.width == fixed.width &&
                   simple_ui.height == fixed.height &&
                   simple_ui.rects.size() == fixed.rects.size() &&
                   simple_ui.rects[0].x == fixed.rects[0].x &&
                   simple_ui.rects[0].color.r == fixed.rects[0].color.r &&
                   simple_ui.texts.size() == 1 &&
                   simple_ui.texts[0].content == "NovelTea UI reference" &&
                   simple_ui.texts[0].font_size == 32,
               "standalone UI reuses deterministic reference geometry and includes actual text"))
        return 1;
    // Both UI backends use one scene definition, mapped into their own
    // logical coordinate domains. The Engine default is 1920x1080.
    const auto standalone_markup = simple_ui_reference_markup(simple_ui);
    const auto engine_markup = simple_ui_reference_markup(simple_ui, 1.5f);
    if (!check(standalone_markup.find("id='reference-background'") != std::string::npos &&
                   standalone_markup.find("width:1280px;height:720px") != std::string::npos &&
                   standalone_markup.find("left:700px;top:130px;width:340px;height:210px") !=
                       std::string::npos &&
                   engine_markup.find("width:1920px;height:1080px") != std::string::npos &&
                   engine_markup.find("left:1050px;top:195px;width:510px;height:315px") !=
                       std::string::npos &&
                   standalone_markup.find("white-space: nowrap") != std::string::npos &&
                   standalone_markup.find("width:600px;height:52px") != std::string::npos &&
                   engine_markup.find("width:900px;height:78px") != std::string::npos &&
                   standalone_markup.find("NovelTea UI reference") != std::string::npos &&
                   engine_markup.find("NovelTea UI reference") != std::string::npos,
               "RmlUi engines share semantic markup with correctly scaled visible geometry"))
        return 1;
    const auto scale = ui_scaling_reference_scene(512, 64);
    const auto same_scale = ui_scaling_reference_scene(512, 64);
    const auto markup = simple_ui_reference_markup(scale);
    if (!check(scale.id == "ui-scaling-reference" && scale.rects.size() == 512 &&
                   scale.texts.size() == 64 && scale.rects[0].id == "ui-element-0" &&
                   scale.rects[511].id == "ui-element-511" && scale.texts[0].id == "ui-text-0" &&
                   scale.texts[0].content == ui_dynamic_text(0) &&
                   scale.texts[63].id == "ui-text-63" &&
                   scale.rects[127].x == same_scale.rects[127].x &&
                   scale.rects[127].color.g == same_scale.rects[127].color.g &&
                   scale.texts[53].content == same_scale.texts[53].content,
               "bounded scaling scene is deterministic") ||
        !check(markup.find("id='ui-element-511'") != std::string::npos &&
                   markup.find("id='ui-text-63'") != std::string::npos &&
                   markup.find("width:300px;height:12px") != std::string::npos &&
                   simple_ui_reference_markup(scale, 1.5f).find("width:450px;height:18px") !=
                       std::string::npos,
               "standalone and Engine share dense but legible markup") ||
        !check(ui_dynamic_text(1) == "NovelTea dynamic 00000001" &&
                   ui_dynamic_text(1, 1) == "NovelTea dynamic 00009974" &&
                   ui_dynamic_text(1, 1) != ui_dynamic_text(1, 2) &&
                   ui_dynamic_text(1, 2).size() == ui_dynamic_text(1).size() &&
                   ui_dynamic_text(12345678) == "NovelTea dynamic 12345678" &&
                   valid_ui_scaling_parameters(1, 0, 1, 0, 0, "static", "continuous") &&
                   valid_ui_scaling_parameters(2048, 256, 8, 8, 8, "dynamic", "dirty-only") &&
                   !valid_ui_scaling_parameters(0, 1, 1, 0, 0, "static", "continuous") &&
                   !valid_ui_scaling_parameters(2049, 1, 1, 0, 0, "static", "continuous") &&
                   !valid_ui_scaling_parameters(1, 257, 1, 0, 0, "static", "continuous") &&
                   !valid_ui_scaling_parameters(1, 1, 0, 0, 0, "static", "continuous") &&
                   !valid_ui_scaling_parameters(1, 1, 8, 16, 1, "static", "continuous") &&
                   !valid_ui_scaling_parameters(1, 1, 1, 0, 0, "animated", "continuous") &&
                   !valid_ui_scaling_parameters(1, 1, 1, 0, 0, "static", "once"),
               "RmlUi scaling invalid modes and independent bounds rejected"))
        return 1;
    const UiEffectCounts effects{2, 1, 3, 2, 2, 2};
    const auto advanced = ui_effects_reference_scene(effects);
    const auto advanced_markup = simple_ui_reference_markup(advanced);
    const auto engine_effects_markup = simple_ui_reference_markup(advanced, 1.5f);
    if (!check(is_ui_effects_scenario("standalone-rmlui-effects") &&
                   is_ui_effects_scenario("integrated-rmlui-effects") &&
                   !is_ui_effects_scenario("integrated-rmlui-scaling") &&
                   valid_ui_effects_parameters(effects) && !valid_ui_effects_parameters({}) &&
                   !valid_ui_effects_parameters({17, 0, 0, 0, 0, 0}) &&
                   !valid_ui_effects_parameters({4, 4, 4, 4, 4, 4}) &&
                   valid_ui_effects_parameters({0, 16, 0, 0, 0, 0}),
               "advanced effect scenarios and count bounds") ||
        !check(advanced_markup.find("id='effect-0-1'") != std::string::npos &&
                   advanced_markup.find("id='effect-0-2'") == std::string::npos &&
                   advanced_markup.find("id='effect-1-0'") != std::string::npos &&
                   advanced_markup.find("id='effect-2-2'") != std::string::npos &&
                   advanced_markup.find("id='effect-3-1'") != std::string::npos &&
                   advanced_markup.find("id='effect-4-1'") != std::string::npos &&
                   advanced_markup.find("id='effect-5-1'") != std::string::npos &&
                   advanced_markup.find("overflow:hidden") != std::string::npos &&
                   advanced_markup.find("transform:rotate") != std::string::npos &&
                   advanced_markup.find("decorator:linear-gradient") != std::string::npos &&
                   advanced_markup.find("filter:drop-shadow") != std::string::npos &&
                   advanced_markup.find("mask-image:radial-gradient") != std::string::npos &&
                   advanced_markup.find("opacity:0.6") != std::string::npos &&
                   engine_effects_markup.find("width:267px;height:37.5px") != std::string::npos &&
                   advanced_markup ==
                       simple_ui_reference_markup(ui_effects_reference_scene(effects)),
               "effect controls generate deterministic distinct CSS and scaled geometry"))
        return 1;

    noveltea::UiEffectActivity callbacks{
        .clipping_calls = 1,
        .transforms = 1,
        .gradient_draws = 1,
        .filtered_composites = 1,
        .mask_saves = 1,
        .layer_pushes = 2,
        .max_layer_depth = 2,
    };
    std::string unsupported;
    if (!check(verify_ui_effect_activity(effects, callbacks, unsupported),
               "all requested effects require observed callbacks"))
        return 1;
    callbacks.mask_saves = 0;
    if (!check(!verify_ui_effect_activity(effects, callbacks, unsupported) &&
                   unsupported.find("masks") != std::string::npos,
               "unsupported masks must produce an explicit failed result"))
        return 1;
    callbacks.mask_saves = 1;
    callbacks.backend_errors = 1;
    if (!check(!verify_ui_effect_activity(effects, callbacks, unsupported) &&
                   unsupported.find("errors") != std::string::npos,
               "adapter failures cannot report success"))
        return 1;

    const auto exploratory = geometry_reference_scene(12, 0.5);
    const auto repeated = geometry_reference_scene(12, 0.5);
    if (!check(exploratory.rects.size() == 12 && exploratory.rects[0].x == 785 &&
                   exploratory.rects[0].width == 170 && exploratory.rects[3].id == "tile-0" &&
                   exploratory.rects[11].id == "tile-8",
               "scaled and repeated rectangles") ||
        !check(exploratory.rects[9].x == repeated.rects[9].x &&
                   exploratory.rects[9].y == repeated.rects[9].y &&
                   exploratory.rects[9].color.b == repeated.rects[9].color.b &&
                   exploratory.rects[9].id == repeated.rects[9].id,
               "independent deterministic generated geometry") ||
        !check(valid_geometry_parameters(1, 0.25) &&
                   valid_geometry_parameters(kMaxReferenceRects, 1.0) &&
                   !valid_geometry_parameters(0, 1.0) &&
                   !valid_geometry_parameters(kMaxReferenceRects + 1, 1.0) &&
                   !valid_geometry_parameters(3, 0.1) && !valid_geometry_parameters(3, 1.1) &&
                   !valid_geometry_parameters(3, std::numeric_limits<double>::quiet_NaN()),
               "valid parameter bounds"))
        return 1;

    for (uint32_t count : {1u, 2u, 3u, 4u, 5u, 7u, 511u, 512u}) {
        const auto tiles = reference_quad_partition(count);
        if (!check(tiles.size() == count, "quad partition uses exactly the requested geometry"))
            return 1;
        double area = 0;
        for (const auto& tile : tiles) {
            if (!check(tile.width > 0 && tile.height > 0 && tile.x >= 0 && tile.y >= 0 &&
                           tile.x + tile.width <= 1.00001 && tile.y + tile.height <= 1.00001,
                       "quad tiles remain inside the exact covered area"))
                return 1;
            area += double(tile.width) * tile.height;
        }
        if (!check(std::abs(area - 1.0) < 0.00001,
                   "odd and even quad counts always cover the entire region"))
            return 1;
        // Every occupied row starts at x=0, ends at x=1, and is gap-free.
        size_t begin = 0;
        while (begin < tiles.size()) {
            size_t end = begin;
            float right = 0;
            while (end < tiles.size() && tiles[end].y == tiles[begin].y) {
                if (!check(std::abs(tiles[end].x - right) < 0.00001,
                           "quad row has no gap or overlap"))
                    return 1;
                right = tiles[end].x + tiles[end].width;
                ++end;
            }
            if (!check(std::abs(right - 1.0f) < 0.00001,
                       "incomplete final row spans full covered width"))
                return 1;
            begin = end;
        }
    }
    if (!check(reference_quad_partition(0).empty() && reference_quad_partition(513).empty(),
               "invalid quad counts have no partition"))
        return 1;

    Options raw;
    raw.scenario = "raw-bgfx-clear";
    const auto clear = raw_workload_reference(raw, 1280, 720);
    raw.scenario = "raw-bgfx-single-quad";
    const auto single = raw_workload_reference(raw, 1280, 720);
    raw.scenario = "raw-bgfx-textured";
    const auto textured = raw_workload_reference(raw, 1280, 720);
    raw.scenario = "raw-bgfx-offscreen";
    const auto offscreen = raw_workload_reference(raw, 1280, 720);
    const auto small_offscreen = raw_workload_reference(raw, 640, 360);
    raw.scenario = "raw-bgfx-draw-calls";
    const auto variable = raw_workload_reference(raw, 1280, 720);
    if (!check(clear && clear->id == "raw-bgfx-clear" && clear->draws_per_frame == 0 &&
                   clear->vertices_per_frame == 0 && clear->view_count == 1 && single &&
                   single->id == "raw-bgfx-single-quad" && single->draws_per_frame == 1 &&
                   single->quads_per_draw == 1 && single->vertices_per_frame == 4 &&
                   single->texture_bytes == 4 && textured && textured->id == "raw-bgfx-textured" &&
                   textured->draws_per_frame == 1 && textured->coverage == 1.0 &&
                   textured->texture_bytes == 256 * 256 * 4 && offscreen &&
                   offscreen->id == "raw-bgfx-offscreen" && offscreen->draws_per_frame == 2 &&
                   offscreen->view_count == 2 && offscreen->vertices_per_frame == 8 &&
                   offscreen->triangles_per_frame == 4 && offscreen->offscreen &&
                   offscreen->texture_bytes == 256 * 256 * 4 + 1280 * 720 * 4 && small_offscreen &&
                   small_offscreen->texture_bytes == 256 * 256 * 4 + 640 * 360 * 4 && variable &&
                   variable->id == "raw-bgfx-draw-calls" && variable->draws_per_frame == 64 &&
                   variable->vertices_per_frame == 256 && variable->triangles_per_frame == 128 &&
                   !variable->offscreen,
               "stable real raw workload identities and operation counts"))
        return 1;

    raw.draw_calls = 7;
    raw.quad_count = 9;
    raw.texture_size = 64;
    raw.coverage = 0.375;
    const auto scaled = raw_workload_reference(raw, 1280, 720);
    if (!check(scaled && scaled->draws_per_frame == 7 && scaled->quads_per_draw == 9 &&
                   scaled->vertices_per_frame == 7 * 9 * 4 &&
                   scaled->triangles_per_frame == 7 * 9 * 2 &&
                   scaled->texture_bytes == 64 * 64 * 4 && scaled->coverage == 0.375,
               "draw submissions, geometry, texture footprint and coverage scale independently"))
        return 1;
    raw = {};
    raw.scenario = "raw-bgfx-composition";
    const auto direct = raw_workload_reference(raw, 1280, 720);
    raw.composition_path = "offscreen";
    raw.composite_passes = 1;
    const auto composed = raw_workload_reference(raw, 1280, 720);
    raw.composite_passes = 4;
    raw.target_scale = 0.5;
    raw.msaa_samples = 4;
    const auto stacked = raw_workload_reference(raw, 1280, 720);
    if (!check(direct && direct->composition && !direct->offscreen &&
                   direct->equivalent_to_direct && direct->draws_per_frame == 2 &&
                   direct->view_count == 2 && composed && composed->offscreen &&
                   composed->equivalent_to_direct && composed->draws_per_frame == 3 &&
                   composed->target_count == 1 && composed->target_width == 1280 && stacked &&
                   stacked->composite_passes == 4 && stacked->view_count == 6 &&
                   stacked->target_count == 3 && stacked->target_width == 640 &&
                   stacked->target_height == 360 && !stacked->equivalent_to_direct &&
                   stacked->estimated_msaa_bytes == 640 * 360 * 4 * 4 &&
                   stacked->target_color_bytes == 640 * 360 * 4 * 3,
               "composition path, target sizes, pass counts and MSAA budget are explicit"))
        return 1;
    raw.composition_path = "direct";
    if (!check(!raw_workload_reference(raw, 1280, 720),
               "direct path rejects intermediate passes, scaling and MSAA"))
        return 1;
    raw.composition_path = "offscreen";
    raw.target_scale = 0.25;
    if (!check(!raw_workload_reference(raw, 1, 1),
               "composition rejects rounded-to-zero framebuffer dimensions"))
        return 1;
    raw = {};
    raw.scenario = "raw-bgfx-draw-calls";
    raw.draw_calls = 1025;
    const bool invalid_draws = !raw_workload_reference(raw, 1280, 720);
    raw.draw_calls = 7;
    raw.quad_count = 513;
    const bool invalid_quads = !raw_workload_reference(raw, 1280, 720);
    raw.quad_count = 9;
    raw.texture_size = 63;
    const bool invalid_texture = !raw_workload_reference(raw, 1280, 720);
    raw.texture_size = 64;
    raw.coverage = std::numeric_limits<double>::quiet_NaN();
    const bool invalid_nan = !raw_workload_reference(raw, 1280, 720);
    raw.coverage = 0.12;
    const bool invalid_coverage = !raw_workload_reference(raw, 1280, 720);
    raw.coverage = 0.375;
    if (!check(invalid_draws && invalid_quads && invalid_texture && invalid_nan &&
                   invalid_coverage && !raw_workload_reference(raw, 0, 720) &&
                   !raw_workload_reference(raw, 8193, 720),
               "invalid raw workload and render dimension boundaries"))
        return 1;
    return 0;
}
