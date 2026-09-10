#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <optional>
#include <string_view>

namespace noveltea::core {

struct MessageResolutionRequest {
    std::string_view key;
    std::string_view locale;
};

struct ResolvedMessage {
    std::string_view text;
    std::string_view locale;
};

class MessageResolver {
public:
    explicit MessageResolver(const compiled::Localization& localization) noexcept
        : m_localization(localization)
    {
    }

    [[nodiscard]] std::optional<ResolvedMessage>
    resolve(const MessageResolutionRequest& request) const noexcept;

private:
    const compiled::Localization& m_localization;
};

} // namespace noveltea::core
