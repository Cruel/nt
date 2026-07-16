#pragma once

#include <compare>
#include <cstdint>
#include <limits>
#include <optional>

namespace noveltea::runtime {

template<class Tag> class RuntimeMonotonicId {
public:
    RuntimeMonotonicId() = delete;

    [[nodiscard]] static constexpr std::optional<RuntimeMonotonicId>
    from_number(std::uint64_t value) noexcept
    {
        if (value == 0) {
            return std::nullopt;
        }
        return RuntimeMonotonicId(value);
    }

    [[nodiscard]] constexpr std::uint64_t number() const noexcept { return m_value; }

    [[nodiscard]] constexpr std::optional<RuntimeMonotonicId> next() const noexcept
    {
        if (m_value == std::numeric_limits<std::uint64_t>::max()) {
            return std::nullopt;
        }
        return RuntimeMonotonicId(m_value + 1);
    }

    auto operator<=>(const RuntimeMonotonicId&) const = default;

private:
    explicit constexpr RuntimeMonotonicId(std::uint64_t value) noexcept : m_value(value) {}
    std::uint64_t m_value;
};

} // namespace noveltea::runtime
