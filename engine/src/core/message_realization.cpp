#include "noveltea/core/message_realization.hpp"

#include <algorithm>

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

} // namespace

std::optional<RealizedMessage>
MessageRealizer::realize(const MessageRealizationRequest& request) const noexcept
{
    auto locale =
        request.locale.empty() ? std::string_view{m_localization.default_locale} : request.locale;
    const auto maximum_hops = m_localization.locales.size() + 1;
    for (std::size_t hops = 0; !locale.empty() && hops < maximum_hops; ++hops) {
        if (const auto* entry = find_message(m_localization, locale, request.message_id))
            return RealizedMessage{entry->value, locale};
        if (locale == m_localization.source_locale)
            return std::nullopt;
        const auto parent = parent_locale(m_localization, locale);
        locale = parent ? *parent : std::string_view{m_localization.source_locale};
    }
    return std::nullopt;
}

} // namespace noveltea::core
