#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

namespace noveltea::text {

struct TextBreaks {
    std::vector<char> line;
    std::vector<char> grapheme;
    std::vector<char> word;
};

[[nodiscard]] bool text_is_utf8_boundary(std::string_view value, std::size_t offset);
[[nodiscard]] std::optional<std::size_t>
text_break_marker_index_for_boundary(std::string_view value, std::size_t offset);
[[nodiscard]] TextBreaks collect_text_breaks(std::string_view value, const std::string& language);
[[nodiscard]] bool text_valid_boundary(std::string_view value, const TextBreaks& breaks,
                                       std::size_t offset, const std::set<std::uint32_t>& clusters);
[[nodiscard]] bool text_legal_line_break_boundary(std::string_view value, const TextBreaks& breaks,
                                                  std::size_t offset,
                                                  const std::set<std::uint32_t>& clusters);
[[nodiscard]] bool text_mandatory_line_break_boundary(std::string_view value,
                                                      const TextBreaks& breaks, std::size_t offset,
                                                      const std::set<std::uint32_t>& clusters);
[[nodiscard]] std::vector<std::string> split_utf8_graphemes(std::string_view value,
                                                            const std::string& language = "und");
[[nodiscard]] std::size_t utf8_grapheme_count(std::string_view value,
                                              const std::string& language = "und");

} // namespace noveltea::text
