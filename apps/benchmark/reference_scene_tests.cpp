#include "reference_scene.hpp"

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
    return 0;
}
