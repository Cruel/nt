#include "ui/rmlui/rmlui_render_pass_scheduler.hpp"

#include <catch2/catch_test_macros.hpp>

using namespace noveltea::ui::rmlui;

static RmlUiPassRequest request(RmlUiPassKind kind, uintptr_t framebuffer, bool clears_color,
                                bool clears_stencil, const char* name)
{
    return {kind, framebuffer, 0, clears_color, clears_stencil, 0, 0, 800, 600, name};
}

TEST_CASE("RmlUi pass scheduler reuses ordinary geometry view")
{
    RmlUiRenderPassScheduler scheduler(32, 34);
    const auto first = scheduler.acquire(request(RmlUiPassKind::Geometry, 7, false, false, "geo"));
    const auto second = scheduler.acquire(request(RmlUiPassKind::Geometry, 7, false, false, "geo"));

    REQUIRE(first);
    REQUIRE(second);
    CHECK(first->view == second->view);
    CHECK(scheduler.passes().size() == 1);
}

TEST_CASE("RmlUi pass scheduler reuses adjacent non-clear views with matching state")
{
    RmlUiRenderPassScheduler scheduler(32, 34);
    const auto first =
        scheduler.acquire(request(RmlUiPassKind::LayerComposite, 7, false, false, "comp"));
    const auto second =
        scheduler.acquire(request(RmlUiPassKind::LayerComposite, 7, false, false, "comp"));

    REQUIRE(first);
    REQUIRE(second);
    CHECK(first->view == second->view);
    CHECK(second->reused);
    CHECK(scheduler.passes().size() == 1);
}

TEST_CASE("RmlUi pass scheduler keeps clears as dependency boundaries")
{
    RmlUiRenderPassScheduler scheduler(32, 36);
    const auto composite =
        scheduler.acquire(request(RmlUiPassKind::LayerComposite, 7, false, false, "comp"));
    const auto clear = scheduler.acquire(request(RmlUiPassKind::Clear, 7, true, true, "clear"));
    const auto after_clear =
        scheduler.acquire(request(RmlUiPassKind::LayerComposite, 7, false, false, "comp"));
    const auto geometry =
        scheduler.acquire(request(RmlUiPassKind::Geometry, 7, false, false, "geo"));

    REQUIRE(composite);
    REQUIRE(clear);
    REQUIRE(after_clear);
    REQUIRE(geometry);
    CHECK(composite->view == 32);
    CHECK(clear->view == 33);
    CHECK(after_clear->view == 34);
    CHECK(geometry->view == after_clear->view);
    CHECK(geometry->reused);
}

TEST_CASE("RmlUi pass scheduler creates passes for framebuffer boundaries")
{
    RmlUiRenderPassScheduler scheduler(32, 36);
    const auto geometry =
        scheduler.acquire(request(RmlUiPassKind::Geometry, 7, false, false, "geo"));
    const auto clear = scheduler.acquire(request(RmlUiPassKind::Clear, 7, true, true, "clear"));
    const auto other_framebuffer =
        scheduler.acquire(request(RmlUiPassKind::Geometry, 8, false, false, "geo"));
    const auto postprocess =
        scheduler.acquire(request(RmlUiPassKind::Postprocess, 8, false, false, "post"));

    REQUIRE(geometry);
    REQUIRE(clear);
    REQUIRE(other_framebuffer);
    REQUIRE(postprocess);
    CHECK(geometry->view == 32);
    CHECK(clear->view == 33);
    CHECK(other_framebuffer->view == 34);
    CHECK(postprocess->view == other_framebuffer->view);
    CHECK(postprocess->reused);
}

TEST_CASE("RmlUi pass scheduler reports exhaustion without reusing final view")
{
    RmlUiRenderPassScheduler scheduler(32, 33);
    REQUIRE(scheduler.acquire(request(RmlUiPassKind::Clear, 0, true, false, "a")));
    REQUIRE(scheduler.acquire(request(RmlUiPassKind::Resolve, 1, false, false, "b")));
    const auto exhausted =
        scheduler.acquire(request(RmlUiPassKind::FinalComposite, 2, false, false, "c"));

    CHECK_FALSE(exhausted);
    CHECK(scheduler.exhausted());
    CHECK(scheduler.passes().size() == 2);
}
