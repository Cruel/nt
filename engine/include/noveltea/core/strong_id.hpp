#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <compare>
#include <cstddef>
#include <functional>
#include <string>
#include <string_view>
#include <utility>

namespace noveltea::core {

template<class Tag> class StrongId {
public:
    StrongId() = delete;

    [[nodiscard]] static Result<StrongId, Diagnostics> create(std::string value)
    {
        if (!is_valid(value)) {
            return Result<StrongId, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "domain.invalid_id",
                .message = "ID must be lowercase kebab-case and begin with a letter",
            }});
        }
        return Result<StrongId, Diagnostics>::success(StrongId(std::move(value)));
    }

    [[nodiscard]] const std::string& text() const noexcept { return m_value; }
    [[nodiscard]] explicit operator std::string_view() const noexcept { return m_value; }

    auto operator<=>(const StrongId&) const = default;

private:
    explicit StrongId(std::string value) : m_value(std::move(value)) {}

    [[nodiscard]] static bool is_valid(std::string_view value) noexcept
    {
        if (value.empty() || value.front() < 'a' || value.front() > 'z')
            return false;
        bool previous_dash = false;
        for (const char character : value) {
            const bool alphanumeric =
                (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
            if (!alphanumeric && character != '-')
                return false;
            if (character == '-' && previous_dash)
                return false;
            previous_dash = character == '-';
        }
        return !previous_dash;
    }

    std::string m_value;
};

} // namespace noveltea::core

namespace std {
template<class Tag> struct hash<noveltea::core::StrongId<Tag>> {
    [[nodiscard]] size_t operator()(const noveltea::core::StrongId<Tag>& id) const noexcept
    {
        return hash<string>{}(id.text());
    }
};
} // namespace std
