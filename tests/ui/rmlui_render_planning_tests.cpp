#include "ui/rmlui/rmlui_render_planning.hpp"

#include <catch2/catch_approx.hpp>
#include <catch2/catch_test_macros.hpp>

using namespace noveltea::ui::rmlui;

TEST_CASE("RmlUi fullscreen triangle covers clip space with portable UVs")
{
    const auto top_left = fullscreen_triangle(false);
    CHECK(top_left[0].x == -1.0f);
    CHECK(top_left[1].x == 3.0f);
    CHECK(top_left[2].y == 3.0f);
    CHECK(top_left[0].v == 0.0f);
    CHECK(top_left[2].v == 2.0f);

    const auto bottom_left = fullscreen_triangle(true);
    CHECK(bottom_left[0].v == 0.0f);
    CHECK(bottom_left[2].v == 2.0f);
}

TEST_CASE("RmlUi layer pool allocation is bounded by maximum nesting depth")
{
    LayerPoolPlan pool;
    constexpr uint32_t max_depth = 7;

    for (int frame = 0; frame < 10000; ++frame) {
        pool.begin_frame();
        for (uint32_t i = 0; i < max_depth; ++i) {
            CHECK(pool.push() == i + 1);
        }
    }

    CHECK(pool.slot_count() == max_depth + 1);
    CHECK(pool.allocation_count() == max_depth + 1);
}

TEST_CASE("RmlUi postprocess pool does not consume layer handles")
{
    LayerPoolPlan layers;
    PostprocessPoolPlan postprocess;

    layers.begin_frame();
    CHECK(layers.push() == 1);
    postprocess.mark_allocated(PostprocessTargetKind::Scratch);
    postprocess.mark_allocated(PostprocessTargetKind::Primary);
    CHECK(layers.push() == 2);
    CHECK(layers.slot_count() == 3);
    CHECK(postprocess.allocation_count() == 2);

    layers.begin_frame();
    CHECK(layers.push() == 1);
    CHECK(layers.push() == 2);
}

TEST_CASE("RmlUi resize bookkeeping recreates layer and postprocess resources independently")
{
    LayerPoolPlan layers;
    PostprocessPoolPlan postprocess;
    layers.begin_frame();
    CHECK(layers.push() == 1);
    CHECK(layers.push() == 2);
    postprocess.mark_allocated(PostprocessTargetKind::Scratch);
    postprocess.mark_allocated(PostprocessTargetKind::BlendMask);

    layers.reset_resources();
    postprocess.reset_resources();

    CHECK(layers.slot_count() == 1);
    CHECK(layers.allocation_count() == 1);
    CHECK_FALSE(postprocess.allocated(PostprocessTargetKind::Scratch));
    CHECK(postprocess.allocation_count() == 0);
}

TEST_CASE("RmlUi stencil planner never treats depth-only fallback as stencil")
{
    CHECK(choose_stencil_plan(true, false) == StencilPlan::StencilAttachment);
    CHECK(choose_stencil_plan(false, true) == StencilPlan::StencilAttachment);
    CHECK(choose_stencil_plan(false, false) == StencilPlan::Unsupported);
}

TEST_CASE("RmlUi gaussian kernel is normalized")
{
    const auto kernel = gaussian_kernel(4.0f);
    REQUIRE(kernel.weights.size() > 1);
    float sum = kernel.weights[0];
    for (size_t i = 1; i < kernel.weights.size(); ++i) {
        sum += 2.0f * kernel.weights[i];
    }
    CHECK(sum == Catch::Approx(1.0f).margin(0.0001f));
}

TEST_CASE("RmlUi color filter matrices match expected scalar behavior")
{
    const auto brightness = make_brightness_filter(2.0f);
    CHECK(brightness.kind == FilterKind::ColorMatrix);
    CHECK(brightness.matrix[0] == 2.0f);
    CHECK(brightness.matrix[5] == 2.0f);
    CHECK(brightness.matrix[10] == 2.0f);

    const auto invert = make_invert_filter(1.0f);
    CHECK(invert.matrix[0] == -1.0f);
    CHECK(invert.matrix[5] == -1.0f);
    CHECK(invert.matrix[10] == -1.0f);
    CHECK(invert.matrix[12] == 1.0f);
}

TEST_CASE("RmlUi color matrix helper uses row-major RGB rows with translation")
{
    const auto identity = make_brightness_filter(1.0f);
    const std::array<float, 4> premul {0.2f, 0.4f, 0.1f, 0.5f};
    const auto unchanged = apply_color_matrix(identity.matrix, premul);
    CHECK(unchanged[0] == Catch::Approx(0.2f));
    CHECK(unchanged[1] == Catch::Approx(0.4f));
    CHECK(unchanged[2] == Catch::Approx(0.1f));
    CHECK(unchanged[3] == Catch::Approx(0.5f));

    const auto contrast = make_contrast_filter(2.0f);
    const auto contrasted = apply_color_matrix(contrast.matrix, {0.25f, 0.25f, 0.25f, 0.5f});
    CHECK(contrasted[0] == Catch::Approx(0.0f));
    CHECK(contrasted[1] == Catch::Approx(0.0f));
    CHECK(contrasted[2] == Catch::Approx(0.0f));
    CHECK(contrasted[3] == Catch::Approx(0.5f));
}
