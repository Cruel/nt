#include <RmlUi/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/NovelTeaPatch.h>
#include <RmlUi/Core/RenderInterface.h>

#include <cmath>
#include <cstdio>
#include <string_view>

#ifndef RMLUI_NOVELTEA_PATCH_REVISION
#error "The repository-owned RmlUi patch marker is missing"
#endif

#ifndef NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION
#error "The expected RmlUi patch revision was not supplied by the NovelTea build"
#endif

static_assert(std::string_view(RMLUI_NOVELTEA_PATCH_REVISION) ==
              std::string_view(NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION));

namespace {

class HeadlessRenderInterface final : public Rml::RenderInterface {
public:
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override
    {
        return ++m_next_geometry;
    }

    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}

    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}

    Rml::TextureHandle LoadTexture(Rml::Vector2i& texture_dimensions, const Rml::String&) override
    {
        texture_dimensions = {0, 0};
        return 0;
    }

    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte>, Rml::Vector2i) override
    {
        return ++m_next_texture;
    }

    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}

private:
    Rml::CompiledGeometryHandle m_next_geometry = 0;
    Rml::TextureHandle m_next_texture = 0;
};

constexpr const char* kContextName = "noveltea-rmlui-media-query-patch-test";

constexpr const char* kDocument = R"(
<rml>
<head>
    <style>
        body {
            left: 0;
            top: 0;
            right: 0;
            bottom: 0;
            margin: 0;
        }

        div {
            display: block;
            width: 10px;
            height: 10px;
        }

        #viewport-units {
            width: 50vw;
            height: 25vh;
        }

        @media (min-width: 1100px) {
            #media-width { width: 20px; }
        }

        @media (min-height: 1500px) {
            #media-height { height: 30px; }
        }

        @media (orientation: portrait) {
            #media-orientation { width: 40px; }
        }

        @media (max-aspect-ratio: 3/4) {
            #media-aspect { height: 50px; }
        }

        @media (min-resolution: 2x) {
            #media-resolution {
                width: 60px;
                height: 70px;
            }
        }

        @media (min-width: 130vw) {
            #media-viewport-unit-threshold { width: 80px; }
        }
    </style>
</head>
<body>
    <div id="viewport-units"></div>
    <div id="media-width"></div>
    <div id="media-height"></div>
    <div id="media-orientation"></div>
    <div id="media-aspect"></div>
    <div id="media-resolution"></div>
    <div id="media-viewport-unit-threshold"></div>
</body>
</rml>
)";

int g_failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: %s\n", message);
        ++g_failures;
    }
}

bool NearlyEqual(float lhs, float rhs) { return std::fabs(lhs - rhs) <= 0.01F; }

void ExpectVector(Rml::Vector2i actual, Rml::Vector2i expected, const char* message)
{
    if (actual != expected) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: %s (actual=%d,%d expected=%d,%d)\n",
                     message, actual.x, actual.y, expected.x, expected.y);
        ++g_failures;
    }
}

void ExpectSize(Rml::Element* element, Rml::Vector2f expected, const char* message)
{
    if (!element) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: %s (missing element)\n", message);
        ++g_failures;
        return;
    }

    const Rml::Vector2f actual = element->GetBox().GetSize();
    if (!NearlyEqual(actual.x, expected.x) || !NearlyEqual(actual.y, expected.y)) {
        std::fprintf(stderr,
                     "[rmlui-media-query-patch] FAILED: %s (actual=%.2f,%.2f expected=%.2f,%.2f)\n",
                     message, actual.x, actual.y, expected.x, expected.y);
        ++g_failures;
    }
}

} // namespace

int main()
{
    HeadlessRenderInterface render_interface;
    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: RmlUi initialization failed\n");
        return 1;
    }

    Rml::Context* context =
        Rml::CreateContext(kContextName, Rml::Vector2i(1000, 800), &render_interface);
    if (!context) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: context creation failed\n");
        Rml::Shutdown();
        return 1;
    }

    Rml::ElementDocument* document = context->LoadDocumentFromMemory(kDocument);
    if (!document) {
        std::fprintf(stderr, "[rmlui-media-query-patch] FAILED: document load failed\n");
        Rml::RemoveContext(kContextName);
        Rml::Shutdown();
        return 1;
    }

    document->Show();
    Expect(context->Update(), "initial context update succeeds");

    Rml::Element* viewport_units = document->GetElementById("viewport-units");
    Rml::Element* media_width = document->GetElementById("media-width");
    Rml::Element* media_height = document->GetElementById("media-height");
    Rml::Element* media_orientation = document->GetElementById("media-orientation");
    Rml::Element* media_aspect = document->GetElementById("media-aspect");
    Rml::Element* media_resolution = document->GetElementById("media-resolution");
    Rml::Element* media_viewport_unit_threshold =
        document->GetElementById("media-viewport-unit-threshold");

    ExpectVector(context->GetDimensions(), {1000, 800},
                 "ordinary context dimensions retain the layout viewport");
    ExpectVector(context->GetMediaQueryDimensions(), {1000, 800},
                 "media-query dimensions default to ordinary context dimensions");
    ExpectSize(viewport_units, {500.0F, 200.0F},
               "default vw/vh values use ordinary context dimensions");
    ExpectSize(media_width, {10.0F, 10.0F},
               "default media width behavior matches upstream context dimensions");
    ExpectSize(media_height, {10.0F, 10.0F},
               "default media height behavior matches upstream context dimensions");
    ExpectSize(media_orientation, {10.0F, 10.0F},
               "default media orientation behavior matches upstream context dimensions");
    ExpectSize(media_aspect, {10.0F, 10.0F},
               "default media aspect behavior matches upstream context dimensions");
    ExpectSize(media_resolution, {10.0F, 10.0F},
               "media resolution does not derive from media dimensions");
    ExpectSize(media_viewport_unit_threshold, {10.0F, 10.0F},
               "media-query viewport units use ordinary layout dimensions by default");

    context->SetMediaQueryDimensions({1200, 1600});
    ExpectVector(context->GetMediaQueryDimensions(), {1200, 1600},
                 "media-query dimension override is observable");
    Expect(context->Update(), "context updates after setting media-query dimensions");
    ExpectSize(viewport_units, {500.0F, 200.0F},
               "media override does not change layout-sized vw/vh values");
    ExpectSize(media_width, {20.0F, 10.0F}, "media width uses the override and recompiles styles");
    ExpectSize(media_height, {10.0F, 30.0F},
               "media height uses the override and recompiles styles");
    ExpectSize(media_orientation, {40.0F, 10.0F}, "media orientation uses the override");
    ExpectSize(media_aspect, {10.0F, 50.0F}, "media aspect ratio uses the override");
    ExpectSize(media_resolution, {10.0F, 10.0F},
               "media resolution remains bound to the DP ratio under an override");
    ExpectSize(media_viewport_unit_threshold, {10.0F, 10.0F},
               "media-query viewport-unit thresholds remain layout-sized under an override");

    context->SetDimensions({800, 600});
    Expect(context->Update(), "context updates after layout dimensions change");
    ExpectVector(context->GetDimensions(), {800, 600},
                 "SetDimensions continues to own layout dimensions");
    ExpectVector(context->GetMediaQueryDimensions(), {1200, 1600},
                 "layout resize does not replace an active media override");
    ExpectSize(document, {800.0F, 600.0F}, "SetDimensions continues to own document box layout");
    ExpectSize(viewport_units, {400.0F, 150.0F},
               "vw/vh follow layout dimensions while a media override is active");
    ExpectSize(media_width, {20.0F, 10.0F},
               "media width remains bound to the active override after layout resize");
    ExpectSize(media_height, {10.0F, 30.0F},
               "media height remains bound to the active override after layout resize");
    ExpectSize(media_viewport_unit_threshold, {80.0F, 10.0F},
               "layout resize dirties media queries using viewport-unit thresholds");

    context->SetDensityIndependentPixelRatio(2.0F);
    Expect(context->Update(), "context updates after DP-ratio change");
    ExpectSize(media_resolution, {60.0F, 70.0F}, "media resolution uses the context DP ratio");

    context->ClearMediaQueryDimensions();
    ExpectVector(context->GetMediaQueryDimensions(), {800, 600},
                 "clearing the override restores ordinary context dimensions");
    Expect(context->Update(), "context updates after clearing media-query dimensions");
    ExpectSize(viewport_units, {400.0F, 150.0F},
               "clearing the override leaves layout-sized vw/vh unchanged");
    ExpectSize(media_width, {10.0F, 10.0F},
               "clearing the override recompiles media width against context dimensions");
    ExpectSize(media_height, {10.0F, 10.0F},
               "clearing the override recompiles media height against context dimensions");
    ExpectSize(media_orientation, {10.0F, 10.0F},
               "clearing the override restores context orientation behavior");
    ExpectSize(media_aspect, {10.0F, 10.0F},
               "clearing the override restores context aspect behavior");
    ExpectSize(media_resolution, {60.0F, 70.0F},
               "clearing dimensions does not change DP-ratio media resolution");

    context->SetDensityIndependentPixelRatio(1.0F);
    Expect(context->Update(), "context updates after restoring the DP ratio");
    ExpectSize(media_resolution, {10.0F, 10.0F},
               "restoring the DP ratio recompiles resolution media queries");

    document->Close();
    context->Update();
    Expect(Rml::RemoveContext(kContextName), "test context removal succeeds");
    Rml::Shutdown();

    if (g_failures == 0) {
        std::printf("[rmlui-media-query-patch] all checks passed\n");
        return 0;
    }

    std::fprintf(stderr, "[rmlui-media-query-patch] %d check(s) failed\n", g_failures);
    return 1;
}
