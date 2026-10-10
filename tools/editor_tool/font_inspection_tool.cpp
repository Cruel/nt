#include "tooling_native.hpp"

#include <ft2build.h>
#include FT_FREETYPE_H

#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct LibraryCloser {
    void operator()(FT_LibraryRec_* library) const
    {
        if (library)
            FT_Done_FreeType(library);
    }
};

struct FaceCloser {
    void operator()(FT_FaceRec_* face) const
    {
        if (face)
            FT_Done_Face(face);
    }
};

noveltea::tooling::NativeOperationResult failure(std::string message)
{
    return {.exit_code = 1,
            .response_json = nlohmann::json{{"ok", false}, {"error", std::move(message)}}.dump()};
}

} // namespace

namespace noveltea::tooling {

NativeOperationResult inspect_font(std::string_view request_json)
{
    const auto request = nlohmann::json::parse(request_json, nullptr, false);
    if (!request.is_object() || !request.contains("path") || !request["path"].is_string())
        return failure("Font inspection requires an absolute file path.");

    const auto path_text = request["path"].get<std::string>();
    const auto filename = std::filesystem::path(std::u8string(path_text.begin(), path_text.end()));
    if (!filename.is_absolute())
        return failure("Font inspection requires an absolute file path.");

    std::ifstream input(filename, std::ios::binary | std::ios::ate);
    if (!input)
        return failure("Font source could not be opened.");
    const auto length = input.tellg();
    constexpr std::streamoff max_font_bytes = 32 * 1024 * 1024;
    if (length <= 0 || length > max_font_bytes ||
        length > static_cast<std::streamoff>(std::numeric_limits<FT_Long>::max()))
        return failure("Font source must be between 1 byte and 32 MiB.");
    input.seekg(0);
    std::vector<FT_Byte> bytes(static_cast<std::size_t>(length));
    input.read(reinterpret_cast<char*>(bytes.data()), length);
    if (!input)
        return failure("Font source could not be read completely.");

    FT_Library raw_library = nullptr;
    if (FT_Init_FreeType(&raw_library) != 0)
        return failure("FreeType initialization failed.");
    std::unique_ptr<FT_LibraryRec_, LibraryCloser> library(raw_library);

    FT_Face raw_face = nullptr;
    if (FT_New_Memory_Face(library.get(), bytes.data(), static_cast<FT_Long>(bytes.size()), 0,
                           &raw_face) != 0 ||
        raw_face == nullptr)
        return failure("FreeType could not parse the font face.");
    std::unique_ptr<FT_FaceRec_, FaceCloser> face(raw_face);
    if (face->num_glyphs <= 0)
        return failure("Font contains no glyphs.");
    if (FT_Select_Charmap(face.get(), FT_ENCODING_UNICODE) != 0)
        return failure("Font has no Unicode character map.");

    FT_UInt glyph_index = 0;
    (void)FT_Get_First_Char(face.get(), &glyph_index);
    if (glyph_index == 0 || glyph_index >= static_cast<FT_UInt>(face->num_glyphs))
        return failure("Font has no usable mapped glyphs.");
    if (FT_Set_Pixel_Sizes(face.get(), 0, 24) != 0)
        return failure("FreeType could not set a usable font size.");
    if (FT_Load_Glyph(face.get(), glyph_index, FT_LOAD_DEFAULT) != 0)
        return failure("FreeType could not load a mapped glyph.");

    return {.exit_code = 0,
            .response_json = nlohmann::json{{"ok", true}, {"glyphCount", face->num_glyphs}}.dump()};
}

} // namespace noveltea::tooling
