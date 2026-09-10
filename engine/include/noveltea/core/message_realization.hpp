#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <optional>
#include <string_view>

namespace noveltea::core {

struct MessageRealizationRequest {
    MessageId message_id = 0;
    std::string_view locale;
};

struct RealizedMessage {
    std::string_view text;
    std::string_view locale;
};

class MessageRealizer {
public:
    explicit MessageRealizer(const compiled::Localization& localization) noexcept
        : m_localization(localization)
    {
    }

    [[nodiscard]] std::optional<RealizedMessage>
    realize(const MessageRealizationRequest& request) const noexcept;

private:
    const compiled::Localization& m_localization;
};

} // namespace noveltea::core
