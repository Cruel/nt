#pragma once

#include "noveltea/core/message_realization.hpp"

#include <optional>
#include <string_view>

namespace noveltea::core {

struct MessageResolutionRequest {
    MessageId message_id = 0;
    std::string_view locale;
};

using ResolvedMessage = RealizedMessage;

// Transitional #176 seam. MessageRealizer owns localization policy; this adapter keeps existing
// callers on that single realization path while the remaining consumers move to first-class
// Messages.
class MessageResolver {
public:
    explicit MessageResolver(const compiled::Localization& localization) noexcept
        : m_realizer(localization)
    {
    }

    [[nodiscard]] std::optional<ResolvedMessage>
    resolve(const MessageResolutionRequest& request) const noexcept;

private:
    MessageRealizer m_realizer;
};

} // namespace noveltea::core
