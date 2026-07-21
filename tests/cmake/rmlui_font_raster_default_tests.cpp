#include <RmlUi/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/RenderInterface.h>

#include <algorithm>
#include <cstddef>
#include <cstdio>
#include <filesystem>
#include <string>

#ifndef NOVELTEA_SOURCE_DIR
#error "NOVELTEA_SOURCE_DIR is required"
#endif

namespace {

class TextureCaptureRenderInterface final : public Rml::RenderInterface {
public:
    void begin_capture()
    {
        captured_texture_count = 0;
        captured_opaque_pixels = 0;
        captured_total_pixels = 0;
    }

    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override
    {
        return ++next_geometry;
    }
    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}
    Rml::TextureHandle LoadTexture(Rml::Vector2i& dimensions, const Rml::String&) override
    {
        dimensions = {};
        return 0;
    }
    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte> source,
                                       Rml::Vector2i dimensions) override
    {
        ++captured_texture_count;
        captured_total_pixels += std::size_t(dimensions.x) * std::size_t(dimensions.y);
        for (std::size_t i = 3; i < source.size(); i += 4) {
            if (source[i] != 0)
                ++captured_opaque_pixels;
        }
        return ++next_texture;
    }
    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}

    std::size_t captured_texture_count = 0;
    std::size_t captured_opaque_pixels = 0;
    std::size_t captured_total_pixels = 0;

private:
    Rml::CompiledGeometryHandle next_geometry = 0;
    Rml::TextureHandle next_texture = 0;
};

constexpr const char* kDocument = R"(
<rml>
<head>
    <style>
        body { margin: 0; font-family: "Liberation Sans"; font-size: 24px; line-height: 28px; }
        #sample { position: absolute; left: 10px; top: 10px; width: 92px; }
    </style>
</head>
<body><div id="sample">Native glyph raster</div></body>
</rml>
)";

int failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-font-raster-default] FAILED: %s\n", message);
        ++failures;
    }
}

} // namespace

int main()
{
    TextureCaptureRenderInterface render_interface;
    if (!Rml::Initialise())
        return 1;

    const std::filesystem::path font_path =
        std::filesystem::path(NOVELTEA_SOURCE_DIR) / "apps/sandbox/assets/rmlui/LiberationSans.ttf";
    Expect(Rml::LoadFontFace(font_path.string(), true), "default FreeType font loads");

    Rml::Context* context =
        Rml::CreateContext("noveltea-font-raster-default", {240, 140}, &render_interface);
    Expect(context != nullptr, "context creation succeeds");
    if (!context) {
        Rml::Shutdown();
        return 1;
    }

    Rml::ElementDocument* document = context->LoadDocumentFromMemory(kDocument);
    Expect(document != nullptr, "document loads");
    if (document)
        document->Show();
    context->SetFontRasterScale(1.f);
    Expect(context->Update(), "1x layout update succeeds");

    Rml::Element* sample = document ? document->GetElementById("sample") : nullptr;
    Rml::ElementText* text = sample && sample->GetNumChildren() > 0
                                 ? rmlui_dynamic_cast<Rml::ElementText*>(sample->GetChild(0))
                                 : nullptr;
    Expect(sample != nullptr && text != nullptr, "sample text element is available");
    if (!sample || !text) {
        Rml::RemoveContext("noveltea-font-raster-default");
        Rml::Shutdown();
        return 1;
    }

    const Rml::Vector2f logical_box_size = sample->GetBox().GetSize();
    const std::size_t logical_line_count = text->GetLines().size();
    const float logical_font_size = sample->GetComputedValues().font_size();
    const Rml::FontFaceHandle one_x_handle = sample->GetFontFaceHandle();

    render_interface.begin_capture();
    context->Render();
    const std::size_t one_x_opaque_pixels = render_interface.captured_opaque_pixels;
    Expect(render_interface.captured_texture_count > 0 && one_x_opaque_pixels > 0,
           "1x rendering generates default-engine glyph atlas pixels");

    context->SetFontRasterScale(2.f);
    Rml::ReleaseFontRasterResources();
    Expect(context->Update(), "2x raster update succeeds");
    const Rml::FontFaceHandle two_x_handle = sample->GetFontFaceHandle();
    Expect(context->GetFontRasterScale() == 2.f, "context retains the 2x raster scale");
    Expect(two_x_handle != 0 && two_x_handle != one_x_handle,
           "default engine resolves a distinct 2x raster handle");
    Expect(sample->GetComputedValues().font_size() == logical_font_size,
           "2x rasterization preserves computed logical font size");
    Expect(sample->GetBox().GetSize() == logical_box_size,
           "2x rasterization preserves logical box geometry");
    Expect(text->GetLines().size() == logical_line_count,
           "2x rasterization preserves line wrapping");

    render_interface.begin_capture();
    context->Render();
    const std::size_t two_x_opaque_pixels = render_interface.captured_opaque_pixels;
    std::printf("[rmlui-font-raster-default] 1x handle=%zu 2x handle=%zu 1x opaque=%zu 2x "
                "opaque=%zu textures=%zu pixels=%zu\n",
                std::size_t(one_x_handle), std::size_t(two_x_handle), one_x_opaque_pixels,
                two_x_opaque_pixels, render_interface.captured_texture_count,
                render_interface.captured_total_pixels);
    Expect(render_interface.captured_texture_count > 0,
           "2x rendering regenerates default-engine glyph atlas textures");
    Expect(two_x_opaque_pixels > one_x_opaque_pixels * 2,
           "2x rendering materially increases generated glyph raster pixel coverage");

    if (document)
        document->Close();
    context->Update();
    Expect(Rml::RemoveContext("noveltea-font-raster-default"), "context removal succeeds");
    Rml::Shutdown();

    if (failures == 0) {
        std::printf("[rmlui-font-raster-default] all checks passed\n");
        return 0;
    }
    std::fprintf(stderr, "[rmlui-font-raster-default] %d check(s) failed\n", failures);
    return 1;
}
