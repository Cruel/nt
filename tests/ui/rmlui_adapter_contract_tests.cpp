#include "ui/rmlui/rmlui_render_interface_bgfx.hpp"

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

namespace noveltea::ui::rmlui {
namespace {

template<class Id> Id id(std::string value)
{
    auto result = Id::create(std::move(value));
    return std::move(result).value();
}

PresentationMetrics presentation_at(IntegerSize ui_size)
{
    auto presentation = make_presentation_metrics(
        make_host_surface_metrics(1920, 1080, ui_size.width, ui_size.height),
        {.reference = {.size = {1920, 1080}}});
    REQUIRE(presentation);
    return std::move(*presentation.value_if());
}

ResolvedContextMetrics context_at(IntegerSize logical_size, AxisScale ui_raster_scale)
{
    ResolvedContextMetrics context;
    context.layout_size = logical_size;
    context.media_query_size = {3840, 2160};
    context.ui_raster_scale = ui_raster_scale;
    context.font_raster_scale = ui_raster_scale.x;
    return context;
}

core::PresentationMaterialParameter occurrence_time_parameter(std::uint64_t session,
                                                              core::compiled::LayoutSlot slot)
{
    const auto material = id<core::MaterialId>("ui-material");
    return {
        core::PresentationOwner{
            core::SessionPresentationOwner{core::PresentationSessionId::from_number(session)}},
        core::LayoutMaterialOccurrence{core::ReservedLayoutMountKey{slot}, material},
        material,
        "u_time",
        std::nullopt,
        core::MaterialStandardFacet::OccurrenceTime,
        core::MaterialClockPolicy::Gameplay,
    };
}

} // namespace

TEST_CASE("RmlUi adapter surface uses exact active context metrics")
{
    const PresentationMetrics presentation = presentation_at({3840, 2160});
    const ResolvedContextMetrics one_x = context_at({3840, 2160}, {1.0f, 1.0f});
    const ResolvedContextMetrics two_x = context_at({1920, 1080}, {2.0f, 2.0f});

    const auto one_x_surface = to_rmlui_bgfx_surface(presentation, one_x);
    REQUIRE(one_x_surface);
    CHECK(one_x_surface->logical_width == 3840);
    CHECK(one_x_surface->logical_height == 2160);
    CHECK(one_x_surface->framebuffer_width == 3840);
    CHECK(one_x_surface->framebuffer_height == 2160);
    CHECK(one_x_surface->scale_x == 1.0f);
    CHECK(one_x_surface->scale_y == 1.0f);

    const auto two_x_surface = to_rmlui_bgfx_surface(presentation, two_x);
    REQUIRE(two_x_surface);
    CHECK(two_x_surface->logical_width == 1920);
    CHECK(two_x_surface->logical_height == 1080);
    CHECK(two_x_surface->framebuffer_width == 3840);
    CHECK(two_x_surface->framebuffer_height == 2160);
    CHECK(two_x_surface->scale_x == 2.0f);
    CHECK(two_x_surface->scale_y == 2.0f);

    const auto one_x_again = to_rmlui_bgfx_surface(presentation, one_x);
    REQUIRE(one_x_again);
    CHECK(one_x_again->logical_width == one_x_surface->logical_width);
    CHECK(one_x_again->logical_height == one_x_surface->logical_height);
    CHECK(one_x_again->framebuffer_width == one_x_surface->framebuffer_width);
    CHECK(one_x_again->framebuffer_height == one_x_surface->framebuffer_height);
    CHECK(one_x_again->scale_x == one_x_surface->scale_x);
    CHECK(one_x_again->scale_y == one_x_surface->scale_y);
}

TEST_CASE("RmlUi adapter context surfaces switch between inherited and ignored UI domains")
{
    const PresentationMetrics presentation = presentation_at({3840, 2160});
    const auto inherited = resolve_context_metrics(presentation, 1.25f, true);
    const auto ignored = resolve_context_metrics(presentation, 1.25f, false);
    REQUIRE(inherited);
    REQUIRE(ignored);

    const auto inherited_surface = to_rmlui_bgfx_surface(presentation, inherited.value());
    const auto ignored_surface = to_rmlui_bgfx_surface(presentation, ignored.value());
    const auto inherited_again = to_rmlui_bgfx_surface(presentation, inherited.value());
    REQUIRE(inherited_surface);
    REQUIRE(ignored_surface);
    REQUIRE(inherited_again);

    CHECK(inherited_surface->logical_width == 1536);
    CHECK(inherited_surface->logical_height == 864);
    CHECK(inherited_surface->scale_x == 2.5f);
    CHECK(inherited_surface->scale_y == 2.5f);
    CHECK(ignored_surface->logical_width == 1920);
    CHECK(ignored_surface->logical_height == 1080);
    CHECK(ignored_surface->scale_x == 2.0f);
    CHECK(ignored_surface->scale_y == 2.0f);
    CHECK(inherited_again->logical_width == inherited_surface->logical_width);
    CHECK(inherited_again->logical_height == inherited_surface->logical_height);
    CHECK(inherited_again->scale_x == inherited_surface->scale_x);
    CHECK(inherited_again->scale_y == inherited_surface->scale_y);
}

TEST_CASE("RmlUi adapter snaps submission origins only after logical-to-raster transform")
{
    const ResolvedContextMetrics one_x = context_at({3840, 2160}, {1.0f, 1.0f});
    const ResolvedContextMetrics two_x = context_at({1920, 1080}, {2.0f, 2.0f});

    const Rml::Vector2f one_x_origin = snap_rmlui_submission_translation({10.25f, 20.75f}, one_x);
    CHECK_THAT(one_x_origin.x, Catch::Matchers::WithinAbs(10.0f, 0.0001f));
    CHECK_THAT(one_x_origin.y, Catch::Matchers::WithinAbs(21.0f, 0.0001f));

    const Rml::Vector2f two_x_origin = snap_rmlui_submission_translation({10.25f, 20.25f}, two_x);
    CHECK_THAT(two_x_origin.x, Catch::Matchers::WithinAbs(10.5f, 0.0001f));
    CHECK_THAT(two_x_origin.y, Catch::Matchers::WithinAbs(20.5f, 0.0001f));

    const Rml::Vector2f fractional_advance{two_x_origin.x + 0.375f, two_x_origin.y + 0.625f};
    CHECK_THAT(fractional_advance.x - two_x_origin.x, Catch::Matchers::WithinAbs(0.375f, 0.0001f));
    CHECK_THAT(fractional_advance.y - two_x_origin.y, Catch::Matchers::WithinAbs(0.625f, 0.0001f));
}

TEST_CASE("RmlUi Material textures support occurrence-only author-owned sources")
{
    const auto material = id<core::MaterialId>("ui-material");
    const core::PresentationMaterialTextureBinding occurrence{
        material, "s_detail", "project:/images/detail.png"};

    const auto occurrence_only = resolve_rmlui_material_texture(nullptr, &occurrence);
    REQUIRE(occurrence_only);
    CHECK(occurrence_only->source == "project:/images/detail.png");
    CHECK(occurrence_only->filtering == MaterialTextureSampler::ClampLinear);

    const MaterialTextureAssignment authored{"s_detail", "project:/images/base.png",
                                             MaterialTextureSampler::RepeatNearest};
    const auto overridden = resolve_rmlui_material_texture(&authored, &occurrence);
    REQUIRE(overridden);
    CHECK(overridden->source == "project:/images/detail.png");
    CHECK(overridden->filtering == MaterialTextureSampler::RepeatNearest);

    const auto authored_only = resolve_rmlui_material_texture(&authored, nullptr);
    REQUIRE(authored_only);
    CHECK(authored_only->source == "project:/images/base.png");
    CHECK(authored_only->filtering == MaterialTextureSampler::RepeatNearest);
    CHECK_FALSE(resolve_rmlui_material_texture(nullptr, nullptr));
}

TEST_CASE("RmlUi occurrence-time epochs are isolated by context and semantic occurrence")
{
    RmlUiMaterialOccurrenceEpochs epochs;
    const auto first = occurrence_time_parameter(1, core::compiled::LayoutSlot::Hud);
    const auto same_semantic_mount = occurrence_time_parameter(1, core::compiled::LayoutSlot::Hud);
    const auto occurrence_one = core::LayoutMountOccurrenceId::from_number(1);
    const auto occurrence_two = core::LayoutMountOccurrenceId::from_number(2);

    epochs.retain("context-a", occurrence_one, std::span{&first, 1});
    CHECK(epochs.elapsed("context-a", first, 10.0) == 0.0);
    CHECK(epochs.elapsed("context-a", first, 12.5) == 2.5);

    epochs.retain("context-b", occurrence_one, std::span{&first, 1});
    CHECK(epochs.elapsed("context-b", first, 12.5) == 0.0);
    CHECK(epochs.elapsed("context-a", first, 13.0) == 3.0);

    epochs.retain("context-a", occurrence_two, std::span{&same_semantic_mount, 1});
    CHECK(epochs.elapsed("context-a", same_semantic_mount, 13.0) == 0.0);
    CHECK(epochs.elapsed("context-a", same_semantic_mount, 14.0) == 1.0);

    epochs.retain("context-a", std::nullopt, {});
    epochs.retain("context-a", occurrence_two, std::span{&same_semantic_mount, 1});
    CHECK(epochs.elapsed("context-a", same_semantic_mount, 20.0) == 0.0);
}

} // namespace noveltea::ui::rmlui
