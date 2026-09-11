#include "noveltea/core/message_realization.hpp"

#include <algorithm>
#include <charconv>
#include <cmath>

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
            auto text = interpolate(*entry, request.arguments, locale);
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
