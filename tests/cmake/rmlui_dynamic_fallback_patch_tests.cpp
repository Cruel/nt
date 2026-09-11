#include <RmlUi/Core.h>
#include <RmlUi/Core/NovelTeaPatch.h>

#include <cstdio>
#include <filesystem>
#include <string_view>

#ifndef NOVELTEA_SOURCE_DIR
#error "NOVELTEA_SOURCE_DIR is required"
#endif

#ifndef NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION
#error "NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION is required"
#endif

namespace {

int failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-dynamic-fallback] FAILED: %s\n", message);
        ++failures;
    }
}

} // namespace

int main()
{
    static_assert(std::string_view(RMLUI_NOVELTEA_PATCH_REVISION) ==
                  std::string_view(NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION));

    if (!Rml::Initialise())
        return 1;

    const std::filesystem::path font_path = std::filesystem::path(NOVELTEA_SOURCE_DIR) /
                                            "engine/assets/system/fonts/LiberationSans.ttf";
    Expect(Rml::LoadFontFace(font_path.string(), "NovelTea Fallback A",
                             Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, false),
           "first fallback family loads without activating global fallback priority");
    Expect(Rml::LoadFontFace(font_path.string(), "NovelTea Fallback B",
                             Rml::Style::FontStyle::Normal, Rml::Style::FontWeight::Normal, false),
           "second fallback family loads without activating global fallback priority");

    Expect(Rml::SetFallbackFontFamilies({"NovelTea Fallback A", "NovelTea Fallback B"}),
           "loaded families can replace fallback priority atomically");
    Expect(!Rml::SetFallbackFontFamilies({"NovelTea Fallback A", "Missing Family"}),
           "replacement rejects an unavailable family instead of accepting a partial list");
    Expect(Rml::SetFallbackFontFamilies({"NovelTea Fallback B", "NovelTea Fallback A"}),
           "fallback priority can be replaced again without reloading faces");

    Rml::Shutdown();

    if (failures == 0) {
        std::printf("[rmlui-dynamic-fallback] all checks passed\n");
        return 0;
    }
    std::fprintf(stderr, "[rmlui-dynamic-fallback] %d check(s) failed\n", failures);
    return 1;
}
