#include "noveltea/core/message_realization.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>

namespace noveltea::core {
namespace {

const compiled::LocalizationEntry* find_message(const compiled::Localization& localization,
                                                std::string_view locale,
                                                MessageId message_id) noexcept
{
    const auto catalog = std::find_if(
        localization.catalogs.begin(), localization.catalogs.end(),
        [locale](const compiled::LocalizationCatalog& value) { return value.locale == locale; });
    if (catalog == localization.catalogs.end())
        return nullptr;
    const auto entry = std::find_if(catalog->entries.begin(), catalog->entries.end(),
                                    [message_id](const compiled::LocalizationEntry& value) {
                                        return value.message_id == message_id;
                                    });
    return entry == catalog->entries.end() ? nullptr : &*entry;
}

std::optional<std::string_view> parent_locale(const compiled::Localization& localization,
                                              std::string_view locale) noexcept
{
    const auto definition = std::find_if(
        localization.locales.begin(), localization.locales.end(),
        [locale](const compiled::LocaleDefinition& value) { return value.locale == locale; });
    if (definition == localization.locales.end() || !definition->parent_locale)
        return std::nullopt;
    return std::string_view{*definition->parent_locale};
}

bool language_is(std::string_view locale, std::string_view language) noexcept
{
    return locale == language ||
           (locale.size() > language.size() && locale.substr(0, language.size()) == language &&
            locale[language.size()] == '-');
}

struct NumberPunctuation {
    std::string_view decimal = ".";
    std::string_view group = ",";
};

NumberPunctuation number_punctuation(std::string_view locale) noexcept
{
    if (language_is(locale, "de") || language_is(locale, "es") || language_is(locale, "it") ||
        language_is(locale, "pt"))
        return {",", "."};
    if (language_is(locale, "fr"))
        return {",", "\xE2\x80\xAF"};
    return {};
}

std::string group_ascii_number(std::string_view ascii, std::string_view locale)
{
    const auto punctuation = number_punctuation(locale);
    const auto exponent = ascii.find_first_of("eE");
    const auto mantissa_end = exponent == std::string_view::npos ? ascii.size() : exponent;
    const auto decimal = ascii.find('.');
    const auto integer_end =
        decimal == std::string_view::npos || decimal > mantissa_end ? mantissa_end : decimal;
    const auto sign = !ascii.empty() && (ascii.front() == '-' || ascii.front() == '+') ? 1u : 0u;

    std::string result;
    result.reserve(ascii.size() + ascii.size() / 3);
    for (std::size_t index = 0; index < integer_end; ++index) {
        if (index > sign && (integer_end - index) % 3 == 0)
            result.append(punctuation.group);
        result.push_back(ascii[index]);
    }
    if (decimal != std::string_view::npos && decimal < mantissa_end) {
        result.append(punctuation.decimal);
        result.append(ascii.substr(decimal + 1, mantissa_end - decimal - 1));
    }
    if (exponent != std::string_view::npos)
        result.append(ascii.substr(exponent));
    return result;
}

std::optional<std::string> format_value(const MessageArgumentValue& value,
                                        compiled::MessageArgumentType type, std::string_view locale)
{
    if (type == compiled::MessageArgumentType::String) {
        if (const auto* text = std::get_if<std::string>(&value))
            return *text;
        return std::nullopt;
    }
    if (type == compiled::MessageArgumentType::Integer) {
        const auto* integer = std::get_if<std::int64_t>(&value);
        if (!integer)
            return std::nullopt;
        char buffer[64];
        const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), *integer);
        if (converted.ec != std::errc{})
            return std::nullopt;
        return group_ascii_number(std::string_view(buffer, converted.ptr), locale);
    }
    if (type == compiled::MessageArgumentType::Number ||
        type == compiled::MessageArgumentType::PluralNumber) {
        if (const auto* integer = std::get_if<std::int64_t>(&value)) {
            char buffer[64];
            const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), *integer);
            if (converted.ec != std::errc{})
                return std::nullopt;
            return group_ascii_number(std::string_view(buffer, converted.ptr), locale);
        }
        const auto* number = std::get_if<double>(&value);
        if (!number || !std::isfinite(*number))
            return std::nullopt;
        char buffer[128];
        const auto converted =
            std::to_chars(buffer, buffer + sizeof(buffer), *number, std::chars_format::general);
        if (converted.ec != std::errc{})
            return std::nullopt;
        return group_ascii_number(std::string_view(buffer, converted.ptr), locale);
    }

    if (const auto* text = std::get_if<std::string>(&value))
        return *text;
    if (const auto* boolean = std::get_if<bool>(&value))
        return *boolean ? std::string{"true"} : std::string{"false"};
    if (const auto* integer = std::get_if<std::int64_t>(&value)) {
        char buffer[64];
        const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), *integer);
        if (converted.ec != std::errc{})
            return std::nullopt;
        return group_ascii_number(std::string_view(buffer, converted.ptr), locale);
    }
    const auto* number = std::get_if<double>(&value);
    if (!number || !std::isfinite(*number))
        return std::nullopt;
    char buffer[128];
    const auto converted =
        std::to_chars(buffer, buffer + sizeof(buffer), *number, std::chars_format::general);
    if (converted.ec != std::errc{})
        return std::nullopt;
    return group_ascii_number(std::string_view(buffer, converted.ptr), locale);
}

std::optional<std::string> interpolate(const compiled::LocalizationEntry& entry,
                                       const std::vector<MessageArgument>& arguments,
                                       std::string_view locale)
{
    if (entry.arguments.empty())
        return arguments.empty() ? std::optional<std::string>{entry.value} : std::nullopt;
    if (arguments.size() != entry.arguments.size())
        return std::nullopt;

    std::vector<std::pair<std::string_view, std::string>> values;
    values.reserve(entry.arguments.size());
    for (const auto& definition : entry.arguments) {
        const auto first =
            std::find_if(arguments.begin(), arguments.end(),
                         [&](const MessageArgument& arg) { return arg.name == definition.name; });
        if (first == arguments.end())
            return std::nullopt;
        if (std::find_if(std::next(first), arguments.end(), [&](const MessageArgument& arg) {
                return arg.name == definition.name;
            }) != arguments.end())
            return std::nullopt;
        auto formatted = format_value(first->value, definition.type, locale);
        if (!formatted)
            return std::nullopt;
        values.emplace_back(definition.name, std::move(*formatted));
    }

    std::string output;
    output.reserve(entry.value.size() + 16);
    for (std::size_t index = 0; index < entry.value.size();) {
        if (entry.value[index] == '{') {
            if (index + 1 < entry.value.size() && entry.value[index + 1] == '{') {
                output.push_back('{');
                index += 2;
                continue;
            }
            const auto close = entry.value.find('}', index + 1);
            if (close == std::string::npos)
                return std::nullopt;
            const auto name = std::string_view(entry.value).substr(index + 1, close - index - 1);
            const auto value = std::find_if(values.begin(), values.end(), [name](const auto& item) {
                return item.first == name;
            });
            if (value == values.end())
                return std::nullopt;
            output.append(value->second);
            index = close + 1;
            continue;
        }
        if (entry.value[index] == '}' && index + 1 < entry.value.size() &&
            entry.value[index + 1] == '}') {
            output.push_back('}');
            index += 2;
            continue;
        }
        output.push_back(entry.value[index++]);
    }
    return output;
}

std::string_view primary_language(std::string_view locale) noexcept
{
    const auto separator = locale.find('-');
    return locale.substr(0, separator);
}

std::string plural_category(const MessageArgumentValue& value, std::string_view locale)
{
    double number = 0.0;
    bool integer_value = false;
    std::uint64_t integer = 0;
    if (const auto* exact = std::get_if<std::int64_t>(&value)) {
        number = static_cast<double>(*exact);
        integer_value = true;
        integer = *exact < 0 ? static_cast<std::uint64_t>(-(*exact + 1)) + 1
                             : static_cast<std::uint64_t>(*exact);
    } else if (const auto* real = std::get_if<double>(&value); real && std::isfinite(*real)) {
        number = *real;
        const auto absolute = std::fabs(*real);
        const auto truncated = std::trunc(absolute);
        integer_value = truncated == absolute &&
                        truncated <= static_cast<double>(std::numeric_limits<std::uint64_t>::max());
        if (integer_value)
            integer = static_cast<std::uint64_t>(truncated);
    } else {
        return "other";
    }

    const auto absolute_number = std::fabs(number);
    const auto mod10 = integer % 10;
    const auto mod100 = integer % 100;
    const auto language = primary_language(locale);

    if (language == "zh" || language == "ja" || language == "ko" || language == "th" ||
        language == "vi" || language == "id" || language == "ms")
        return "other";
    if (language == "ar") {
        if (absolute_number == 0.0)
            return "zero";
        if (absolute_number == 1.0)
            return "one";
        if (absolute_number == 2.0)
            return "two";
        const auto n100 = std::fmod(absolute_number, 100.0);
        if (n100 >= 3.0 && n100 <= 10.0)
            return "few";
        if (n100 >= 11.0 && n100 <= 99.0)
            return "many";
        return "other";
    }
    if (language == "ru" || language == "uk" || language == "be") {
        if (!integer_value)
            return "other";
        if (mod10 == 1 && mod100 != 11)
            return "one";
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
            return "few";
        return "many";
    }
    if (language == "pl") {
        if (!integer_value)
            return "other";
        if (integer == 1)
            return "one";
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
            return "few";
        return "many";
    }
    if (language == "cs" || language == "sk") {
        if (!integer_value)
            return "many";
        if (integer == 1)
            return "one";
        if (integer >= 2 && integer <= 4)
            return "few";
        return "other";
    }
    if (language == "sl") {
        if (!integer_value)
            return "few";
        if (mod100 == 1)
            return "one";
        if (mod100 == 2)
            return "two";
        if (mod100 == 3 || mod100 == 4)
            return "few";
        return "other";
    }
    if (language == "lt") {
        if (!integer_value)
            return "many";
        if (mod10 == 1 && (mod100 < 11 || mod100 > 19))
            return "one";
        if (mod10 >= 2 && mod10 <= 9 && (mod100 < 11 || mod100 > 19))
            return "few";
        return "other";
    }
    if (language == "ro") {
        if (integer_value && integer == 1)
            return "one";
        if (!integer_value || absolute_number == 0.0 || (mod100 >= 2 && mod100 <= 19))
            return "few";
        return "other";
    }
    if (language == "he") {
        if (integer_value && integer == 1)
            return "one";
        if (integer_value && integer == 2)
            return "two";
        return "other";
    }
    if (language == "fr" || language == "pt")
        return integer_value && (integer == 0 || integer == 1) ? "one" : "other";
    return integer_value && integer == 1 ? "one" : "other";
}

const MessageArgument* find_argument(const std::vector<MessageArgument>& arguments,
                                     std::string_view name) noexcept
{
    const auto found = std::find_if(arguments.begin(), arguments.end(),
                                    [&](const auto& argument) { return argument.name == name; });
    return found == arguments.end() ? nullptr : &*found;
}

std::optional<std::string> realize_pattern(const compiled::LocalizationEntry& entry,
                                           const std::vector<MessageArgument>& arguments,
                                           std::string_view locale)
{
    if (!entry.pattern || entry.pattern->nodes.empty() ||
        entry.pattern->root >= entry.pattern->nodes.size())
        return std::nullopt;

    std::uint32_t node_index = entry.pattern->root;
    for (std::size_t depth = 0; depth <= entry.pattern->nodes.size(); ++depth) {
        if (node_index >= entry.pattern->nodes.size())
            return std::nullopt;
        const auto& node = entry.pattern->nodes[node_index];
        if (node.kind == compiled::MessagePatternNodeKind::Text) {
            auto leaf = entry;
            leaf.value = node.text;
            leaf.pattern.reset();
            return interpolate(leaf, arguments, locale);
        }

        const auto* argument = find_argument(arguments, node.argument);
        if (!argument)
            return std::nullopt;
        std::string key;
        if (node.kind == compiled::MessagePatternNodeKind::Plural) {
            const auto definition = std::find_if(
                entry.arguments.begin(), entry.arguments.end(),
                [&](const auto& candidate) { return candidate.name == node.argument; });
            if (definition == entry.arguments.end() ||
                definition->type != compiled::MessageArgumentType::PluralNumber)
                return std::nullopt;
            key = plural_category(argument->value, locale);
        } else {
            const auto definition = std::find_if(
                entry.arguments.begin(), entry.arguments.end(),
                [&](const auto& candidate) { return candidate.name == node.argument; });
            if (definition == entry.arguments.end() ||
                definition->type != compiled::MessageArgumentType::String)
                return std::nullopt;
            const auto* selected = std::get_if<std::string>(&argument->value);
            if (!selected)
                return std::nullopt;
            key = *selected;
        }

        const auto exact = std::find_if(node.cases.begin(), node.cases.end(),
                                        [&](const auto& item) { return item.key == key; });
        const auto fallback = std::find_if(node.cases.begin(), node.cases.end(),
                                           [](const auto& item) { return item.key == "other"; });
        if (exact != node.cases.end())
            node_index = exact->node;
        else if (fallback != node.cases.end())
            node_index = fallback->node;
        else
            return std::nullopt;
    }
    return std::nullopt;
}

} // namespace

const std::vector<compiled::MessageArgumentDefinition>*
MessageRealizer::argument_definitions(MessageId message_id) const noexcept
{
    if (const auto* source = find_message(m_localization, m_localization.source_locale, message_id))
        return &source->arguments;
    return nullptr;
}

std::optional<RealizedMessage>
MessageRealizer::realize(const MessageRealizationRequest& request) const
{
    auto locale =
        request.locale.empty() ? std::string_view{m_localization.default_locale} : request.locale;
    const auto maximum_hops = m_localization.locales.size() + 1;
    for (std::size_t hops = 0; !locale.empty() && hops < maximum_hops; ++hops) {
        if (const auto* entry = find_message(m_localization, locale, request.message_id)) {
            auto text = entry->pattern ? realize_pattern(*entry, request.arguments, locale)
                                       : interpolate(*entry, request.arguments, locale);
            if (!text)
                return std::nullopt;
            return RealizedMessage{std::move(*text), locale};
        }
        if (locale == m_localization.source_locale)
            return std::nullopt;
        const auto parent = parent_locale(m_localization, locale);
        locale = parent ? *parent : std::string_view{m_localization.source_locale};
    }
    return std::nullopt;
}

} // namespace noveltea::core
