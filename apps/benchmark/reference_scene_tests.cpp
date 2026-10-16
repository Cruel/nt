#include "reference_scene.hpp"
#include "reference_workloads.hpp"

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
