#include "noveltea/core/message_resolution.hpp"

#include <algorithm>
#include <array>

namespace noveltea::core {
namespace {

const compiled::LocalizationEntry* find_message(const compiled::Localization& localization,
                                                std::string_view locale,
                                                std::string_view key) noexcept
{
    const auto catalog = std::find_if(
        localization.catalogs.begin(), localization.catalogs.end(),
        [locale](const compiled::LocalizationCatalog& value) { return value.locale == locale; });
    if (catalog == localization.catalogs.end())
        return nullptr;
    const auto entry =
        std::find_if(catalog->entries.begin(), catalog->entries.end(),
                     [key](const compiled::LocalizationEntry& value) { return value.key == key; });
    return entry == catalog->entries.end() ? nullptr : &*entry;
}

} // namespace

std::optional<ResolvedMessage>
MessageResolver::resolve(const MessageResolutionRequest& request) const noexcept
{
    const std::array<std::optional<std::string_view>, 3> candidates = {
        request.locale.empty() ? std::nullopt : std::optional<std::string_view>{request.locale},
        std::string_view{m_localization.default_locale},
        m_localization.fallback_locale
            ? std::optional<std::string_view>{*m_localization.fallback_locale}
            : std::nullopt,
    };

    std::array<std::string_view, 3> consulted{};
    std::size_t consulted_count = 0;
    for (const auto candidate : candidates) {
        if (!candidate || candidate->empty())
            continue;
        if (std::find(consulted.begin(), consulted.begin() + consulted_count, *candidate) !=
            consulted.begin() + consulted_count)
            continue;
        consulted[consulted_count++] = *candidate;
        if (const auto* entry = find_message(m_localization, *candidate, request.key))
            return ResolvedMessage{entry->value, *candidate};
    }

    return std::nullopt;
}

} // namespace noveltea::core
