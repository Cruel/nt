#pragma once

#include <compare>
#include <cstddef>
#include <cstdint>

namespace noveltea::core {

class TypedSaveSlotId {
public:
    enum class Kind : std::uint8_t {
        Manual,
        Autosave
    };

    [[nodiscard]] static TypedSaveSlotId manual(std::uint32_t number) noexcept
    {
        return TypedSaveSlotId(Kind::Manual, number);
    }
    [[nodiscard]] static TypedSaveSlotId autosave() noexcept
    {
        return TypedSaveSlotId(Kind::Autosave, 0);
    }
    [[nodiscard]] Kind kind() const noexcept { return m_kind; }
    [[nodiscard]] std::uint32_t number() const noexcept { return m_number; }
    [[nodiscard]] bool is_autosave() const noexcept { return m_kind == Kind::Autosave; }
    auto operator<=>(const TypedSaveSlotId&) const = default;

private:
    TypedSaveSlotId(Kind kind, std::uint32_t number) noexcept : m_kind(kind), m_number(number) {}
    Kind m_kind;
    std::uint32_t m_number;
};

struct TypedSaveSlotIdHash {
    [[nodiscard]] std::size_t operator()(const TypedSaveSlotId& slot) const noexcept;
};

} // namespace noveltea::core
