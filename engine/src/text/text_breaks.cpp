#include "text/text_breaks.hpp"

#include <graphemebreak.h>
#include <linebreak.h>
#include <wordbreak.h>

#include <algorithm>
#include <optional>

namespace noveltea::text {
namespace {

void initialize_unibreak()
{
    static bool initialized = false;
    if (!initialized) {
        init_linebreak();
        init_graphemebreak();
        init_wordbreak();
        initialized = true;
    }
}

const char* language_or_default(const std::string& language)
{
    return language.empty() ? "und" : language.c_str();
}

} // namespace

bool text_is_utf8_boundary(std::string_view value, std::size_t offset)
{
    if (offset > value.size()) {
        return false;
    }
    if (offset == 0 || offset == value.size()) {
        return true;
    }
    return (static_cast<unsigned char>(value[offset]) & 0xc0u) != 0x80u;
}

std::optional<std::size_t> text_break_marker_index_for_boundary(std::string_view value,
                                                                std::size_t offset)
{
    if (offset == 0 || offset == value.size()) {
        return std::nullopt;
    }
    if (!text_is_utf8_boundary(value, offset)) {
        return std::nullopt;
    }
    return offset - 1u;
}

TextBreaks collect_text_breaks(std::string_view value, const std::string& language)
{
    initialize_unibreak();

    TextBreaks breaks;
    breaks.line.assign(value.size(), LINEBREAK_NOBREAK);
    breaks.grapheme.assign(value.size(), GRAPHEMEBREAK_NOBREAK);
    breaks.word.assign(value.size(), WORDBREAK_NOBREAK);
    if (!value.empty()) {
        const auto* data = reinterpret_cast<const utf8_t*>(value.data());
        const char* lang = language_or_default(language);
        set_linebreaks_utf8(data, value.size(), lang, breaks.line.data());
        set_graphemebreaks_utf8(data, value.size(), lang, breaks.grapheme.data());
        set_wordbreaks_utf8(data, value.size(), lang, breaks.word.data());
    }
    return breaks;
}

bool text_valid_boundary(std::string_view value, const TextBreaks& breaks, std::size_t offset,
                         const std::set<std::uint32_t>& clusters)
{
    if (offset == 0 || offset >= value.size()) {
        return offset == 0 || offset == value.size();
    }
    if (!text_is_utf8_boundary(value, offset)) {
        return false;
    }
    const auto marker_index = text_break_marker_index_for_boundary(value, offset);
    if (!marker_index || *marker_index >= breaks.grapheme.size() ||
        breaks.grapheme[*marker_index] != GRAPHEMEBREAK_BREAK) {
        return false;
    }
    return clusters.contains(static_cast<std::uint32_t>(offset));
}

bool text_legal_line_break_boundary(std::string_view value, const TextBreaks& breaks,
                                    std::size_t offset, const std::set<std::uint32_t>& clusters)
{
    if (!text_valid_boundary(value, breaks, offset, clusters)) {
        return false;
    }
    const auto marker_index = text_break_marker_index_for_boundary(value, offset);
    return marker_index && *marker_index < breaks.line.size() &&
           (breaks.line[*marker_index] == LINEBREAK_ALLOWBREAK ||
            breaks.line[*marker_index] == LINEBREAK_MUSTBREAK);
}

bool text_mandatory_line_break_boundary(std::string_view value, const TextBreaks& breaks,
                                        std::size_t offset, const std::set<std::uint32_t>& clusters)
{
    if (!text_valid_boundary(value, breaks, offset, clusters)) {
        return false;
    }
    const auto marker_index = text_break_marker_index_for_boundary(value, offset);
    return marker_index && *marker_index < breaks.line.size() &&
           breaks.line[*marker_index] == LINEBREAK_MUSTBREAK;
}

std::vector<std::string> split_utf8_graphemes(std::string_view value, const std::string& language)
{
    std::vector<std::string> out;
    if (value.empty()) {
        return out;
    }

    const auto breaks = collect_text_breaks(value, language);
    std::size_t begin = 0;
    for (std::size_t offset = 1; offset < value.size(); ++offset) {
        if (!text_is_utf8_boundary(value, offset)) {
            continue;
        }
        const auto marker_index = text_break_marker_index_for_boundary(value, offset);
        if (marker_index && *marker_index < breaks.grapheme.size() &&
            breaks.grapheme[*marker_index] == GRAPHEMEBREAK_BREAK) {
            out.emplace_back(value.substr(begin, offset - begin));
            begin = offset;
        }
    }
    out.emplace_back(value.substr(begin));
    return out;
}

std::size_t utf8_grapheme_count(std::string_view value, const std::string& language)
{
    return split_utf8_graphemes(value, language).size();
}

} // namespace noveltea::text
