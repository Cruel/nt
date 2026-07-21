#include <RmlUi/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/ElementText.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/NovelTeaPatch.h>
#include <RmlUi/Core/RenderInterface.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string_view>
#include <unordered_map>
#include <unordered_set>

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
    Rml::TextureHandle LoadTexture(Rml::Vector2i& dimensions, const Rml::String&) override
    {
        dimensions = {};
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

class TrackingFontEngineInterface final : public Rml::FontEngineInterface {
public:
    struct HandleRecord {
        Rml::FontMetrics metrics{};
        float raster_scale = 1.f;
        int raster_size = 0;
        int version = 0;
    };

    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String&, Rml::Style::FontStyle,
                                          Rml::Style::FontWeight, int size,
                                          float raster_scale) override
    {
        const int raster_size = std::max(1, int(std::lround(float(size) * raster_scale)));
        const std::uint64_t key =
            (std::uint64_t(std::uint32_t(size)) << 32) | std::uint32_t(raster_size);
        if (const auto found = m_handle_cache.find(key); found != m_handle_cache.end())
            return found->second;

        const Rml::FontFaceHandle handle = ++m_next_handle;
        HandleRecord record;
        record.metrics.size = size;
        record.metrics.ascent = float(size) * 0.8f;
        record.metrics.descent = float(size) * 0.2f;
        record.metrics.line_spacing = float(size);
        record.metrics.x_height = float(size) * 0.5f;
        record.metrics.underline_position = 1.f;
        record.metrics.underline_thickness = 1.f;
        record.metrics.has_ellipsis = true;
        record.raster_scale = raster_scale;
        record.raster_size = raster_size;
        record.version = int(handle);
        m_active_raster_sizes.insert(record.raster_size);
        m_handles.emplace(handle, record);
        m_handle_cache.emplace(key, handle);
        return handle;
    }

    const Rml::FontMetrics& GetFontMetrics(Rml::FontFaceHandle handle) override
    {
        return m_handles.at(handle).metrics;
    }

    int GetStringWidth(Rml::FontFaceHandle handle, Rml::StringView string,
                       const Rml::TextShapingContext&, Rml::Character) override
    {
        const int character_width = std::max(1, m_handles.at(handle).metrics.size / 2);
        return int(string.size()) * character_width;
    }

    int GenerateString(Rml::RenderManager&, Rml::FontFaceHandle handle, Rml::FontEffectsHandle,
                       Rml::StringView string, Rml::Vector2f, Rml::ColourbPremultiplied, float,
                       const Rml::TextShapingContext& context, Rml::TexturedMeshList&) override
    {
        m_last_generated_handle = handle;
        return GetStringWidth(handle, string, context, Rml::Character::Null);
    }

    int GetVersion(Rml::FontFaceHandle handle) override { return m_handles.at(handle).version; }

    void ReleaseFontResources() override
    {
        ++m_release_count;
        m_handles.clear();
        m_handle_cache.clear();
        m_active_raster_sizes.clear();
    }

    const HandleRecord& record(Rml::FontFaceHandle handle) const { return m_handles.at(handle); }
    int release_count() const { return m_release_count; }
    std::size_t active_raster_size_count() const { return m_active_raster_sizes.size(); }
    bool has_active_raster_size(int size) const { return m_active_raster_sizes.contains(size); }
    Rml::FontFaceHandle last_generated_handle() const { return m_last_generated_handle; }

private:
    Rml::FontFaceHandle m_next_handle = 0;
    Rml::FontFaceHandle m_last_generated_handle = 0;
    int m_release_count = 0;
    std::unordered_map<Rml::FontFaceHandle, HandleRecord> m_handles;
    std::unordered_map<std::uint64_t, Rml::FontFaceHandle> m_handle_cache;
    std::unordered_set<int> m_active_raster_sizes;
};

constexpr const char* kDocument = R"(
<rml>
<head>
    <style>
        body { margin: 0; font-family: test; font-size: 20px; line-height: 20px; }
        #wrapped { position: absolute; left: 10px; top: 10px; width: 55px; }
    </style>
</head>
<body><div id="wrapped">aaaa aaaa</div></body>
</rml>
)";

int g_failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-font-raster-scale-patch] FAILED: %s\n", message);
        ++g_failures;
    }
}

bool IsDescendantOrSelf(Rml::Element* element, Rml::Element* ancestor)
{
    while (element) {
        if (element == ancestor)
            return true;
        element = element->GetParentNode();
    }
    return false;
}

} // namespace

int main()
{
    HeadlessRenderInterface render_interface;
    TrackingFontEngineInterface font_engine;
    Rml::SetFontEngineInterface(&font_engine);
    if (!Rml::Initialise())
        return 1;

    Rml::Context* context =
        Rml::CreateContext("noveltea-font-raster-scale", {200, 120}, &render_interface);
    Expect(context != nullptr, "context creation succeeds");
    if (!context) {
        Rml::Shutdown();
        Rml::SetFontEngineInterface(nullptr);
        return 1;
    }

    Expect(context->GetFontRasterScale() == 1.f, "new contexts default to font raster scale 1x");
    Rml::ElementDocument* document = context->LoadDocumentFromMemory(kDocument);
    Expect(document != nullptr, "document loads");
    if (document)
        document->Show();
    Expect(document && context->Update(), "document performs initial layout");

    Rml::Element* wrapped = document ? document->GetElementById("wrapped") : nullptr;
    Rml::ElementText* text = wrapped && wrapped->GetNumChildren() > 0
                                 ? rmlui_dynamic_cast<Rml::ElementText*>(wrapped->GetChild(0))
                                 : nullptr;
    Expect(wrapped != nullptr && text != nullptr, "wrapped text element is available");
    if (!wrapped || !text) {
        Rml::RemoveContext("noveltea-font-raster-scale");
        Rml::Shutdown();
        Rml::SetFontEngineInterface(nullptr);
        return 1;
    }

    const float logical_font_size = wrapped->GetComputedValues().font_size();
    const Rml::Vector2f box_size = wrapped->GetBox().GetSize();
    const std::size_t line_count = text->GetLines().size();
    const Rml::FontFaceHandle one_x_handle = wrapped->GetFontFaceHandle();
    Expect(one_x_handle != 0, "1x logical font handle resolves");
    Expect(font_engine.record(one_x_handle).metrics.size == 20,
           "1x request retains the logical font size");
    Expect(font_engine.record(one_x_handle).raster_size == 20,
           "1x request uses a 20-pixel raster size");
    Expect(line_count >= 2, "logical text wraps into multiple lines");

    context->ProcessMouseMove(15, 15, 0);
    Expect(IsDescendantOrSelf(context->GetHoverElement(), wrapped),
           "1x hit testing reaches the logical wrapped element");

    context->SetFontRasterScale(2.f);
    Expect(context->GetFontRasterScale() == 2.f, "context accepts a 2x font raster scale");
    Expect(wrapped->GetFontFaceHandle() == 0,
           "changing font raster scale immediately invalidates the face handle");
    Expect(wrapped->GetComputedValues().font_size() == logical_font_size,
           "changing font raster scale does not change computed logical font size");
    Expect(context->Update(), "2x font raster update succeeds");

    const Rml::FontFaceHandle two_x_handle = wrapped->GetFontFaceHandle();
    Expect(two_x_handle != 0 && two_x_handle != one_x_handle,
           "2x resolves a distinct exact raster handle");
    Expect(font_engine.record(two_x_handle).metrics.size == 20,
           "2x request preserves the 20-pixel logical size");
    Expect(font_engine.record(two_x_handle).raster_size == 40,
           "2x request selects a 40-pixel raster resource");
    Expect(wrapped->GetBox().GetSize() == box_size,
           "2x rasterization preserves logical box geometry");
    Expect(text->GetLines().size() == line_count, "2x rasterization preserves line wrapping");
    context->ProcessMouseMove(15, 15, 0);
    Expect(IsDescendantOrSelf(context->GetHoverElement(), wrapped),
           "2x rasterization preserves hit-test geometry");
    context->Render();
    Expect(font_engine.last_generated_handle() == two_x_handle,
           "rendering consumes the 2x raster handle");

    context->SetFontRasterScale(1.f);
    Rml::ReleaseFontRasterResources();
    Expect(font_engine.release_count() == 1,
           "explicit font cache collection releases stale raster sizes");
    const Rml::FontFaceHandle reset_handle = wrapped->GetFontFaceHandle();
    Expect(reset_handle != 0 && font_engine.record(reset_handle).raster_size == 20,
           "resetting to 1x rebuilds the exact active raster size");
    Expect(font_engine.has_active_raster_size(20) && !font_engine.has_active_raster_size(40) &&
               font_engine.active_raster_size_count() < 4,
           "font-resource collection removes stale density-specific raster sizes");
    Expect(wrapped->GetComputedValues().font_size() == logical_font_size &&
               wrapped->GetBox().GetSize() == box_size && text->GetLines().size() == line_count,
           "cache collection and 1x reset preserve all logical text geometry");

    context->SetFontRasterScale(0.f);
    Expect(context->GetFontRasterScale() == 1.f, "non-positive raster scales are ignored");

    if (document)
        document->Close();
    context->Update();
    Expect(Rml::RemoveContext("noveltea-font-raster-scale"), "context removal succeeds");
    Rml::Shutdown();
    Rml::SetFontEngineInterface(nullptr);

    if (g_failures == 0) {
        std::printf("[rmlui-font-raster-scale-patch] all checks passed\n");
        return 0;
    }
    std::fprintf(stderr, "[rmlui-font-raster-scale-patch] %d check(s) failed\n", g_failures);
    return 1;
}
