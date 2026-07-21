#include <RmlUi/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/FontEngineInterface.h>
#include <RmlUi/Core/NovelTeaPatch.h>
#include <RmlUi/Core/RenderInterface.h>

#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
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

class TrackingFontEngineInterface final : public Rml::FontEngineInterface {
public:
    Rml::FontFaceHandle GetFontFaceHandle(const Rml::String&, Rml::Style::FontStyle,
                                          Rml::Style::FontWeight, int size) override
    {
        ++m_handle_requests;
        return static_cast<Rml::FontFaceHandle>(size + 1);
    }

    int GetHandleRequests() const { return m_handle_requests; }

private:
    int m_handle_requests = 0;
};

constexpr const char* kDocument = R"(
<rml>
<head>
    <style>
        body {
            margin: 0;
            font-size: 10px;
            line-height: 125%;
        }

        div {
            display: block;
            height: 1px;
        }

        #px {
            font-size: 20px;
            line-height: 24px;
        }

        #em {
            font-size: 1.5em;
            line-height: 150%;
        }

        #percent {
            font-size: 50%;
            line-height: 2;
        }

        #rem {
            font-size: 2rem;
            line-height: 3rem;
        }

        #zero {
            font-size: 0px;
            line-height: 7px;
        }

        #layout {
            font-size: 10px;
            width: 10em;
        }
    </style>
</head>
<body>
    <div id="px">
        <div id="em">
            <div id="percent"></div>
        </div>
        <div id="inherited"></div>
    </div>
    <div id="rem"></div>
    <div id="zero"></div>
    <div id="layout"></div>
</body>
</rml>
)";

constexpr std::array<const char*, 8> kElementIds = {"",          "px",  "em",   "percent",
                                                    "inherited", "rem", "zero", "layout"};

using ComputedSnapshot = std::array<std::uint32_t, kElementIds.size() * 4>;

constexpr std::uint32_t FloatBits(float value) { return std::bit_cast<std::uint32_t>(value); }

// Bit-exact computed text values produced by the unpatched RmlUi 6.2 path for kDocument.
constexpr ComputedSnapshot kUpstreamDefaultSnapshot = {
    FloatBits(10.0F), FloatBits(12.5F),
    FloatBits(1.25F), static_cast<std::uint32_t>(Rml::Style::LineHeight::Number),
    FloatBits(20.0F), FloatBits(24.0F),
    FloatBits(24.0F), static_cast<std::uint32_t>(Rml::Style::LineHeight::Length),
    FloatBits(30.0F), FloatBits(45.0F),
    FloatBits(1.5F),  static_cast<std::uint32_t>(Rml::Style::LineHeight::Number),
    FloatBits(15.0F), FloatBits(30.0F),
    FloatBits(2.0F),  static_cast<std::uint32_t>(Rml::Style::LineHeight::Number),
    FloatBits(20.0F), FloatBits(24.0F),
    FloatBits(24.0F), static_cast<std::uint32_t>(Rml::Style::LineHeight::Length),
    FloatBits(20.0F), FloatBits(30.0F),
    FloatBits(30.0F), static_cast<std::uint32_t>(Rml::Style::LineHeight::Length),
    FloatBits(0.0F),  FloatBits(7.0F),
    FloatBits(7.0F),  static_cast<std::uint32_t>(Rml::Style::LineHeight::Length),
    FloatBits(10.0F), FloatBits(12.5F),
    FloatBits(1.25F), static_cast<std::uint32_t>(Rml::Style::LineHeight::Number),
};

int g_failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-text-scale-patch] FAILED: %s\n", message);
        ++g_failures;
    }
}

bool NearlyEqual(float lhs, float rhs) { return std::fabs(lhs - rhs) <= 0.01F; }

Rml::Element* GetElement(Rml::ElementDocument* document, const char* id)
{
    return id[0] == '\0' ? document : document->GetElementById(id);
}

void ExpectTextMetrics(Rml::ElementDocument* document, const char* id, float expected_font_size,
                       float expected_line_height, const char* message)
{
    Rml::Element* element = GetElement(document, id);
    if (!element) {
        std::fprintf(stderr, "[rmlui-text-scale-patch] FAILED: %s (missing element '%s')\n",
                     message, id);
        ++g_failures;
        return;
    }

    const float actual_font_size = element->GetComputedValues().font_size();
    const float actual_line_height = element->GetComputedValues().line_height().value;
    if (!NearlyEqual(actual_font_size, expected_font_size) ||
        !NearlyEqual(actual_line_height, expected_line_height)) {
        std::fprintf(stderr,
                     "[rmlui-text-scale-patch] FAILED: %s "
                     "(font=%.2f line=%.2f expected-font=%.2f expected-line=%.2f)\n",
                     message, actual_font_size, actual_line_height, expected_font_size,
                     expected_line_height);
        ++g_failures;
    }
}

ComputedSnapshot CaptureComputedSnapshot(Rml::ElementDocument* document)
{
    ComputedSnapshot result{};
    std::size_t index = 0;
    for (const char* id : kElementIds) {
        Rml::Element* element = GetElement(document, id);
        if (!element) {
            g_failures++;
            continue;
        }

        const auto line_height = element->GetComputedValues().line_height();
        result[index++] = std::bit_cast<std::uint32_t>(element->GetComputedValues().font_size());
        result[index++] = std::bit_cast<std::uint32_t>(line_height.value);
        result[index++] = std::bit_cast<std::uint32_t>(line_height.inherit_value);
        result[index++] = static_cast<std::uint32_t>(line_height.inherit_type);
    }
    return result;
}

Rml::ElementDocument* LoadDocument(Rml::Context* context)
{
    Rml::ElementDocument* document = context->LoadDocumentFromMemory(kDocument);
    if (!document)
        return nullptr;

    document->Show();
    return context->Update() ? document : nullptr;
}

void CloseDocument(Rml::Context* context, Rml::ElementDocument* document)
{
    if (document)
        document->Close();
    context->Update();
}

} // namespace

int main()
{
    HeadlessRenderInterface render_interface;
    TrackingFontEngineInterface font_engine;
    Rml::SetFontEngineInterface(&font_engine);

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[rmlui-text-scale-patch] FAILED: RmlUi initialization failed\n");
        return 1;
    }

    Rml::Context* context =
        Rml::CreateContext("noveltea-rmlui-text-scale-patch-test", {800, 600}, &render_interface);
    Expect(context != nullptr, "primary context creation succeeds");
    if (!context) {
        Rml::Shutdown();
        return 1;
    }

    Expect(NearlyEqual(context->GetTextScaleFactor(), 1.0F),
           "new contexts default to text scale factor 1.0");

    Rml::ElementDocument* document = LoadDocument(context);
    Expect(document != nullptr, "primary text-scale document loads and updates");
    if (!document) {
        Rml::RemoveContext(context->GetName());
        Rml::Shutdown();
        return 1;
    }

    ExpectTextMetrics(document, "", 10.0F, 12.5F,
                      "root px font and percentage line-height match upstream defaults");
    ExpectTextMetrics(document, "px", 20.0F, 24.0F,
                      "absolute px font and line-height match upstream defaults");
    ExpectTextMetrics(document, "em", 30.0F, 45.0F,
                      "nested em font and percentage line-height match upstream defaults");
    ExpectTextMetrics(document, "percent", 15.0F, 30.0F,
                      "nested percent font and numeric line-height match upstream defaults");
    ExpectTextMetrics(document, "inherited", 20.0F, 24.0F,
                      "inherited font and absolute line-height match upstream defaults");
    ExpectTextMetrics(document, "rem", 20.0F, 30.0F,
                      "rem font and line-height derive from the unscaled root at factor 1.0");
    ExpectTextMetrics(document, "zero", 0.0F, 7.0F,
                      "zero font size retains its independent absolute line-height");

    Rml::Element* layout = document->GetElementById("layout");
    Expect(layout != nullptr && NearlyEqual(layout->GetBox().GetSize().x, 100.0F),
           "em-sized layout uses the upstream-default computed font size");

    const ComputedSnapshot untouched_default_snapshot = CaptureComputedSnapshot(document);
    Expect(std::memcmp(kUpstreamDefaultSnapshot.data(), untouched_default_snapshot.data(),
                       sizeof(kUpstreamDefaultSnapshot)) == 0,
           "default factor 1.0 is byte-for-byte equivalent to unpatched RmlUi 6.2 computed values");
    const Rml::FontFaceHandle original_px_handle =
        document->GetElementById("px")->GetFontFaceHandle();
    const int original_handle_requests = font_engine.GetHandleRequests();
    Expect(original_px_handle != 0, "initial computed font face handle is populated");

    context->SetTextScaleFactor(2.0F);
    Expect(NearlyEqual(context->GetTextScaleFactor(), 2.0F),
           "context exposes the updated text scale factor");
    Expect(document->GetElementById("px")->GetFontFaceHandle() == 0,
           "changing text scale immediately dirties cached font face handles");
    ExpectTextMetrics(document, "px", 20.0F, 24.0F,
                      "computed text metrics remain unchanged until the next context update");

    Expect(context->Update(), "context update recompiles styles after text scale changes");
    ExpectTextMetrics(document, "", 20.0F, 25.0F,
                      "absolute root font scales once and percentage line-height follows it");
    ExpectTextMetrics(document, "px", 40.0F, 48.0F,
                      "absolute px font and line-height receive the factor once");
    ExpectTextMetrics(document, "em", 60.0F, 90.0F,
                      "nested em and percentage metrics derive from the scaled parent once");
    ExpectTextMetrics(document, "percent", 30.0F, 60.0F,
                      "nested percent font and numeric line-height do not double-scale");
    ExpectTextMetrics(document, "inherited", 40.0F, 48.0F,
                      "inherited font and absolute line-height do not double-scale");
    ExpectTextMetrics(document, "rem", 40.0F, 60.0F,
                      "rem font and line-height derive from the already-scaled document root");
    ExpectTextMetrics(document, "zero", 0.0F, 14.0F,
                      "absolute line-height recompiles even when scaled font size remains zero");
    Expect(layout != nullptr && NearlyEqual(layout->GetBox().GetSize().x, 200.0F),
           "font-relative layout is remeasured after text scale changes");
    Expect(document->GetElementById("px")->GetFontFaceHandle() != 0 &&
               document->GetElementById("px")->GetFontFaceHandle() != original_px_handle,
           "font face handles are recompiled for the scaled computed size");
    Expect(font_engine.GetHandleRequests() > original_handle_requests,
           "font engine receives new handle requests after text scale changes");

    context->SetTextScaleFactor(1.0F);
    Expect(context->Update(), "context update succeeds after resetting text scale to 1.0");
    const ComputedSnapshot reset_snapshot = CaptureComputedSnapshot(document);
    Expect(std::memcmp(untouched_default_snapshot.data(), reset_snapshot.data(),
                       sizeof(untouched_default_snapshot)) == 0,
           "resetting to 1.0 restores byte-for-byte identical computed text values");

    Rml::Context* explicit_one_context =
        Rml::CreateContext("noveltea-rmlui-text-scale-explicit-one", {800, 600}, &render_interface);
    Expect(explicit_one_context != nullptr, "explicit-one context creation succeeds");
    Rml::ElementDocument* explicit_one_document = nullptr;
    if (explicit_one_context) {
        explicit_one_context->SetTextScaleFactor(1.0F);
        explicit_one_document = LoadDocument(explicit_one_context);
        Expect(explicit_one_document != nullptr, "explicit-one document loads and updates");
        if (explicit_one_document) {
            const ComputedSnapshot explicit_one_snapshot =
                CaptureComputedSnapshot(explicit_one_document);
            Expect(
                std::memcmp(untouched_default_snapshot.data(), explicit_one_snapshot.data(),
                            sizeof(untouched_default_snapshot)) == 0,
                "explicit factor 1.0 is byte-for-byte equivalent to the untouched upstream path");
        }
    }

    CloseDocument(context, document);
    Expect(Rml::RemoveContext("noveltea-rmlui-text-scale-patch-test"),
           "primary context removal succeeds");
    if (explicit_one_context) {
        CloseDocument(explicit_one_context, explicit_one_document);
        Expect(Rml::RemoveContext("noveltea-rmlui-text-scale-explicit-one"),
               "explicit-one context removal succeeds");
    }

    Rml::Context* reset_context = Rml::CreateContext("noveltea-rmlui-text-scale-context-reset",
                                                     {800, 600}, &render_interface);
    Expect(reset_context != nullptr && NearlyEqual(reset_context->GetTextScaleFactor(), 1.0F),
           "a newly created context resets text scale to the default factor 1.0");
    if (reset_context)
        Expect(Rml::RemoveContext("noveltea-rmlui-text-scale-context-reset"),
               "reset context removal succeeds");

    Rml::Shutdown();
    Rml::SetFontEngineInterface(nullptr);

    if (g_failures == 0) {
        std::printf("[rmlui-text-scale-patch] all checks passed\n");
        return 0;
    }

    std::fprintf(stderr, "[rmlui-text-scale-patch] %d check(s) failed\n", g_failures);
    return 1;
}
