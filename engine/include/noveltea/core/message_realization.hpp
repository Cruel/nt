#pragma once

#include "noveltea/core/compiled_project.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace noveltea::core {

[[nodiscard]] std::optional<MessageId> system_message_id(std::string_view key) noexcept;
[[nodiscard]] std::optional<std::string_view> system_message_key(MessageId id) noexcept;

using MessageArgumentValue = std::variant<std::string, double, std::int64_t, bool>;

struct MessageArgument {
    std::string name;
    MessageArgumentValue value;
};

struct MessageRealizationRequest {
    MessageRealizationRequest(MessageId message_id, std::string_view locale,
                              std::vector<MessageArgument> arguments = {})
        : message_id(message_id), locale(locale), arguments(std::move(arguments))
    {
    }

    MessageId message_id = 0;
    std::string_view locale;
    std::vector<MessageArgument> arguments;
};

struct RealizedMessage {
    std::string text;
    std::string_view locale;
};

class MessageRealizer {
public:
    explicit MessageRealizer(const compiled::Localization& localization) noexcept
        : m_localization(localization)
    {
    }

    [[nodiscard]] const std::vector<compiled::MessageArgumentDefinition>*
    argument_definitions(MessageId message_id) const noexcept;

    [[nodiscard]] std::optional<RealizedMessage>
    realize(const MessageRealizationRequest& request) const;

private:
    const compiled::Localization& m_localization;
};

} // namespace noveltea::core
