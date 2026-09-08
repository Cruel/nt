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

enum class StrongIdSyntax {
    KebabCase,
    KebabOrSnakeCase,
};

[[nodiscard]] inline bool valid_strong_id(std::string_view value, StrongIdSyntax syntax) noexcept
{
    if (value.empty() || value.front() < 'a' || value.front() > 'z')
        return false;
    bool previous_separator = false;
    for (const char character : value) {
        const bool alphanumeric =
            (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
        const bool separator =
            character == '-' || (syntax == StrongIdSyntax::KebabOrSnakeCase && character == '_');
        if (!alphanumeric && !separator)
            return false;
        if (separator && previous_separator)
            return false;
        previous_separator = separator;
    }
    return !previous_separator;
}

template<class Tag, StrongIdSyntax Syntax = StrongIdSyntax::KebabCase> class StrongId {
public:
    StrongId() = delete;

    [[nodiscard]] static Result<StrongId, Diagnostics> create(std::string value)
    {
        if (!valid_strong_id(value, Syntax)) {
            return Result<StrongId, Diagnostics>::failure(Diagnostics{Diagnostic{
                .code = "domain.invalid_id",
                .message = Syntax == StrongIdSyntax::KebabCase
                               ? "ID must be lowercase kebab-case and begin with a letter"
                               : "ID must begin with a lowercase letter and contain only lowercase "
                                 "letters, numbers, hyphens, and underscores",
            }});
        }
        return Result<StrongId, Diagnostics>::success(StrongId(std::move(value)));
    }

    [[nodiscard]] const std::string& text() const noexcept { return m_value; }
    [[nodiscard]] explicit operator std::string_view() const noexcept { return m_value; }

    auto operator<=>(const StrongId&) const = default;

private:
    explicit StrongId(std::string value) : m_value(std::move(value)) {}

    std::string m_value;
};

} // namespace noveltea::core

namespace std {
template<class Tag, noveltea::core::StrongIdSyntax Syntax>
struct hash<noveltea::core::StrongId<Tag, Syntax>> {
    [[nodiscard]] size_t operator()(const noveltea::core::StrongId<Tag, Syntax>& id) const noexcept
    {
        return hash<string>{}(id.text());
    }
};
} // namespace std
