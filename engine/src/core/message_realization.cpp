#include "noveltea/core/message_realization.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <limits>

namespace noveltea::core {
namespace {

constexpr MessageId kSystemMessageIdBase = 0xffff0000u;

struct SystemMessageDefinition {
    MessageId id = 0;
    std::string_view key;
    std::string_view source;
    std::string_view pt_br;
};

constexpr std::array kSystemMessages{
    SystemMessageDefinition{kSystemMessageIdBase + 0, "noveltea.shell.game_menu", "Game Menu",
                            "Menu do jogo"},
    SystemMessageDefinition{kSystemMessageIdBase + 1, "noveltea.shell.paused", "Paused", "Pausado"},
    SystemMessageDefinition{kSystemMessageIdBase + 2, "noveltea.shell.resume", "Resume",
                            "Continuar"},
    SystemMessageDefinition{kSystemMessageIdBase + 3, "noveltea.shell.save", "Save", "Salvar"},
    SystemMessageDefinition{kSystemMessageIdBase + 4, "noveltea.shell.load", "Load", "Carregar"},
    SystemMessageDefinition{kSystemMessageIdBase + 5, "noveltea.shell.text_log", "Text Log",
                            "Histórico de texto"},
    SystemMessageDefinition{kSystemMessageIdBase + 6, "noveltea.shell.settings", "Settings",
                            "Configurações"},
    SystemMessageDefinition{kSystemMessageIdBase + 7, "noveltea.shell.title", "Title", "Título"},
    SystemMessageDefinition{kSystemMessageIdBase + 8, "noveltea.shell.quit", "Quit", "Sair"},
    SystemMessageDefinition{kSystemMessageIdBase + 9, "noveltea.shell.back", "Back", "Voltar"},
    SystemMessageDefinition{kSystemMessageIdBase + 10, "noveltea.shell.menu", "Menu", "Menu"},
    SystemMessageDefinition{kSystemMessageIdBase + 11, "noveltea.save.no_thumbnail", "No thumbnail",
                            "Sem miniatura"},
    SystemMessageDefinition{kSystemMessageIdBase + 12, "noveltea.settings.ui_scale",
                            "UI scale:", "Escala da interface:"},
    SystemMessageDefinition{kSystemMessageIdBase + 13, "noveltea.settings.text_scale",
                            "Text scale:", "Escala do texto:"},
    SystemMessageDefinition{kSystemMessageIdBase + 14, "noveltea.settings.minimum", "Minimum",
                            "Mínimo"},
    SystemMessageDefinition{kSystemMessageIdBase + 15, "noveltea.settings.default_scale", "100%",
                            "100%"},
    SystemMessageDefinition{kSystemMessageIdBase + 16, "noveltea.settings.maximum", "Maximum",
                            "Máximo"},
    SystemMessageDefinition{kSystemMessageIdBase + 17, "noveltea.text_log.history", "History",
                            "Histórico"},
    SystemMessageDefinition{kSystemMessageIdBase + 18, "noveltea.text_log.title", "Text Log",
                            "Histórico de texto"},
    SystemMessageDefinition{kSystemMessageIdBase + 19, "noveltea.text_log.empty", "No log entries",
                            "Nenhuma entrada no histórico"},
    SystemMessageDefinition{kSystemMessageIdBase + 20, "noveltea.confirmation.confirm", "Confirm",
                            "Confirmar"},
    SystemMessageDefinition{kSystemMessageIdBase + 21, "noveltea.confirmation.prompt",
                            "Are you sure?", "Tem certeza?"},
    SystemMessageDefinition{kSystemMessageIdBase + 22, "noveltea.confirmation.cancel", "Cancel",
                            "Cancelar"},
    SystemMessageDefinition{kSystemMessageIdBase + 23, "noveltea.verb_menu.actions", "Actions",
                            "Ações"},
    SystemMessageDefinition{kSystemMessageIdBase + 24, "noveltea.common.close", "Close", "Fechar"},
    SystemMessageDefinition{kSystemMessageIdBase + 25, "noveltea.inventory.title", "Inventory",
                            "Inventário"},
    SystemMessageDefinition{kSystemMessageIdBase + 26, "noveltea.command_builder.command",
                            "Command", "Comando"},
    SystemMessageDefinition{kSystemMessageIdBase + 27, "noveltea.game.nearby", "Nearby", "Próximo"},
    SystemMessageDefinition{kSystemMessageIdBase + 28, "noveltea.status.saved", "Saved.", "Salvo."},
    SystemMessageDefinition{kSystemMessageIdBase + 29, "noveltea.status.settings_updated",
                            "Settings updated.", "Configurações atualizadas."},
    SystemMessageDefinition{kSystemMessageIdBase + 30, "noveltea.confirmation.return_to_title",
                            "Return to the title screen? Unsaved progress will be lost.",
                            "Voltar à tela de título? O progresso não salvo será perdido."},
    SystemMessageDefinition{kSystemMessageIdBase + 31, "noveltea.confirmation.quit",
                            "Quit NovelTea?", "Sair do NovelTea?"},
    SystemMessageDefinition{kSystemMessageIdBase + 32, "noveltea.confirmation.load",
                            "Load this save? Current unsaved progress will be lost.",
                            "Carregar este salvamento? O progresso atual não salvo será perdido."},
    SystemMessageDefinition{kSystemMessageIdBase + 33, "noveltea.settings.language", "Language",
                            "Idioma"},
    SystemMessageDefinition{kSystemMessageIdBase + 34, "noveltea.status.language_updated",
                            "Language updated.", "Idioma atualizado."},
    SystemMessageDefinition{kSystemMessageIdBase + 35, "noveltea.status.language_change_failed",
                            "Unable to change language.", "Não foi possível alterar o idioma."},
};

const SystemMessageDefinition* find_system_message(MessageId id) noexcept
{
    const auto found = std::find_if(kSystemMessages.begin(), kSystemMessages.end(),
                                    [id](const auto& definition) { return definition.id == id; });
    return found == kSystemMessages.end() ? nullptr : &*found;
}

std::optional<RealizedMessage> realize_system_message(MessageId id, std::string_view locale)
{
    const auto* definition = find_system_message(id);
    if (!definition)
        return std::nullopt;
    if (locale == "pt-BR")
        return RealizedMessage{std::string{definition->pt_br}, "pt-BR"};
    return RealizedMessage{std::string{definition->source}, "en"};
}

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

std::optional<std::string_view> supported_locale(const compiled::Localization& localization,
                                                 std::string_view requested) noexcept
{
    auto candidate = requested;
    while (!candidate.empty()) {
        const auto definition =
            std::find_if(localization.locales.begin(), localization.locales.end(),
                         [candidate](const compiled::LocaleDefinition& value) {
                             return value.locale == candidate && value.supported;
                         });
        if (definition != localization.locales.end())
            return std::string_view{definition->locale};
        const auto separator = candidate.rfind('-');
        if (separator == std::string_view::npos)
            break;
        candidate = candidate.substr(0, separator);
    }
    return std::nullopt;
}

const compiled::LocaleNumberFormat&
number_format(const compiled::Localization& localization, std::string_view locale) noexcept
{
    const auto definition = std::find_if(
        localization.locales.begin(), localization.locales.end(),
        [locale](const compiled::LocaleDefinition& value) { return value.locale == locale; });
    if (definition != localization.locales.end())
        return definition->number_format;
    static const compiled::LocaleNumberFormat fallback;
    return fallback;
}

std::string localize_ascii_digits(std::string_view ascii,
                                  const compiled::LocaleNumberFormat& format)
{
    std::string result;
    for (const char character : ascii) {
        if (character >= '0' && character <= '9')
            result.append(format.digits[static_cast<std::size_t>(character - '0')]);
        else
            result.push_back(character);
    }
    return result;
}

std::string group_ascii_number(std::string_view ascii,
                               const compiled::Localization& localization,
                               std::string_view locale)
{
    const auto& format = number_format(localization, locale);
    const auto exponent = ascii.find_first_of("eE");
    const auto mantissa_end = exponent == std::string_view::npos ? ascii.size() : exponent;
    const auto decimal = ascii.find('.');
    const auto integer_end =
        decimal == std::string_view::npos || decimal > mantissa_end ? mantissa_end : decimal;
    const auto sign = !ascii.empty() && (ascii.front() == '-' || ascii.front() == '+') ? 1u : 0u;
    const auto integer_digits = integer_end - sign;

    std::string result;
    result.reserve(ascii.size() + ascii.size() / 3);
    if (sign != 0)
        result.push_back(ascii.front());
    for (std::size_t offset = 0; offset < integer_digits; ++offset) {
        const auto remaining = integer_digits - offset;
        const auto primary = static_cast<std::size_t>(format.primary_group_size);
        const auto secondary = static_cast<std::size_t>(format.secondary_group_size);
        if (offset > 0 && !format.group_separator.empty() && primary > 0 && secondary > 0 &&
            remaining >= primary && (remaining - primary) % secondary == 0)
            result.append(format.group_separator);
        const char digit = ascii[sign + offset];
        result.append(format.digits[static_cast<std::size_t>(digit - '0')]);
    }
    if (decimal != std::string_view::npos && decimal < mantissa_end) {
        result.append(format.decimal_separator);
        result.append(localize_ascii_digits(
            ascii.substr(decimal + 1, mantissa_end - decimal - 1), format));
    }
    if (exponent != std::string_view::npos)
        result.append(localize_ascii_digits(ascii.substr(exponent), format));
    return result;
}

std::optional<std::string> format_value(const MessageArgumentValue& value,
                                        compiled::MessageArgumentType type,
                                        const compiled::Localization& localization,
                                        std::string_view locale)
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
        return group_ascii_number(std::string_view(buffer, converted.ptr), localization, locale);
    }
    if (type == compiled::MessageArgumentType::Number ||
        type == compiled::MessageArgumentType::PluralNumber) {
        if (const auto* integer = std::get_if<std::int64_t>(&value)) {
            char buffer[64];
            const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), *integer);
            if (converted.ec != std::errc{})
                return std::nullopt;
            return group_ascii_number(std::string_view(buffer, converted.ptr), localization, locale);
        }
        const auto* number = std::get_if<double>(&value);
        if (!number || !std::isfinite(*number))
            return std::nullopt;
        char buffer[128];
        const auto converted =
            std::to_chars(buffer, buffer + sizeof(buffer), *number, std::chars_format::general);
        if (converted.ec != std::errc{})
            return std::nullopt;
        return group_ascii_number(std::string_view(buffer, converted.ptr), localization, locale);
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
        return group_ascii_number(std::string_view(buffer, converted.ptr), localization, locale);
    }
    const auto* number = std::get_if<double>(&value);
    if (!number || !std::isfinite(*number))
        return std::nullopt;
    char buffer[128];
    const auto converted =
        std::to_chars(buffer, buffer + sizeof(buffer), *number, std::chars_format::general);
    if (converted.ec != std::errc{})
        return std::nullopt;
    return group_ascii_number(std::string_view(buffer, converted.ptr), localization, locale);
}

std::optional<std::string> interpolate(const compiled::LocalizationEntry& entry,
                                       const std::vector<MessageArgument>& arguments,
                                       const compiled::Localization& localization,
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
        auto formatted = format_value(first->value, definition.type, localization, locale);
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

struct PluralOperands {
    double n = 0.0;
    double i = 0.0;
    double v = 0.0;
    double w = 0.0;
    double f = 0.0;
    double t = 0.0;
    double e = 0.0;
};

std::optional<PluralOperands> plural_operands(const MessageArgumentValue& value) noexcept
{
    if (const auto* exact = std::get_if<std::int64_t>(&value)) {
        const auto magnitude = *exact < 0 ? static_cast<std::uint64_t>(-(*exact + 1)) + 1
                                          : static_cast<std::uint64_t>(*exact);
        const double number = static_cast<double>(magnitude);
        return PluralOperands{.n = number, .i = number};
    }
    const auto* real = std::get_if<double>(&value);
    if (!real || !std::isfinite(*real))
        return std::nullopt;

    const double absolute = std::fabs(*real);
    double rounded = absolute;
    if (absolute <= static_cast<double>(std::numeric_limits<std::uint64_t>::max()) / 1000.0)
        rounded = std::round(absolute * 1000.0) / 1000.0;
    const double integer = std::floor(rounded);
    std::uint64_t fraction = 0;
    std::uint8_t visible_digits = 0;
    if (rounded < static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
        const auto scaled_fraction = std::round((rounded - integer) * 1000.0);
        fraction = static_cast<std::uint64_t>(std::clamp(scaled_fraction, 0.0, 999.0));
        if (fraction != 0) {
            visible_digits = 3;
            while (fraction % 10 == 0) {
                fraction /= 10;
                --visible_digits;
            }
        }
    }
    return PluralOperands{.n = rounded,
                          .i = integer,
                          .v = static_cast<double>(visible_digits),
                          .w = static_cast<double>(visible_digits),
                          .f = static_cast<double>(fraction),
                          .t = static_cast<double>(fraction),
                          .e = 0.0};
}

double plural_operand_value(const PluralOperands& operands,
                            compiled::PluralOperand operand) noexcept
{
    switch (operand) {
    case compiled::PluralOperand::N:
        return operands.n;
    case compiled::PluralOperand::I:
        return operands.i;
    case compiled::PluralOperand::V:
        return operands.v;
    case compiled::PluralOperand::W:
        return operands.w;
    case compiled::PluralOperand::F:
        return operands.f;
    case compiled::PluralOperand::T:
        return operands.t;
    case compiled::PluralOperand::E:
        return operands.e;
    }
    return 0.0;
}

bool plural_relation_matches(const PluralOperands& operands,
                             const compiled::PluralRelation& relation) noexcept
{
    double candidate = plural_operand_value(operands, relation.operand);
    if (relation.modulo)
        candidate = std::fmod(candidate, static_cast<double>(*relation.modulo));
    constexpr double epsilon = 1e-9;
    const bool integer_relation = std::ranges::all_of(relation.ranges, [](const auto& range) {
        return std::floor(range.minimum) == range.minimum &&
               std::floor(range.maximum) == range.maximum;
    });
    const bool in_range =
        (!integer_relation || std::fabs(candidate - std::round(candidate)) <= epsilon) &&
        std::ranges::any_of(relation.ranges, [&](const auto& range) {
            return candidate + epsilon >= range.minimum && candidate - epsilon <= range.maximum;
        });
    return relation.negated ? !in_range : in_range;
}

std::string plural_category(const MessageArgumentValue& value,
                            const compiled::Localization& localization, std::string_view locale)
{
    const auto operands = plural_operands(value);
    if (!operands)
        return "other";
    const auto definition = std::ranges::find_if(
        localization.locales,
        [&](const compiled::LocaleDefinition& candidate) { return candidate.locale == locale; });
    if (definition == localization.locales.end())
        return "other";
    for (const auto& rule : definition->plural_rules) {
        const bool matches = std::ranges::any_of(rule.alternatives, [&](const auto& alternative) {
            return std::ranges::all_of(alternative, [&](const auto& relation) {
                return plural_relation_matches(*operands, relation);
            });
        });
        if (matches)
            return rule.category;
    }
    return "other";
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
                                           const compiled::Localization& localization,
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
            return interpolate(leaf, arguments, localization, locale);
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
            key = plural_category(argument->value, localization, locale);
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

std::optional<MessageId> system_message_id(std::string_view key) noexcept
{
    const auto found =
        std::find_if(kSystemMessages.begin(), kSystemMessages.end(),
                     [key](const auto& definition) { return definition.key == key; });
    if (found == kSystemMessages.end())
        return std::nullopt;
    return found->id;
}

std::optional<std::string_view> system_message_key(MessageId id) noexcept
{
    const auto* definition = find_system_message(id);
    return definition ? std::optional<std::string_view>{definition->key} : std::nullopt;
}

const std::vector<compiled::MessageArgumentDefinition>*
MessageRealizer::argument_definitions(MessageId message_id) const noexcept
{
    if (const auto* source = find_message(m_localization, m_localization.source_locale, message_id))
        return &source->arguments;
    if (find_system_message(message_id)) {
        static const std::vector<compiled::MessageArgumentDefinition> empty;
        return &empty;
    }
    return nullptr;
}

const compiled::LocalizationEntry*
MessageRealizer::resolved_entry(MessageId message_id, std::string_view locale) const noexcept
{
    const auto requested = locale.empty() ? std::string_view{m_localization.default_locale} : locale;
    if (const auto negotiated = supported_locale(m_localization, requested))
        if (const auto* entry = find_message(m_localization, *negotiated, message_id))
            return entry;
    return find_message(m_localization, m_localization.source_locale, message_id);
}

std::optional<RealizedMessage>
MessageRealizer::realize(const MessageRealizationRequest& request) const
{
    const auto requested =
        request.locale.empty() ? std::string_view{m_localization.default_locale} : request.locale;
    if (const auto negotiated = supported_locale(m_localization, requested)) {
        if (const auto* entry = find_message(m_localization, *negotiated, request.message_id)) {
            auto text = entry->pattern
                            ? realize_pattern(*entry, request.arguments, m_localization, *negotiated)
                            : interpolate(*entry, request.arguments, m_localization, *negotiated);
            if (!text)
                return std::nullopt;
            return RealizedMessage{std::move(*text), *negotiated};
        }
    }

    if (const auto* source =
            find_message(m_localization, m_localization.source_locale, request.message_id)) {
        auto text = source->pattern
                        ? realize_pattern(*source, request.arguments, m_localization,
                                          m_localization.source_locale)
                        : interpolate(*source, request.arguments, m_localization,
                                      m_localization.source_locale);
        if (!text)
            return std::nullopt;
        return RealizedMessage{std::move(*text), m_localization.source_locale};
    }

    if (!request.arguments.empty())
        return std::nullopt;
    if (const auto negotiated = supported_locale(m_localization, requested))
        return realize_system_message(request.message_id, *negotiated);
    return realize_system_message(request.message_id, m_localization.source_locale);
}

} // namespace noveltea::core
