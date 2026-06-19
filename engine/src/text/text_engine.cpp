#include "text/text_engine.hpp"

#include <SheenBidi/SBAlgorithm.h>
#include <SheenBidi/SBCodepointSequence.h>
#include <SheenBidi/SBLine.h>
#include <SheenBidi/SBParagraph.h>
#include <SheenBidi/SBRun.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_GLYPH_H
#include <graphemebreak.h>
#include <hb-ft.h>
#include <hb.h>
#include <linebreak.h>
#include <wordbreak.h>

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <string_view>
#include <utility>

namespace noveltea::text {
namespace {

struct FtLibraryDeleter {
    void operator()(FT_Library library) const
    {
        if (library) {
            FT_Done_FreeType(library);
        }
    }
};

struct FtFaceDeleter {
    void operator()(FT_Face face) const
    {
        if (face) {
            FT_Done_Face(face);
        }
    }
};

struct HbFaceDeleter {
    void operator()(hb_face_t* face) const
    {
        if (face) {
            hb_face_destroy(face);
        }
    }
};

struct HbFontDeleter {
    void operator()(hb_font_t* font) const
    {
        if (font) {
            hb_font_destroy(font);
        }
    }
};

struct SbAlgorithmDeleter {
    void operator()(SBAlgorithmRef algorithm) const
    {
        if (algorithm) {
            SBAlgorithmRelease(algorithm);
        }
    }
};

struct SbParagraphDeleter {
    void operator()(SBParagraphRef paragraph) const
    {
        if (paragraph) {
            SBParagraphRelease(paragraph);
        }
    }
};

struct SbLineDeleter {
    void operator()(SBLineRef line) const
    {
        if (line) {
            SBLineRelease(line);
        }
    }
};

using FtLibraryPtr = std::unique_ptr<std::remove_pointer_t<FT_Library>, FtLibraryDeleter>;
using FtFacePtr = std::unique_ptr<std::remove_pointer_t<FT_Face>, FtFaceDeleter>;
using HbFacePtr = std::unique_ptr<hb_face_t, HbFaceDeleter>;
using HbFontPtr = std::unique_ptr<hb_font_t, HbFontDeleter>;
using SbAlgorithmPtr = std::unique_ptr<std::remove_pointer_t<SBAlgorithmRef>, SbAlgorithmDeleter>;
using SbParagraphPtr = std::unique_ptr<std::remove_pointer_t<SBParagraphRef>, SbParagraphDeleter>;
using SbLinePtr = std::unique_ptr<std::remove_pointer_t<SBLineRef>, SbLineDeleter>;

struct FontResource {
    FontDesc desc;
    std::vector<uint8_t> bytes;
    FtFacePtr ft_face;
    HbFacePtr hb_face;
    HbFontPtr hb_font;
};

struct ShapedGlyphData {
    uint32_t glyph_id = 0;
    uint32_t cluster = 0;
    Vec2 advance{};
    Vec2 offset{};
};

struct ShapedData {
    std::vector<ShapedGlyphData> glyphs;
    float width = 0.0f;
};

struct BreakData {
    std::vector<char> line;
    std::vector<char> grapheme;
    std::vector<char> word;
};

uint32_t checked_u32(size_t value)
{
    return value > std::numeric_limits<uint32_t>::max() ? std::numeric_limits<uint32_t>::max()
                                                        : static_cast<uint32_t>(value);
}

std::string logical_font_path(const std::filesystem::path& path)
{
    const std::string requested = path.generic_string();
    return requested.find(":/") == std::string::npos ? "project:/" + requested : requested;
}

SBLevel base_level(TextDirection direction)
{
    switch (direction) {
    case TextDirection::LeftToRight:
        return 0;
    case TextDirection::RightToLeft:
        return 1;
    case TextDirection::Auto:
        return SBLevelDefaultLTR;
    }
    return SBLevelDefaultLTR;
}

hb_direction_t hb_direction(TextDirection direction)
{
    return direction == TextDirection::RightToLeft ? HB_DIRECTION_RTL : HB_DIRECTION_LTR;
}

TextDirection direction_from_level(SBLevel level)
{
    return (level & 1u) ? TextDirection::RightToLeft : TextDirection::LeftToRight;
}

FT_Int32 ft_load_flags(HintingMode hinting)
{
    FT_Int32 flags = FT_LOAD_DEFAULT;
    switch (hinting) {
    case HintingMode::None:
        flags |= FT_LOAD_NO_HINTING;
        break;
    case HintingMode::Light:
        flags |= FT_LOAD_TARGET_LIGHT;
        break;
    case HintingMode::Monochrome:
        flags |= FT_LOAD_TARGET_MONO;
        break;
    case HintingMode::Default:
        break;
    }
    return flags;
}

bool set_size(FontResource& font, float pixel_size)
{
    const auto pixels = static_cast<FT_UInt>(normalize_raster_pixel_size(pixel_size));
    if (FT_Set_Pixel_Sizes(font.ft_face.get(), 0, pixels) != 0) {
        return false;
    }
    hb_ft_font_changed(font.hb_font.get());
    return true;
}

FontMetrics metrics_for(FontResource& font, float pixel_size)
{
    FontMetrics result;
    if (!set_size(font, pixel_size) || !font.ft_face->size) {
        return result;
    }
    const FT_Size_Metrics& metrics = font.ft_face->size->metrics;
    result.ascender = static_cast<float>(metrics.ascender) / 64.0f;
    result.descender = static_cast<float>(metrics.descender) / 64.0f;
    result.line_height = static_cast<float>(metrics.height) / 64.0f;
    result.line_gap = result.line_height - (result.ascender - result.descender);
    return result;
}

BreakData collect_breaks(std::string_view value, const std::string& language)
{
    static bool initialized = false;
    if (!initialized) {
        init_linebreak();
        init_graphemebreak();
        init_wordbreak();
        initialized = true;
    }

    BreakData breaks;
    breaks.line.assign(value.size(), LINEBREAK_NOBREAK);
    breaks.grapheme.assign(value.size(), GRAPHEMEBREAK_NOBREAK);
    breaks.word.assign(value.size(), WORDBREAK_NOBREAK);
    if (!value.empty()) {
        const auto* data = reinterpret_cast<const utf8_t*>(value.data());
        const char* lang = language.empty() ? "und" : language.c_str();
        set_linebreaks_utf8(data, value.size(), lang, breaks.line.data());
        set_graphemebreaks_utf8(data, value.size(), lang, breaks.grapheme.data());
        set_wordbreaks_utf8(data, value.size(), lang, breaks.word.data());
    }
    return breaks;
}

bool valid_boundary(size_t offset, std::string_view value, const BreakData& breaks,
                    const std::set<uint32_t>& clusters)
{
    if (offset == 0 || offset >= value.size()) {
        return offset == 0 || offset == value.size();
    }
    if (!is_utf8_boundary(value, offset)) {
        return false;
    }
    const auto marker_index = unibreak_marker_index_for_boundary(value, offset);
    if (!marker_index || breaks.grapheme[*marker_index] != GRAPHEMEBREAK_BREAK) {
        return false;
    }
    return clusters.contains(checked_u32(offset));
}

bool legal_wrap_boundary(size_t offset, std::string_view value, const BreakData& breaks,
                         const std::set<uint32_t>& clusters)
{
    if (!valid_boundary(offset, value, breaks, clusters)) {
        return false;
    }
    const auto marker_index = unibreak_marker_index_for_boundary(value, offset);
    return marker_index && (breaks.line[*marker_index] == LINEBREAK_ALLOWBREAK ||
                            breaks.line[*marker_index] == LINEBREAK_MUSTBREAK);
}

std::vector<uint32_t> cluster_ends(const std::vector<ShapedGlyphData>& glyphs, uint32_t run_end)
{
    std::vector<uint32_t> clusters;
    clusters.reserve(glyphs.size() + 1);
    for (const auto& glyph : glyphs) {
        clusters.push_back(glyph.cluster);
    }
    clusters.push_back(run_end);
    std::sort(clusters.begin(), clusters.end());
    clusters.erase(std::unique(clusters.begin(), clusters.end()), clusters.end());
    return clusters;
}

uint32_t source_end_for_cluster(uint32_t cluster, const std::vector<uint32_t>& sorted_clusters,
                                uint32_t run_end)
{
    auto it = std::upper_bound(sorted_clusters.begin(), sorted_clusters.end(), cluster);
    return it == sorted_clusters.end() ? run_end : *it;
}

} // namespace

uint32_t normalize_raster_pixel_size(float pixel_size)
{
    if (!std::isfinite(pixel_size)) {
        return 1;
    }
    return static_cast<uint32_t>(std::max(1.0f, std::round(pixel_size)));
}

uint32_t glyph_cache_pixel_size_key(float pixel_size)
{
    return normalize_raster_pixel_size(pixel_size);
}

bool is_utf8_boundary(std::string_view value, size_t offset)
{
    if (offset > value.size()) {
        return false;
    }
    if (offset == 0 || offset == value.size()) {
        return true;
    }
    return (static_cast<unsigned char>(value[offset]) & 0xC0u) != 0x80u;
}

std::optional<size_t> unibreak_marker_index_for_boundary(std::string_view value, size_t offset)
{
    if (offset == 0 || offset == value.size()) {
        return std::nullopt;
    }
    if (!is_utf8_boundary(value, offset)) {
        return std::nullopt;
    }
    return offset - 1u;
}

GlyphAtlasUpload make_padded_glyph_upload(const GlyphBitmap& bitmap, uint16_t padding)
{
    GlyphAtlasUpload upload;
    upload.width = static_cast<uint16_t>(bitmap.width + padding * 2u);
    upload.height = static_cast<uint16_t>(bitmap.height + padding * 2u);
    upload.glyph_x = padding;
    upload.glyph_y = padding;
    upload.rgba.assign(static_cast<size_t>(upload.width) * upload.height * 4u, 0);
    for (uint32_t y = 0; y < bitmap.height; ++y) {
        for (uint32_t x = 0; x < bitmap.width; ++x) {
            const size_t src = static_cast<size_t>(y) * bitmap.width + x;
            const size_t dst = (static_cast<size_t>(y + padding) * upload.width + x + padding) * 4u;
            upload.rgba[dst + 0u] = 255;
            upload.rgba[dst + 1u] = 255;
            upload.rgba[dst + 2u] = 255;
            upload.rgba[dst + 3u] = bitmap.coverage[src];
        }
    }
    return upload;
}

struct TextEngine::Impl {
    explicit Impl(const assets::AssetManager& asset_manager) : assets(asset_manager)
    {
        FT_Library raw = nullptr;
        if (FT_Init_FreeType(&raw) == 0) {
            library.reset(raw);
        }
    }

    const assets::AssetManager& assets;
    FtLibraryPtr library;
    mutable std::unordered_map<uint32_t, FontResource> fonts;
    uint32_t next_id = 1;

    FontResource* find(FontHandle handle) const
    {
        auto it = fonts.find(handle.id);
        return it == fonts.end() ? nullptr : &it->second;
    }

    ShapedData shape(const Text& text, uint32_t begin, uint32_t end, TextDirection direction,
                     float physical_size, float inverse_scale) const
    {
        ShapedData shaped;
        FontResource* font = find(text.font);
        if (!font || begin >= end || end > text.value.size() || !set_size(*font, physical_size)) {
            return shaped;
        }

        hb_buffer_t* buffer = hb_buffer_create();
        hb_buffer_add_utf8(buffer, text.value.data(), static_cast<int>(text.value.size()),
                           static_cast<unsigned>(begin), static_cast<int>(end - begin));
        hb_buffer_set_direction(buffer, hb_direction(direction));
        hb_buffer_set_language(
            buffer,
            hb_language_from_string(text.language.c_str(), static_cast<int>(text.language.size())));
        hb_buffer_guess_segment_properties(buffer);
        hb_shape(font->hb_font.get(), buffer, nullptr, 0);

        unsigned glyph_count = 0;
        const hb_glyph_info_t* infos = hb_buffer_get_glyph_infos(buffer, &glyph_count);
        const hb_glyph_position_t* positions = hb_buffer_get_glyph_positions(buffer, &glyph_count);
        shaped.glyphs.reserve(glyph_count);
        for (unsigned i = 0; i < glyph_count; ++i) {
            ShapedGlyphData glyph;
            glyph.glyph_id = infos[i].codepoint;
            glyph.cluster = infos[i].cluster;
            glyph.advance = {static_cast<float>(positions[i].x_advance) / 64.0f * inverse_scale,
                             -static_cast<float>(positions[i].y_advance) / 64.0f * inverse_scale};
            glyph.offset = {static_cast<float>(positions[i].x_offset) / 64.0f * inverse_scale,
                            -static_cast<float>(positions[i].y_offset) / 64.0f * inverse_scale};
            shaped.width += glyph.advance.x;
            shaped.glyphs.push_back(glyph);
        }
        hb_buffer_destroy(buffer);
        return shaped;
    }

    float range_width(const Text& text, uint32_t begin, uint32_t end, TextDirection direction,
                      float physical_size, float inverse_scale) const
    {
        return shape(text, begin, end, direction, physical_size, inverse_scale).width;
    }
};

TextEngine::TextEngine(const assets::AssetManager& assets) : m_impl(std::make_unique<Impl>(assets))
{
}

TextEngine::~TextEngine() = default;

bool TextEngine::valid() const { return m_impl && m_impl->library; }

FontHandle TextEngine::load_font(const FontDesc& desc)
{
    if (!valid()) {
        return {};
    }

    const std::string logical_path = logical_font_path(desc.asset_path);
    auto bytes = m_impl->assets.read_binary(logical_path);
    if (!bytes || bytes.value->bytes.empty()) {
        std::fprintf(stderr, "[text] failed to load font: %s (%s)\n", logical_path.c_str(),
                     bytes.error.c_str());
        return {};
    }

    FontResource font;
    font.desc = desc;
    font.bytes = std::move(bytes.value->bytes);

    FT_Face raw_face = nullptr;
    const FT_Error face_error = FT_New_Memory_Face(
        m_impl->library.get(), font.bytes.data(), static_cast<FT_Long>(font.bytes.size()),
        static_cast<FT_Long>(desc.face_index), &raw_face);
    if (face_error != 0 || !raw_face) {
        std::fprintf(stderr, "[text] FreeType failed to create face: %s\n", logical_path.c_str());
        return {};
    }
    font.ft_face.reset(raw_face);
    font.hb_face.reset(hb_ft_face_create_referenced(font.ft_face.get()));
    font.hb_font.reset(hb_ft_font_create_referenced(font.ft_face.get()));
    if (!font.hb_face || !font.hb_font) {
        return {};
    }

    const uint32_t id = m_impl->next_id++;
    m_impl->fonts.emplace(id, std::move(font));
    return FontHandle{id};
}

TextMetrics TextEngine::measure_text(FontHandle font, std::string_view value, float size) const
{
    Text text;
    text.font = font;
    text.value = std::string(value);
    text.style.size = size;
    text.wrap = TextWrap::NoWrap;
    return measure_text(text);
}

TextMetrics TextEngine::measure_text(const Text& text) const { return layout_text(text).metrics; }

TextLayout TextEngine::layout_text(const Text& text) const { return layout_text(text, 1.0f); }

TextLayout TextEngine::layout_text(const Text& text, float scale) const
{
    TextLayout layout;
    layout.bounds = text.bounds;
    layout.style = text.style;
    layout.align = text.align;
    layout.transform = text.transform;
    FontResource* font = m_impl->find(text.font);
    if (!font || text.value.empty()) {
        return layout;
    }

    const float effective_scale = std::isfinite(scale) && scale > 0.0f ? scale : 1.0f;
    const float physical_size =
        static_cast<float>(normalize_raster_pixel_size(text.style.size * effective_scale));
    const float inverse_scale =
        text.style.size > 0.0f ? text.style.size / physical_size : 1.0f / effective_scale;
    const FontMetrics physical_font_metrics = metrics_for(*font, physical_size);
    const FontMetrics font_metrics{
        physical_font_metrics.ascender * inverse_scale,
        physical_font_metrics.descender * inverse_scale,
        physical_font_metrics.line_gap * inverse_scale,
        physical_font_metrics.line_height * inverse_scale,
    };
    const float line_height = std::max(font_metrics.line_height, text.style.size);
    const BreakData breaks = collect_breaks(text.value, text.language);
    const SBCodepointSequence sequence{SBStringEncodingUTF8, text.value.data(), text.value.size()};
    SbAlgorithmPtr algorithm(SBAlgorithmCreate(&sequence));
    if (!algorithm) {
        return layout;
    }
    SbParagraphPtr paragraph(SBAlgorithmCreateParagraph(algorithm.get(), 0, text.value.size(),
                                                        base_level(text.direction)));
    if (!paragraph) {
        return layout;
    }

    const TextDirection paragraph_direction =
        direction_from_level(SBParagraphGetBaseLevel(paragraph.get()));
    layout.direction = paragraph_direction;
    const float wrap_width =
        text.wrap == TextWrap::Word && text.bounds.width > 0.0f ? text.bounds.width : 0.0f;
    const auto all_shaped = m_impl->shape(text, 0, checked_u32(text.value.size()),
                                          paragraph_direction, physical_size, inverse_scale);
    std::set<uint32_t> cluster_boundaries;
    cluster_boundaries.insert(0);
    cluster_boundaries.insert(checked_u32(text.value.size()));
    for (const auto& glyph : all_shaped.glyphs) {
        cluster_boundaries.insert(glyph.cluster);
    }

    uint32_t line_begin = 0;
    while (line_begin < text.value.size()) {
        uint32_t mandatory_end = checked_u32(text.value.size());
        for (uint32_t i = line_begin; i < text.value.size(); ++i) {
            if (text.value[i] == '\n') {
                mandatory_end = i;
                break;
            }
        }

        uint32_t line_end = mandatory_end;
        if (wrap_width > 0.0f) {
            float best_width = 0.0f;
            uint32_t best = line_begin;
            for (uint32_t candidate = line_begin + 1; candidate <= mandatory_end; ++candidate) {
                if (candidate < mandatory_end &&
                    !legal_wrap_boundary(candidate, text.value, breaks, cluster_boundaries)) {
                    continue;
                }
                const float width = m_impl->range_width(
                    text, line_begin, candidate, paragraph_direction, physical_size, inverse_scale);
                if (width <= wrap_width || best == line_begin) {
                    best = candidate;
                    best_width = width;
                }
                if (width > wrap_width && best != candidate) {
                    break;
                }
            }
            line_end = best > line_begin ? best : mandatory_end;
            if (best_width <= 0.0f && line_end > line_begin) {
                best_width = m_impl->range_width(text, line_begin, line_end, paragraph_direction,
                                                 physical_size, inverse_scale);
            }
            (void)best_width;
        }

        SbLinePtr bidi_line(
            SBParagraphCreateLine(paragraph.get(), line_begin, line_end - line_begin));
        TextLine line;
        line.source_byte_begin = line_begin;
        line.source_byte_end = line_end;
        line.baseline = text.bounds.y + font_metrics.ascender +
                        static_cast<float>(layout.lines.size()) * line_height;

        if (bidi_line) {
            const SBRun* runs = SBLineGetRunsPtr(bidi_line.get());
            const SBUInteger run_count = SBLineGetRunCount(bidi_line.get());
            for (SBUInteger run_index = 0; run_index < run_count; ++run_index) {
                const SBRun& run = runs[run_index];
                const uint32_t run_begin = checked_u32(run.offset);
                const uint32_t run_end = checked_u32(run.offset + run.length);
                const TextDirection run_direction = direction_from_level(run.level);
                auto shaped = m_impl->shape(text, run_begin, run_end, run_direction, physical_size,
                                            inverse_scale);
                auto sorted_clusters = cluster_ends(shaped.glyphs, run_end);
                ShapedRun visual_run;
                visual_run.source_byte_begin = run_begin;
                visual_run.source_byte_end = run_end;
                visual_run.direction = run_direction;
                visual_run.bidi_level = run.level;
                visual_run.glyphs.reserve(shaped.glyphs.size());
                float pen_x = text.bounds.x + line.width;
                for (const auto& glyph : shaped.glyphs) {
                    PositionedGlyph positioned;
                    positioned.glyph_id = glyph.glyph_id;
                    positioned.source_byte_begin = glyph.cluster;
                    positioned.source_byte_end =
                        source_end_for_cluster(glyph.cluster, sorted_clusters, run_end);
                    positioned.position = {pen_x, line.baseline};
                    positioned.advance = glyph.advance;
                    positioned.offset = glyph.offset;
                    positioned.font = text.font;
                    positioned.logical_pixel_size = text.style.size;
                    positioned.raster_pixel_size = physical_size;
                    visual_run.glyphs.push_back(positioned);
                    pen_x += glyph.advance.x;
                }
                line.width += shaped.width;
                line.visual_runs.push_back(std::move(visual_run));
            }
        }

        float align_offset = 0.0f;
        const bool final_line = line_end >= text.value.size();
        const float box_width = text.bounds.width > 0.0f ? text.bounds.width : line.width;
        const TextAlign effective_align = text.align;
        if (box_width > line.width) {
            if (effective_align == TextAlign::Center) {
                align_offset = (box_width - line.width) * 0.5f;
            } else if ((effective_align == TextAlign::End &&
                        paragraph_direction == TextDirection::LeftToRight) ||
                       (effective_align == TextAlign::Start &&
                        paragraph_direction == TextDirection::RightToLeft)) {
                align_offset = box_width - line.width;
            } else if (effective_align == TextAlign::Justify && !final_line) {
                uint32_t spaces = 0;
                for (uint32_t i = line.source_byte_begin; i < line.source_byte_end; ++i) {
                    if (text.value[i] == ' ') {
                        ++spaces;
                    }
                }
                if (spaces > 0) {
                    const float extra = (box_width - line.width) / static_cast<float>(spaces);
                    float accumulated = 0.0f;
                    for (auto& run : line.visual_runs) {
                        for (auto& glyph : run.glyphs) {
                            glyph.position.x += accumulated;
                            if (glyph.source_byte_begin < text.value.size() &&
                                text.value[glyph.source_byte_begin] == ' ') {
                                glyph.advance.x += extra;
                                accumulated += extra;
                            }
                        }
                    }
                    line.width = box_width;
                }
            }
        }
        if (align_offset != 0.0f) {
            for (auto& run : line.visual_runs) {
                for (auto& glyph : run.glyphs) {
                    glyph.position.x += align_offset;
                }
            }
        }

        layout.metrics.width = std::max(layout.metrics.width, line.width + align_offset);
        layout.lines.push_back(std::move(line));

        if (mandatory_end < text.value.size() && line_end == mandatory_end) {
            line_begin = mandatory_end + 1;
        } else {
            line_begin = line_end;
        }
        if (line_begin == line_end && line_begin < text.value.size()) {
            ++line_begin;
        }
    }

    layout.metrics.line_count = checked_u32(layout.lines.size());
    layout.metrics.line_height = line_height;
    layout.metrics.height = line_height * static_cast<float>(layout.lines.size());
    if (text.bounds.height > 0.0f && layout.metrics.height > text.bounds.height) {
        layout.overflowed = true;
        const uint32_t visible_lines =
            static_cast<uint32_t>(std::floor(text.bounds.height / line_height));
        if (visible_lines < layout.lines.size()) {
            layout.lines.resize(visible_lines);
            layout.metrics.line_count = checked_u32(layout.lines.size());
            layout.metrics.height = line_height * static_cast<float>(layout.lines.size());
        }
    }
    return layout;
}

std::optional<GlyphBitmap> TextEngine::rasterize_glyph(FontHandle handle, uint32_t glyph_id,
                                                       float pixel_size) const
{
    FontResource* font = m_impl->find(handle);
    if (!font || !set_size(*font, pixel_size)) {
        return std::nullopt;
    }
    const FT_Int32 flags = ft_load_flags(font->desc.hinting);
    if (FT_Load_Glyph(font->ft_face.get(), glyph_id, flags) != 0) {
        return std::nullopt;
    }
    if (FT_Render_Glyph(font->ft_face->glyph, FT_RENDER_MODE_NORMAL) != 0) {
        return std::nullopt;
    }
    const FT_GlyphSlot slot = font->ft_face->glyph;
    if (slot->bitmap.pixel_mode != FT_PIXEL_MODE_GRAY) {
        return std::nullopt;
    }
    GlyphBitmap bitmap;
    bitmap.width = slot->bitmap.width;
    bitmap.height = slot->bitmap.rows;
    bitmap.bearing_x = slot->bitmap_left;
    bitmap.bearing_y = slot->bitmap_top;
    bitmap.advance = {static_cast<float>(slot->advance.x) / 64.0f,
                      -static_cast<float>(slot->advance.y) / 64.0f};
    bitmap.coverage.assign(static_cast<size_t>(bitmap.width) * bitmap.height, 0);
    const int pitch = slot->bitmap.pitch;
    const size_t row_stride = static_cast<size_t>(std::abs(pitch));
    const uint8_t* first_row = slot->bitmap.buffer;
    if (pitch < 0 && bitmap.height > 0) {
        first_row = slot->bitmap.buffer + row_stride * static_cast<size_t>(bitmap.height - 1u);
    }
    for (uint32_t y = 0; y < bitmap.height; ++y) {
        const auto* src = pitch >= 0 ? first_row + static_cast<size_t>(y) * row_stride
                                     : first_row - static_cast<size_t>(y) * row_stride;
        std::memcpy(bitmap.coverage.data() + static_cast<size_t>(y) * bitmap.width, src,
                    bitmap.width);
    }
    return bitmap;
}

FontMetrics TextEngine::metrics(FontHandle handle, float pixel_size) const
{
    FontResource* font = m_impl->find(handle);
    return font ? metrics_for(*font, pixel_size) : FontMetrics{};
}

uint32_t TextEngine::glyph_index(FontHandle handle, uint32_t codepoint) const
{
    FontResource* font = m_impl->find(handle);
    return font ? FT_Get_Char_Index(font->ft_face.get(), codepoint) : 0;
}

ShelfAtlasPacker::ShelfAtlasPacker(uint16_t width, uint16_t height, uint16_t padding)
    : m_width(width), m_height(height), m_padding(padding)
{
    m_pages.push_back({});
}

AtlasRect ShelfAtlasPacker::add(uint16_t rect_width, uint16_t rect_height)
{
    const uint16_t padded_width = static_cast<uint16_t>(rect_width + m_padding * 2u);
    const uint16_t padded_height = static_cast<uint16_t>(rect_height + m_padding * 2u);
    if (padded_width > m_width || padded_height > m_height) {
        return {};
    }
    for (uint16_t page_index = 0; page_index < m_pages.size(); ++page_index) {
        Page& page = m_pages[page_index];
        if (page.x + padded_width > m_width) {
            page.x = 0;
            page.y = static_cast<uint16_t>(page.y + page.row_height);
            page.row_height = 0;
        }
        if (page.y + padded_height <= m_height) {
            AtlasRect rect;
            rect.page = page_index;
            rect.x = static_cast<uint16_t>(page.x + m_padding);
            rect.y = static_cast<uint16_t>(page.y + m_padding);
            rect.width = rect_width;
            rect.height = rect_height;
            page.x = static_cast<uint16_t>(page.x + padded_width);
            page.row_height = std::max(page.row_height, padded_height);
            return rect;
        }
    }
    m_pages.push_back({});
    return add(rect_width, rect_height);
}

} // namespace noveltea::text
