#pragma once

#include <compare>
#include <cstdint>
#include <string>
#include <variant>

namespace noveltea::core {

struct InlineText {
    std::string value;
    auto operator<=>(const InlineText&) const = default;
};
struct LocalizedTextKey {
    std::string value;
    auto operator<=>(const LocalizedTextKey&) const = default;
};
struct LuaTextExpression {
    std::string source;
    auto operator<=>(const LuaTextExpression&) const = default;
};
using TextSource = std::variant<InlineText, LocalizedTextKey, LuaTextExpression>;
enum class TextMarkup : std::uint8_t {
    Plain,
    ActiveText
};
struct TextContent {
    TextSource source;
    TextMarkup markup = TextMarkup::Plain;
};

} // namespace noveltea::core
